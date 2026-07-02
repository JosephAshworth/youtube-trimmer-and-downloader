"use client";

import { useEffect, useRef, useState } from "react";

interface LiveProgressBarProps {
  title: string;
  message: string;
  percent: number;
  active: boolean;
}

export default function LiveProgressBar({
  title,
  message,
  percent,
  active,
}: LiveProgressBarProps) {
  const [displayPercent, setDisplayPercent] = useState(0);
  const targetRef = useRef(percent);

  useEffect(() => {
    targetRef.current = Math.min(100, Math.max(0, percent));
  }, [percent]);

  useEffect(() => {
    if (!active && targetRef.current === 0) {
      setDisplayPercent(0);
      return;
    }
    const interval = setInterval(() => {
      setDisplayPercent((prev) => {
        const target = targetRef.current;
        const delta = target - prev;
        if (Math.abs(delta) < 0.2) return target;
        return prev + delta * 0.2;
      });
    }, 40);
    return () => clearInterval(interval);
  }, [active]);

  return (
    <div className="glass-panel p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-200">{title}</span>
        <span className="font-mono text-white">{Math.round(displayPercent)}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-black/40 overflow-hidden">
        <div
          className="h-full bg-[var(--accent)] transition-[width] duration-150 ease-linear"
          style={{ width: `${displayPercent}%` }}
        />
      </div>
      <p className="text-xs text-gray-400">{message}</p>
    </div>
  );
}
