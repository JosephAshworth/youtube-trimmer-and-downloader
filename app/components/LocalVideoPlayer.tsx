"use client";

import { useRef, useState } from "react";
import VolumeControl from "./VolumeControl";
import { formatTimeDisplay } from "@/lib/utils";

interface LocalVideoPlayerProps {
  src: string;
  durationMs: number;
  currentTimeMs: number;
  isPlaying: boolean;
  volume: number;
  onTogglePlay: () => void;
  onSkip: (deltaMs: number) => void;
  onSeek: (ms: number) => void;
  onVolumeChange: (volume: number) => void;
  videoRef: (element: HTMLVideoElement | null) => void;
}

export default function LocalVideoPlayer({
  src,
  durationMs,
  currentTimeMs,
  isPlaying,
  volume,
  onTogglePlay,
  onSkip,
  onSeek,
  onVolumeChange,
  videoRef,
}: LocalVideoPlayerProps) {
  const timelineRef = useRef<HTMLInputElement | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  const getTimelineValue = (clientX: number) => {
    if (!timelineRef.current || durationMs <= 0) return 0;
    const rect = timelineRef.current.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * durationMs;
  };

  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-black glow-box">
        <video
          ref={videoRef}
          src={src}
          className="w-full h-full"
          playsInline
          preload="metadata"
          onError={() =>
            setPlaybackError(
              "This file can't be previewed in the browser. You can still set the trim times and export it."
            )
          }
          onLoadedData={() => setPlaybackError(null)}
        />
      </div>
      {playbackError && (
        <p className="text-amber-300 text-sm" role="status">
          {playbackError}
        </p>
      )}

      <div className="glass-panel p-4 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <input
              type="range"
              min={0}
              max={durationMs || 1}
              value={Math.min(currentTimeMs, durationMs || 0)}
              onChange={(e) => onSeek(Number(e.target.value))}
              onPointerDown={(e) => onSeek(getTimelineValue(e.clientX))}
              className="w-full playback-range"
              aria-label="Playback timeline"
              ref={timelineRef}
            />
          </div>
        </div>
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
