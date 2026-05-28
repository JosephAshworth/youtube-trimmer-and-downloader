import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { extractYouTubeVideoId } from "@/lib/utils";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface YtDlpOutput {
  id: string;
  title: string;
  duration: number;
  thumbnail: string;
  uploader?: string;
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url");

  if (!url) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    return NextResponse.json({ error: "Invalid YouTube URL" }, { status: 400 });
  }

  try {
    const { stdout } = await execFileAsync(
      "yt-dlp",
      [
        "--dump-json",
        "--no-playlist",
        "--no-warnings",
        url,
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: 60000 }
    );

    const data = JSON.parse(stdout) as YtDlpOutput;

    return NextResponse.json({
      videoId: data.id,
      title: data.title,
      duration: data.duration,
      durationMs: Math.round(data.duration * 1000),
      thumbnail: data.thumbnail,
      uploader: data.uploader ?? "Unknown",
    });
  } catch (error) {
    console.error("video-info error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to fetch video info";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
