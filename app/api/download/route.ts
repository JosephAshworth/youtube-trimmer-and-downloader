import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "fs";
import { v4 as uuidv4 } from "uuid";
import {
  cleanupFiles,
  createProcessedPaths,
  ensureTmpDir,
  processVideoToOutputFile,
  validateExportSpeed,
  validateProcessInput,
} from "@/lib/videoPipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  ensureTmpDir();

  let body: {
    url?: string;
    startTime?: number;
    endTime?: number;
    title?: string;
    speed?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { url, startTime, endTime, title, speed } = body;
  const validated = validateProcessInput(url, startTime, endTime);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: validated.status });
  }

  const speedResult = validateExportSpeed(speed);
  if ("error" in speedResult) {
    return NextResponse.json({ error: speedResult.error }, { status: speedResult.status });
  }

  const id = uuidv4();
  const processed = createProcessedPaths(id);

  try {
    await processVideoToOutputFile(
      validated.canonicalUrl,
      startTime!,
      endTime!,
      processed,
      speedResult.speed
    );

    const safeTitle = (title ?? "trimmed_video")
      .replace(/[^a-zA-Z0-9_\-\s]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 80);

    const speedSuffix = speedResult.speed === 1 ? "" : "_1.5x";
    const filename = `${safeTitle || "trimmed_video"}${speedSuffix}.mp4`;

    const stream = createReadStream(processed.outputPath);
    const responseStream = new ReadableStream({
      start(controller) {
        stream.on("data", (chunk) => controller.enqueue(chunk));
        stream.on("end", () => {
          controller.close();
          cleanupFiles(
            processed.downloadedPath,
            processed.trimmedPath,
            processed.outputPath
          );
        });
        stream.on("error", (err) => {
          controller.error(err);
          cleanupFiles(
            processed.downloadedPath,
            processed.trimmedPath,
            processed.outputPath
          );
        });
      },
    });

    return new NextResponse(responseStream, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    cleanupFiles(processed.downloadedPath, processed.trimmedPath, processed.outputPath);
    console.error("download error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to download and trim video";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
