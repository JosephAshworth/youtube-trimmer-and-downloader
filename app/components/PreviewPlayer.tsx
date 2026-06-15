"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import DownloadButton from "./DownloadButton";
import VolumeControl from "./VolumeControl";
import { DOWNLOAD_SPEED, formatTimeDisplay } from "@/lib/utils";

interface PreviewPlayerProps {
  sourceUrl: string;
  startMs: number;
  endMs: number;
  onExitPreview: () => void;
  onDownload: () => void;
  isDownloading: boolean;
}

export default function PreviewPlayer({
  sourceUrl,
  startMs,
  endMs,
  onExitPreview,
  onDownload,
  isDownloading,
}: PreviewPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLInputElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(100);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;

    const loadPreview = async () => {
      setIsLoadingPreview(true);
      setPreviewError(null);
      setPreviewUrl(null);
      setCurrentTimeMs(0);
      setDurationMs(0);
      setIsPlaying(false);

      try {
        const res = await fetch("/api/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: sourceUrl,
            startTime: startMs,
            endTime: endMs,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error ?? "Failed to load preview");
        }

        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      } catch (err) {
        if (controller.signal.aborted) return;
        setPreviewError(
          err instanceof Error ? err.message : "Failed to load preview"
        );
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
  }, [sourceUrl, startMs, endMs]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume / 100;
  }, [volume, previewUrl]);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setDurationMs(Math.round(video.duration * 1000));
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold glow-text">Preview Mode</h3>
          <p className="text-sm text-gray-400">
            {formatTimeDisplay(startMs)} → {formatTimeDisplay(endMs)} at {DOWNLOAD_SPEED}×
            (pitch-shifted, same as download)
          </p>
        </div>
        <button type="button" onClick={onExitPreview} className="btn-secondary">
          Exit Preview
        </button>
      </div>

      {isLoadingPreview && (
        <div className="glass-panel p-8 text-center text-gray-400">
          Processing preview at {DOWNLOAD_SPEED}×…
        </div>
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

      <DownloadButton onDownload={onDownload} isDownloading={isDownloading} />
    </div>
  );
}
