"use strict";

const crypto = require("crypto");
const { createReadStream, statSync } = require("fs");
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const {
  fetchVideoInfo,
  processClip,
  cleanupTmpDirectory,
  isAgeRestrictedYtDlpError,
} = require("./lib/pipeline");

const PORT = Number(process.env.PORT || 8080);
const API_KEY = (process.env.YTDLP_WORKER_API_KEY || "").trim();

// Optional comma-separated IP allowlist (e.g. your NAT gateway EIP).
const IP_ALLOWLIST = (process.env.YTDLP_WORKER_IP_ALLOWLIST || "")
  .split(",")
  .map((ip) => ip.trim())
  .filter(Boolean);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0].trim();
  }
  return req.ip;
}

function authMiddleware(req, res, next) {
  if (IP_ALLOWLIST.length > 0) {
    const ip = clientIp(req);
    const allowed = IP_ALLOWLIST.some((entry) => ip === entry || ip.endsWith(entry));
    if (!allowed) {
      return res.status(403).json({ error: "IP not allowed" });
    }
  }

  if (!API_KEY) {
    return res
      .status(500)
      .json({ error: "Worker misconfigured: YTDLP_WORKER_API_KEY is not set" });
  }
  const provided = (req.headers["x-api-key"] || "").toString();
  if (!provided || !timingSafeEqual(provided, API_KEY)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}

function toStatusCode(error) {
  if (error && typeof error.statusCode === "number") return error.statusCode;
  return 500;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: Date.now() });
});

app.post("/video-info", authMiddleware, async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing url" });
  }
  try {
    const info = await fetchVideoInfo(url);
    return res.json(info);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch video info";
    console.error("[worker] /video-info error", message.slice(0, 500));
    return res.status(toStatusCode(error)).json({
      error: message,
      ageRestricted: isAgeRestrictedYtDlpError(message),
    });
  }
});

app.post("/download", authMiddleware, async (req, res) => {
  const { url, startTime, endTime, speed } = req.body || {};
  const id = uuidv4();

  // Bridge the HTTP connection lifetime to an AbortSignal so a client
  // disconnect kills the yt-dlp/ffmpeg work.
  const abortController = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  let finished;
  try {
    finished = await processClip({
      url,
      startTime: Number(startTime),
      endTime: Number(endTime),
      speed: Number(speed) === 1.5 ? 1.5 : 1,
      id,
      signal: abortController.signal,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to process clip";
    console.error("[worker] /download error", message.slice(0, 500));
    if (!res.headersSent) {
      res.status(toStatusCode(error)).json({
        error: message,
        ageRestricted: isAgeRestrictedYtDlpError(message),
      });
    }
    return;
  }

  const { outputPath, cleanup } = finished;
  let size = 0;
  try {
    size = statSync(outputPath).size;
  } catch {
    // ignore
  }

  res.setHeader("Content-Type", "video/mp4");
  if (size > 0) res.setHeader("Content-Length", String(size));
  res.setHeader("Cache-Control", "no-store");

  const stream = createReadStream(outputPath);
  stream.on("error", (err) => {
    console.error("[worker] stream error", err.message);
    cleanup();
    if (!res.headersSent) res.status(500).end();
    else res.destroy(err);
  });
  stream.on("close", cleanup);
  res.on("close", cleanup);
  stream.pipe(res);
});

cleanupTmpDirectory();

const server = app.listen(PORT, () => {
  console.log(`[worker] listening on :${PORT}`);
  if (!API_KEY) {
    console.warn(
      "[worker] WARNING: YTDLP_WORKER_API_KEY is not set; all authed requests will fail."
    );
  }
});

function shutdown() {
  console.log("[worker] shutting down");
  server.close(() => {
    cleanupTmpDirectory();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
