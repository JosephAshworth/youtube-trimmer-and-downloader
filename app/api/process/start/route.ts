import { NextRequest, NextResponse } from "next/server";
import { createProcessingJob } from "@/lib/processJobs";
import { ensureTmpDir, validateExportSpeed, validateProcessInput } from "@/lib/videoPipeline";

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
    sessionId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { url, startTime, endTime, title, speed, sessionId } = body;
  const validated = validateProcessInput(url, startTime, endTime);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: validated.status });
  }

  const speedResult = validateExportSpeed(speed);
  if ("error" in speedResult) {
    return NextResponse.json({ error: speedResult.error }, { status: speedResult.status });
  }

  const jobId = createProcessingJob({
    canonicalUrl: validated.canonicalUrl,
    startTime: startTime!,
    endTime: endTime!,
    speed: speedResult.speed,
    title,
    sessionId,
  });

  return NextResponse.json({ jobId });
}
