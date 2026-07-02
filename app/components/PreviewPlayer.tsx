"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import DownloadButton from "./DownloadButton";
import ExportSpeedSelector from "./ExportSpeedSelector";
import LiveProgressBar from "./LiveProgressBar";
import VolumeControl from "./VolumeControl";
import {
  type ExportSpeed,
  formatTimeDisplay,
  getExportSpeedLabel,
} from "@/lib/utils";
import { waitForJobProgress } from "../lib/jobProgressClient";

interface PreviewPlayerProps {
  sourceUrl: string;
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
  const timelineRef = useRef<HTMLInputElement | null>(null);
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
              url: sourceUrl,
              startTime: startMs,
              endTime: endMs,
              speed: exportSpeed,
              sessionId,
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
  }, [sourceUrl, startMs, endMs, exportSpeed, sessionId]);

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

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTimeMs(Math.round(video.currentTime * 1000));
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
    const clamped = Math.min(durationMs, Math.max(0, ms));
    video.currentTime = clamped / 1000;
    setCurrentTimeMs(clamped);
  }, [durationMs]);

  const handleSkip = useCallback(
    (deltaMs: number) => {
      handleSeek(currentTimeMs + deltaMs);
    },
    [currentTimeMs, handleSeek]
  );

  const getTimelineValue = (clientX: number) => {
    if (!timelineRef.current || durationMs <= 0) return 0;
    const rect = timelineRef.current.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * durationMs;
  };

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
        disabled={isLoadingPreview || isQueueingDownload}
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
              className="w-full h-full"
              playsInline
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => {
                const video = videoRef.current;
                if (!video) return;
                video.currentTime = 0;
                void video.play();
              }}
            />
          </div>

          <div className="glass-panel p-4 flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <input
                  type="range"
                  min={0}
                  max={durationMs || 1}
                  value={Math.min(currentTimeMs, durationMs || 0)}
                  onChange={(e) => handleSeek(Number(e.target.value))}
                  onPointerDown={(e) => handleSeek(getTimelineValue(e.clientX))}
                  className="w-full playback-range"
                  aria-label="Preview playback timeline"
                  ref={timelineRef}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleSkip(-5000)}
                  className="btn-secondary px-3 py-2 text-sm"
                  aria-label="Skip back 5 seconds"
                >
                  -5s
                </button>
                <button
                  type="button"
                  onClick={handleTogglePlay}
                  className="btn-primary px-4 py-2"
                  aria-label={isPlaying ? "Pause" : "Play"}
                >
                  {isPlaying ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                    </svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => handleSkip(5000)}
                  className="btn-secondary px-3 py-2 text-sm"
                  aria-label="Skip forward 5 seconds"
                >
                  +5s
                </button>
              </div>

              <div className="text-sm font-mono text-gray-300">
                <span className="text-white">{formatTimeDisplay(currentTimeMs)}</span>
                <span className="text-gray-500"> / </span>
                <span>{formatTimeDisplay(durationMs)}</span>
              </div>

              <VolumeControl volume={volume} onChange={setVolume} />
            </div>
          </div>
        </>
      )}

      <DownloadButton onDownload={onDownload} isDownloading={isQueueingDownload} />
    </div>
  );
}
