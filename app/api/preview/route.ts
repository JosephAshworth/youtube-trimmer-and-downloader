import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "fs";
import { v4 as uuidv4 } from "uuid";
import {
  cleanupFiles,
  createProcessedPaths,
  ensureTmpDir,
  processVideoToSpedFile,
  validateProcessInput,
} from "@/lib/videoPipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  ensureTmpDir();

  let body: { url?: string; startTime?: number; endTime?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { url, startTime, endTime } = body;
  const validated = validateProcessInput(url, startTime, endTime);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: validated.status });
  }

  const id = uuidv4();
  const processed = createProcessedPaths(id);

  try {
    await processVideoToSpedFile(
      validated.canonicalUrl,
      startTime!,
      endTime!,
      processed
    );

    const stream = createReadStream(processed.spedPath);
    const responseStream = new ReadableStream({
      start(controller) {
        stream.on("data", (chunk) => controller.enqueue(chunk));
        stream.on("end", () => {
          controller.close();
          cleanupFiles(
            processed.downloadedPath,
            processed.trimmedPath,
            processed.spedPath
          );
        });
        stream.on("error", (err) => {
          controller.error(err);
          cleanupFiles(
            processed.downloadedPath,
            processed.trimmedPath,
            processed.spedPath
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
    cleanupFiles(processed.downloadedPath, processed.trimmedPath, processed.spedPath);
    console.error("preview error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to generate preview video";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
