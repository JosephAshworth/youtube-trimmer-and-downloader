const express = require("express");
const { spawn, execFile } = require("child_process");
const { join } = require("path");
const { existsSync, writeFileSync, unlinkSync, mkdirSync, statSync } = require("fs");
const { v4: uuidv4 } = require("uuid");
const ffmpeg = require("fluent-ffmpeg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.YTDLP_WORKER_API_KEY || "your-secret-key";

// Ensure tmp dir exists for processing
const TMP_DIR = join(__dirname, "tmp");
if (!existsSync(TMP_DIR)) {
  mkdirSync(TMP_DIR, { recursive: true });
}

// Write cookies.txt if YT_DLP_COOKIES_B64 is provided.
// Accept either a base64 Netscape cookie file or the raw file pasted by mistake.
const COOKIES_PATH = join(__dirname, "cookies.txt");
const COOKIE_ENV = (process.env.YT_DLP_COOKIES_B64 || "").trim();
if (COOKIE_ENV) {
  try {
    const decoded = decodeCookieEnv(COOKIE_ENV);
    if (!decoded.includes("youtube.com")) {
      console.error("YT_DLP_COOKIES_B64 decoded, but the result is not a YouTube cookie file");
    } else {
      writeFileSync(COOKIES_PATH, decoded.endsWith("\n") ? decoded : decoded + "\n");
      console.log("Wrote cookies.txt from env (" + decoded.length + " bytes)");
    }
  } catch (e) {
    console.error("Failed to decode YT_DLP_COOKIES_B64:", e);
  }
} else {
  console.log("WARNING: YT_DLP_COOKIES_B64 is not set");
}

// null lets yt-dlp pick its current default. tv,web was failing the datacenter bot check
// even with cookies, because that pair is a poor match for a signed-in session.
const PLAYER_CLIENTS = [null, "android_vr", "web_safari,web", "tv_embedded"];

function decodeCookieEnv(value) {
  if (value.includes("youtube.com") && value.includes("\t")) return value;
  return Buffer.from(value.replace(/\s+/g, ""), "base64").toString("utf8");
}

function cookieState() {
  if (!existsSync(COOKIES_PATH)) return { loaded: false, bytes: 0 };
  try {
    const bytes = statSync(COOKIES_PATH).size;
    return { loaded: bytes > 0, bytes };
  } catch {
    return { loaded: false, bytes: 0 };
  }
}

function cookieStatus() {
  const cookies = cookieState();
  return cookies.loaded ? `cookies loaded (${cookies.bytes} bytes)` : "cookies not loaded";
}

function withClient(args, client) {
  if (!client) return args;
  return [...args, "--extractor-args", `youtube:player_client=${client}`];
}

function authArgs() {
  const cookies = cookieState();
  return cookies.loaded ? ["--cookies", COOKIES_PATH] : [];
}

function runYtDlp(args, timeout) {
  return new Promise((resolve) => {
    execFile(
      "yt-dlp",
      args,
      { timeout, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          error,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      }
    );
  });
}

function spawnYtDlp(args) {
  return new Promise((resolve) => {
    const child = spawn("yt-dlp", args);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => resolve({ code: 1, stderr: err.message }));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function briefYtDlpError(stderr, fallback) {
  const line = String(stderr || fallback || "yt-dlp failed")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("ERROR:"));
  return (line || "yt-dlp failed").slice(0, 300);
}

// Health check for Render wakeups
app.get("/", (req, res) => {
  res.status(200).send("YT-Dlp Worker is online");
});

// Authentication middleware
function auth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/status", auth, (req, res) => {
  const cookies = cookieState();
  res.json({ ok: true, cookiesLoaded: cookies.loaded, cookiesBytes: cookies.bytes });
});

app.post("/video-info", auth, async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  const shared = [
    ...authArgs(),
    "--skip-download",
    "--print",
    '{"id":%(id)j,"title":%(title)j,"duration":%(duration)j,"thumbnail":%(thumbnail)j,"uploader":%(uploader)j}',
    "--no-playlist",
    "--no-warnings",
  ];

  let lastError = "yt-dlp failed";
  for (const client of PLAYER_CLIENTS) {
    const args = [...withClient(shared, client), url];
    console.log("Running yt-dlp video-info", { client: client || "default", cookies: cookieStatus() });
    const result = await runYtDlp(args, 45000);
    if (result.error) {
      lastError = briefYtDlpError(result.stderr, result.error.message);
      console.error("yt-dlp video-info failed", { client: client || "default", error: lastError });
      continue;
    }

    try {
      const line = result.stdout
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith("{") && entry.endsWith("}"));
      if (!line) throw new Error("No metadata returned");
      const data = JSON.parse(line);
      return res.json({
        videoId: data.id,
        title: data.title,
        duration: data.duration,
        durationMs: Math.round(data.duration * 1000),
        thumbnail: data.thumbnail,
        uploader: data.uploader || "Unknown",
      });
    } catch (parseError) {
      lastError = parseError.message;
      console.error("Parse error:", parseError, "Stdout was:", result.stdout.slice(0, 300));
    }
  }

  return res.status(500).json({ error: `${lastError} (${cookieStatus()})` });
});

app.post("/download", auth, async (req, res) => {
  const { url, startTime, endTime, speed = 1 } = req.body;
  if (!url || startTime === undefined || endTime === undefined) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  const jobUuid = uuidv4();
  const rawDownloadPath = join(TMP_DIR, `${jobUuid}_raw.mp4`);
  const finalOutputPath = join(TMP_DIR, `${jobUuid}_final.mp4`);

  // Download section only
  const startTimestamp = msToFfmpegTimestamp(startTime * 1000);
  const endTimestamp = msToFfmpegTimestamp(endTime * 1000);

  const formatArg = "bestvideo[height<=1080][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best";
  const shared = [
    ...authArgs(),
    "-f",
    formatArg,
    "--merge-output-format",
    "mp4",
    "--download-sections",
    `*${startTimestamp}-${endTimestamp}`,
    "--force-keyframes-at-cuts",
    "-o",
    rawDownloadPath,
  ];

  let downloaded = false;
  let lastError = "yt-dlp download failed";
  for (const client of PLAYER_CLIENTS) {
    const args = [...withClient(shared, client), url];
    console.log(`Starting yt-dlp job ${jobUuid}`, { client: client || "default", cookies: cookieStatus() });
    const result = await spawnYtDlp(args);
    if (result.code === 0) {
      downloaded = true;
      break;
    }
    lastError = briefYtDlpError(result.stderr, String(result.code));
    console.error(`yt-dlp failed for job ${jobUuid}`, { client: client || "default", error: lastError });
    cleanup([rawDownloadPath]);
  }

  if (!downloaded) {
    cleanup([rawDownloadPath, finalOutputPath]);
    return res.status(500).json({ error: `${lastError} (${cookieStatus()})` });
  }

  console.log(`Download finished for job ${jobUuid}. Post-processing (speed: ${speed})...`);

    let ff = ffmpeg(rawDownloadPath);

    // Apply speed changes if necessary
    if (speed === 1.5) {
      ff = ff.videoFilters("setpts=0.66667*PTS").audioFilters("atempo=1.5");
    } else if (speed === 2) {
      ff = ff.videoFilters("setpts=0.5*PTS").audioFilters("atempo=2.0");
    }

    ff.output(finalOutputPath)
      .on("end", () => {
        console.log(`Processing complete for ${jobUuid}. Streaming file to client...`);
        res.download(finalOutputPath, "video.mp4", (err) => {
          if (err) {
            console.error("Error sending file:", err);
          }
          cleanup([rawDownloadPath, finalOutputPath]);
        });
      })
      .on("error", (err) => {
        console.error("FFmpeg error:", err);
        cleanup([rawDownloadPath, finalOutputPath]);
        if (!res.headersSent) {
          res.status(500).json({ error: "FFmpeg processing failed: " + err.message });
        }
      })
      .run();
});

function cleanup(paths) {
  paths.forEach((p) => {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch (e) {
      // ignore
    }
  });
}

function msToFfmpegTimestamp(ms) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSecs = seconds % 60;
  const milli = ms % 1000;

  const pad = (num, size = 2) => String(num).padStart(size, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(remainingSecs)}:${pad(milli, 3)}`;
}

app.listen(PORT, () => {
  console.log(`yt-dlp worker listening on port ${PORT}`);
});
