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

  let body: { url?: string; startTime?: number; endTime?: number; speed?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { url, startTime, endTime, speed } = body;
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

    // #region agent log
    fetch("http://127.0.0.1:7932/ingest/0ee73f06-2d76-4a1b-8b74-1c95c424e7fc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "974ac8",
      },
      body: JSON.stringify({
        sessionId: "974ac8",
        location: "preview/route.ts:POST",
        message: "preview processed",
        data: { speed: speedResult.speed, clipMs: endTime! - startTime! },
        timestamp: Date.now(),
        hypothesisId: "H1",
        runId: "pre-fix",
      }),
    }).catch(() => {});
    // #endregion

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
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    cleanupFiles(processed.downloadedPath, processed.trimmedPath, processed.outputPath);
    console.error("preview error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to generate preview video";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
