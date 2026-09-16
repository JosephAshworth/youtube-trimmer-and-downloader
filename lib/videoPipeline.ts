import { spawn } from "child_process";
import { existsSync, mkdirSync, unlinkSync, renameSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import ffmpeg from "fluent-ffmpeg";
import {
  type ExportSpeed,
  extractYouTubeVideoId,
  msToFfmpegTimestamp,
  parseExportSpeed,
} from "@/lib/utils";
import {
  formatYtDlpAuthHint,
  getYtDlpAuthArgs,
  logYtDlpFailure,
} from "@/lib/ytDlpAuth";
import {
  downloadProcessedClipFromWorker,
  isWorkerEnabled,
} from "@/lib/ytDlpWorker";

export const TMP_DIR = join(process.cwd(), "tmp");
const YT_DLP_TIMEOUT_MS = 300000;
const YT_DLP_CONCURRENT_FRAGMENTS = 8;
const DOWNLOAD_SEGMENT_MS = 3 * 60 * 1000;
const SECTION_DOWNLOAD_BACKOFF_MS = 15 * 60 * 1000;

const FORMAT_1080_MP4 =
  "bestvideo[height=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080][ext=mp4]/best[height<=1080]";
const FORMAT_1080_ANY =
  "bestvideo[height=1080]+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080]";

let sectionDownloadsBackoffUntil = 0;

export interface ProcessedVideoPaths {
  id: string;
  downloadedPath: string;
  trimmedPath: string;
  outputPath: string;
}

function maybeDelete(path: string) {
  if (existsSync(path)) unlinkSync(path);
}

export interface ProcessVideoInput {
  url: string;
  startTime: number;
  endTime: number;
}

export function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) {
    mkdirSync(TMP_DIR, { recursive: true });
  }
}

export function cleanupFiles(...files: string[]) {
  for (const file of files) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // ignore cleanup errors
    }
  }
}

export function validateProcessInput(
  url: string | undefined,
  startTime: number | undefined,
  endTime: number | undefined
): { canonicalUrl: string; videoId: string } | { error: string; status: number } {
  if (!url || startTime === undefined || endTime === undefined) {
    return { error: "Missing required fields: url, startTime, endTime", status: 400 };
  }
  if (startTime >= endTime) {
    return { error: "Start time must be before end time", status: 400 };
  }
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    return { error: "Invalid YouTube URL", status: 400 };
  }
  return {
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
  };
}

export function validateExportSpeed(
  speed: unknown
): { speed: ExportSpeed } | { error: string; status: number } {
  const parsed = parseExportSpeed(speed ?? 1);
  if (parsed === null) {
    return { error: "Invalid speed. Use 1 (normal) or 1.5 (fast).", status: 400 };
  }
  return { speed: parsed };
}

type YtDlpAttempt = {
  label: string;
  args: string[];
};

type TimeRange = {
  startMs: number;
  endMs: number;
};

export type ProcessStage = "download" | "trim" | "speed" | "finalize";

export interface ProcessProgress {
  stage: ProcessStage;
  percent: number;
  message: string;
}

type ProgressCallback = (progress: ProcessProgress) => void;

function createAbortError(): Error {
  return new Error("Processing aborted");
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function emitProgress(
  onProgress: ProgressCallback | undefined,
  stage: ProcessStage,
  percent: number,
  message: string
) {
  onProgress?.({
    stage,
    percent: clampPercent(percent),
    message,
  });
}

function parseYtDlpPercent(output: string): number | null {
  const matches = output.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
  if (!matches) return null;
  return Number(matches[1]);
}

function buildSegmentRanges(startMs: number, endMs: number): TimeRange[] {
  const ranges: TimeRange[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const next = Math.min(cursor + DOWNLOAD_SEGMENT_MS, endMs);
    ranges.push({ startMs: cursor, endMs: next });
    cursor = next;
  }
  return ranges;
}

function createDownloadSectionArg(range: TimeRange): string {
  const start = msToFfmpegTimestamp(range.startMs);
  const end = msToFfmpegTimestamp(range.endMs);
  return `*${start}-${end}`;
}

function isLikelyHttp403(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("403 Forbidden");
}

function shouldBackOffSectionDownloads(now = Date.now()): boolean {
  return now < sectionDownloadsBackoffUntil;
}

function recordSectionDownload403(now = Date.now()) {
  sectionDownloadsBackoffUntil = now + SECTION_DOWNLOAD_BACKOFF_MS;
}

function runYtDlpAttempt(
  args: string[],
  attemptLabel: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    const onAbort = () => {
      child.kill("SIGKILL");
      reject(createAbortError());
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`yt-dlp attempt "${attemptLabel}" timed out`));
    }, YT_DLP_TIMEOUT_MS);

    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      const parsed = parseYtDlpPercent(text);
      if (parsed !== null) {
        const mapped = 2 + parsed * 0.7;
        emitProgress(
          onProgress,
          "download",
          mapped,
          `Downloading source video (${parsed.toFixed(1)}%)`
        );
      }
    };

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      const parsed = parseYtDlpPercent(text);
      if (parsed !== null) {
        const mapped = 2 + parsed * 0.7;
        emitProgress(
          onProgress,
          "download",
          mapped,
          `Downloading source video (${parsed.toFixed(1)}%)`
        );
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          stderr.trim() || stdout.trim() || `yt-dlp failed with exit code ${code ?? "unknown"}`
        )
      );
    });
  });
}

async function downloadWithFallbacks(
  canonicalUrl: string,
  outputPath: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  range?: TimeRange
): Promise<void> {
  const defaultAttempts: YtDlpAttempt[] = [
    {
      label: "1080p merged (default client)",
      args: ["-f", FORMAT_1080_ANY, "--merge-output-format", "mp4"],
    },
    {
      label: "1080p mp4 merged (default client)",
      args: ["-f", FORMAT_1080_MP4, "--merge-output-format", "mp4"],
    },
    {
      label: "1080p single-file (default client)",
      args: ["-f", "best[height<=1080][ext=mp4]/best[height<=1080]"],
    },
    {
      label: "android/web fallback (may be below 1080)",
      args: [
        "-f",
        "best[height<=1080]/best",
        "--merge-output-format",
        "mp4",
        "--extractor-args",
        "youtube:player_client=android,web",
      ],
    },
  ];
  const sectionAttempts: YtDlpAttempt[] = [
    {
      label: "1080p single-file (section)",
      args: ["-f", "best[height<=1080][ext=mp4]/best[height<=1080]"],
    },
    {
      label: "android/web single-file (section)",
      args: [
        "-f",
        "best[height<=1080][ext=mp4]/best[height<=1080]",
        "--extractor-args",
        "youtube:player_client=android,web",
      ],
    },
    {
      label: "720p fallback (section)",
      args: ["-f", "best[height<=720][ext=mp4]/best[height<=720]/best"],
    },
  ];
  const attempts = range ? sectionAttempts : defaultAttempts;

  let lastError: unknown;

  const authArgs = getYtDlpAuthArgs();
  const sectionArgs = range
    ? ["--download-sections", createDownloadSectionArg(range)]
    : [];
  const retryCount = range ? "2" : "10";
  const fragmentRetryCount = range ? "2" : "10";
  emitProgress(onProgress, "download", 2, "Preparing source download...");

  for (const attempt of attempts) {
    if (signal?.aborted) throw createAbortError();
    try {
      emitProgress(
        onProgress,
        "download",
        2,
        `Downloading (${attempt.label})...`
      );
      await runYtDlpAttempt(
        [
          ...authArgs,
          ...attempt.args,
          ...sectionArgs,
          "-o",
          outputPath,
          "--no-playlist",
          "--no-warnings",
          "--retries",
          retryCount,
          "--fragment-retries",
          fragmentRetryCount,
          "--socket-timeout",
          "30",
          "--concurrent-fragments",
          String(YT_DLP_CONCURRENT_FRAGMENTS),
          "--no-part",
          canonicalUrl,
        ],
        attempt.label,
        onProgress,
        signal
      );

      if (existsSync(outputPath)) {
        emitProgress(onProgress, "download", 72, "Source download complete");
        return;
      }
      throw new Error(`yt-dlp attempt "${attempt.label}" completed without output`);
    } catch (error) {
      lastError = error;
      logYtDlpFailure("videoPipeline.ts:downloadWithFallbacks", error, {
        attempt: attempt.label,
        url: canonicalUrl,
      });
      cleanupFiles(outputPath);
    }
  }

  const lastMessage =
    lastError instanceof Error ? lastError.message : "unknown error";
  throw new Error(
    formatYtDlpAuthHint(
      `yt-dlp failed after multiple fallback attempts. Last error: ${lastMessage}`
    )
  );
}

function trimVideo(
  inputPath: string,
  outputPath: string,
  startMs: number,
  endMs: number,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const start = msToFfmpegTimestamp(startMs);
    const durationMs = Math.max(1, endMs - startMs);
    const duration = msToFfmpegTimestamp(durationMs);
    maybeDelete(outputPath);
    emitProgress(onProgress, "trim", 74, "Trimming segment...");
    const command = ffmpeg(inputPath)
      .setStartTime(start)
      .setDuration(duration)
      .outputOptions(["-c", "copy", "-avoid_negative_ts", "make_zero"])
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .save(outputPath);
    const onAbort = () => {
      command.kill("SIGKILL");
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function concatSegments(
  segmentPaths: string[],
  outputPath: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const listPath = join(
      TMP_DIR,
      `concat_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`
    );
    const listContent = segmentPaths
      .map((segmentPath) => `file '${segmentPath.replace(/'/g, "'\\''")}'`)
      .join("\n");
    writeFileSync(listPath, listContent, "utf8");

    maybeDelete(outputPath);
    emitProgress(onProgress, "trim", 84, "Joining downloaded segments...");
    const command = ffmpeg()
      .input(listPath)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions(["-c", "copy", "-movflags", "+faststart"])
      .on("end", () => {
        cleanupFiles(listPath);
        emitProgress(onProgress, "trim", 90, "Segments joined");
        resolve();
      })
      .on("error", (err) => {
        cleanupFiles(listPath);
        reject(err);
      })
      .save(outputPath);

    const onAbort = () => {
      cleanupFiles(listPath);
      command.kill("SIGKILL");
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function probeAudioInfo(filePath: string): Promise<{ hasAudio: boolean; sampleRate: number }> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) {
        resolve({ hasAudio: false, sampleRate: 44100 });
        return;
      }
      const audio = data.streams.find((s) => s.codec_type === "audio");
      resolve({
        hasAudio: Boolean(audio),
        sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : 44100,
      });
    });
  });
}

function speedVideo(
  inputPath: string,
  outputPath: string,
  speed: number,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAbortError());
  return probeAudioInfo(inputPath).then(({ hasAudio, sampleRate }) => {
      return new Promise<void>((resolve, reject) => {
        emitProgress(onProgress, "speed", 91, "Applying speed effect...");
        let cmd = ffmpeg(inputPath).videoFilters(`setpts=PTS/${speed}`);
        if (hasAudio) {
          cmd = cmd.audioFilters(
            `asetrate=${Math.round(sampleRate * speed)},aresample=${sampleRate}`
          );
        } else {
          cmd = cmd.outputOptions("-an");
        }
        cmd
          .outputOptions(["-movflags", "+faststart", "-preset", "veryfast", "-threads", "0"])
          .on("progress", (progress) => {
            if (typeof progress.percent !== "number") return;
            const ratio = Math.min(1, Math.max(0, progress.percent / 100));
            emitProgress(onProgress, "speed", 91 + ratio * 7, "Applying speed effect...");
          })
          .on("end", () => {
            emitProgress(onProgress, "speed", 98, "Speed effect complete");
            resolve();
          })
          .on("error", (err) => reject(err))
          .save(outputPath);
        const onAbort = () => {
          cmd.kill("SIGKILL");
          reject(createAbortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    });
}

async function buildOutputFromSegments(
  segmentPaths: string[],
  spedSegmentPaths: string[],
  outputPath: string,
  speed: ExportSpeed,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  if (speed === 1) {
    if (segmentPaths.length === 1) {
      maybeDelete(outputPath);
      renameSync(segmentPaths[0], outputPath);
    } else {
      await concatSegments(segmentPaths, outputPath, onProgress, signal);
    }
    return;
  }

  for (let index = 0; index < segmentPaths.length; index += 1) {
    const segmentPath = segmentPaths[index];
    const spedPath = spedSegmentPaths[index];
    emitProgress(onProgress, "speed", 90, `Speeding segment ${index + 1}/${segmentPaths.length}...`);
    await speedVideo(
      segmentPath,
      spedPath,
      speed,
      (progress) => {
        const localRatio = Math.min(1, Math.max(0, (progress.percent - 91) / 7));
        const overallRatio = (index + localRatio) / segmentPaths.length;
        emitProgress(
          onProgress,
          "speed",
          90 + overallRatio * 9,
          `Speeding segment ${index + 1}/${segmentPaths.length}...`
        );
      },
      signal
    );
    if (!existsSync(spedPath)) {
      throw new Error(`Segment ${index + 1} speed processing failed - file not created`);
    }
  }

  if (spedSegmentPaths.length === 1) {
    maybeDelete(outputPath);
    renameSync(spedSegmentPaths[0], outputPath);
  } else {
    await concatSegments(spedSegmentPaths, outputPath, onProgress, signal);
  }
}

export function createProcessedPaths(id: string): ProcessedVideoPaths {
  return {
    id,
    downloadedPath: join(TMP_DIR, `${id}_full.mp4`),
    trimmedPath: join(TMP_DIR, `${id}_trimmed.mp4`),
    outputPath: join(TMP_DIR, `${id}_output.mp4`),
  };
}

async function downloadFullThenTrimSegments(
  canonicalUrl: string,
  paths: ProcessedVideoPaths,
  ranges: TimeRange[],
  segmentPaths: string[],
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  emitProgress(onProgress, "download", 20, "Downloading full source for reliable trimming...");
  await downloadWithFallbacks(canonicalUrl, paths.downloadedPath, onProgress, signal);
  if (!existsSync(paths.downloadedPath)) {
    throw new Error("Fallback full download failed - file not created");
  }

  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    emitProgress(onProgress, "trim", 74, `Preparing segment ${index + 1}/${ranges.length}...`);
    await trimVideo(
      paths.downloadedPath,
      segmentPaths[index],
      range.startMs,
      range.endMs,
      onProgress,
      signal
    );
    if (!existsSync(segmentPaths[index])) {
      throw new Error(`Segment ${index + 1} trim failed - file not created`);
    }
  }
}

export async function processVideoToOutputFile(
  canonicalUrl: string,
  startTime: number,
  endTime: number,
  paths: ProcessedVideoPaths,
  speed: ExportSpeed,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  emitProgress(onProgress, "download", 1, "Starting processing...");

  // When a worker is configured, offload the entire yt-dlp + ffmpeg pipeline
  // (download + trim + speed) to it so YouTube egress happens from a
  // non-datacenter IP. The worker streams back the finished clip.
  if (isWorkerEnabled()) {
    await downloadProcessedClipFromWorker(
      { url: canonicalUrl, startTime, endTime, speed },
      paths.outputPath,
      onProgress,
      signal
    );
    if (!existsSync(paths.outputPath)) {
      throw new Error("Worker did not return an output file");
    }
    emitProgress(onProgress, "finalize", 100, "Processing complete");
    return;
  }

  const ranges = buildSegmentRanges(startTime, endTime);
  const segmentPaths = ranges.map((_, index) =>
    join(TMP_DIR, `${paths.id}_segment_${String(index + 1).padStart(3, "0")}.mp4`)
  );
  const spedSegmentPaths = ranges.map((_, index) =>
    join(TMP_DIR, `${paths.id}_segment_${String(index + 1).padStart(3, "0")}_sped.mp4`)
  );

  try {
    if (shouldBackOffSectionDownloads()) {
      await downloadFullThenTrimSegments(
        canonicalUrl,
        paths,
        ranges,
        segmentPaths,
        onProgress,
        signal
      );
      await buildOutputFromSegments(
        segmentPaths,
        spedSegmentPaths,
        paths.outputPath,
        speed,
        onProgress,
        signal
      );
      return;
    }

    let sectionDownloadFailed = false;
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index];
      const segmentPath = segmentPaths[index];
      emitProgress(onProgress, "download", 2, `Downloading segment ${index + 1}/${ranges.length}...`);
      try {
        await downloadWithFallbacks(canonicalUrl, segmentPath, onProgress, signal, range);
      } catch (error) {
        if (isLikelyHttp403(error)) {
          recordSectionDownload403();
          sectionDownloadFailed = true;
          break;
        }
        throw error;
      }
      if (!existsSync(segmentPath)) {
        throw new Error(`Segment ${index + 1} download failed - file not created`);
      }
    }

    if (sectionDownloadFailed) {
      cleanupFiles(...segmentPaths);
      await downloadFullThenTrimSegments(
        canonicalUrl,
        paths,
        ranges,
        segmentPaths,
        onProgress,
        signal
      );
    }

    await buildOutputFromSegments(
      segmentPaths,
      spedSegmentPaths,
      paths.outputPath,
      speed,
      onProgress,
      signal
    );
  } finally {
    cleanupFiles(
      ...segmentPaths,
      ...spedSegmentPaths,
      paths.downloadedPath,
      paths.trimmedPath
    );
  }

  if (!existsSync(paths.outputPath)) {
    throw new Error("Output assembly failed - file not created");
  }

  emitProgress(onProgress, "finalize", 100, "Processing complete");
}

export function cleanupTmpDirectory() {
  if (!existsSync(TMP_DIR)) return;
  const files = readdirSync(TMP_DIR);
  for (const file of files) {
    cleanupFiles(join(TMP_DIR, file));
  }
}

export function getTmpFileCount(): number {
  if (!existsSync(TMP_DIR)) return 0;
  return readdirSync(TMP_DIR).length;
}
