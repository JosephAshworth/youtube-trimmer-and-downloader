"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import DownloadButton from "./DownloadButton";
import ExportSpeedSelector from "./ExportSpeedSelector";
import LiveProgressBar from "./LiveProgressBar";
import PlayerChrome from "./PlayerChrome";
import {
  type ExportSpeed,
  formatTimeDisplay,
  getExportSpeedLabel,
} from "@/lib/utils";
import { waitForJobProgress } from "../lib/jobProgressClient";
import {
  createLiveScrubSession,
  flushLiveScrub,
  pushLiveScrub,
} from "../lib/liveVideoScrub";

interface PreviewPlayerProps {
  sourceUrl: string;
  uploadId?: string | null;
  startMs: number;
  endMs: number;
  exportSpeed: ExportSpeed;
  sessionId: string;
  resumeJobId?: string | null;
  onJobStarted?: (jobId: string) => void;
  onSettled?: () => void;
  onExportSpeedChange: (speed: ExportSpeed) => void;
  onExitPreview: () => void;
  onDownload: () => void;
  isQueueingDownload: boolean;
}

export default function PreviewPlayer({
  sourceUrl,
  uploadId = null,
  startMs,
  endMs,
  exportSpeed,
  sessionId,
  resumeJobId = null,
  onJobStarted,
  onSettled,
  onExportSpeedChange,
  onExitPreview,
  onDownload,
  isQueueingDownload,
}: PreviewPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const seekHoldRef = useRef<number | null>(null);
  const scrubbingRef = useRef(false);
  const scrubSessionRef = useRef(createLiveScrubSession());
  const resumeAfterScrubRef = useRef(false);
  // Consume the resume jobId at most once; later param changes start fresh jobs.
  const resumeJobIdRef = useRef<string | null>(resumeJobId ?? null);
  const resumeConsumedRef = useRef(false);
  // Keep latest callbacks in refs so the load effect doesn't re-run (and abort
  // an in-progress preview) just because a parent callback identity changed.
  const onJobStartedRef = useRef(onJobStarted);
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onJobStartedRef.current = onJobStarted;
    onSettledRef.current = onSettled;
  }, [onJobStarted, onSettled]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewProgress, setPreviewProgress] = useState(0);
  const [previewMessage, setPreviewMessage] = useState("Preparing preview...");
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(100);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;

    const loadPreview = async () => {
      // Only the first run after mount may re-attach to a persisted job; any
      // later run (params changed) starts a brand-new preview job.
      const resumeId = resumeConsumedRef.current ? null : resumeJobIdRef.current;
      resumeConsumedRef.current = true;

      setIsLoadingPreview(true);
      setPreviewError(null);
      setPreviewUrl(null);
      setCurrentTimeMs(0);
      setDurationMs(0);
      setIsPlaying(false);
      setPreviewProgress(1);
      setPreviewMessage(resumeId ? "Resuming preview..." : "Preparing preview...");

      try {
        let jobId: string;
        if (resumeId) {
          jobId = resumeId;
        } else {
          const startRes = await fetch("/api/process/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...(uploadId ? { uploadId } : { url: sourceUrl }),
              startTime: startMs,
              endTime: endMs,
              speed: exportSpeed,
              sessionId,
              kind: "preview",
            }),
            signal: controller.signal,
          });
          const startData = await startRes.json();
          if (!startRes.ok || !startData.jobId) {
            throw new Error(startData.error ?? "Failed to start preview");
          }
          jobId = String(startData.jobId);
          onJobStartedRef.current?.(jobId);
        }

        await waitForJobProgress(jobId, {
          signal: controller.signal,
          onProgress: (snapshot) => {
            if (!snapshot.progress) return;
            setPreviewProgress(Number(snapshot.progress.percent ?? 0));
            setPreviewMessage(String(snapshot.progress.message ?? "Processing preview..."));
          },
        });

        // Retry the file fetch: a briefly-backgrounded tab can hit transient
        // network drops right as the file becomes available.
        let res: Response | null = null;
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (controller.signal.aborted) return;
          try {
            res = await fetch(`/api/process/file/${jobId}`, {
              cache: "no-store",
              signal: controller.signal,
            });
            break;
          } catch (fetchError) {
            if (controller.signal.aborted) return;
            lastError = fetchError;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        if (!res) {
          throw new Error(
            lastError instanceof Error ? lastError.message : "Failed to load preview"
          );
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "Failed to load preview");
        }
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
        setPreviewProgress(100);
        setPreviewMessage("Preview ready");
        onSettledRef.current?.();
      } catch (err) {
        if (controller.signal.aborted) return;
        setPreviewError(
          err instanceof Error ? err.message : "Failed to load preview"
        );
        onSettledRef.current?.();
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingPreview(false);
        }
      }
    };

    loadPreview();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sourceUrl, uploadId, startMs, endMs, exportSpeed, sessionId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume / 100;
  }, [volume, previewUrl]);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const loadedMs = Math.round(video.duration * 1000);
    setDurationMs(loadedMs);
  }, []);

  const handleTogglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  }, []);

  const handleSeek = useCallback((ms: number) => {
    const video = videoRef.current;
    if (!video) return;
    const limit = durationMs > 0 ? durationMs : 0;
    const clamped = Math.min(limit || ms, Math.max(0, ms));
    setCurrentTimeMs(clamped);
    if (scrubbingRef.current) {
      pushLiveScrub(video, scrubSessionRef.current, clamped);
      return;
    }
    if (limit > 0) {
      video.currentTime = clamped / 1000;
      const readMs = video.currentTime * 1000;
      seekHoldRef.current = Math.abs(readMs - clamped) <= 250 ? null : clamped;
    }
  }, [durationMs]);

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
    if (resumeAfterScrubRef.current && video) void video.play();
    resumeAfterScrubRef.current = false;
  }, []);

  const handleSkip = useCallback(
    (deltaMs: number) => {
      const video = videoRef.current;
      const base = video ? video.currentTime * 1000 : currentTimeMs;
      handleSeek(base + deltaMs);
    },
    [currentTimeMs, handleSeek]
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !previewUrl) return;

    let frame = 0;
    let lastPublish = 0;
    const publish = (force: boolean) => {
      if (scrubbingRef.current) return;
      const ms = video.currentTime * 1000;
      const hold = seekHoldRef.current;
      if (hold != null) {
        const ahead = ms - hold;
        const caughtUp = Math.abs(ahead) <= 250 || (ahead > 0 && ahead < 700);
        if (caughtUp) seekHoldRef.current = null;
        else return;
      }
      const now = performance.now();
      if (!force && now - lastPublish < 32) return;
      lastPublish = now;
      const rounded = Math.round(ms);
      setCurrentTimeMs((prev) => (prev === rounded ? prev : rounded));
    };

    const onSeeked = () => publish(true);
    video.addEventListener("seeked", onSeeked);
    const tick = () => {
      if (!video.paused && !video.ended) publish(false);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(frame);
      video.removeEventListener("seeked", onSeeked);
    };
  }, [previewUrl]);

  const speedLabel = getExportSpeedLabel(exportSpeed);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold glow-text">Preview Mode</h3>
          <p className="text-sm text-gray-400">
            {formatTimeDisplay(startMs)} → {formatTimeDisplay(endMs)} at {speedLabel}
          </p>
        </div>
        <button type="button" onClick={onExitPreview} className="btn-secondary">
          Exit Preview
        </button>
      </div>

      <ExportSpeedSelector
        value={exportSpeed}
        onChange={onExportSpeedChange}
        disabled={isLoadingPreview}
      />

      {isLoadingPreview && (
        <LiveProgressBar
          title={`Generating Preview (${speedLabel})`}
          message={previewMessage}
          percent={previewProgress}
          active={isLoadingPreview}
        />
      )}

      {previewError && (
        <p className="text-red-400 text-sm" role="alert">
          {previewError}
        </p>
      )}

      {previewUrl && !isLoadingPreview && (
        <>
          <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-black glow-box">
            <video
              ref={videoRef}
              src={previewUrl}
              className="relative z-0 h-full w-full object-contain"
              playsInline
              onLoadedMetadata={handleLoadedMetadata}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => {
                const video = videoRef.current;
                if (!video) return;
                video.currentTime = 0;
                void video.play();
              }}
            />
            <button
              type="button"
              className="absolute inset-0 z-10 cursor-pointer border-0 bg-transparent p-0 outline-none"
              aria-label={isPlaying ? "Pause" : "Play"}
              tabIndex={-1}
              onClick={handleTogglePlay}
            />
            <PlayerChrome
              durationMs={durationMs}
              currentTimeMs={currentTimeMs}
              isPlaying={isPlaying}
              volume={volume}
              onTogglePlay={handleTogglePlay}
              onSkip={handleSkip}
              onSeek={handleSeek}
              onScrubStart={beginScrub}
              onScrubEnd={endScrub}
              onVolumeChange={setVolume}
              seekLabel="Preview playback position"
            />
          </div>
        </>
      )}

      <DownloadButton onDownload={onDownload} isDownloading={isQueueingDownload} />
    </div>
  );
}
