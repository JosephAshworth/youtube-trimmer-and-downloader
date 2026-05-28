export interface TimeParts {
  hours: number;
  minutes: number;
  seconds: number;
  milliseconds: number;
}

export function msToTimeParts(ms: number): TimeParts {
  const totalMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const milliseconds = totalMs % 1000;

  return { hours, minutes, seconds, milliseconds };
}

export function timePartsToMs(parts: TimeParts): number {
  return (
    parts.hours * 3600000 +
    parts.minutes * 60000 +
    parts.seconds * 1000 +
    parts.milliseconds
  );
}

export function formatTimeDisplay(ms: number): string {
  const { hours, minutes, seconds, milliseconds } = msToTimeParts(ms);
  const pad = (n: number, len = 2) => n.toString().padStart(len, "0");
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(milliseconds, 3)}`;
  }
  return `${minutes}:${pad(seconds)}.${pad(milliseconds, 3)}`;
}

export function clampTime(ms: number, min: number, max: number): number {
  return Math.min(Math.max(ms, min), max);
}

export const MIN_GAP_MS = 3000;

export function getMinimumGap(durationMs: number): number {
  return Math.min(MIN_GAP_MS, Math.max(0, durationMs));
}

export function extractYouTubeVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function msToFfmpegTimestamp(ms: number): string {
  const { hours, minutes, seconds, milliseconds } = msToTimeParts(ms);
  const pad = (n: number, len = 2) => n.toString().padStart(len, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(milliseconds, 3)}`;
}

export function range(start: number, end: number): number[] {
  const result: number[] = [];
  for (let i = start; i <= end; i++) {
    result.push(i);
  }
  return result;
}

export const THEME_COLORS = [
  { name: "Red", value: "#ff0040", glow: "rgba(255, 0, 64, 0.6)" },
  { name: "Orange", value: "#ff6600", glow: "rgba(255, 102, 0, 0.6)" },
  { name: "Yellow", value: "#ffcc00", glow: "rgba(255, 204, 0, 0.6)" },
  { name: "Green", value: "#00ff88", glow: "rgba(0, 255, 136, 0.6)" },
  { name: "Blue", value: "#0088ff", glow: "rgba(0, 136, 255, 0.6)" },
  { name: "Purple", value: "#aa44ff", glow: "rgba(170, 68, 255, 0.6)" },
  { name: "Pink", value: "#ff44aa", glow: "rgba(255, 68, 170, 0.6)" },
] as const;

export type ThemeColor = (typeof THEME_COLORS)[number];
