"use client";

import { useState } from "react";
import PlayerChrome from "./PlayerChrome";

interface LocalVideoPlayerProps {
  src: string;
  durationMs: number;
  currentTimeMs: number;
  isPlaying: boolean;
  volume: number;
  onTogglePlay: () => void;
  onSkip: (deltaMs: number) => void;
  onSeek: (ms: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
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
  onScrubStart,
  onScrubEnd,
  onVolumeChange,
  videoRef,
}: LocalVideoPlayerProps) {
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-black glow-box">
        <video
          ref={videoRef}
          src={src}
          className="relative z-0 h-full w-full object-contain"
          playsInline
          preload="metadata"
          onError={() =>
            setPlaybackError(
              "This file can't be previewed in the browser. You can still set the trim times and export it."
            )
          }
          onLoadedData={() => setPlaybackError(null)}
        />
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
      </div>
      {playbackError && (
        <p className="text-amber-300 text-sm" role="status">
          {playbackError}
        </p>
      )}
    </div>
  );
}
