"use client";

import { useCallback, useEffect, useState } from "react";
import FallingLogos from "./components/FallingLogos";
import ColorPicker from "./components/ColorPicker";
import YouTubeInput from "./components/YouTubeInput";
import VideoPlayer from "./components/VideoPlayer";
import Timeline from "./components/Timeline";
import TimeInputs from "./components/TimeInputs";
import PreviewPlayer from "./components/PreviewPlayer";
import { useYouTubePlayer } from "./hooks/useYouTubePlayer";
import { useTimeRange } from "./hooks/useTimeRange";
import { THEME_COLORS, type ThemeColor } from "@/lib/utils";

interface VideoInfo {
  videoId: string;
  title: string;
  durationMs: number;
  thumbnail: string;
  uploader: string;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [theme, setTheme] = useState<ThemeColor>(THEME_COLORS[3]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  const player = useYouTubePlayer();
  const timeRange = useTimeRange(videoInfo?.durationMs ?? 0);

  useEffect(() => {
    document.documentElement.style.setProperty("--accent", theme.value);
    document.documentElement.style.setProperty("--accent-glow", theme.glow);
  }, [theme]);

  const {
    destroy: destroyPlayer,
    onReady,
    onStateChange,
    togglePlay,
    skip,
    setVolume,
    seekTo,
    setDurationMs,
    state: playerState,
  } = player;

  const {
    startMs,
    endMs,
    setStart,
    setEnd,
    initRange,
  } = timeRange;

  useEffect(() => {
    if (videoInfo && playerState.durationMs > 0) {
      initRange(playerState.durationMs);
    }
  }, [videoInfo, playerState.durationMs, initRange]);

  const handleProcess = useCallback(async () => {
    if (!url.trim()) return;

    setIsLoading(true);
    setError(null);
    setIsPreviewMode(false);
    destroyPlayer();

    try {
      const res = await fetch(
        `/api/video-info?url=${encodeURIComponent(url.trim())}`
      );
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Failed to process video");
      }

      setVideoInfo({
        videoId: data.videoId,
        title: data.title,
        durationMs: data.durationMs,
        thumbnail: data.thumbnail,
        uploader: data.uploader,
      });
      initRange(data.durationMs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setVideoInfo(null);
    } finally {
      setIsLoading(false);
    }
  }, [url, destroyPlayer, initRange]);

  const handleDownload = useCallback(async () => {
    if (!videoInfo || !url.trim()) return;

    setIsDownloading(true);
    setError(null);

    try {
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          startTime: startMs,
          endTime: endMs,
          title: videoInfo.title,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Download failed");
      }

      const blob = await res.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = `${videoInfo.title.replace(/[^a-zA-Z0-9_\-\s]/g, "").trim() || "trimmed"}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setIsDownloading(false);
    }
  }, [videoInfo, url, startMs, endMs]);

  const handlePreview = useCallback(() => {
    setIsPreviewMode(true);
    seekTo(startMs);
  }, [seekTo, startMs]);

  const handleExitPreview = useCallback(() => {
    setIsPreviewMode(false);
    seekTo(startMs);
  }, [seekTo, startMs]);

  return (
    <div className="relative min-h-screen flex flex-col">
      <FallingLogos color={theme.value} />

      <div className="relative z-10 flex flex-col flex-1 max-w-5xl mx-auto w-full px-4 py-8 gap-8">
        <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold glow-text tracking-tight">
              YouTube Trimmer
            </h1>
            <p className="text-gray-400 mt-1 text-sm sm:text-base">
              Trim, preview, and download any YouTube video
            </p>
          </div>
          <ColorPicker selected={theme} onChange={setTheme} />
        </header>

        <section className="glass-panel p-6">
          <YouTubeInput
            url={url}
            onUrlChange={setUrl}
            onProcess={handleProcess}
            isLoading={isLoading}
          />
          {error && (
            <p className="mt-3 text-red-400 text-sm" role="alert">
              {error}
            </p>
          )}
        </section>

        {videoInfo && (
          <>
            <section className="glass-panel p-4">
              <h2 className="text-lg font-semibold text-white truncate">
                {videoInfo.title}
              </h2>
              <p className="text-sm text-gray-400">by {videoInfo.uploader}</p>
            </section>

            {!isPreviewMode ? (
              <>
                <VideoPlayer
                  videoId={videoInfo.videoId}
                  durationMs={playerState.durationMs || videoInfo.durationMs}
                  currentTimeMs={playerState.currentTime}
                  isPlaying={playerState.isPlaying}
                  volume={playerState.volume}
                  onReady={(e) => onReady(e.target)}
                  onStateChange={(e) => onStateChange(e)}
                  onTogglePlay={togglePlay}
                  onSkip={skip}
                  onSeek={seekTo}
                  onVolumeChange={setVolume}
                  onEndedAt={setDurationMs}
                  useNativeControls={false}
                  showCustomTimeline
                />

                <Timeline
                  durationMs={playerState.durationMs || videoInfo.durationMs}
                  currentTimeMs={playerState.currentTime}
                  startMs={startMs}
                  endMs={endMs}
                  onSeek={seekTo}
                  onStartChange={setStart}
                  onEndChange={setEnd}
                />

                <TimeInputs
                  durationMs={playerState.durationMs || videoInfo.durationMs}
                  startMs={startMs}
                  endMs={endMs}
                  onStartUpdate={setStart}
                  onEndUpdate={setEnd}
                />

                <button
                  type="button"
                  onClick={handlePreview}
                  className="btn-primary w-full py-4 text-lg"
                >
                  Preview Trimmed Section
                </button>
              </>
            ) : (
              <PreviewPlayer
                videoId={videoInfo.videoId}
                startMs={startMs}
                endMs={endMs}
                currentTimeMs={playerState.currentTime}
                isPlaying={playerState.isPlaying}
                volume={playerState.volume}
                onReady={(e) => onReady(e.target)}
                onStateChange={(e) => onStateChange(e)}
                onTogglePlay={togglePlay}
                onSkip={skip}
                onSeek={seekTo}
                onVolumeChange={setVolume}
                onExitPreview={handleExitPreview}
                onDownload={handleDownload}
                isDownloading={isDownloading}
              />
            )}
          </>
        )}

        {!videoInfo && !isLoading && (
          <section className="glass-panel p-8 text-center text-gray-400">
            <p>Paste a YouTube link above to get started.</p>
            <p className="text-sm mt-2">Works with public and unlisted videos.</p>
          </section>
        )}
      </div>
    </div>
  );
}
