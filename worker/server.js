const express = require("express");
const { spawn, execFile } = require("child_process");
const { join } = require("path");
const { existsSync, writeFileSync, unlinkSync, mkdirSync } = require("fs");
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

// Write cookies.txt if YT_DLP_COOKIES_B64 is provided
const COOKIES_PATH = join(__dirname, "cookies.txt");
if (process.env.YT_DLP_COOKIES_B64) {
  try {
    const decoded = Buffer.from(process.env.YT_DLP_COOKIES_B64, "base64").toString("utf8");
    writeFileSync(COOKIES_PATH, decoded);
    console.log("Successfully wrote cookies.txt from base64 env var");
  } catch (e) {
    console.error("Failed to decode YT_DLP_COOKIES_B64:", e);
  }
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

app.post("/video-info", auth, (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  const args = [];
  if (existsSync(COOKIES_PATH)) {
    args.push("--cookies", COOKIES_PATH);
  }

  args.push(
    "--skip-download",
    "--print",
    '{"id":%(id)j,"title":%(title)j,"duration":%(duration)j,"thumbnail":%(thumbnail)j,"uploader":%(uploader)j}',
    "--no-playlist",
    "--no-warnings",
    url
  );

  execFile("yt-dlp", args, { timeout: 60000 }, (error, stdout, stderr) => {
    if (error) {
      console.error("yt-dlp error:", error);
      return res.status(500).json({ error: error.message || stderr });
    }

    try {
      const line = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.startsWith("{") && l.endsWith("}"));

      if (!line) {
        throw new Error("No metadata returned");
      }

      const data = JSON.parse(line);
      res.json({
        videoId: data.id,
        title: data.title,
        duration: data.duration,
        durationMs: Math.round(data.duration * 1000),
        thumbnail: data.thumbnail,
        uploader: data.uploader || "Unknown",
      });
    } catch (parseError) {
      res.status(500).json({ error: "Failed to parse metadata: " + parseError.message });
    }
  });
});

app.post("/download", auth, (req, res) => {
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
  const args = [];
  if (existsSync(COOKIES_PATH)) {
    args.push("--cookies", COOKIES_PATH);
  }

  args.push(
    "-f",
    formatArg,
    "--merge-output-format",
    "mp4",
    "--download-sections",
    `*${startTimestamp}-${endTimestamp}`,
    "--force-keyframes-at-cuts",
    "-o",
    rawDownloadPath,
    url
  );

  console.log(`Starting yt-dlp job ${jobUuid}: ${args.join(" ")}`);

  const child = spawn("yt-dlp", args);

  child.on("close", (code) => {
    if (code !== 0) {
      cleanup([rawDownloadPath, finalOutputPath]);
      return res.status(500).json({ error: `yt-dlp download failed with exit code ${code}` });
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
        res.status(500).json({ error: "FFmpeg processing failed: " + err.message });
      })
      .run();
  });
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
  return `${pad(hours)}:${pad(minutes)}:${pad(remainingSecs)}.${pad(milli, 3)}`;
}

app.listen(PORT, () => {
  console.log(`yt-dlp worker listening on port ${PORT}`);
});
