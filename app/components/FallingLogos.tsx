"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

interface FallingLogosProps {
  color: string;
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

function distributeDelays(count: number, maxDelay: number): number[] {
  const delays = Array.from({ length: count }, (_, i) => (i / count) * maxDelay);
  for (let i = delays.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [delays[i], delays[j]] = [delays[j], delays[i]];
  }
  return delays;
}

export default function FallingLogos({ color }: FallingLogosProps) {
  const [logos, setLogos] = useState<
    Array<{
      id: number;
      left: string;
      size: number;
      duration: number;
      delay: number;
      spinDuration: number;
    }>
  >([]);
  const [offsetX, setOffsetX] = useState(0);
  const targetOffsetRef = useRef(0);
  const currentOffsetRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const count = 18;
    const maxDelay = 12;
    const delays = distributeDelays(count, maxDelay);
    const nextLogos = Array.from({ length: count }, (_, i) => ({
      id: i,
      left: `${Math.random() * 100}%`,
      size: 24 + Math.random() * 32,
      duration: 8 + Math.random() * 12,
      delay: delays[i] + Math.random() * 1.2,
      spinDuration: 3 + Math.random() * 4,
    }));
    setLogos(nextLogos);
  }, []);

  useEffect(() => {
    const isFinePointer =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(pointer: fine)").matches;

    if (!isFinePointer) return;

    const handlePointerMove = (event: PointerEvent) => {
      const ratio = event.clientX / Math.max(1, window.innerWidth);
      targetOffsetRef.current = (ratio - 0.5) * 55;
    };

    const animate = () => {
      const current = currentOffsetRef.current;
      const target = targetOffsetRef.current;
      const next = current + (target - current) * 0.08;
      currentOffsetRef.current = next;
      setOffsetX(next);
      rafRef.current = requestAnimationFrame(animate);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div
      className="pointer-events-none fixed inset-0 overflow-hidden z-0"
      style={{ transform: `translateX(${offsetX}px)` }}
    >
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
