import { NextResponse } from "next/server";
import { getProcessingStatus } from "@/lib/processJobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = getProcessingStatus();
  return NextResponse.json(status, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
