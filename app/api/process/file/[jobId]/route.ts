import { NextRequest, NextResponse } from "next/server";
import { createReadStream, existsSync } from "fs";
import { cleanupJob, getCompletedJobFile, getJobSnapshot } from "@/lib/processJobs";
import { cleanupFiles, createProcessedPaths } from "@/lib/videoPipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ jobId: string }>;
}

function debugLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>
) {
  // #region agent log
  fetch("http://127.0.0.1:7932/ingest/0ee73f06-2d76-4a1b-8b74-1c95c424e7fc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "974ac8",
    },
    body: JSON.stringify({
      sessionId: "974ac8",
      runId: "pre-fix",
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

export async function GET(request: NextRequest, { params }: Params) {
  const { jobId } = await params;
  const fallbackPaths = createProcessedPaths(jobId);
  const fallbackOutputExists = existsSync(fallbackPaths.outputPath);
  const snapshot = getJobSnapshot(jobId);
  if (!snapshot) {
    if (!fallbackOutputExists) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
  }
  if (snapshot?.status === "failed") {
    return NextResponse.json(
      { error: snapshot.error ?? "Processing failed" },
      { status: 500 }
    );
  }
  if (snapshot && snapshot.status !== "completed" && !fallbackOutputExists) {
    return NextResponse.json({ error: "Job is not complete yet" }, { status: 409 });
  }

  const file =
    getCompletedJobFile(jobId) ??
    (fallbackOutputExists
      ? {
          outputPath: fallbackPaths.outputPath,
          filename: `trimmed_${jobId}.mp4`,
        }
      : null);

  if (!file) {
    debugLog("H3,H5", "process-file/route.ts:GET", "file lookup failed", {
      jobId,
      snapshotStatus: snapshot?.status ?? "missing",
      fallbackOutputExists,
    });
    return NextResponse.json({ error: "Output file not found" }, { status: 404 });
  }

  const download = request.nextUrl.searchParams.get("download") === "1";
  const stream = createReadStream(file.outputPath);
  const responseStream = new ReadableStream({
    start(controller) {
      stream.on("data", (chunk) => controller.enqueue(chunk));
      stream.on("end", () => {
        controller.close();
        cleanupJob(jobId, { cleanupRelatedVideo: download });
        cleanupFiles(
          fallbackPaths.downloadedPath,
          fallbackPaths.trimmedPath,
          fallbackPaths.outputPath
        );
      });
      stream.on("error", (err) => {
        debugLog("H3,H5", "process-file/route.ts:stream", "stream open/read failed", {
          jobId,
          outputPath: file.outputPath,
          error: err instanceof Error ? err.message.slice(0, 300) : String(err),
        });
        controller.error(err);
        cleanupJob(jobId);
        cleanupFiles(
          fallbackPaths.downloadedPath,
          fallbackPaths.trimmedPath,
          fallbackPaths.outputPath
        );
      });
    },
  });

  return new NextResponse(responseStream, {
    headers: {
      "Content-Type": "video/mp4",
      ...(download ? { "Content-Disposition": `attachment; filename="${file.filename}"` } : {}),
      "Cache-Control": "no-store",
    },
  });
}
