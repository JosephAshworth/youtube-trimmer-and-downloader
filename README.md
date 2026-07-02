# YouTube Trimmer and Downloader

This app is a full-stack Next.js service:
- Frontend: `app/page.tsx` and UI components
- Backend: Next.js API routes under `app/api/**`

Because frontend and backend run in one Next.js process, production deployment to AWS is typically a **single ECS/Fargate service behind one ALB**.

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

## Deploy to AWS (Frontend + Backend)

This repo includes:
- `Dockerfile` for the Next.js app
- `scripts/deploy-aws-ecs.sh` for image build/push + ECS rollout
- `aws/deploy.env.example` for deployment variables

### 1) One-time AWS setup

Create or verify these resources in your AWS account:
- VPC + at least 2 public subnets (or private subnets + NAT)
- Application Load Balancer + target group (HTTP 3000 target)
- ECS cluster
- ECS service (Fargate) connected to the target group
- IAM execution role for ECS tasks (can pull ECR images + write CloudWatch logs)
- CloudWatch log group (for container logs)
- ECR repository (script can auto-create it if missing)

If you already have an ECS service running this app, you can skip ahead to step 2.

### 2) Configure deployment variables

```bash
cp aws/deploy.env.example aws/deploy.env
```

Edit `aws/deploy.env` with your values.

### 3) Deploy

```bash
set -a
source aws/deploy.env
set +a

./scripts/deploy-aws-ecs.sh
```

The script will:
1. Build Docker image
2. Push image to ECR
3. Register a new ECS task definition revision with the new image
4. Update the ECS service and wait for stability

### 4) Verify

- Check ECS service events and desired/running task counts
- Check ALB target health
- Open your ALB DNS name in the browser
- Test both:
  - Frontend page load
  - Backend API route (for example `/api/video-info?...`)

## YouTube Auth / Cookies in Production

For age-restricted or sign-in-protected videos, configure cookies using:
- `YT_DLP_COOKIES_FILE=/tmp/cookies.txt` (recommended in containers)
- or `YT_DLP_COOKIES_FROM_BROWSER` (mostly for local development)

If using AWS Secrets Manager with chunked cookie values, see `taskdef-v4.json` for an example command that reconstructs `/tmp/cookies.txt` at container startup.

## Reliability on AWS: offload yt-dlp to a worker

YouTube anti-bot checks are tied to the **egress IP reputation**. AWS datacenter
IP ranges are frequently blocked even with valid cookies, so downloads from ECS
can be inconsistent. The fix is to keep the AWS app (CloudFront -> ALB -> ECS)
for UI + job orchestration, and run only yt-dlp on a non-datacenter / residential
IP path.

```
Browser -> CloudFront -> ALB -> ECS (Next.js UI + orchestration)
                                   |  HTTPS + X-API-Key
                                   v
                          yt-dlp Worker (residential IP) -> YouTube
```

This repo ships that worker in [`worker/`](worker/README.md). To enable it, set
two env vars on the ECS task:

```
YTDLP_WORKER_URL=https://your-worker.example.com
YTDLP_WORKER_API_KEY=your-long-random-secret
```

When `YTDLP_WORKER_URL` is set:
- `app/api/video-info` calls the worker's `POST /video-info`.
- The processing pipeline (`lib/videoPipeline.ts`) calls the worker's
  `POST /download`, which returns the finished (downloaded + trimmed + sped-up)
  clip. No yt-dlp runs on ECS.

The rest of the app — frontend, job orchestration, progress streaming — is
unchanged. See [`worker/README.md`](worker/README.md) for the full API contract
and deployment options (VPS, home server + tunnel, or datacenter + residential
proxy via `YT_DLP_PROXY`).
