# QClips

A local-first batch video clipper. Upload a video file or provide a YouTube URL for a video you own or are authorized to download. QClips splits it into consecutive 30-second segments and generates **two 9:16 portrait versions** of every segment:

- **Center crop:** fills the vertical frame; edges may be cropped.
- **Blur background:** preserves the complete source frame over a blurred vertical background.

A 20-minute source produces 40 segments and 80 MP4 files. The final segment is kept even if shorter than 30 seconds.

## Requirements

- Windows 10/11, macOS or Linux
- Node.js 20+
- FFmpeg with ffprobe
- yt-dlp only when using YouTube URLs

Install Node dependencies:

```bash
npm install
```

Install FFmpeg and ensure both `ffmpeg` and `ffprobe` are in PATH. Install yt-dlp only if using YouTube URLs.

## Run locally

```bash
npm start
```

Open http://localhost:3000

### Upload a local video

Choose MP4, MOV, MKV, WEBM or M4V. Default upload limit is 2 GB; configure it with `MAX_VIDEO_MB`. Uploads are processed on the local machine and the temporary source upload is deleted after processing.

### Use a YouTube URL

Paste a URL for content you own or are authorized to download. QClips uses yt-dlp without extracting browser cookies or bypassing access restrictions. Some videos may be unavailable to third-party downloaders; use a permitted local file as fallback.

## Output

Every source is split into consecutive fixed 30-second segments. Each segment gets one center-crop MP4 and one blur-background MP4. The ZIP contains all outputs. Video is encoded at 1080×1920 using H.264; audio is AAC when present. Silent videos remain silent.

## Limits and safeguards

- Maximum source duration: 4 hours.
- Default upload size: 2 GB.
- Upscaling cannot restore detail absent from a low-resolution source.
- Re-encoding gives reliable boundaries but is slower than stream-copy cutting.
- Job state is held in memory and resets if the server restarts. Completed files remain in `data/jobs`.
- Large projects require substantial free disk space.
- Use authorized sources and comply with platform terms and copyright law. This tool does not bypass DRM, private-video restrictions, age gates, paid access or other controls.

## Troubleshooting

**FFmpeg/ffprobe not recognized:** reopen the terminal or add the FFmpeg binary folder to PATH.

**YouTube download fails:** update yt-dlp. Some videos are not available to third-party tools. QClips intentionally does not handle browser cookies; upload a permitted local video instead.

**Upload too large:** set `MAX_VIDEO_MB` to a suitable value, considering disk space and local capacity.

**libx264 missing:** install a full FFmpeg build with the libx264 encoder.

## API

- `POST /api/jobs` JSON body `{"url":"https://youtu.be/..."}` — YouTube job.
- `POST /api/jobs/upload` multipart field `video` — local file job.
- `GET /api/jobs/:id` — status and output list.
- `GET /api/jobs/:id/download` — ZIP archive.
- `GET /api/health` — dependency checks.
