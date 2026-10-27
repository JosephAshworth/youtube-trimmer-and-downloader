import { NextRequest, NextResponse } from "next/server";
import { createProcessingJob } from "@/lib/processJobs";
import { getUpload, isUploadId, touchUpload } from "@/lib/uploads";
import { ensureTmpDir, validateExportSpeed, validateProcessInput } from "@/lib/videoPipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  ensureTmpDir();

  let body: {
    url?: string;
    uploadId?: string;
    startTime?: number;
    endTime?: number;
    title?: string;
    speed?: number;
    sessionId?: string;
    kind?: "preview" | "download";
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { url, uploadId, startTime, endTime, title, speed, sessionId, kind } = body;
  if (startTime === undefined || endTime === undefined) {
    return NextResponse.json(
      { error: "Missing required fields: startTime, endTime" },
      { status: 400 }
    );
  }
  if (startTime >= endTime) {
    return NextResponse.json({ error: "Start time must be before end time" }, { status: 400 });
  }

  let canonicalUrl: string;
  let localSourcePath: string | null = null;
  if (uploadId) {
    if (!isUploadId(uploadId)) {
      return NextResponse.json({ error: "Invalid upload" }, { status: 400 });
    }
    const upload = getUpload(uploadId);
    if (!upload) {
      return NextResponse.json(
        { error: "Uploaded video not found. Upload it again." },
        { status: 404 }
      );
    }
    if (endTime > upload.durationMs + 1000) {
      return NextResponse.json({ error: "End time is past the end of the video" }, { status: 400 });
    }
    touchUpload(uploadId);
    canonicalUrl = `upload:${upload.id}`;
    localSourcePath = upload.filePath;
  } else {
    const validated = validateProcessInput(url, startTime, endTime);
    if ("error" in validated) {
      return NextResponse.json({ error: validated.error }, { status: validated.status });
    }
    canonicalUrl = validated.canonicalUrl;
  }

  const speedResult = validateExportSpeed(speed);
  if ("error" in speedResult) {
    return NextResponse.json({ error: speedResult.error }, { status: speedResult.status });
  }

  const jobId = createProcessingJob({
    canonicalUrl,
    startTime: startTime!,
    endTime: endTime!,
    speed: speedResult.speed,
    title,
    sessionId,
    kind: kind === "preview" ? "preview" : "download",
    localSourcePath,
  });

  return NextResponse.json({ jobId });
}
