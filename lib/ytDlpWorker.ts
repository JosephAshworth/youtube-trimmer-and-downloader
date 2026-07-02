import { createWriteStream } from "fs";
import { Readable } from "stream";
import { type ExportSpeed } from "@/lib/utils";
import { type ProcessProgress } from "@/lib/videoPipeline";

/**
 * Client for the external yt-dlp worker (see /worker).
 *
 * When YTDLP_WORKER_URL is configured, the Next.js app offloads all yt-dlp
 * execution (metadata + download/trim/speed) to the worker, which runs on a
 * non-datacenter / residential IP path so YouTube anti-bot checks pass.
 */

const WORKER_REQUEST_TIMEOUT_MS = 300000;

export interface WorkerVideoInfo {
  videoId: string;
  title: string;
  duration: number;
  durationMs: number;
  thumbnail: string;
  uploader: string;
}

function getWorkerUrl(): string | null {
  const url = process.env.YTDLP_WORKER_URL?.trim();
  if (!url) return null;
  return url.replace(/\/+$/, "");
}

export function isWorkerEnabled(): boolean {
  return getWorkerUrl() !== null;
}

function getApiKey(): string {
  const key = process.env.YTDLP_WORKER_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "YTDLP_WORKER_URL is set but YTDLP_WORKER_API_KEY is missing. Set both to use the yt-dlp worker."
    );
  }
  return key;
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    if (data?.error) return data.error;
  } catch {
    // response was not JSON
  }
  return fallback;
}

/** Combine an optional caller AbortSignal with an internal timeout. */
function withTimeout(signal?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("yt-dlp worker request timed out")),
    WORKER_REQUEST_TIMEOUT_MS
  );
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export async function fetchVideoInfoFromWorker(
  url: string,
  signal?: AbortSignal
): Promise<WorkerVideoInfo> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) throw new Error("yt-dlp worker is not configured");
  const apiKey = getApiKey();

  const { signal: reqSignal, cleanup } = withTimeout(signal);
  try {
    const response = await fetch(`${workerUrl}/video-info`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ url }),
      signal: reqSignal,
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(
        await readErrorMessage(
          response,
          `yt-dlp worker returned ${response.status}`
        )
      );
    }

    return (await response.json()) as WorkerVideoInfo;
  } finally {
    cleanup();
  }
}

/**
 * Ask the worker to download + trim + (optionally) speed a clip and stream the
 * finished MP4 straight to `outputPath`. The worker does all yt-dlp/ffmpeg work,
 * so the caller only writes the returned bytes.
 */
export async function downloadProcessedClipFromWorker(
  input: {
    url: string;
    startTime: number;
    endTime: number;
    speed: ExportSpeed;
  },
  outputPath: string,
  onProgress?: (progress: ProcessProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) throw new Error("yt-dlp worker is not configured");
  const apiKey = getApiKey();

  onProgress?.({
    stage: "download",
    percent: 2,
    message: "Contacting download worker...",
  });

  const { signal: reqSignal, cleanup } = withTimeout(signal);
  try {
    const response = await fetch(`${workerUrl}/download`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify(input),
      signal: reqSignal,
      cache: "no-store",
    });

    if (!response.ok || !response.body) {
      throw new Error(
        await readErrorMessage(
          response,
          `yt-dlp worker returned ${response.status}`
        )
      );
    }

    const totalBytes = Number(response.headers.get("content-length") || 0);
    let received = 0;

    const nodeStream = Readable.fromWeb(
      response.body as import("stream/web").ReadableStream
    );
    const fileStream = createWriteStream(outputPath);

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        nodeStream.destroy();
        fileStream.destroy();
        reject(new Error("Processing aborted"));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      nodeStream.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (totalBytes > 0) {
          const ratio = Math.min(1, received / totalBytes);
          onProgress?.({
            stage: "download",
            percent: 5 + ratio * 90,
            message: `Downloading processed clip (${Math.round(ratio * 100)}%)`,
          });
        } else {
          onProgress?.({
            stage: "download",
            percent: 50,
            message: "Downloading processed clip...",
          });
        }
      });
      nodeStream.on("error", (err) => {
        fileStream.destroy();
        reject(err);
      });
      fileStream.on("error", (err) => {
        nodeStream.destroy();
        reject(err);
      });
      fileStream.on("finish", () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });

      nodeStream.pipe(fileStream);
    });

    onProgress?.({
      stage: "finalize",
      percent: 100,
      message: "Processing complete",
    });
  } finally {
    cleanup();
  }
}
