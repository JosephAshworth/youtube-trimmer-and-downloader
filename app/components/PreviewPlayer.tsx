"use client";

import VideoPlayer from "./VideoPlayer";
import DownloadButton from "./DownloadButton";
import { formatTimeDisplay } from "@/lib/utils";
import type { YouTubeProps } from "react-youtube";

interface PreviewPlayerProps {
  videoId: string;
  startMs: number;
  endMs: number;
  currentTimeMs: number;
  isPlaying: boolean;
  volume: number;
  onReady: YouTubeProps["onReady"];
  onStateChange: YouTubeProps["onStateChange"];
  onTogglePlay: () => void;
  onSkip: (deltaMs: number) => void;
  onSeek: (ms: number) => void;
  onVolumeChange: (volume: number) => void;
  onExitPreview: () => void;
  onDownload: () => void;
  isDownloading: boolean;
}

export default function PreviewPlayer({
  videoId,
  startMs,
  endMs,
  currentTimeMs,
  isPlaying,
  volume,
  onReady,
  onStateChange,
  onTogglePlay,
  onSkip,
  onSeek,
  onVolumeChange,
  onExitPreview,
  onDownload,
  isDownloading,
}: PreviewPlayerProps) {
  const clipDuration = endMs - startMs;
  const clampToClip = (ms: number) => Math.min(endMs, Math.max(startMs, ms));
  const handleSeek = (ms: number) => onSeek(clampToClip(ms));
  const handleSkip = (deltaMs: number) =>
    onSeek(clampToClip(currentTimeMs + deltaMs));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold glow-text">Preview Mode</h3>
          <p className="text-sm text-gray-400">
            Playing clip: {formatTimeDisplay(startMs)} → {formatTimeDisplay(endMs)} (
            {formatTimeDisplay(clipDuration)})
          </p>
        </div>
        <button type="button" onClick={onExitPreview} className="btn-secondary">
          Exit Preview
        </button>
      </div>

      <VideoPlayer
        videoId={videoId}
        durationMs={clipDuration}
        currentTimeMs={Math.max(0, currentTimeMs - startMs)}
        isPlaying={isPlaying}
        volume={volume}
        onReady={onReady}
        onStateChange={onStateChange}
        onTogglePlay={onTogglePlay}
        onSkip={handleSkip}
        onSeek={(ms) => handleSeek(ms + startMs)}
        onVolumeChange={onVolumeChange}
        startSeconds={startMs / 1000}
        endSeconds={endMs / 1000}
        loopPreview
        useNativeControls={false}
        showCustomTimeline
        showTrimTimeOverlay
      />

      <DownloadButton onDownload={onDownload} isDownloading={isDownloading} />
    </div>
  );
}
