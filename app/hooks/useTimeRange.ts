"use client";

import { useCallback, useState } from "react";
import {
  clampTime,
  getMinimumGap,
  msToTimeParts,
  timePartsToMs,
  type TimeParts,
} from "@/lib/utils";

export function useTimeRange(durationMs: number) {
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(0);
  const minGap = getMinimumGap(durationMs);

  const initRange = useCallback((duration: number) => {
    setStartMs(0);
    setEndMs(duration);
  }, []);

  const setStart = useCallback(
    (ms: number) => {
      const maxStart = Math.max(endMs - minGap, 0);
      const clamped = clampTime(ms, 0, maxStart);
      setStartMs(clamped);
    },
    [endMs, minGap]
  );

  const setEnd = useCallback(
    (ms: number) => {
      const minEnd = Math.min(startMs + minGap, durationMs);
      const clamped = clampTime(ms, minEnd, durationMs);
      setEndMs(clamped);
    },
    [startMs, durationMs, minGap]
  );

  const setStartFromParts = useCallback(
    (parts: TimeParts) => {
      setStart(timePartsToMs(parts));
    },
    [setStart]
  );

  const setEndFromParts = useCallback(
    (parts: TimeParts) => {
      setEnd(timePartsToMs(parts));
    },
    [setEnd]
  );

  const startParts = msToTimeParts(startMs);
  const endParts = msToTimeParts(endMs);

  return {
    startMs,
    endMs,
    startParts,
    endParts,
    setStart,
    setEnd,
    setStartFromParts,
    setEndFromParts,
    initRange,
  };
}
