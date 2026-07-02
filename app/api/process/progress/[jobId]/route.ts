import { NextResponse } from "next/server";
import { getJobSnapshot } from "@/lib/processJobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ jobId: string }>;
}

export async function GET(_request: Request, { params }: Params) {
  const { jobId } = await params;
  const snapshot = getJobSnapshot(jobId);
  if (!snapshot) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  return NextResponse.json(snapshot, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
