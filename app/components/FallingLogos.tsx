"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";

interface FallingLogosProps {
  color: string;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function YouTubeLogoIcon({ color, size }: { color: string; size: number }) {
  return (
    <svg
      width={size}
      height={size * 0.7}
      viewBox="0 0 90 63"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ filter: `drop-shadow(0 0 8px ${color})` }}
    >
      <rect width="90" height="63" rx="14" fill={color} opacity="0.85" />
      <path d="M36 20L58 31.5L36 43V20Z" fill="#0a0a0f" />
    </svg>
  );
}

function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function distributeDelays(count: number, maxDelay: number): number[] {
  const delays = Array.from({ length: count }, (_, i) => (i / count) * maxDelay);
  for (let i = delays.length - 1; i > 0; i -= 1) {
    const j = Math.floor(pseudoRandom(i + 1) * (i + 1));
    [delays[i], delays[j]] = [delays[j], delays[i]];
  }
  return delays;
}

export default function FallingLogos({ color }: FallingLogosProps) {
  const logos = useMemo(() => {
    const count = 18;
    const maxDelay = 12;
    const delays = distributeDelays(count, maxDelay);
    return Array.from({ length: count }, (_, i) => ({
      id: i,
      left: `${roundTo(pseudoRandom(i * 11 + 1) * 100, 4)}%`,
      size: roundTo(24 + pseudoRandom(i * 11 + 2) * 32, 4),
      duration: roundTo(8 + pseudoRandom(i * 11 + 3) * 12, 4),
      delay: roundTo(delays[i] + pseudoRandom(i * 11 + 4) * 1.2, 4),
      spinDuration: roundTo(3 + pseudoRandom(i * 11 + 5) * 4, 4),
    }));
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden z-0">
      {logos.map((logo) => (
        <motion.div
          key={logo.id}
          className="absolute falling-logo"
          style={{
            left: logo.left,
            top: "-10vh",
            animationDuration: `${logo.duration}s`,
            animationDelay: `${logo.delay}s`,
          }}
        >
          <motion.div
            className="spinning-logo"
            style={{ animationDuration: `${logo.spinDuration}s` }}
          >
            <YouTubeLogoIcon color={color} size={logo.size} />
          </motion.div>
        </motion.div>
      ))}
    </div>
  );
}
