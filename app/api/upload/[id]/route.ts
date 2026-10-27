import { NextRequest, NextResponse } from "next/server";
import { createReadStream, statSync } from "fs";
import type { Readable } from "stream";
import { getUpload, isUploadId } from "@/lib/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

function nodeStreamToWeb(stream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      stream.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      stream.on("end", () => controller.close());
      stream.on("error", (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    },
  });
}

function parseRange(
  rangeHeader: string,
  size: number
): { start: number; end: number } | "invalid" {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || size <= 0) return "invalid";
  const startStr = match[1];
  const endStr = match[2];
  if (startStr === "" && endStr === "") return "invalid";

  if (startStr === "") {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  const start = Number(startStr);
  const end = endStr === "" ? size - 1 : Number(endStr);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= size) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}

export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!isUploadId(id)) {
    return NextResponse.json({ error: "Invalid upload" }, { status: 400 });
  }

  const upload = getUpload(id);
  if (!upload) {
    return NextResponse.json({ error: "Uploaded video not found" }, { status: 404 });
  }

  const size = statSync(upload.filePath).size;
  const rangeHeader = request.headers.get("range");
  const baseHeaders = {
    "Accept-Ranges": "bytes",
    "Content-Type": upload.mime,
    "Cache-Control": "private, no-store",
  };

  if (!rangeHeader) {
    const stream = createReadStream(upload.filePath);
    return new NextResponse(nodeStreamToWeb(stream), {
      status: 200,
      headers: {
        ...baseHeaders,
        "Content-Length": String(size),
      },
    });
  }

  const range = parseRange(rangeHeader, size);
  if (range === "invalid") {
    return new NextResponse(null, {
      status: 416,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes */${size}`,
      },
    });
  }

  const stream = createReadStream(upload.filePath, { start: range.start, end: range.end });
  return new NextResponse(nodeStreamToWeb(stream), {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      "Content-Length": String(range.end - range.start + 1),
    },
  });
}
