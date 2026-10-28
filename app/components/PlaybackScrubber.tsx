"use client";

import { useEffect, useRef, useState } from "react";
import { clampTime, formatTimeDisplay } from "@/lib/utils";

interface PlaybackScrubberProps {
  durationMs: number;
  currentTimeMs: number;
  onSeek: (ms: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  ariaLabel?: string;
}

/**
 * Seek bar driven by the pointer, not by the range input's drag gesture.
 * A controlled range only commits its value on mouseup in Chrome once React
 * writes `value` back, so the picture would stay still until release.
 */
export default function PlaybackScrubber({
  durationMs,
  currentTimeMs,
  onSeek,
  onScrubStart,
  onScrubEnd,
  ariaLabel = "Playback position",
}: PlaybackScrubberProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const onSeekRef = useRef(onSeek);
  const onScrubStartRef = useRef(onScrubStart);
  const onScrubEndRef = useRef(onScrubEnd);
  const [dragMs, setDragMs] = useState<number | null>(null);
  onSeekRef.current = onSeek;
  onScrubStartRef.current = onScrubStart;
  onScrubEndRef.current = onScrubEnd;

  const max = durationMs > 0 && Number.isFinite(durationMs) ? durationMs : 0;
  const live = Number.isFinite(currentTimeMs) ? clampTime(currentTimeMs, 0, max) : 0;
  const shown = dragMs ?? live;

  useEffect(() => {
    if (draggingRef.current || dragMs == null) return;
    if (Math.abs(live - dragMs) <= 400) setDragMs(null);
  }, [live, dragMs]);

  useEffect(() => {
    if (dragMs == null) return;
    const timeout = window.setTimeout(() => {
      if (!draggingRef.current) setDragMs(null);
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [dragMs]);

  const msFromClientX = (clientX: number) => {
    const track = trackRef.current;
    if (!track || max <= 0) return 0;
    const rect = track.getBoundingClientRect();
    const thumb = 14;
    const usable = Math.max(rect.width - thumb, 1);
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left - thumb / 2) / usable));
    return clampTime(ratio * max, 0, max);
  };

  const finishDrag = (clientX: number) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (max <= 0) {
      setDragMs(null);
      onScrubEndRef.current?.();
      return;
    }
    const ms = msFromClientX(clientX);
    setDragMs(ms);
    onSeekRef.current(ms);
    onScrubEndRef.current?.();
  };
  const finishDragRef = useRef(finishDrag);
  finishDragRef.current = finishDrag;

  useEffect(() => {
    const onPointerEnd = (event: PointerEvent) => finishDragRef.current(event.clientX);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    return () => {
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
    };
  }, []);

  const progress = max > 0 ? (shown / max) * 100 : 0;

  return (
    <div
      ref={trackRef}
      className="player-seek-hit"
      onPointerDown={(event) => {
        if (max <= 0) return;
        event.preventDefault();
        event.stopPropagation();
        draggingRef.current = true;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is only available for a real pointer.
        }
        inputRef.current?.focus();
        onScrubStartRef.current?.();
        const ms = msFromClientX(event.clientX);
        setDragMs(ms);
        onSeekRef.current(ms);
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current || max <= 0) return;
        const ms = msFromClientX(event.clientX);
        setDragMs(ms);
        onSeekRef.current(ms);
      }}
      onPointerUp={(event) => finishDrag(event.clientX)}
      onPointerCancel={(event) => finishDrag(event.clientX)}
    >
      <input
        ref={inputRef}
        type="range"
        min={0}
        max={max > 0 ? max : 1}
        step="any"
        value={max > 0 ? shown : 0}
        disabled={max <= 0}
        className="player-seek"
        style={{ ["--seek" as string]: `${progress}%`, pointerEvents: "none" }}
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={formatTimeDisplay(shown)}
        onChange={(event) => {
          if (draggingRef.current) return;
          const parsed = Number(event.currentTarget.value);
          if (!Number.isFinite(parsed)) return;
          onSeekRef.current(clampTime(parsed, 0, max));
        }}
        onBlur={() => {
          if (!draggingRef.current) setDragMs(null);
        }}
      />
    </div>
  );
}
