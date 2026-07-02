import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { extractYouTubeVideoId } from "@/lib/utils";
import {
  formatYtDlpAuthHint,
  getYtDlpAuthArgs,
  logYtDlpFailure,
} from "@/lib/ytDlpAuth";
import { fetchVideoInfoFromWorker, isWorkerEnabled } from "@/lib/ytDlpWorker";

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

type VideoInfoAttempt = {
  label: string;
  args: string[];
};

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url");

  if (!url) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    return NextResponse.json({ error: "Invalid YouTube URL" }, { status: 400 });
  }

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  if (isWorkerEnabled()) {
    try {
      const info = await fetchVideoInfoFromWorker(canonicalUrl);
      return NextResponse.json(info);
    } catch (error) {
      console.error("video-info worker error:", error);
      logYtDlpFailure("video-info/route.ts:GET:worker", error, {
        url: canonicalUrl,
      });
      const message = formatYtDlpAuthHint(
        error instanceof Error ? error.message : "Failed to fetch video info"
      );
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  try {
    const authArgs = getYtDlpAuthArgs();
    const attempts: VideoInfoAttempt[] = [
      {
        label: "default client",
        args: [],
      },
      {
        label: "android/web client fallback",
        args: ["--extractor-args", "youtube:player_client=android,web"],
      },
      {
        label: "android_vr client fallback",
        args: ["--extractor-args", "youtube:player_client=android_vr,android,web"],
      },
    ];

    let lastError: unknown;
    let stdout = "";

    for (const attempt of attempts) {
      try {
        const result = await execFileAsync(
          "yt-dlp",
          [
            ...authArgs,
            ...attempt.args,
            "--dump-json",
            "--no-playlist",
            "--no-warnings",
            canonicalUrl,
          ],
          { maxBuffer: 10 * 1024 * 1024, timeout: 60000 }
        );
        stdout = result.stdout;
        break;
      } catch (error) {
        lastError = error;
        logYtDlpFailure("video-info/route.ts:GET:attempt", error, {
          url: canonicalUrl,
          attempt: attempt.label,
        });
      }
    }

    if (!stdout) {
      throw lastError ?? new Error("Failed to fetch video info");
    }

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
    logYtDlpFailure("video-info/route.ts:GET", error, { url: canonicalUrl });
    const message = formatYtDlpAuthHint(
      error instanceof Error ? error.message : "Failed to fetch video info"
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
