import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { createReadStream, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import ffmpeg from "fluent-ffmpeg";
import { extractYouTubeVideoId, msToFfmpegTimestamp } from "@/lib/utils";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TMP_DIR = join(process.cwd(), "tmp");
const YT_DLP_TIMEOUT_MS = 300000;

function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) {
    mkdirSync(TMP_DIR, { recursive: true });
  }
}

function cleanup(...files: string[]) {
  for (const file of files) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // ignore cleanup errors
    }
  }
}

type YtDlpAttempt = {
  label: string;
  args: string[];
};

async function downloadWithFallbacks(
  canonicalUrl: string,
  outputPath: string
): Promise<void> {
  const attempts: YtDlpAttempt[] = [
    {
      label: "mp4 merged (android/web client)",
      args: [
        "-f",
        "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format",
        "mp4",
        "--extractor-args",
        "youtube:player_client=android,web",
      ],
    },
    {
      label: "single-file best mp4",
      args: ["-f", "best[ext=mp4]/best"],
    },
    {
      label: "generic best merged",
      args: [
        "-f",
        "bv*+ba/b",
        "--merge-output-format",
        "mp4",
        "--extractor-args",
        "youtube:player_client=android,web",
      ],
    },
  ];

  let lastError: unknown;

  for (const attempt of attempts) {
    try {
      await execFileAsync(
        "yt-dlp",
        [
          ...attempt.args,
          "-o",
          outputPath,
          "--no-playlist",
          "--no-warnings",
          "--retries",
          "10",
          "--fragment-retries",
          "10",
          "--socket-timeout",
          "30",
          "--no-part",
          canonicalUrl,
        ],
        { maxBuffer: 50 * 1024 * 1024, timeout: YT_DLP_TIMEOUT_MS }
      );

      if (existsSync(outputPath)) return;
      throw new Error(`yt-dlp attempt "${attempt.label}" completed without output`);
    } catch (error) {
      lastError = error;
      cleanup(outputPath);
    }
  }

  throw lastError instanceof Error
    ? new Error(
        `yt-dlp failed after multiple fallback attempts. Last error: ${lastError.message}`
      )
    : new Error("yt-dlp failed after multiple fallback attempts");
}

function trimVideo(
  inputPath: string,
  outputPath: string,
  startMs: number,
  endMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = msToFfmpegTimestamp(startMs);
    const duration = msToFfmpegTimestamp(endMs - startMs);

    ffmpeg(inputPath)
      .setStartTime(start)
      .setDuration(duration)
      .outputOptions(["-c", "copy", "-avoid_negative_ts", "make_zero"])
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .save(outputPath);
  });
}

export async function POST(request: NextRequest) {
  ensureTmpDir();

  let body: { url?: string; startTime?: number; endTime?: number; title?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { url, startTime, endTime, title } = body;

  if (!url || startTime === undefined || endTime === undefined) {
    return NextResponse.json(
      { error: "Missing required fields: url, startTime, endTime" },
      { status: 400 }
    );
  }

  if (startTime >= endTime) {
    return NextResponse.json(
      { error: "Start time must be before end time" },
      { status: 400 }
    );
  }

  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    return NextResponse.json({ error: "Invalid YouTube URL" }, { status: 400 });
  }
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const id = uuidv4();
  const downloadedPath = join(TMP_DIR, `${id}_full.mp4`);
  const trimmedPath = join(TMP_DIR, `${id}_trimmed.mp4`);

  try {
    await downloadWithFallbacks(canonicalUrl, downloadedPath);

    if (!existsSync(downloadedPath)) {
      throw new Error("Download failed - file not created");
    }

    await trimVideo(downloadedPath, trimmedPath, startTime, endTime);

    if (!existsSync(trimmedPath)) {
      throw new Error("Trim failed - output file not created");
    }

    const safeTitle = (title ?? "trimmed_video")
      .replace(/[^a-zA-Z0-9_\-\s]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 80);

    const filename = `${safeTitle || "trimmed_video"}.mp4`;

    const stream = createReadStream(trimmedPath);
    const responseStream = new ReadableStream({
      start(controller) {
        stream.on("data", (chunk) => controller.enqueue(chunk));
        stream.on("end", () => {
          controller.close();
          cleanup(downloadedPath, trimmedPath);
        });
        stream.on("error", (err) => {
          controller.error(err);
          cleanup(downloadedPath, trimmedPath);
        });
      },
    });

    return new NextResponse(responseStream, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    cleanup(downloadedPath, trimmedPath);
    console.error("download error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to download and trim video";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
