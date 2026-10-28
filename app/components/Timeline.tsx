"use client";

import { useCallback, useRef, useState } from "react";
import { formatTimeDisplay, getMinimumGap } from "@/lib/utils";

interface TimelineProps {
  durationMs: number;
  currentTimeMs: number;
  startMs: number;
  endMs: number;
  onStartChange: (ms: number) => void;
  onEndChange: (ms: number) => void;
}

type DragTarget = "start" | "end" | null;

export default function Timeline({
  durationMs,
  currentTimeMs,
  startMs,
  endMs,
  onStartChange,
  onEndChange,
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget>(null);
  const [showWarning, setShowWarning] = useState(false);
  const warningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minGap = getMinimumGap(durationMs);

  const toMs = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || durationMs <= 0) return 0;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * durationMs;
    },
    [durationMs]
  );

  const pct = (ms: number) => (durationMs > 0 ? (ms / durationMs) * 100 : 0);
  const playheadReady = durationMs > 0 && Number.isFinite(currentTimeMs);

  const flashGapWarning = () => {
    setShowWarning(true);
    if (warningTimeoutRef.current) {
      clearTimeout(warningTimeoutRef.current);
    }
    warningTimeoutRef.current = setTimeout(() => {
      setShowWarning(false);
    }, 1500);
  };

  const snapStartToPlayhead = () => {
    if (!playheadReady) return;
    const playheadMs = Math.min(Math.max(Math.round(currentTimeMs), 0), durationMs);
    const maxStart = Math.max(endMs - minGap, 0);
    const clamped = Math.min(playheadMs, maxStart);
    if (clamped !== playheadMs) flashGapWarning();
    onStartChange(clamped);
  };

  const snapEndToPlayhead = () => {
    if (!playheadReady) return;
    const playheadMs = Math.min(Math.max(Math.round(currentTimeMs), 0), durationMs);
    const minEnd = Math.min(startMs + minGap, durationMs);
    const clamped = Math.max(playheadMs, minEnd);
    if (clamped !== playheadMs) flashGapWarning();
    onEndChange(clamped);
  };

  const handlePointerDown = (target: DragTarget) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const ms = toMs(e.clientX);
    if (target === "start") {
      const clamped = Math.min(ms, endMs - minGap);
      onStartChange(clamped);
    }
    if (target === "end") {
      const clamped = Math.max(ms, startMs + minGap);
      onEndChange(clamped);
    }
    setDragTarget(target);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragTarget) return;
    const ms = toMs(e.clientX);

    if (dragTarget === "start") {
      const clamped = Math.min(ms, endMs - minGap);
      if (clamped !== ms) flashGapWarning();
      onStartChange(clamped);
    } else if (dragTarget === "end") {
      const clamped = Math.max(ms, startMs + minGap);
      if (clamped !== ms) flashGapWarning();
      onEndChange(clamped);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    setDragTarget(null);
    if ((e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div className="glass-panel p-5 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-gray-400 font-mono">
          Start: {formatTimeDisplay(startMs)}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={snapStartToPlayhead}
            disabled={!playheadReady}
            className="btn-secondary px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Set start to playhead"
          >
            Set start to playhead
          </button>
          <button
            type="button"
            onClick={snapEndToPlayhead}
            disabled={!playheadReady}
            className="btn-secondary px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Set end to playhead"
          >
            Set end to playhead
          </button>
        </div>
        <span className="text-xs text-gray-400 font-mono">
          End: {formatTimeDisplay(endMs)}
        </span>
      </div>

      <div
        ref={trackRef}
        className="relative h-12 select-none"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        role="group"
        aria-label="Trim range"
      >
        <div className="absolute top-1/2 -translate-y-1/2 w-full h-2 rounded-full bg-white/10" />

        <div
          className="absolute top-1/2 -translate-y-1/2 h-2 rounded-full pointer-events-none"
          style={{
            left: `${pct(startMs)}%`,
            width: `${pct(endMs - startMs)}%`,
            background: "linear-gradient(90deg, #00ff88 0%, #ff0040 100%)",
            opacity: 0.55,
            boxShadow: "0 0 12px rgba(0, 255, 136, 0.45), 0 0 12px rgba(255, 0, 64, 0.45)",
          }}
        />

        {/* Start marker */}
        <div
          className="timeline-marker absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-7 h-7 rounded-full cursor-grab active:cursor-grabbing z-10 border-2 border-white"
          style={{
            left: `${pct(startMs)}%`,
            background: "#00ff88",
            boxShadow: "0 0 15px rgba(0, 255, 136, 0.8)",
          }}
          onPointerDown={handlePointerDown("start")}
          role="slider"
          aria-label="Start time marker"
          aria-valuenow={startMs}
          aria-valuemin={0}
          aria-valuemax={Math.max(endMs - minGap, 0)}
        />

        {/* End marker */}
        <div
          className="timeline-marker absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-7 h-7 rounded-full cursor-grab active:cursor-grabbing z-10 border-2 border-white"
          style={{
            left: `${pct(endMs)}%`,
            background: "#ff0040",
            boxShadow: "0 0 15px rgba(255, 0, 64, 0.8)",
          }}
          onPointerDown={handlePointerDown("end")}
          role="slider"
          aria-label="End time marker"
          aria-valuenow={endMs}
          aria-valuemin={Math.min(startMs + minGap, durationMs)}
          aria-valuemax={durationMs}
        />
      </div>

      <div className="flex justify-between text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-[#00ff88]" />
          Start marker
        </span>
        <span className={showWarning ? "text-red-400" : "text-gray-400"}>
          {showWarning
            ? "Adjusted to 3s min gap"
            : "Minimum gap: 3 seconds between start and end."}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-[#ff0040]" />
          End marker
        </span>
      </div>
    </div>
  );
}
