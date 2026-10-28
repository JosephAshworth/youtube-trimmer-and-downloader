"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { YouTubePlayer as YTPlayer } from "react-youtube";

export interface PlayerState {
  isPlaying: boolean;
  isBuffering: boolean;
  currentTime: number;
  durationMs: number;
  volume: number;
  isReady: boolean;
}

export function useYouTubePlayer() {
  const playerRef = useRef<YTPlayer | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollLockRef = useRef(false);
  const seekHoldRef = useRef<{ targetMs: number; startedAt: number } | null>(null);
  const scrubbingRef = useRef(false);
  const resumeAfterScrubRef = useRef(false);
  const scrubLatestRef = useRef<number | null>(null);
  const scrubTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubSentAtRef = useRef(0);
  const [state, setState] = useState<PlayerState>({
    isPlaying: false,
    isBuffering: false,
    currentTime: 0,
    durationMs: 0,
    volume: 100,
    isReady: false,
  });

  const clearPoll = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const startPoll = useCallback(() => {
    clearPoll();
    intervalRef.current = setInterval(() => {
      if (pollLockRef.current) return;
      const player = playerRef.current;
      if (!player) return;
      pollLockRef.current = true;
      void (async () => {
        try {
          const [playerState, currentTime] = await Promise.all([
            player.getPlayerState(),
            player.getCurrentTime(),
          ]);
          const reported = (typeof currentTime === "number" ? currentTime : 0) * 1000;
          const hold = seekHoldRef.current;
          let nextTimeMs = reported;
          if (scrubbingRef.current && hold) {
            nextTimeMs = hold.targetMs;
          } else if (hold) {
            const ahead = reported - hold.targetMs;
            const expired = performance.now() - hold.startedAt > 800;
            const caughtUp =
              Math.abs(ahead) <= 250 || (ahead > 0 && ahead < 700);
            if (caughtUp || expired) {
              seekHoldRef.current = null;
              nextTimeMs = reported;
            } else {
              nextTimeMs = hold.targetMs;
            }
          }
          const isBuffering = playerState === 3;
          const isPlaying = playerState === 1 || isBuffering;
          setState((prev) => ({
            ...prev,
            currentTime: nextTimeMs,
            isPlaying,
            isBuffering,
          }));
        } catch {
          // Player may be unmounted
        } finally {
          pollLockRef.current = false;
        }
      })();
    }, 33);
  }, [clearPoll]);

  useEffect(() => {
    return () => clearPoll();
  }, [clearPoll]);

  const onReady = useCallback(
    async (player: YTPlayer) => {
      playerRef.current = player;
      let durationMs = 0;
      try {
        durationMs = (await player.getDuration()) * 1000;
      } catch {
        durationMs = 0;
      }
      setState((prev) => ({
        ...prev,
        isReady: true,
        volume: 100,
        isBuffering: false,
        durationMs: durationMs || prev.durationMs,
      }));
      startPoll();
    },
    [startPoll]
  );

  const onStateChange = useCallback(
    (event: { data: number }) => {
      const isBuffering = event.data === 3;
      const isPlaying = event.data === 1 || isBuffering;
      setState((prev) => ({ ...prev, isPlaying, isBuffering }));
      if (isPlaying) {
        startPoll();
      }
    },
    [startPoll]
  );

  const play = useCallback(async () => {
    await playerRef.current?.playVideo();
  }, []);

  const pause = useCallback(async () => {
    await playerRef.current?.pauseVideo();
  }, []);

  const togglePlay = useCallback(async () => {
    if (state.isPlaying) {
      await pause();
    } else {
      await play();
    }
  }, [state.isPlaying, play, pause]);

  const flushYouTubeScrub = useCallback((force: boolean) => {
    const player = playerRef.current;
    const targetMs = scrubLatestRef.current;
    if (!player || targetMs == null) return;
    const elapsed = performance.now() - scrubSentAtRef.current;
    if (!force && elapsed < 50) {
      if (scrubTimerRef.current == null) {
        scrubTimerRef.current = setTimeout(() => {
          scrubTimerRef.current = null;
          flushYouTubeScrub(true);
        }, 50 - elapsed);
      }
      return;
    }
    if (scrubTimerRef.current != null) {
      clearTimeout(scrubTimerRef.current);
      scrubTimerRef.current = null;
    }
    scrubLatestRef.current = null;
    scrubSentAtRef.current = performance.now();
    void player.seekTo(targetMs / 1000, true);
  }, []);

  const seekTo = useCallback(async (ms: number) => {
    const targetMs = Math.max(0, ms);
    seekHoldRef.current = { targetMs, startedAt: performance.now() };
    setState((prev) => ({ ...prev, currentTime: targetMs }));
    if (scrubbingRef.current) {
      scrubLatestRef.current = targetMs;
      flushYouTubeScrub(false);
      return;
    }
    await playerRef.current?.seekTo(targetMs / 1000, true);
  }, [flushYouTubeScrub]);

  const beginScrub = useCallback(() => {
    scrubbingRef.current = true;
    resumeAfterScrubRef.current = state.isPlaying;
    void playerRef.current?.pauseVideo();
  }, [state.isPlaying]);

  const endScrub = useCallback(() => {
    flushYouTubeScrub(true);
    scrubbingRef.current = false;
    if (resumeAfterScrubRef.current) {
      void playerRef.current?.playVideo();
    }
    resumeAfterScrubRef.current = false;
  }, [flushYouTubeScrub]);

  const skip = useCallback(
    async (deltaMs: number) => {
      const player = playerRef.current;
      if (!player) return;
      const current = (await player.getCurrentTime()) * 1000;
      await seekTo(Math.max(0, current + deltaMs));
    },
    [seekTo]
  );

  const setVolume = useCallback(async (volume: number) => {
    const clamped = Math.min(100, Math.max(0, volume));
    await playerRef.current?.setVolume(clamped);
    setState((prev) => ({ ...prev, volume: clamped }));
  }, []);

  const setDurationMs = useCallback((durationMs: number) => {
    setState((prev) => ({
      ...prev,
      durationMs: durationMs > 0 ? durationMs : prev.durationMs,
    }));
  }, []);

  const destroy = useCallback(() => {
    clearPoll();
    seekHoldRef.current = null;
    playerRef.current = null;
    setState({
      isPlaying: false,
      isBuffering: false,
      currentTime: 0,
      durationMs: 0,
      volume: 100,
      isReady: false,
    });
  }, [clearPoll]);

  return {
    playerRef,
    state,
    onReady,
    onStateChange,
    play,
    pause,
    togglePlay,
    seekTo,
    beginScrub,
    endScrub,
    skip,
    setVolume,
    setDurationMs,
    destroy,
  };
}
