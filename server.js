const express = require("express");
const archiver = require("archiver");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const JOBS_DIR = path.join(ROOT, "data", "jobs");
const PUBLIC_DIR = path.join(ROOT, "public");
const jobs = new Map();

fs.mkdirSync(JOBS_DIR, { recursive: true });
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...opts });
    let stdout = "", stderr = "";
    child.stdout?.on("data", d => stdout += d.toString());
    child.stderr?.on("data", d => stderr += d.toString());
    child.on("error", err => reject(new Error(`Could not start ${command}. Is it installed and in PATH? ${err.message}`)));
    child.on("close", code => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} failed (exit ${code}). ${stderr.slice(-2500) || stdout.slice(-1000)}`)));
  });
}

function validYouTubeUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return ["youtube.com", "m.youtube.com", "youtu.be", "youtube-nocookie.com"].includes(host)
      && (u.protocol === "https:" || u.protocol === "http:");
  } catch { return false; }
}

function safeName(s) {
  return String(s || "video").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\s+/g, "_").slice(0, 70) || "video";
}

function update(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

async function createClips(job, videoPath, duration) {
  const total = Math.ceil(duration / job.clipSeconds);
  const outDir = path.join(job.dir, "clips");
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];

  for (let i = 0; i < total; i++) {
    const start = i * job.clipSeconds;
    const clipDuration = Math.min(job.clipSeconds, duration - start);
    if (clipDuration <= 0.05) continue;

    const n = String(i + 1).padStart(3, "0");
    const base = `${n}_from_${formatTime(start)}_to_${formatTime(start + clipDuration)}`;
    const variants = [
      {
        key: "center-crop",
        filename: `${base}_center-crop.mp4`,
        filter: "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"
      },
      {
        key: "blur-background",
        filename: `${base}_blur-background.mp4`,
        filter: "[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=28:10[blur];[fg]scale=1080:1920:force_original_aspect_ratio=decrease[front];[blur][front]overlay=(W-w)/2:(H-h)/2,format=yuv420p"
      }
    ];

    for (const variant of variants) {
      const output = path.join(outDir, variant.filename);
      const filterArgs = variant.key === "blur-background"
        ? ["-filter_complex", variant.filter]
        : ["-vf", variant.filter];
      const args = [
        "-hide_banner", "-loglevel", "error", "-y",
        "-ss", String(start), "-i", videoPath, "-t", String(clipDuration),
        ...filterArgs,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", "-avoid_negative_ts", "make_zero",
        output
      ];
      await run(process.env.FFMPEG_PATH || "ffmpeg", args);
      results.push({
        name: variant.filename,
        style: variant.key,
        clipNumber: i + 1,
        start,
        end: start + clipDuration,
        size: fs.statSync(output).size
      });
    }
    update(job, {
      progress: Math.round(((i + 1) / total) * 100),
      message: `Created segment ${i + 1} of ${total} (${results.length} files)`
    });
  }
  return { results, totalSegments: total };
}

function formatTime(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map(v => String(v).padStart(2, "0")).join("-");
}

async function processJob(job) {
  try {
    update(job, { status: "processing", progress: 2, message: "Downloading source video..." });
    const videoPath = path.join(job.dir, "source.mp4");

    // Download only videos the user is authorized to download. yt-dlp merges streams into MP4.
    await run(process.env.YTDLP_PATH || "yt-dlp", [
      "--no-playlist",
      "--no-warnings",
      "--cookies-from-browser",
      process.env.YTDLP_BROWSER || "chrome",
      "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
      "--merge-output-format", "mp4",
      "--recode-video", "mp4",
      "-o", videoPath,
      job.url
    ]);


    if (!fs.existsSync(videoPath)) throw new Error("Download completed but source.mp4 was not created.");
    update(job, { progress: 15, message: "Reading video duration..." });

    const probe = await run(process.env.FFPROBE_PATH || "ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath
    ]);
    const duration = Number(probe.stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not determine source video duration.");
    if (duration > 4 * 60 * 60) throw new Error("Video is longer than the 4-hour safety limit.");

    update(job, { duration, progress: 18, message: "Generating both portrait versions..." });
    const generated = await createClips(job, videoPath, duration);
    update(job, {
      status: "completed", progress: 100, message: "All clips are ready.",
      totalSegments: generated.totalSegments, files: generated.results,
      outputCount: generated.results.length
    });
  } catch (err) {
    update(job, { status: "failed", message: err.message, error: err.message });
  }
}

app.post("/api/jobs", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  const clipSeconds = Number(req.body?.clipSeconds || 30);
  if (!validYouTubeUrl(url)) return res.status(400).json({ error: "Enter a valid YouTube URL." });
  if (clipSeconds !== 30) return res.status(400).json({ error: "This MVP is configured for 30-second clips." });

  const id = crypto.randomUUID();
  const dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const job = {
    id, url, clipSeconds, dir, status: "queued", progress: 0,
    message: "Queued...", createdAt: new Date().toISOString(), files: []
  };
  jobs.set(id, job);
  res.status(202).json({ id, status: job.status });
  processJob(job);
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found. Jobs are stored in memory until the server restarts." });
  const { id, status, progress, message, duration, totalSegments, outputCount, files, error } = job;
  res.json({ id, status, progress, message, duration, totalSegments, outputCount, files, error });
});

app.get("/api/jobs/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "completed") return res.status(409).json({ error: "Clips are not ready yet." });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="clipforge-${job.id.slice(0, 8)}.zip"`);
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
  res.json({ ok: Object.values(checks).every(x => x.ok), checks });
});

app.listen(PORT, () => console.log(`ClipForge running at http://localhost:${PORT}`));
