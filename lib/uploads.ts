import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import ffmpeg from "fluent-ffmpeg";

export const UPLOADS_DIR = join(process.cwd(), "uploads");
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;

const ALLOWED_EXTENSIONS = new Set([
  "mp4",
  "m4v",
  "webm",
  "mov",
  "mkv",
  "avi",
  "mpeg",
  "mpg",
  "wmv",
  "flv",
  "3gp",
  "ogv",
  "ts",
  "m2ts",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  "3gp": "video/3gpp",
  ogv: "video/ogg",
  ts: "video/mp2t",
  m2ts: "video/mp2t",
};

export interface UploadRecord {
  id: string;
  filePath: string;
  filename: string;
  title: string;
  mime: string;
  durationMs: number;
  createdAt: number;
}

interface UploadMeta {
  filename: string;
  title: string;
  mime: string;
  durationMs: number;
  createdAt: number;
}

export function ensureUploadsDir() {
  if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

export function isUploadId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export function uploadFilePath(id: string): string {
  return join(UPLOADS_DIR, id);
}

function uploadMetaPath(id: string): string {
  return join(UPLOADS_DIR, `${id}.json`);
}

export function fileExtension(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function isAllowedVideoUpload(filename: string, mime: string): boolean {
  if (ALLOWED_EXTENSIONS.has(fileExtension(filename))) return true;
  return mime.toLowerCase().startsWith("video/");
}

export function playbackMime(filename: string, mime: string): string {
  const fromExt = MIME_BY_EXTENSION[fileExtension(filename)];
  if (fromExt) return fromExt;
  if (mime.toLowerCase().startsWith("video/")) return mime.split(";")[0].trim();
  return "application/octet-stream";
}

function titleFromFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const withoutExt = base.replace(/\.[^.]+$/, "").trim();
  return withoutExt || "Uploaded video";
}

function probeDurationMs(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) {
        reject(new Error("Could not read that file as a video."));
        return;
      }
      const hasVideo = data.streams.some((stream) => stream.codec_type === "video");
      const durationSec = data.format.duration;
      if (
        !hasVideo ||
        typeof durationSec !== "number" ||
        !Number.isFinite(durationSec) ||
        durationSec <= 0
      ) {
        reject(new Error("That file does not contain a video track."));
        return;
      }
      resolve(Math.round(durationSec * 1000));
    });
  });
}

export async function finalizeUpload(input: {
  id: string;
  filename: string;
  mime: string;
}): Promise<UploadRecord> {
  const filePath = uploadFilePath(input.id);
  if (!existsSync(filePath)) {
    throw new Error("Upload did not finish writing.");
  }
  const size = statSync(filePath).size;
  if (size <= 0) {
    throw new Error("The uploaded file is empty.");
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw new Error("File is larger than 2 GB.");
  }

  const durationMs = await probeDurationMs(filePath);
  const createdAt = Date.now();
  const meta: UploadMeta = {
    filename: input.filename,
    title: titleFromFilename(input.filename),
    mime: playbackMime(input.filename, input.mime),
    durationMs,
    createdAt,
  };
  writeFileSync(uploadMetaPath(input.id), JSON.stringify(meta), "utf8");
  return {
    id: input.id,
    filePath,
    filename: meta.filename,
    title: meta.title,
    mime: meta.mime,
    durationMs: meta.durationMs,
    createdAt,
  };
}

export function getUpload(id: string): UploadRecord | null {
  if (!isUploadId(id)) return null;
  const filePath = uploadFilePath(id);
  const metaPath = uploadMetaPath(id);
  if (!existsSync(filePath) || !existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<UploadMeta>;
    if (
      typeof meta.filename !== "string" ||
      typeof meta.title !== "string" ||
      typeof meta.mime !== "string" ||
      typeof meta.durationMs !== "number" ||
      typeof meta.createdAt !== "number"
    ) {
      return null;
    }
    return {
      id,
      filePath,
      filename: meta.filename,
      title: meta.title,
      mime: meta.mime,
      durationMs: meta.durationMs,
      createdAt: meta.createdAt,
    };
  } catch {
    return null;
  }
}

export function touchUpload(id: string) {
  const record = getUpload(id);
  if (!record) return;
  const now = new Date();
  try {
    utimesSync(record.filePath, now, now);
    utimesSync(uploadMetaPath(id), now, now);
  } catch {
    // ignore touch errors
  }
}

export function removeUpload(id: string) {
  if (!isUploadId(id)) return;
  for (const path of [uploadFilePath(id), uploadMetaPath(id)]) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // ignore cleanup errors
    }
  }
}

export function sweepExpiredUploads(now = Date.now()) {
  if (!existsSync(UPLOADS_DIR)) return;
  for (const entry of readdirSync(UPLOADS_DIR)) {
    const id = entry.endsWith(".json") ? entry.slice(0, -5) : entry;
    if (!isUploadId(id)) continue;
    const path = join(UPLOADS_DIR, entry);
    try {
      const stats = statSync(path);
      if (now - stats.mtimeMs > UPLOAD_TTL_MS) {
        removeUpload(id);
      }
    } catch {
      // ignore files that disappear mid-scan
    }
  }
}
