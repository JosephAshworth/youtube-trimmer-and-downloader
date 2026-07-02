# yt-dlp Worker

A small standalone service that runs **yt-dlp + ffmpeg** and exposes them over
HTTP. The main Next.js app calls this worker instead of running yt-dlp locally.

## Why this exists

YouTube anti-bot checks are tied to the reputation of the **egress IP**. AWS
datacenter IP ranges are frequently blocked even with valid cookies. Running
yt-dlp here — on a non-datacenter / residential IP path (or behind a residential
proxy via `YT_DLP_PROXY`) — lets downloads pass those checks while the rest of
the app keeps running on AWS.

```
Browser -> CloudFront -> ALB -> ECS (Next.js UI + orchestration)
                                   |
                                   |  HTTPS + X-API-Key
                                   v
                          yt-dlp Worker (residential IP)  -> YouTube
```

## API contract

All endpoints except `/health` require the `X-API-Key` header matching
`YTDLP_WORKER_API_KEY`.

### `GET /health`
Returns `{ "status": "ok", "ts": 1700000000000 }`.

### `POST /video-info`
Request body:
```json
{ "url": "https://www.youtube.com/watch?v=VIDEO_ID" }
```
Response:
```json
{
  "videoId": "VIDEO_ID",
  "title": "Some title",
  "duration": 212,
  "durationMs": 212000,
  "thumbnail": "https://...",
  "uploader": "Channel name"
}
```

### `POST /download`
Request body:
```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "startTime": 5000,
  "endTime": 15000,
  "speed": 1
}
```
`startTime` / `endTime` are in **milliseconds**. `speed` is `1` or `1.5`.

The worker downloads, trims, and (optionally) speeds up the clip, then streams
the finished MP4 back as `video/mp4`. On failure it returns JSON:
`{ "error": "...", "ageRestricted": false }`.

## Run locally

```bash
cd worker
cp .env.example .env
# edit .env: set YTDLP_WORKER_API_KEY (and cookies/proxy if needed)
npm install
export $(grep -v '^#' .env | xargs)
npm start
```

Test it:
```bash
curl -s localhost:8080/health
curl -s -X POST localhost:8080/video-info \
  -H "x-api-key: $YTDLP_WORKER_API_KEY" -H "content-type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

## Run with Docker

```bash
cd worker
docker build -t ytdlp-worker .
docker run --rm -p 8080:8080 \
  -e YTDLP_WORKER_API_KEY=your-long-random-secret \
  ytdlp-worker
```

## Deploying on a non-datacenter IP

Pick whichever fits you:

- A small VPS/VM from a provider whose ranges YouTube does not block.
- A home server / mini-PC on your residential connection (port-forward or a
  tunnel like Cloudflare Tunnel / Tailscale Funnel to get a public HTTPS URL).
- Any datacenter host **plus** a residential/rotating proxy via `YT_DLP_PROXY`.

Then point the Next.js app at it:

```
YTDLP_WORKER_URL=https://your-worker.example.com
YTDLP_WORKER_API_KEY=your-long-random-secret
```

## Security

- Always set a long random `YTDLP_WORKER_API_KEY` and serve over HTTPS.
- Optionally set `YTDLP_WORKER_IP_ALLOWLIST` to your AWS NAT gateway EIP(s) so
  only your ECS tasks can reach the worker.
