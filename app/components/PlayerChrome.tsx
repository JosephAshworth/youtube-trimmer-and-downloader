"use client";

import PlaybackScrubber from "./PlaybackScrubber";
import VolumeControl from "./VolumeControl";
import { formatTimeDisplay } from "@/lib/utils";

interface PlayerChromeProps {
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
  seekLabel?: string;
}

export default function PlayerChrome({
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
  seekLabel = "Playback position",
}: PlayerChromeProps) {
  return (
    <div className="player-chrome absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1.5 px-3 pt-12 pb-2.5">
      <PlaybackScrubber
        durationMs={durationMs}
        currentTimeMs={currentTimeMs}
        onSeek={onSeek}
        onScrubStart={onScrubStart}
        onScrubEnd={onScrubEnd}
        ariaLabel={seekLabel}
      />
      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
        <button
          type="button"
          onClick={() => onSkip(-5000)}
          className="player-chrome-btn"
          aria-label="Skip back 5 seconds"
        >
          -5s
        </button>
        <button
          type="button"
          onClick={onTogglePlay}
          className="player-chrome-btn player-chrome-play"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={() => onSkip(5000)}
          className="player-chrome-btn"
          aria-label="Skip forward 5 seconds"
        >
          +5s
        </button>
        <div className="text-xs sm:text-sm font-mono text-white/90 tabular-nums">
          <span>{formatTimeDisplay(currentTimeMs)}</span>
          <span className="text-white/55"> / </span>
          <span className="text-white/75">{formatTimeDisplay(durationMs)}</span>
        </div>
        <div className="ml-auto">
          <VolumeControl volume={volume} onChange={onVolumeChange} variant="overlay" />
        </div>
      </div>
    </div>
  );
}
