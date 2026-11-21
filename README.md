# ClipForge

A small local-first YouTube video batch clipper. It splits an authorized source video into consecutive 30-second segments and creates **both** portrait variants for every segment:
- `center-crop`: fills a 9:16 frame; sides/top-bottom may be cropped.
- `blur-background`: preserves the full source frame over a blurred 9:16 background.

A 20-minute source produces 40 segments and 80 MP4 files (40 × 2 styles). The final segment is kept even if shorter than 30 seconds.

## Requirements

- Windows 10/11
- Node.js 20+
- FFmpeg (includes ffprobe)
- yt-dlp

Install tools from PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
winget install yt-dlp.yt-dlp
```

Close and reopen PowerShell after installation, then verify:

```powershell
node -v
npm -v
ffmpeg -version
ffprobe -version
yt-dlp --version
```

## Run

In this folder:

```powershell
npm install
npm start
```

Open http://localhost:3000

Paste a YouTube URL for a video you own or are authorized to download. Wait for processing, then download the ZIP.

## What costs money?

The app and tools are free. It uses your own computer, so there is no API or hosting bill. Electricity and your computer's time are the only operating costs. Video processing speed depends on CPU, source resolution and duration.

## Known limitations / safeguards

- This tool does not bypass DRM, age restrictions, private videos, paid content, or other access controls.
- Downloading from YouTube may be restricted by YouTube's Terms or copyright law. Use your own content or obtain permission.
- YouTube may change its delivery methods; update yt-dlp if a download stops working: `yt-dlp -U`.
- Both styles are generated, so output count is twice the number of segments.
- The output is encoded at 1080×1920. Upscaling a low-resolution source cannot restore missing detail.
- Very long videos take time and disk space. The server rejects videos longer than four hours.
- This is a local prototype: job state is held in memory and resets if the server restarts. Generated files remain in `data/jobs`.
- The ZIP is compressed lightly because MP4 files are already compressed.
- Fast re-encoding is used for reliable segment boundaries; this is slower than stream-copy cutting.

## Troubleshooting

**`ffmpeg` / `ffprobe` / `yt-dlp` not recognized:** reopen PowerShell or add the installation directory to PATH.

**YouTube download fails:** update yt-dlp (`yt-dlp -U`). Some videos require sign-in or are unavailable to third-party downloaders; this prototype intentionally does not handle cookies or bypass restrictions.

**`libx264` encoder missing:** install a full FFmpeg build (the Gyan Windows build is suitable).

**Disk space:** both variants can consume significant space. Delete old job folders from `data/jobs` when finished.

**Black bars / subject crop:** use the blur-background variant to preserve the full source frame. Center-crop intentionally fills the screen.

## API

- `POST /api/jobs` body: `{"url":"https://youtu.be/...","clipSeconds":30}`
- `GET /api/jobs/:id` job status and generated file list
- `GET /api/jobs/:id/download` ZIP archive
- `GET /api/health` checks local dependencies
