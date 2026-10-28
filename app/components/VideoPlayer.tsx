"use client";

import { useEffect, useRef } from "react";
import YouTube, { type YouTubeProps, type YouTubePlayer } from "react-youtube";
import PlayerChrome from "./PlayerChrome";

interface VideoPlayerProps {
  videoId: string;
  durationMs: number;
  currentTimeMs: number;
  isPlaying: boolean;
  volume: number;
  onReady: YouTubeProps["onReady"];
  onStateChange: YouTubeProps["onStateChange"];
  onTogglePlay: () => void;
  onSkip: (deltaMs: number) => void;
  onSeek: (ms: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  onVolumeChange: (volume: number) => void;
  onEndedAt?: (ms: number) => void;
  startSeconds?: number;
  endSeconds?: number;
  loopPreview?: boolean;
  onPreviewEnd?: () => void;
  useNativeControls?: boolean;
  showCustomTimeline?: boolean;
}

export default function VideoPlayer({
  videoId,
  durationMs,
  currentTimeMs,
  isPlaying,
  volume,
  onReady,
  onStateChange,
  onTogglePlay,
  onSkip,
  onSeek,
  onScrubStart,
  onScrubEnd,
  onVolumeChange,
  onEndedAt,
  startSeconds,
  endSeconds,
  loopPreview = false,
  onPreviewEnd,
  useNativeControls = true,
  showCustomTimeline = true,
}: VideoPlayerProps) {
  const playerRef = useRef<YouTubePlayer | null>(null);

  const opts: YouTubeProps["opts"] = {
    height: "100%",
    width: "100%",
    playerVars: {
      autoplay: 0,
      controls: useNativeControls ? 1 : 0,
      modestbranding: 1,
      rel: 0,
      ...(startSeconds !== undefined ? { start: Math.floor(startSeconds) } : {}),
      ...(endSeconds !== undefined ? { end: Math.ceil(endSeconds) } : {}),
    },
  };

  const handleReady: YouTubeProps["onReady"] = (event) => {
    playerRef.current = event.target;
    onReady?.(event);
  };

  const handleStateChange: YouTubeProps["onStateChange"] = (event) => {
    if (loopPreview && event.data === 0 && startSeconds !== undefined) {
      event.target.seekTo(startSeconds, true);
      event.target.playVideo();
    }
    if (event.data === 0 && endSeconds !== undefined && onPreviewEnd) {
      onPreviewEnd();
    }
    if (event.data === 0 && endSeconds === undefined && onEndedAt) {
      const timeValue = event.target.getCurrentTime();
      const time = typeof timeValue === "number" ? timeValue : 0;
      onEndedAt(time * 1000);
    }
    onStateChange?.(event);
  };

  useEffect(() => {
    if (playerRef.current && startSeconds !== undefined) {
      playerRef.current.seekTo(startSeconds, true);
    }
  }, [startSeconds, endSeconds, videoId]);

  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-black youtube-container glow-box">
        <YouTube
          videoId={videoId}
          opts={opts}
          onReady={handleReady}
          onStateChange={handleStateChange}
          className="absolute inset-0 z-0 h-full w-full"
          iframeClassName="h-full w-full"
        />
        {showCustomTimeline && (
          <>
            <button
              type="button"
              className="absolute inset-0 z-10 cursor-pointer border-0 bg-transparent p-0 outline-none"
              aria-label={isPlaying ? "Pause" : "Play"}
              tabIndex={-1}
              onClick={onTogglePlay}
            />
            <PlayerChrome
              durationMs={durationMs}
              currentTimeMs={currentTimeMs}
              isPlaying={isPlaying}
              volume={volume}
              onTogglePlay={onTogglePlay}
              onSkip={onSkip}
              onSeek={onSeek}
              onScrubStart={onScrubStart}
              onScrubEnd={onScrubEnd}
              onVolumeChange={onVolumeChange}
            />
          </>
        )}
      </div>
    </div>
  );
}
