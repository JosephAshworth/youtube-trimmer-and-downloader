"use client";

import { useEffect, useRef, useState } from "react";
import YouTube, { type YouTubeProps, type YouTubePlayer } from "react-youtube";
import VolumeControl from "./VolumeControl";
import { formatTimeDisplay } from "@/lib/utils";

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
  const timelineRef = useRef<HTMLInputElement | null>(null);
  const hoverFrameRef = useRef<number | null>(null);
  const hoverTargetRef = useRef<number>(0);
  const hoverDisplayRef = useRef<number>(0);
  const hoverActiveRef = useRef(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  const getTimelineValue = (clientX: number) => {
    if (!timelineRef.current) return 0;
    const rect = timelineRef.current.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * durationMs;
  };

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
          className="w-full h-full"
          iframeClassName="w-full h-full"
        />
      </div>

      <div className="glass-panel p-4 flex flex-col gap-3">
        {showCustomTimeline && (
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="relative">
              <input
                type="range"
                min={0}
                max={durationMs}
                value={Math.min(currentTimeMs, durationMs)}
                onChange={(e) => onSeek(Number(e.target.value))}
                onPointerDown={(e) => {
                  const targetValue = getTimelineValue(e.clientX);
                  onSeek(targetValue);
                }}
                className="w-full playback-range"
                aria-label="Playback timeline"
                ref={timelineRef}
                onPointerMove={(e) => {
                  const rect = (e.currentTarget as HTMLInputElement).getBoundingClientRect();
                  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                  hoverTargetRef.current = ratio * durationMs;
                  if (!hoverActiveRef.current) {
                    hoverActiveRef.current = true;
                    hoverDisplayRef.current = hoverTargetRef.current;
                    setHoverTime(Math.round(hoverDisplayRef.current));
                  }
                  if (hoverFrameRef.current === null) {
                    const animateHover = () => {
                      if (!hoverActiveRef.current) return;
                      const target = hoverTargetRef.current;
                      const current = hoverDisplayRef.current;
                      const diff = target - current;
                      const next = Math.abs(diff) < 0.5 ? target : current + diff * 0.2;
                      hoverDisplayRef.current = next;
                      setHoverTime(Math.round(next));
                      hoverFrameRef.current = requestAnimationFrame(animateHover);
                    };
                    hoverFrameRef.current = requestAnimationFrame(animateHover);
                  }
                }}
                onPointerLeave={() => {
                  if (hoverFrameRef.current) {
                    cancelAnimationFrame(hoverFrameRef.current);
                    hoverFrameRef.current = null;
                  }
                  hoverActiveRef.current = false;
                  setHoverTime(null);
                }}
              />
              {hoverTime !== null && (
                <div
                  className="absolute -top-8 px-2 py-1 rounded bg-black/80 text-xs text-white font-mono pointer-events-none"
                  style={{
                    left: `${Math.min(
                      100,
                      Math.max(0, (hoverTime / Math.max(durationMs, 1)) * 100)
                    )}%`,
                    transform: "translateX(-50%)",
                  }}
                >
                  {formatTimeDisplay(hoverTime)}
                  <span className="absolute left-1/2 top-full -translate-x-1/2 w-0 h-0 border-l-6 border-r-6 border-t-6 border-l-transparent border-r-transparent border-t-black/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]" />
                </div>
              )}
              </div>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSkip(-5000)}
              className="btn-secondary px-3 py-2 text-sm"
              aria-label="Skip back 5 seconds"
            >
              -5s
            </button>
            <button
              type="button"
              onClick={onTogglePlay}
              className="btn-primary px-4 py-2"
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
            <button
              type="button"
              onClick={() => onSkip(5000)}
              className="btn-secondary px-3 py-2 text-sm"
              aria-label="Skip forward 5 seconds"
            >
              +5s
            </button>
          </div>

          <div className="text-sm font-mono text-gray-300">
            <span className="text-white">{formatTimeDisplay(currentTimeMs)}</span>
            <span className="text-gray-500"> / </span>
            <span>{formatTimeDisplay(durationMs)}</span>
          </div>

          <VolumeControl volume={volume} onChange={onVolumeChange} />
        </div>
      </div>
    </div>
  );
}
