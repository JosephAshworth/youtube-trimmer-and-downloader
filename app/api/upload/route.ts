import { randomUUID } from "crypto";
import { createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { NextRequest, NextResponse } from "next/server";
import {
  ensureUploadsDir,
  finalizeUpload,
  isAllowedVideoUpload,
  MAX_UPLOAD_BYTES,
  removeUpload,
  sweepExpiredUploads,
  uploadFilePath,
} from "@/lib/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function decodeFilename(header: string | null): string {
  if (!header) return "uploaded_video";
  try {
    const decoded = decodeURIComponent(header).replace(/[\r\n]/g, "").trim();
    return decoded.slice(0, 180) || "uploaded_video";
  } catch {
    return header.replace(/[\r\n]/g, "").trim().slice(0, 180) || "uploaded_video";
  }
}

export async function POST(request: NextRequest) {
  ensureUploadsDir();
  sweepExpiredUploads();

  const contentLength = Number(request.headers.get("content-length"));
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return NextResponse.json({ error: "Missing upload size" }, { status: 400 });
  }
  if (contentLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "File is larger than 2 GB" }, { status: 413 });
  }

  const filename = decodeFilename(request.headers.get("x-filename"));
  const mime = request.headers.get("content-type") || "application/octet-stream";
  if (!isAllowedVideoUpload(filename, mime)) {
    return NextResponse.json(
      { error: "Upload a video file such as MP4, MOV, WebM, or MKV." },
      { status: 400 }
    );
  }
  if (!request.body) {
    return NextResponse.json({ error: "Empty upload" }, { status: 400 });
  }

  const id = randomUUID();
  const dest = uploadFilePath(id);

  try {
    await pipeline(
      Readable.fromWeb(request.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(dest)
    );
    const record = await finalizeUpload({ id, filename, mime });
    return NextResponse.json({
      uploadId: record.id,
      title: record.title,
      durationMs: record.durationMs,
      filename: record.filename,
      mime: record.mime,
    });
  } catch (error) {
    removeUpload(id);
    const message = error instanceof Error ? error.message : "Upload failed";
    const status = message.includes("video") || message.includes("empty") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
