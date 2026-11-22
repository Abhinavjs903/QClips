const express = require("express");
const archiver = require("archiver");
const multer = require("multer");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const JOBS_DIR = path.join(ROOT, "data", "jobs");
const UPLOAD_DIR = path.join(ROOT, "data", "uploads");
const PUBLIC_DIR = path.join(ROOT, "public");
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_MB || 2048) * 1024 * 1024;
const MAX_DURATION_SECONDS = 4 * 60 * 60;
const jobs = new Map();

fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".mp4", ".mov", ".mkv", ".webm", ".m4v"].includes(ext)) {
      return cb(new Error("Unsupported video type. Use MP4, MOV, MKV, WEBM or M4V."));
    }
    cb(null, true);
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

function run(command, args, onOutput) {
  return new Promise((resolve, reject) => {
    const label = path.basename(command);
    console.log(`[QClips] Starting ${label}...`);
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "", stderr = "", settled = false;
    child.stdout?.on("data", d => {
      const chunk = d.toString();
      stdout += chunk;
      if (chunk.trim()) console.log(`[${label}] ${chunk.trim()}`);
      onOutput?.(chunk);
    });
    child.stderr?.on("data", d => {
      const chunk = d.toString();
      stderr += chunk;
      if (chunk.trim()) console.log(`[${label}] ${chunk.trim()}`);
    });
    child.on("error", err => {
      if (settled) return;
      settled = true;
      console.error(`[QClips] ${label} failed to start: ${err.message}`);
      reject(new Error(`Could not start ${command}. Check that it is installed and in PATH. ${err.message}`));
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      console.log(`[QClips] ${label} exited with code ${code}`);
      code === 0 ? resolve({ stdout, stderr }) :
        reject(new Error(`${command} failed (exit ${code}). ${stderr.slice(-2500) || stdout.slice(-1000)}`));
    });
  });
}

function validYouTubeUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return ["youtube.com", "m.youtube.com", "youtu.be", "youtube-nocookie.com"].includes(host)
      && ["https:", "http:"].includes(u.protocol);
  } catch { return false; }
}

function update(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function formatTime(seconds) {
  const s = Math.floor(seconds), h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h, m, sec].map(v => String(v).padStart(2, "0")).join("-");
}

async function inspectVideo(videoPath) {
  const probe = await run(process.env.FFPROBE_PATH || "ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type",
    "-of", "json", videoPath
  ]);
  let info;
  try { info = JSON.parse(probe.stdout); }
  catch { throw new Error("Could not read video metadata. Check that the file is a valid video."); }
  const duration = Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not determine video duration.");
  if (duration > MAX_DURATION_SECONDS) throw new Error("Video is longer than the 4-hour limit.");
  const streams = info.streams || [];
  if (!streams.some(s => s.codec_type === "video")) throw new Error("The selected file has no video stream.");
  return { duration, hasAudio: streams.some(s => s.codec_type === "audio") };
}

async function createClips(job, videoPath, duration, hasAudio) {
  const total = duration < 60 ? 1 : duration < 120 ? 2 : 3;
  const clipDuration = Math.min(job.clipSeconds, duration / total);
  const outDir = path.join(job.dir, "clips");
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];

  // Divide the source into broad sections, then choose one random moment per section.
  // This keeps clips spread out and guarantees they do not overlap.
  const sectionLength = duration / total;
  const starts = Array.from({ length: total }, (_, i) => {
    const sectionStart = i * sectionLength;
    const available = Math.max(0, sectionLength - clipDuration);
    return sectionStart + Math.random() * available;
  }).sort((a, b) => a - b);

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const n = String(i + 1).padStart(3, "0");
    const base = `${n}_from_${formatTime(start)}_to_${formatTime(start + clipDuration)}`;
    const filename = `${base}_center-crop.mp4`;
    const output = path.join(outDir, filename);
    const filter = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1";
    const args = [
      "-hide_banner", "-loglevel", "warning", "-stats", "-y",
      "-ss", String(start), "-i", videoPath, "-t", String(clipDuration),
      "-vf", filter, "-map", "0:v:0", ...(hasAudio ? ["-map", "0:a:0?"] : []),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
      ...(hasAudio ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]),
      "-movflags", "+faststart", "-avoid_negative_ts", "make_zero", output
    ];
    await run(process.env.FFMPEG_PATH || "ffmpeg", args);
    results.push({ name: filename, style: "center-crop", clipNumber: i + 1,
      start, end: start + clipDuration, size: fs.statSync(output).size });
    update(job, {
      progress: Math.min(99, 12 + Math.round((results.length / total) * 87)),
      message: `Rendered ${results.length} of ${total} random clips`
    });
  }
  return { results, totalSegments: total };
}
async function processJob(job) {
  try {
    let videoPath = job.sourcePath;
    if (job.sourceType === "youtube") {
      update(job, { status: "processing", progress: 2, message: "Downloading authorized YouTube source..." });
      const template = path.join(job.dir, "source.%(ext)s");
      await run(process.env.YTDLP_PATH || "yt-dlp", [
        "--no-playlist", "--no-warnings",
        "--concurrent-fragments", process.env.YTDLP_CONCURRENT_FRAGMENTS || "8",
        "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
        "--merge-output-format", "mp4", "-o", template, job.url
      ], chunk => {
        const matches = [...chunk.matchAll(/(\\d+(?:\\.\\d+)?)%/g)];
        if (!matches.length) return;
        const percent = Number(matches[matches.length - 1][1]);
        if (Number.isFinite(percent)) {
          update(job, {
            progress: Math.min(7, 2 + Math.round(percent * 0.05)),
            message: "Downloading source · " + Math.round(percent) + "% complete"
          });
        }
      });
      const files = fs.readdirSync(job.dir).filter(f => f.startsWith("source."));
      if (!files.length) throw new Error("Download completed but no source file was created.");
      videoPath = path.join(job.dir, files.find(f => f.endsWith(".mp4")) || files[0]);
    }
    update(job, { status: "processing", progress: 8, message: "Checking source video..." });
    const { duration, hasAudio } = await inspectVideo(videoPath);
    update(job, { duration, progress: 12, message: "Picking random moments and creating portrait clips..." });
    const generated = await createClips(job, videoPath, duration, hasAudio);
    update(job, { status: "completed", progress: 100, message: "All clips are ready.",
      totalSegments: generated.totalSegments, files: generated.results, outputCount: generated.results.length });
  } catch (err) {
    update(job, { status: "failed", message: err.message, error: err.message });
  } finally {
    if (job.uploadPath) fs.promises.unlink(job.uploadPath).catch(() => {});
  }
}

function startJob(source) {
  const id = crypto.randomUUID(), dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const job = { id, ...source, clipSeconds: 20, dir, status: "queued", progress: 0,
    message: "Queued...", createdAt: new Date().toISOString(), files: [] };
  jobs.set(id, job);
  processJob(job);
  return job;
}

app.post("/api/jobs", (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!validYouTubeUrl(url)) return res.status(400).json({ error: "Enter a valid YouTube URL." });
  const job = startJob({ sourceType: "youtube", url });
  res.status(202).json({ id: job.id, status: job.status });
});

app.post("/api/jobs/upload", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a video file first." });
  const ext = path.extname(req.file.originalname).toLowerCase();
  const stored = path.join(UPLOAD_DIR, crypto.randomUUID() + ext);
  try {
    fs.renameSync(req.file.path, stored);
    const job = startJob({ sourceType: "upload", sourcePath: stored, uploadPath: stored });
    res.status(202).json({ id: job.id, status: job.status });
  } catch (err) {
    fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(500).json({ error: `Could not start upload job: ${err.message}` });
  }
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found. Job status resets when the server restarts." });
  const { id, status, progress, message, duration, totalSegments, outputCount, files, error } = job;
  res.json({ id, status, progress, message, duration, totalSegments, outputCount, files, error });
});

app.get("/api/jobs/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "completed") return res.status(409).json({ error: "Clips are not ready yet." });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="qclips-${job.id.slice(0, 8)}.zip"`);
  const archive = archiver("zip", { zlib: { level: 1 } });
  archive.on("error", err => res.destroy(err));
  archive.pipe(res);
  archive.directory(path.join(job.dir, "clips"), false);
  archive.finalize();
});

app.get("/api/health", async (_req, res) => {
  const checks = {};
  for (const [name, cmd, args] of [
    ["node", process.execPath, ["--version"]],
    ["ffmpeg", process.env.FFMPEG_PATH || "ffmpeg", ["-version"]],
    ["ffprobe", process.env.FFPROBE_PATH || "ffprobe", ["-version"]],
    ["yt-dlp", process.env.YTDLP_PATH || "yt-dlp", ["--version"]]
  ]) {
    try {
      const result = await run(cmd, args);
      checks[name] = { ok: true, version: (result.stdout || result.stderr).split(/\r?\n/)[0] };
    } catch (e) { checks[name] = { ok: false, error: e.message }; }
  }
  res.json({ ok: Object.values(checks).every(v => v.ok), checks });
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE"
      ? `Video exceeds the ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} MB upload limit.` : err.message;
    return res.status(400).json({ error: message });
  }
  res.status(400).json({ error: err?.message || "Request failed." });
});

app.listen(PORT, () => console.log(`QClips running at http://localhost:${PORT}`));
