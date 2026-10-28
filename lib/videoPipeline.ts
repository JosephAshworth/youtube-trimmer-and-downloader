import { spawn } from "child_process";
import { existsSync, mkdirSync, unlinkSync, renameSync, readdirSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
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
import { tryFastLocalExport, tryFastRangeExport } from "@/lib/rangedClip";

export const TMP_DIR = join(process.cwd(), "tmp");
const YT_DLP_TIMEOUT_MS = 300000;
const YT_DLP_CONCURRENT_FRAGMENTS = 24;
const YT_DLP_HTTP_CHUNK_SIZE = "8M";
const SECTION_DOWNLOAD_CONCURRENCY = 2;
// One section covers a short clip. Longer clips are split into larger pieces so
// each yt-dlp process still finishes inside the timeout, without a cut every 3 minutes.
const DOWNLOAD_SEGMENT_MS = 10 * 60 * 1000;
const SECTION_DOWNLOAD_BACKOFF_MS = 15 * 60 * 1000;

// YouTube's "best" mp4 is often AV1. Copied into an MP4 it plays audio and a blank picture
// in QuickTime and many other players, so keep H.264 video and AAC audio.
const FORMAT_1080_H264 =
  "bestvideo[height<=1080][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=1080][vcodec^=avc1][acodec^=mp4a]/best[height<=1080][vcodec^=avc1]";
const FORMAT_720_H264 =
  "bestvideo[height<=720][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=720][vcodec^=avc1][acodec^=mp4a]/best[height<=720][vcodec^=avc1]";

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

function cleanupDownloadArtifacts(outputPath: string) {
  cleanupFiles(outputPath, `${outputPath}.part`, `${outputPath}.ytdl`);
  const dir = dirname(outputPath);
  const stem = basename(outputPath).replace(/\.[^.]+$/, "");
  const prefix = `${stem}.`;
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (file.startsWith(prefix)) cleanupFiles(join(dir, file));
  }
}

function linkAbortSignal(parent?: AbortSignal): {
  signal: AbortSignal;
  abort: () => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    cleanup: () => parent?.removeEventListener("abort", onAbort),
  };
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
  return /403:?\s*Forbidden/i.test(error.message);
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
  range?: TimeRange,
  mode: "default" | "android-web-1080" = "default"
): Promise<void> {
  const defaultAttempts: YtDlpAttempt[] = [
    {
      label: "1080p h264 (default client)",
      args: ["-f", FORMAT_1080_H264, "--merge-output-format", "mp4"],
    },
    {
      label: "1080p h264 (android/web)",
      args: [
        "-f",
        FORMAT_1080_H264,
        "--merge-output-format",
        "mp4",
        "--extractor-args",
        "youtube:player_client=android,web",
      ],
    },
    {
      label: "720p h264 fallback",
      args: ["-f", FORMAT_720_H264, "--merge-output-format", "mp4"],
    },
  ];
  const sectionAttempts: YtDlpAttempt[] = [
    {
      label: "1080p h264 (section)",
      args: ["-f", FORMAT_1080_H264, "--merge-output-format", "mp4"],
    },
    {
      label: "android/web h264 (section)",
      args: [
        "-f",
        FORMAT_1080_H264,
        "--merge-output-format",
        "mp4",
        "--extractor-args",
        "youtube:player_client=android,web",
      ],
    },
    {
      label: "720p h264 fallback (section)",
      args: ["-f", FORMAT_720_H264, "--merge-output-format", "mp4"],
    },
  ];
  const androidWebSectionRetry: YtDlpAttempt = {
    label: "android/web h264 (section retry)",
    args: [
      "-f",
      FORMAT_1080_H264,
      "--merge-output-format",
      "mp4",
      "--extractor-args",
      "youtube:player_client=android,web",
    ],
  };
  const attempts =
    range && mode === "android-web-1080"
      ? [androidWebSectionRetry]
      : range
        ? sectionAttempts
        : defaultAttempts;

  let lastError: unknown;

  const authArgs = getYtDlpAuthArgs();
  const sectionArgs = range
    ? [
        "--download-sections",
        createDownloadSectionArg(range),
        // Progressive formats make ffmpeg open the googlevideo URL itself, which
        // YouTube rejects with 403. These headers cover that path if it is used.
        "--downloader-args",
        'ffmpeg_i:-user_agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" -referer https://www.youtube.com/',
      ]
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
          "--http-chunk-size",
          YT_DLP_HTTP_CHUNK_SIZE,
          "--concurrent-fragments",
          String(YT_DLP_CONCURRENT_FRAGMENTS),
          "--throttled-rate",
          "100K",
          // Section downloads keep .part files so a failed fragment can resume.
          // Full downloads still write straight to the destination.
          ...(range ? [] : ["--no-part"]),
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
      cleanupDownloadArtifacts(outputPath);
      if (signal?.aborted || isProcessingAborted(error)) throw error;
      lastError = error;
      const willRetry = attempt !== attempts[attempts.length - 1];
      logYtDlpFailure("videoPipeline.ts:downloadWithFallbacks", error, {
        attempt: attempt.label,
        url: canonicalUrl,
        willRetry,
      });
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

async function downloadOneSection(
  canonicalUrl: string,
  outputPath: string,
  range: TimeRange,
  onProgress: ProgressCallback | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  try {
    await downloadWithFallbacks(canonicalUrl, outputPath, onProgress, signal, range);
  } catch (error) {
    if (signal?.aborted || !isLikelyHttp403(error)) throw error;
    // Same 1080p H.264 format, one fresh client, before giving up on sections.
    await downloadWithFallbacks(
      canonicalUrl,
      outputPath,
      onProgress,
      signal,
      range,
      "android-web-1080"
    );
  }
}

async function downloadSectionRanges(
  canonicalUrl: string,
  ranges: TimeRange[],
  segmentPaths: string[],
  onProgress: ProgressCallback | undefined,
  signal?: AbortSignal
): Promise<"ok" | "unavailable"> {
  const linked = linkAbortSignal(signal);
  let nextIndex = 0;
  let unavailable = false;
  let failure: unknown = null;

  const fail = (error: unknown) => {
    if (failure === null) failure = error;
    linked.abort();
  };

  const worker = async () => {
    while (!unavailable && failure === null && !linked.signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= ranges.length) return;

      const segmentOnProgress: ProgressCallback = (progress) => {
        if (ranges.length === 1) {
          onProgress?.(progress);
          return;
        }
        onProgress?.({
          ...progress,
          message: `Segment ${index + 1}/${ranges.length}: ${progress.message}`,
        });
      };

      try {
        emitProgress(
          segmentOnProgress,
          "download",
          2,
          `Downloading segment ${index + 1}/${ranges.length}...`
        );
        await downloadOneSection(
          canonicalUrl,
          segmentPaths[index],
          ranges[index],
          segmentOnProgress,
          linked.signal
        );
        if (!existsSync(segmentPaths[index])) {
          throw new Error(`Segment ${index + 1} download failed - file not created`);
        }
      } catch (error) {
        if (isLikelyHttp403(error)) {
          unavailable = true;
          linked.abort();
          return;
        }
        if (linked.signal.aborted && (unavailable || signal?.aborted)) {
          if (signal?.aborted) fail(createAbortError());
          return;
        }
        fail(error);
        return;
      }
    }
  };

  try {
    const workerCount = Math.min(SECTION_DOWNLOAD_CONCURRENCY, ranges.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    linked.cleanup();
  }

  if (signal?.aborted) throw createAbortError();
  if (failure) throw failure;
  if (unavailable) {
    recordSectionDownload403();
    return "unavailable";
  }
  return "ok";
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
        let cmd = ffmpeg(inputPath)
          .videoCodec("libx264")
          .videoFilters(`setpts=(PTS-STARTPTS)/${speed}`);
        if (hasAudio) {
          cmd = cmd.audioFilters(
            `asetrate=${Math.round(sampleRate * speed)},aresample=${sampleRate},asetpts=PTS-STARTPTS`
          );
        } else {
          cmd = cmd.outputOptions("-an");
        }
        cmd
          .outputOptions([
            "-movflags",
            "+faststart",
            "-preset",
            "superfast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-threads",
            "0",
          ])
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

function isProcessingAborted(error: unknown): boolean {
  return error instanceof Error && error.message === "Processing aborted";
}

function trimUploadedClip(
  inputPath: string,
  outputPath: string,
  startMs: number,
  endMs: number,
  progressCap: number,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  return probeAudioInfo(inputPath).then(({ hasAudio }) => {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }
      const start = msToFfmpegTimestamp(startMs);
      const duration = msToFfmpegTimestamp(Math.max(1, endMs - startMs));
      maybeDelete(outputPath);
      emitProgress(onProgress, "trim", 8, "Trimming uploaded video...");
      let command = ffmpeg(inputPath)
        .setStartTime(start)
        .setDuration(duration)
        .videoCodec("libx264")
        .outputOptions([
          "-preset",
          "veryfast",
          "-crf",
          "20",
          "-pix_fmt",
          "yuv420p",
          "-threads",
          "0",
          "-movflags",
          "+faststart",
        ]);
      if (hasAudio) {
        command = command.audioCodec("aac").outputOptions(["-b:a", "192k"]);
      } else {
        command = command.outputOptions("-an");
      }
      command
        .on("progress", (progress) => {
          if (typeof progress.percent !== "number") return;
          const ratio = Math.min(1, Math.max(0, progress.percent / 100));
          emitProgress(
            onProgress,
            "trim",
            8 + ratio * (progressCap - 8),
            "Trimming uploaded video..."
          );
        })
        .on("end", () => resolve())
        .on("error", (err) => reject(err))
        .save(outputPath);
      const onAbort = () => {
        command.kill("SIGKILL");
        reject(createAbortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  });
}

async function processLocalUpload(
  localSourcePath: string,
  startTime: number,
  endTime: number,
  paths: ProcessedVideoPaths,
  speed: ExportSpeed,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  if (!existsSync(localSourcePath)) {
    throw new Error("Uploaded video is no longer available. Upload it again.");
  }

  emitProgress(onProgress, "trim", 2, "Preparing uploaded video...");
  const segmentPath = join(TMP_DIR, `${paths.id}_segment_001.mp4`);
  try {
    const fastLocal = await tryFastLocalExport({
      sourcePath: localSourcePath,
      outputPath: paths.outputPath,
      startMs: startTime,
      endMs: endTime,
      speed,
      signal,
      onProgress: (stage, percent, message) => emitProgress(onProgress, stage, percent, message),
    });
    if (fastLocal) {
      if (!existsSync(paths.outputPath)) {
        throw new Error("Output assembly failed - file not created");
      }
      emitProgress(onProgress, "finalize", 100, "Processing complete");
      return;
    }

    if (speed === 1) {
      await trimUploadedClip(
        localSourcePath,
        paths.outputPath,
        startTime,
        endTime,
        98,
        onProgress,
        signal
      );
    } else {
      await trimUploadedClip(
        localSourcePath,
        segmentPath,
        startTime,
        endTime,
        88,
        onProgress,
        signal
      );
      if (!existsSync(segmentPath)) {
        throw new Error("Trim failed - file not created");
      }
      maybeDelete(paths.outputPath);
      await speedVideo(segmentPath, paths.outputPath, speed, onProgress, signal);
    }
  } catch (error) {
    if (!isProcessingAborted(error)) {
      cleanupFiles(segmentPath, paths.outputPath);
    }
    throw error;
  } finally {
    cleanupFiles(segmentPath, paths.downloadedPath, paths.trimmedPath);
  }

  if (!existsSync(paths.outputPath)) {
    throw new Error("Output assembly failed - file not created");
  }
  emitProgress(onProgress, "finalize", 100, "Processing complete");
}

export async function processVideoToOutputFile(
  canonicalUrl: string,
  startTime: number,
  endTime: number,
  paths: ProcessedVideoPaths,
  speed: ExportSpeed,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  localSourcePath?: string | null
): Promise<void> {
  if (localSourcePath) {
    await processLocalUpload(
      localSourcePath,
      startTime,
      endTime,
      paths,
      speed,
      onProgress,
      signal
    );
    return;
  }

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

  const fast = await tryFastRangeExport({
    canonicalUrl,
    startMs: startTime,
    endMs: endTime,
    speed,
    outputPath: paths.outputPath,
    tmpDir: TMP_DIR,
    id: paths.id,
    formatAttempts: [
      { label: "1080p h264", args: ["-f", FORMAT_1080_H264] },
      {
        label: "1080p h264 (android/web)",
        args: [
          "-f",
          FORMAT_1080_H264,
          "--extractor-args",
          "youtube:player_client=android,web",
        ],
      },
      { label: "720p h264", args: ["-f", FORMAT_720_H264] },
    ],
    signal,
    onProgress: (stage, percent, message) => emitProgress(onProgress, stage, percent, message),
  });
  if (fast) {
    if (!existsSync(paths.outputPath)) {
      throw new Error("Output assembly failed - file not created");
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

    const sectionResult = await downloadSectionRanges(
      canonicalUrl,
      ranges,
      segmentPaths,
      onProgress,
      signal
    );

    if (sectionResult === "unavailable") {
      for (const segmentPath of segmentPaths) cleanupDownloadArtifacts(segmentPath);
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
    for (const segmentPath of segmentPaths) cleanupDownloadArtifacts(segmentPath);
    cleanupFiles(...spedSegmentPaths, paths.downloadedPath, paths.trimmedPath);
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
