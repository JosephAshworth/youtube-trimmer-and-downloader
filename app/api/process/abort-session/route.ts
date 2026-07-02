import { NextRequest, NextResponse } from "next/server";
import { abortAllJobs, abortSessionJobs } from "@/lib/processJobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: { sessionId?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const sessionId = body.sessionId?.trim();
  if (sessionId) {
    abortSessionJobs(sessionId, "Session ended");
    return NextResponse.json({ ok: true, scope: "session" });
  }

  abortAllJobs("Session ended");
  return NextResponse.json({ ok: true, scope: "all" });
}
