import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, unlinkSync, copyFileSync } from "fs";
import { join } from "path";
import ffmpeg from "fluent-ffmpeg";
import {
  type ExportSpeed,
  extractYouTubeVideoId,
  msToFfmpegTimestamp,
  parseExportSpeed,
} from "@/lib/utils";

const execFileAsync = promisify(execFile);

export const TMP_DIR = join(process.cwd(), "tmp");
const YT_DLP_TIMEOUT_MS = 300000;

const FORMAT_1080_MP4 =
  "bestvideo[height=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080][ext=mp4]/best[height<=1080]";
const FORMAT_1080_ANY =
  "bestvideo[height=1080]+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080]";

export interface ProcessedVideoPaths {
  id: string;
  downloadedPath: string;
  trimmedPath: string;
  outputPath: string;
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

async function downloadWithFallbacks(
  canonicalUrl: string,
  outputPath: string
): Promise<void> {
  const attempts: YtDlpAttempt[] = [
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

  let lastError: unknown;

  for (const attempt of attempts) {
    try {
      await execFileAsync(
        "yt-dlp",
        [
          ...attempt.args,
          "-o",
          outputPath,
          "--no-playlist",
          "--no-warnings",
          "--retries",
          "10",
          "--fragment-retries",
          "10",
          "--socket-timeout",
          "30",
          "--no-part",
          canonicalUrl,
        ],
        { maxBuffer: 50 * 1024 * 1024, timeout: YT_DLP_TIMEOUT_MS }
      );

      if (existsSync(outputPath)) return;
      throw new Error(`yt-dlp attempt "${attempt.label}" completed without output`);
    } catch (error) {
      lastError = error;
      cleanupFiles(outputPath);
    }
  }

  throw lastError instanceof Error
    ? new Error(
        `yt-dlp failed after multiple fallback attempts. Last error: ${lastError.message}`
      )
    : new Error("yt-dlp failed after multiple fallback attempts");
}

function trimVideo(
  inputPath: string,
  outputPath: string,
  startMs: number,
  endMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = msToFfmpegTimestamp(startMs);
    const duration = msToFfmpegTimestamp(endMs - startMs);

    ffmpeg(inputPath)
      .setStartTime(start)
      .setDuration(duration)
      .outputOptions(["-c", "copy", "-avoid_negative_ts", "make_zero"])
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .save(outputPath);
  });
}

function probeHasAudio(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(data.streams.some((s) => s.codec_type === "audio"));
    });
  });
}

function probeAudioSampleRate(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) {
        resolve(44100);
        return;
      }
      const audio = data.streams.find((s) => s.codec_type === "audio");
      resolve(audio?.sample_rate ? Number(audio.sample_rate) : 44100);
    });
  });
}

function speedVideo(
  inputPath: string,
  outputPath: string,
  speed: number
): Promise<void> {
  return Promise.all([probeHasAudio(inputPath), probeAudioSampleRate(inputPath)]).then(
    ([hasAudio, sampleRate]) => {
      return new Promise<void>((resolve, reject) => {
        let cmd = ffmpeg(inputPath).videoFilters(`setpts=PTS/${speed}`);
        if (hasAudio) {
          cmd = cmd.audioFilters(
            `asetrate=${Math.round(sampleRate * speed)},aresample=${sampleRate}`
          );
        } else {
          cmd = cmd.outputOptions("-an");
        }
        cmd
          .outputOptions(["-movflags", "+faststart"])
          .on("end", () => resolve())
          .on("error", (err) => reject(err))
          .save(outputPath);
      });
    }
  );
}

export function createProcessedPaths(id: string): ProcessedVideoPaths {
  return {
    id,
    downloadedPath: join(TMP_DIR, `${id}_full.mp4`),
    trimmedPath: join(TMP_DIR, `${id}_trimmed.mp4`),
    outputPath: join(TMP_DIR, `${id}_output.mp4`),
  };
}

export async function processVideoToOutputFile(
  canonicalUrl: string,
  startTime: number,
  endTime: number,
  paths: ProcessedVideoPaths,
  speed: ExportSpeed
): Promise<void> {
  await downloadWithFallbacks(canonicalUrl, paths.downloadedPath);
  if (!existsSync(paths.downloadedPath)) {
    throw new Error("Download failed - file not created");
  }

  await trimVideo(paths.downloadedPath, paths.trimmedPath, startTime, endTime);
  if (!existsSync(paths.trimmedPath)) {
    throw new Error("Trim failed - output file not created");
  }

  if (speed === 1) {
    copyFileSync(paths.trimmedPath, paths.outputPath);
  } else {
    await speedVideo(paths.trimmedPath, paths.outputPath, speed);
  }

  if (!existsSync(paths.outputPath)) {
    throw new Error("Output file not created");
  }
}
