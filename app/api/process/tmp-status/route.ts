import { NextResponse } from "next/server";
import { getTmpFileCount } from "@/lib/videoPipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const count = getTmpFileCount();
  return NextResponse.json(
    {
      empty: count === 0,
      fileCount: count,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
