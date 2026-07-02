"use strict";

const { spawn } = require("child_process");
const {
  existsSync,
  mkdirSync,
  unlinkSync,
  copyFileSync,
  readdirSync,
} = require("fs");
const { join } = require("path");
const os = require("os");
const ffmpeg = require("fluent-ffmpeg");

const TMP_DIR = join(os.tmpdir(), "ytdlp-worker");
const YT_DLP_TIMEOUT_MS = 300000;

const FORMAT_1080_MP4 =
  "bestvideo[height=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080][ext=mp4]/best[height<=1080]";
const FORMAT_1080_ANY =
  "bestvideo[height=1080]+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080]";

const YT_DLP_BIN = process.env.YT_DLP_BIN || "yt-dlp";

function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) {
    mkdirSync(TMP_DIR, { recursive: true });
  }
}

function cleanupFiles(...files) {
  for (const file of files) {
    try {
      if (file && existsSync(file)) unlinkSync(file);
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Extra yt-dlp argv for authentication (cookies) and anti-bot mitigation
 * (residential proxy). This is the whole reason the worker exists: it runs on a
 * non-datacenter IP path and can additionally tunnel through a proxy.
 */
function getYtDlpAuthArgs() {
  const args = [];

  const cookiesFile =
    process.env.YT_DLP_COOKIES_FILE && process.env.YT_DLP_COOKIES_FILE.trim();
  const cookiesBrowser =
    process.env.YT_DLP_COOKIES_FROM_BROWSER &&
    process.env.YT_DLP_COOKIES_FROM_BROWSER.trim();

  if (cookiesFile) {
    if (!existsSync(cookiesFile)) {
      throw new Error(
        `YT_DLP_COOKIES_FILE is set but file not found: ${cookiesFile}`
      );
    }
    args.push("--cookies", cookiesFile);
  } else if (cookiesBrowser) {
    args.push("--cookies-from-browser", cookiesBrowser);
  }

  const proxy = process.env.YT_DLP_PROXY && process.env.YT_DLP_PROXY.trim();
  if (proxy) {
    args.push("--proxy", proxy);
  }

  return args;
}

function isAgeRestrictedYtDlpError(message) {
  return (
    message.includes("Sign in to confirm your age") ||
    message.includes("confirm you're not a bot") ||
    message.includes("confirm you\u2019re not a bot")
  );
}

function extractYouTubeVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

function canonicalYouTubeUrl(url) {
  const id = extractYouTubeVideoId(url);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

function msToFfmpegTimestamp(ms) {
  const totalMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const milliseconds = totalMs % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(
    milliseconds,
    3
  )}`;
}

function runYtDlpAttempt(args, attemptLabel, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";

    const onAbort = () => {
      child.kill("SIGKILL");
      reject(new Error("Processing aborted"));
    };
    if (signal && signal.aborted) {
      onAbort();
      return;
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`yt-dlp attempt "${attemptLabel}" timed out`));
    }, YT_DLP_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          stderr.trim() ||
            stdout.trim() ||
            `yt-dlp failed with exit code ${code == null ? "unknown" : code}`
        )
      );
    });
  });
}

async function fetchVideoInfo(rawUrl) {
  const canonicalUrl = canonicalYouTubeUrl(rawUrl);
  if (!canonicalUrl) {
    const err = new Error("Invalid YouTube URL");
    err.statusCode = 400;
    throw err;
  }

  const authArgs = getYtDlpAuthArgs();
  const attempts = [
    { label: "default client", args: [] },
    {
      label: "android/web client fallback",
      args: ["--extractor-args", "youtube:player_client=android,web"],
    },
    {
      label: "android_vr client fallback",
      args: [
        "--extractor-args",
        "youtube:player_client=android_vr,android,web",
      ],
    },
  ];

  let lastError;
  let stdout = "";
  for (const attempt of attempts) {
    try {
      const result = await runYtDlpAttempt(
        [
          ...authArgs,
          ...attempt.args,
          "--dump-json",
          "--no-playlist",
          "--no-warnings",
          canonicalUrl,
        ],
        attempt.label
      );
      stdout = result.stdout;
      if (stdout) break;
    } catch (error) {
      lastError = error;
      console.warn("[worker] video-info attempt failed", {
        attempt: attempt.label,
        error: String(error.message || error).slice(0, 300),
      });
    }
  }

  if (!stdout) {
    throw lastError || new Error("Failed to fetch video info");
  }

  const data = JSON.parse(stdout);
  return {
    videoId: data.id,
    title: data.title,
    duration: data.duration,
    durationMs: Math.round((data.duration || 0) * 1000),
    thumbnail: data.thumbnail,
    uploader: data.uploader || "Unknown",
  };
}

async function downloadWithFallbacks(canonicalUrl, outputPath, signal) {
  const attempts = [
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

  let lastError;
  const authArgs = getYtDlpAuthArgs();

  for (const attempt of attempts) {
    if (signal && signal.aborted) throw new Error("Processing aborted");
    try {
      await runYtDlpAttempt(
        [
          ...authArgs,
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
        attempt.label,
        signal
      );
      if (existsSync(outputPath)) return;
      throw new Error(
        `yt-dlp attempt "${attempt.label}" completed without output`
      );
    } catch (error) {
      lastError = error;
      console.warn("[worker] download attempt failed", {
        attempt: attempt.label,
        error: String(error.message || error).slice(0, 300),
      });
      cleanupFiles(outputPath);
    }
  }

  const lastMessage =
    lastError instanceof Error ? lastError.message : "unknown error";
  throw new Error(
    `yt-dlp failed after multiple fallback attempts. Last error: ${lastMessage}`
  );
}

function trimVideo(inputPath, outputPath, startMs, endMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error("Processing aborted"));
      return;
    }
    const start = msToFfmpegTimestamp(startMs);
    const duration = msToFfmpegTimestamp(endMs - startMs);

    const command = ffmpeg(inputPath)
      .setStartTime(start)
      .setDuration(duration)
      .outputOptions(["-c", "copy", "-avoid_negative_ts", "make_zero"])
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .save(outputPath);

    const onAbort = () => {
      command.kill("SIGKILL");
      reject(new Error("Processing aborted"));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function probeHasAudio(filePath) {
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

function probeAudioSampleRate(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) {
        resolve(44100);
        return;
      }
      const audio = data.streams.find((s) => s.codec_type === "audio");
      resolve(audio && audio.sample_rate ? Number(audio.sample_rate) : 44100);
    });
  });
}

async function speedVideo(inputPath, outputPath, speed, signal) {
  if (signal && signal.aborted) throw new Error("Processing aborted");
  const [hasAudio, sampleRate] = await Promise.all([
    probeHasAudio(inputPath),
    probeAudioSampleRate(inputPath),
  ]);

  return new Promise((resolve, reject) => {
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

    const onAbort = () => {
      cmd.kill("SIGKILL");
      reject(new Error("Processing aborted"));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Download + trim + (optional) speed. Returns the path to the finished file.
 * Caller is responsible for streaming it back and calling cleanup().
 */
async function processClip({ url, startTime, endTime, speed, id, signal }) {
  const canonicalUrl = canonicalYouTubeUrl(url);
  if (!canonicalUrl) {
    const err = new Error("Invalid YouTube URL");
    err.statusCode = 400;
    throw err;
  }
  if (
    typeof startTime !== "number" ||
    typeof endTime !== "number" ||
    startTime >= endTime
  ) {
    const err = new Error("Start time must be before end time");
    err.statusCode = 400;
    throw err;
  }
  const effectiveSpeed = speed === 1.5 ? 1.5 : 1;

  ensureTmpDir();
  const downloadedPath = join(TMP_DIR, `${id}_full.mp4`);
  const trimmedPath = join(TMP_DIR, `${id}_trimmed.mp4`);
  const outputPath = join(TMP_DIR, `${id}_output.mp4`);

  const cleanup = () => cleanupFiles(downloadedPath, trimmedPath, outputPath);

  try {
    await downloadWithFallbacks(canonicalUrl, downloadedPath, signal);
    if (!existsSync(downloadedPath)) {
      throw new Error("Download failed - file not created");
    }

    await trimVideo(downloadedPath, trimmedPath, startTime, endTime, signal);
    if (!existsSync(trimmedPath)) {
      throw new Error("Trim failed - output file not created");
    }

    if (effectiveSpeed === 1) {
      if (signal && signal.aborted) throw new Error("Processing aborted");
      copyFileSync(trimmedPath, outputPath);
    } else {
      await speedVideo(trimmedPath, outputPath, effectiveSpeed, signal);
    }

    if (!existsSync(outputPath)) {
      throw new Error("Output file not created");
    }

    return { outputPath, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function cleanupTmpDirectory() {
  if (!existsSync(TMP_DIR)) return;
  for (const file of readdirSync(TMP_DIR)) {
    cleanupFiles(join(TMP_DIR, file));
  }
}

module.exports = {
  TMP_DIR,
  ensureTmpDir,
  cleanupTmpDirectory,
  fetchVideoInfo,
  processClip,
  isAgeRestrictedYtDlpError,
  extractYouTubeVideoId,
  canonicalYouTubeUrl,
};
