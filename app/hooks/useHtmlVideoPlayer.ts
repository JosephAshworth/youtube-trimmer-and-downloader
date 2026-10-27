"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface HtmlPlayerState {
  isPlaying: boolean;
  currentTime: number;
  durationMs: number;
  volume: number;
}

export function useHtmlVideoPlayer() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [node, setNode] = useState<HTMLVideoElement | null>(null);
  const [state, setState] = useState<HtmlPlayerState>({
    isPlaying: false,
    currentTime: 0,
    durationMs: 0,
    volume: 100,
  });

  const setVideoNode = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    setNode(element);
  }, []);

  useEffect(() => {
    const video = node;
    if (!video) return;

    const syncTime = () => {
      setState((prev) => ({
        ...prev,
        currentTime: Math.round(video.currentTime * 1000),
      }));
    };
    const syncDuration = () => {
      const durationMs = Number.isFinite(video.duration)
        ? Math.round(video.duration * 1000)
        : 0;
      setState((prev) => ({
        ...prev,
        durationMs: durationMs > 0 ? durationMs : prev.durationMs,
      }));
    };
    const onPlay = () => setState((prev) => ({ ...prev, isPlaying: true }));
    const onPause = () => setState((prev) => ({ ...prev, isPlaying: false }));

    video.addEventListener("timeupdate", syncTime);
    video.addEventListener("seeked", syncTime);
    video.addEventListener("loadedmetadata", syncDuration);
    video.addEventListener("durationchange", syncDuration);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onPause);

    let frame = 0;
    const tick = () => {
      if (!video.paused && !video.ended) syncTime();
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(frame);
      video.removeEventListener("timeupdate", syncTime);
      video.removeEventListener("seeked", syncTime);
      video.removeEventListener("loadedmetadata", syncDuration);
      video.removeEventListener("durationchange", syncDuration);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onPause);
    };
  }, [node]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = state.volume / 100;
  }, [state.volume, node]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  }, []);

  const seekTo = useCallback((ms: number) => {
    const video = videoRef.current;
    const clamped = Math.max(0, ms);
    if (video && Number.isFinite(video.duration)) {
      video.currentTime = Math.min(clamped, video.duration * 1000) / 1000;
    }
    setState((prev) => ({ ...prev, currentTime: clamped }));
  }, []);

  const skip = useCallback(
    (deltaMs: number) => {
      const video = videoRef.current;
      const current = video ? video.currentTime * 1000 : 0;
      seekTo(Math.max(0, current + deltaMs));
    },
    [seekTo]
  );

  const setVolume = useCallback((volume: number) => {
    const clamped = Math.min(100, Math.max(0, volume));
    setState((prev) => ({ ...prev, volume: clamped }));
  }, []);

  const destroy = useCallback(() => {
    const video = videoRef.current;
    if (video) video.pause();
    setState({
      isPlaying: false,
      currentTime: 0,
      durationMs: 0,
      volume: 100,
    });
  }, []);

  return {
    state,
    setVideoNode,
    togglePlay,
    seekTo,
    skip,
    setVolume,
    destroy,
  };
}
