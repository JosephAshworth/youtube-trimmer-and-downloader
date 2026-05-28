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
  const resumeRef = useRef<{
    baseTimeMs: number;
    startedAt: number;
    active: boolean;
  }>({ baseTimeMs: 0, startedAt: 0, active: false });
  const RESUME_SMOOTH_MS = 200;
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
    intervalRef.current = setInterval(async () => {
      const player = playerRef.current;
      if (!player) return;
      try {
        const playerStatePromise = player.getPlayerState();
        const resumeState = resumeRef.current;
        let nextTimeMs: number | null = null;

        if (resumeState.active) {
          const elapsed = performance.now() - resumeState.startedAt;
          nextTimeMs = resumeState.baseTimeMs + elapsed;
          if (elapsed >= RESUME_SMOOTH_MS) {
            resumeState.active = false;
          }
        }

        if (nextTimeMs === null) {
          const currentTime = await player.getCurrentTime();
          nextTimeMs = currentTime * 1000;
        }

        setState((prev) => ({
          ...prev,
          currentTime: nextTimeMs ?? prev.currentTime,
        }));

        const playerState = await playerStatePromise;
        const isBuffering = playerState === 3;
        const isPlaying = playerState === 1 || isBuffering;
        setState((prev) => ({
          ...prev,
          isPlaying,
          isBuffering,
        }));
      } catch {
        // Player may be unmounted
      }
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
      if (isPlaying && !state.isPlaying) {
        resumeRef.current = {
          baseTimeMs: state.currentTime,
          startedAt: performance.now(),
          active: true,
        };
      }
      setState((prev) => ({ ...prev, isPlaying, isBuffering }));
      if (isPlaying) {
        startPoll();
      }
    },
    [startPoll, state.currentTime, state.isPlaying]
  );

  const play = useCallback(async () => {
    resumeRef.current = {
      baseTimeMs: state.currentTime,
      startedAt: performance.now(),
      active: true,
    };
    await playerRef.current?.playVideo();
  }, [state.currentTime]);

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

  const seekTo = useCallback(async (ms: number) => {
    resumeRef.current = {
      baseTimeMs: ms,
      startedAt: performance.now(),
      active: false,
    };
    await playerRef.current?.seekTo(ms / 1000, true);
    setState((prev) => ({ ...prev, currentTime: ms }));
  }, []);

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
    skip,
    setVolume,
    setDurationMs,
    destroy,
  };
}
