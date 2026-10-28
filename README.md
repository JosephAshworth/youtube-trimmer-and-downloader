# YouTube Trimmer and Downloader

This app is a full-stack Next.js service:
- Frontend: `app/page.tsx` and UI components
- Backend: Next.js API routes under `app/api/**`

Frontend and backend run in one Next.js process.

## Local Development

1. Install dependencies:
   ```bash
   npm ci
   ```
2. Configure environment:
   ```bash
   cp .env.example .env.local
   ```
3. Run:
   ```bash
   npm run dev
   ```
4. Open `http://localhost:3000`

## Docker

```bash
docker compose up --build
```

The app listens on port 3000.

## YouTube Auth / Cookies

For age-restricted or sign-in-protected videos, configure cookies using:
- `YT_DLP_COOKIES_FILE=/path/to/cookies.txt` (recommended in containers)
- or `YT_DLP_COOKIES_FROM_BROWSER` (mostly for local development)

## Datacenter IPs and the yt-dlp worker

YouTube anti-bot checks are tied to the egress IP. Datacenter ranges are often blocked even with valid cookies.

Set `YT_DLP_PROXY` to send local yt-dlp traffic through a residential or rotating proxy. See `.env.example`.

Or offload yt-dlp to an external worker by setting:

```
YTDLP_WORKER_URL=https://your-worker.example.com
YTDLP_WORKER_API_KEY=your-long-random-secret
```

When `YTDLP_WORKER_URL` is set:
- `app/api/video-info` calls the worker's `POST /video-info`.
- The processing pipeline (`lib/videoPipeline.ts`) calls the worker's `POST /download`, which returns the finished (downloaded + trimmed + sped-up) clip. yt-dlp does not run in this app.

The rest of the app — frontend, job orchestration, progress streaming — stays the same. Configure cookies and proxy on the worker, not in this app.
