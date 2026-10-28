"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createLiveScrubSession,
  flushLiveScrub,
  pushLiveScrub,
} from "@/app/lib/liveVideoScrub";

export interface HtmlPlayerState {
  isPlaying: boolean;
  currentTime: number;
  durationMs: number;
  volume: number;
}

export function useHtmlVideoPlayer() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const seekHoldRef = useRef<number | null>(null);
  const scrubbingRef = useRef(false);
  const scrubSessionRef = useRef(createLiveScrubSession());
  const resumeAfterScrubRef = useRef(false);
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

    let lastPublish = 0;
    const syncTime = (force = false) => {
      if (scrubbingRef.current) return;
      const ms = video.currentTime * 1000;
      const hold = seekHoldRef.current;
      if (hold != null) {
        const ahead = ms - hold;
        const caughtUp = Math.abs(ahead) <= 250 || (ahead > 0 && ahead < 700);
        if (caughtUp) {
          seekHoldRef.current = null;
        } else {
          return;
        }
      }
      const now = performance.now();
      if (!force && now - lastPublish < 32) return;
      lastPublish = now;
      const rounded = Math.round(ms);
      setState((prev) =>
        prev.currentTime === rounded ? prev : { ...prev, currentTime: rounded }
      );
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

    const onTimeUpdate = () => syncTime(false);
    const onSeeked = () => syncTime(true);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadedmetadata", syncDuration);
    video.addEventListener("durationchange", syncDuration);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onPause);

    let frame = 0;
    const tick = () => {
      if (!video.paused && !video.ended) syncTime(false);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(frame);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("seeked", onSeeked);
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
    let applied = Math.max(0, ms);
    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      applied = Math.min(applied, video.duration * 1000);
    }
    const rounded = Math.round(applied);
    setState((prev) => ({ ...prev, currentTime: rounded }));
    if (!video) return;
    if (scrubbingRef.current) {
      pushLiveScrub(video, scrubSessionRef.current, applied);
      return;
    }
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = applied / 1000;
      const readMs = video.currentTime * 1000;
      seekHoldRef.current = Math.abs(readMs - applied) <= 250 ? null : applied;
    } else {
      seekHoldRef.current = null;
    }
  }, []);

  const beginScrub = useCallback(() => {
    const video = videoRef.current;
    scrubbingRef.current = true;
    if (!video) return;
    resumeAfterScrubRef.current = !video.paused && !video.ended;
    video.pause();
  }, []);

  const endScrub = useCallback(() => {
    const video = videoRef.current;
    if (video) flushLiveScrub(video, scrubSessionRef.current);
    scrubbingRef.current = false;
    if (resumeAfterScrubRef.current && video) {
      void video.play();
    }
    resumeAfterScrubRef.current = false;
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
    seekHoldRef.current = null;
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
    beginScrub,
    endScrub,
    skip,
    setVolume,
    destroy,
  };
}
