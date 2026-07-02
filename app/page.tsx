"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FallingLogos from "./components/FallingLogos";
import ColorPicker from "./components/ColorPicker";
import YouTubeInput from "./components/YouTubeInput";
import VideoPlayer from "./components/VideoPlayer";
import Timeline from "./components/Timeline";
import TimeInputs from "./components/TimeInputs";
import PreviewPlayer from "./components/PreviewPlayer";
import ExportSpeedSelector from "./components/ExportSpeedSelector";
import LiveProgressBar from "./components/LiveProgressBar";
import { useYouTubePlayer } from "./hooks/useYouTubePlayer";
import { useTimeRange } from "./hooks/useTimeRange";
import { waitForJobProgress } from "./lib/jobProgressClient";
import {
  THEME_COLORS,
  formatTimeDisplay,
  getExportSpeedLabel,
  type ExportSpeed,
  type ThemeColor,
} from "@/lib/utils";

interface VideoInfo {
  videoId: string;
  title: string;
  durationMs: number;
  thumbnail: string;
  uploader: string;
}

type DownloadTaskStatus = "starting" | "processing" | "ready" | "failed";

interface DownloadTask {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  speed: ExportSpeed;
  progress: number;
  message: string;
  status: DownloadTaskStatus;
  fileUrl: string | null;
  filename: string;
  error: string | null;
}

// Active jobs are persisted so that processing/download survives a backgrounded
// tab being reloaded by the OS (common on mobile). The server keeps processing
// independently, so on reload we simply re-attach to the same jobId.
const ACTIVE_JOBS_STORAGE_KEY = "ytt.activeDownloadJobs.v1";

interface PersistedDownloadJob {
  taskId: string;
  jobId: string;
  title: string;
  startMs: number;
  endMs: number;
  speed: ExportSpeed;
  filename: string;
}

function readPersistedJobs(): PersistedDownloadJob[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ACTIVE_JOBS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PersistedDownloadJob[]) : [];
  } catch {
    return [];
  }
}

function writePersistedJobs(jobs: PersistedDownloadJob[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTIVE_JOBS_STORAGE_KEY, JSON.stringify(jobs));
  } catch {
    // ignore storage errors (private mode / quota)
  }
}

// The preview generation is a job-based flow too, so a preview that is still
// rendering when the tab is backgrounded (and possibly reloaded by the OS) is
// persisted and resumed on reload: we restore the editing session and re-attach
// to the same server jobId instead of starting over.
const PREVIEW_SESSION_STORAGE_KEY = "ytt.previewSession.v1";

interface PersistedPreviewSession {
  jobId: string;
  url: string;
  videoInfo: VideoInfo;
  startMs: number;
  endMs: number;
  speed: ExportSpeed;
}

function readPreviewSession(): PersistedPreviewSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PREVIEW_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedPreviewSession;
    return parsed && parsed.jobId && parsed.videoInfo ? parsed : null;
  } catch {
    return null;
  }
}

function writePreviewSession(session: PersistedPreviewSession) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PREVIEW_SESSION_STORAGE_KEY,
      JSON.stringify(session)
    );
  } catch {
    // ignore storage errors (private mode / quota)
  }
}

function clearPreviewSession() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PREVIEW_SESSION_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [theme, setTheme] = useState<ThemeColor>(THEME_COLORS[3]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [startingDownloadCount, setStartingDownloadCount] = useState(0);
  const [exportSpeed, setExportSpeed] = useState<ExportSpeed>(1);
  const [downloadTasks, setDownloadTasks] = useState<DownloadTask[]>([]);
  const downloadObjectUrlsRef = useRef<string[]>([]);
  const pendingDownloadsRef = useRef<{ url: string; filename: string }[]>([]);
  const resumedRef = useRef(false);
  const previewRestoredRef = useRef(false);
  const [resumePreviewJobId, setResumePreviewJobId] = useState<string | null>(null);
  const [tmpCleanupStatus, setTmpCleanupStatus] = useState<string>("Checking tmp cleanup...");
  const [tmpCleanupOk, setTmpCleanupOk] = useState<boolean>(true);
  const [sessionId] = useState(() =>
    typeof window === "undefined" ? "ssr-session" : crypto.randomUUID()
  );

  const player = useYouTubePlayer();
  const timeRange = useTimeRange(videoInfo?.durationMs ?? 0);

  useEffect(() => {
    document.documentElement.style.setProperty("--accent", theme.value);
    document.documentElement.style.setProperty("--accent-glow", theme.glow);
  }, [theme]);

  useEffect(() => {
    return () => {
      for (const objectUrl of downloadObjectUrlsRef.current) {
        URL.revokeObjectURL(objectUrl);
      }
      downloadObjectUrlsRef.current = [];
    };
  }, []);

  // Intentionally NOT aborting jobs on pagehide/visibilitychange: backgrounding
  // the tab (or switching apps on mobile) must let processing + download
  // continue. Server-side jobs self-expire via their own TTL.

  useEffect(() => {
    let cancelled = false;
    const checkTmpStatus = async () => {
      try {
        const response = await fetch("/api/process/tmp-status", {
          cache: "no-store",
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error ?? "Failed to check tmp status");
        }
        if (cancelled) return;
        const count = Number(data.fileCount ?? 0);
        if (count === 0) {
          setTmpCleanupOk(true);
          setTmpCleanupStatus("Tmp cleanup verified: folder is empty.");
        } else {
          setTmpCleanupOk(false);
          setTmpCleanupStatus(`Tmp cleanup warning: ${count} file(s) currently present.`);
        }
      } catch {
        if (cancelled) return;
        setTmpCleanupOk(false);
        setTmpCleanupStatus("Tmp cleanup status unavailable.");
      }
    };
    void checkTmpStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateTask = useCallback((taskId: string, updater: (task: DownloadTask) => DownloadTask) => {
    setDownloadTasks((current) =>
      current.map((task) => (task.id === taskId ? updater(task) : task))
    );
  }, []);

  const performDownloadClick = useCallback(
    (urlToDownload: string, filename: string) => {
      const a = document.createElement("a");
      a.href = urlToDownload;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    },
    []
  );

  // Mobile browsers block/drop programmatic downloads triggered while the tab
  // is hidden. If the file becomes ready in the background, queue the click and
  // flush it when the tab is visible again. The per-job "Save" button is always
  // available as a manual fallback.
  const triggerBrowserDownload = useCallback(
    (urlToDownload: string, filename: string) => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        pendingDownloadsRef.current.push({ url: urlToDownload, filename });
        return;
      }
      performDownloadClick(urlToDownload, filename);
    },
    [performDownloadClick]
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const pending = pendingDownloadsRef.current;
      pendingDownloadsRef.current = [];
      for (const item of pending) {
        performDownloadClick(item.url, item.filename);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [performDownloadClick]);

  const persistJob = useCallback((job: PersistedDownloadJob) => {
    const jobs = readPersistedJobs().filter((item) => item.jobId !== job.jobId);
    jobs.push(job);
    writePersistedJobs(jobs);
  }, []);

  const unpersistJob = useCallback((jobId: string) => {
    writePersistedJobs(readPersistedJobs().filter((item) => item.jobId !== jobId));
  }, []);

  const unpersistJobByTaskId = useCallback((taskId: string) => {
    writePersistedJobs(
      readPersistedJobs().filter((item) => item.taskId !== taskId)
    );
  }, []);

  // Poll a job to completion, then fetch + offer the file. Reused for both
  // freshly-started jobs and jobs resumed after a reload.
  const trackJobToCompletion = useCallback(
    async (taskId: string, jobId: string, meta: { filename: string }) => {
      try {
        await waitForJobProgress(jobId, {
          onProgress: (snapshot) => {
            if (!snapshot.progress) return;
            updateTask(taskId, (task) => ({
              ...task,
              status: snapshot.status === "processing" ? "processing" : task.status,
              progress: Number(snapshot.progress?.percent ?? task.progress),
              message: String(snapshot.progress?.message ?? "Processing download..."),
            }));
          },
        });

        let res: Response | null = null;
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            res = await fetch(`/api/process/file/${jobId}?download=1`, {
              cache: "no-store",
            });
            break;
          } catch (fetchError) {
            lastError = fetchError;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        if (!res) {
          throw new Error(
            lastError instanceof Error ? lastError.message : "Download failed"
          );
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? "Download failed");
        }

        const blob = await res.blob();
        const downloadUrl = URL.createObjectURL(blob);
        downloadObjectUrlsRef.current.push(downloadUrl);
        unpersistJob(jobId);
        updateTask(taskId, (task) => ({
          ...task,
          status: "ready",
          progress: 100,
          message: "Ready to save",
          fileUrl: downloadUrl,
        }));
        triggerBrowserDownload(downloadUrl, meta.filename);
      } catch (err) {
        unpersistJob(jobId);
        const message = err instanceof Error ? err.message : "Download failed";
        updateTask(taskId, (task) => ({
          ...task,
          status: "failed",
          message: "Download failed",
          error: message,
        }));
      }
    },
    [updateTask, unpersistJob, triggerBrowserDownload]
  );

  const {
    destroy: destroyPlayer,
    onReady,
    onStateChange,
    togglePlay,
    skip,
    setVolume,
    seekTo,
    setDurationMs,
    state: playerState,
  } = player;

  const {
    startMs,
    endMs,
    setStart,
    setEnd,
    initRange,
    setRange,
  } = timeRange;

  useEffect(() => {
    if (videoInfo && playerState.durationMs > 0) {
      initRange(playerState.durationMs);
    }
  }, [videoInfo, playerState.durationMs, initRange]);

  const handleProcess = useCallback(async () => {
    if (!url.trim()) return;

    setIsLoading(true);
    setError(null);
    setIsPreviewMode(false);
    setResumePreviewJobId(null);
    clearPreviewSession();
    destroyPlayer();

    try {
      const res = await fetch(
        `/api/video-info?url=${encodeURIComponent(url.trim())}`
      );
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Failed to process video");
      }

      setVideoInfo({
        videoId: data.videoId,
        title: data.title,
        durationMs: data.durationMs,
        thumbnail: data.thumbnail,
        uploader: data.uploader,
      });
      initRange(data.durationMs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setVideoInfo(null);
    } finally {
      setIsLoading(false);
    }
  }, [url, destroyPlayer, initRange]);

  const handleDownload = useCallback(async () => {
    if (!videoInfo || !url.trim()) return;

    const taskId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const safeTitle =
      videoInfo.title.replace(/[^a-zA-Z0-9_\-\s]/g, "").trim() || "trimmed_video";
    const speedSuffix = exportSpeed === 1 ? "" : "_1.5x";
    const filename = `${safeTitle}${speedSuffix}.mp4`;
    let didReleaseStartLock = false;
    const releaseStartLock = () => {
      if (didReleaseStartLock) return;
      didReleaseStartLock = true;
      setStartingDownloadCount((count) => Math.max(0, count - 1));
    };

    setStartingDownloadCount((count) => count + 1);
    setError(null);
    setDownloadTasks((current) => [
      {
        id: taskId,
        title: videoInfo.title,
        startMs,
        endMs,
        speed: exportSpeed,
        progress: 1,
        message: "Preparing download...",
        status: "starting",
        fileUrl: null,
        filename,
        error: null,
      },
      ...current,
    ]);

    try {
      const startRes = await fetch("/api/process/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          startTime: startMs,
          endTime: endMs,
          title: videoInfo.title,
          speed: exportSpeed,
          sessionId,
        }),
      });
      const startData = await startRes.json();
      if (!startRes.ok || !startData.jobId) {
        throw new Error(startData.error ?? "Failed to start download");
      }
      const jobId = String(startData.jobId);

      persistJob({
        taskId,
        jobId,
        title: videoInfo.title,
        startMs,
        endMs,
        speed: exportSpeed,
        filename,
      });

      updateTask(taskId, (task) => ({
        ...task,
        status: "processing",
        message: "Download started",
      }));
      releaseStartLock();

      await trackJobToCompletion(taskId, jobId, { filename });
    } catch (err) {
      releaseStartLock();
      const message = err instanceof Error ? err.message : "Download failed";
      updateTask(taskId, (task) => ({
        ...task,
        status: "failed",
        message: "Download failed",
        error: message,
      }));
      setError(message);
    } finally {
      releaseStartLock();
    }
  }, [
    videoInfo,
    url,
    startMs,
    endMs,
    exportSpeed,
    updateTask,
    sessionId,
    persistJob,
    trackJobToCompletion,
  ]);

  // Resume any jobs that were still active when the page was last closed/reloaded
  // (e.g. mobile OS killed the backgrounded tab). The server job is still running
  // or already finished, so we re-attach and finish the download.
  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    const persisted = readPersistedJobs();
    if (persisted.length === 0) return;

    // One-time hydration of in-flight jobs from storage on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDownloadTasks((current) => {
      const existingIds = new Set(current.map((task) => task.id));
      const restored: DownloadTask[] = persisted
        .filter((job) => !existingIds.has(job.taskId))
        .map((job) => ({
          id: job.taskId,
          title: job.title,
          startMs: job.startMs,
          endMs: job.endMs,
          speed: job.speed,
          progress: 1,
          message: "Resuming download...",
          status: "processing",
          fileUrl: null,
          filename: job.filename,
          error: null,
        }));
      return [...restored, ...current];
    });

    for (const job of persisted) {
      void trackJobToCompletion(job.taskId, job.jobId, { filename: job.filename });
    }
  }, [trackJobToCompletion]);

  // Restore an in-flight preview session after a background reload: bring back
  // the editing state and re-enter preview mode so PreviewPlayer re-attaches to
  // the same server jobId (see resumeJobId below).
  useEffect(() => {
    if (previewRestoredRef.current) return;
    previewRestoredRef.current = true;
    const session = readPreviewSession();
    if (!session) return;

    // One-time hydration of a persisted preview session on mount.
    /* eslint-disable react-hooks/set-state-in-effect */
    setUrl(session.url);
    setVideoInfo(session.videoInfo);
    setExportSpeed(session.speed);
    setRange(session.startMs, session.endMs);
    setResumePreviewJobId(session.jobId);
    setIsPreviewMode(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [setRange]);

  const handlePreview = useCallback(() => {
    setResumePreviewJobId(null);
    clearPreviewSession();
    setIsPreviewMode(true);
  }, []);

  const handleExitPreview = useCallback(() => {
    clearPreviewSession();
    setResumePreviewJobId(null);
    setIsPreviewMode(false);
    seekTo(startMs);
  }, [seekTo, startMs]);

  // PreviewPlayer reports the jobId it started so we can persist the whole
  // editing session and resume the preview after a background reload.
  const handlePreviewJobStarted = useCallback(
    (jobId: string) => {
      if (!videoInfo) return;
      setResumePreviewJobId(null);
      writePreviewSession({
        jobId,
        url: url.trim(),
        videoInfo,
        startMs,
        endMs,
        speed: exportSpeed,
      });
    },
    [videoInfo, url, startMs, endMs, exportSpeed]
  );

  const handlePreviewSettled = useCallback(() => {
    clearPreviewSession();
  }, []);

  const handleSaveReadyDownload = useCallback(
    (task: DownloadTask) => {
      if (!task.fileUrl) return;
      triggerBrowserDownload(task.fileUrl, task.filename);
    },
    [triggerBrowserDownload]
  );

  const handleRemoveTask = useCallback(
    (taskId: string) => {
      unpersistJobByTaskId(taskId);
      setDownloadTasks((current) => {
        const task = current.find((item) => item.id === taskId);
        if (task?.fileUrl) {
          URL.revokeObjectURL(task.fileUrl);
          downloadObjectUrlsRef.current = downloadObjectUrlsRef.current.filter(
            (urlToKeep) => urlToKeep !== task.fileUrl
          );
        }
        return current.filter((item) => item.id !== taskId);
      });
    },
    [unpersistJobByTaskId]
  );

  return (
    <div className="relative min-h-screen flex flex-col">
      <FallingLogos color={theme.value} />

      <div className="relative z-10 flex flex-col flex-1 max-w-5xl mx-auto w-full px-4 py-8 gap-8">
        <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold glow-text tracking-tight">
              YouTube Trimmer
            </h1>
            <p className="text-gray-400 mt-1 text-sm sm:text-base">
              Trim, preview, and download any YouTube video
            </p>
          </div>
          <ColorPicker selected={theme} onChange={setTheme} />
        </header>

        <section className="glass-panel p-3">
          <p
            className={`text-xs ${tmpCleanupOk ? "text-emerald-300" : "text-amber-300"}`}
            role="status"
            aria-live="polite"
          >
            {tmpCleanupStatus}
          </p>
        </section>

        <section className="glass-panel p-6">
          <YouTubeInput
            url={url}
            onUrlChange={setUrl}
            onProcess={handleProcess}
            isLoading={isLoading}
          />
          {error && (
            <p className="mt-3 text-red-400 text-sm" role="alert">
              {error}
            </p>
          )}
        </section>

        {videoInfo && (
          <>
            <section className="glass-panel p-4">
              <h2 className="text-lg font-semibold text-white truncate">
                {videoInfo.title}
              </h2>
              <p className="text-sm text-gray-400">by {videoInfo.uploader}</p>
            </section>

            {!isPreviewMode ? (
              <>
                <VideoPlayer
                  videoId={videoInfo.videoId}
                  durationMs={playerState.durationMs || videoInfo.durationMs}
                  currentTimeMs={playerState.currentTime}
                  isPlaying={playerState.isPlaying}
                  volume={playerState.volume}
                  onReady={(e) => onReady(e.target)}
                  onStateChange={(e) => onStateChange(e)}
                  onTogglePlay={togglePlay}
                  onSkip={skip}
                  onSeek={seekTo}
                  onVolumeChange={setVolume}
                  onEndedAt={setDurationMs}
                  useNativeControls={false}
                  showCustomTimeline
                />

                <Timeline
                  durationMs={playerState.durationMs || videoInfo.durationMs}
                  currentTimeMs={playerState.currentTime}
                  startMs={startMs}
                  endMs={endMs}
                  onSeek={seekTo}
                  onStartChange={setStart}
                  onEndChange={setEnd}
                />

                <TimeInputs
                  durationMs={playerState.durationMs || videoInfo.durationMs}
                  startMs={startMs}
                  endMs={endMs}
                  onStartUpdate={setStart}
                  onEndUpdate={setEnd}
                />

                <ExportSpeedSelector value={exportSpeed} onChange={setExportSpeed} />

                <button
                  type="button"
                  onClick={handlePreview}
                  className="btn-primary w-full py-4 text-lg"
                >
                  Preview Trimmed Section
                </button>
              </>
            ) : (
              <PreviewPlayer
                sourceUrl={url.trim()}
                startMs={startMs}
                endMs={endMs}
                exportSpeed={exportSpeed}
                sessionId={sessionId}
                resumeJobId={resumePreviewJobId}
                onJobStarted={handlePreviewJobStarted}
                onSettled={handlePreviewSettled}
                onExportSpeedChange={setExportSpeed}
                onExitPreview={handleExitPreview}
                onDownload={handleDownload}
                isQueueingDownload={startingDownloadCount > 0}
              />
            )}
          </>
        )}

        {downloadTasks.length > 0 && (
          <section className="glass-panel p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">Download Jobs</h3>
              <p className="text-xs text-gray-400">
                {downloadTasks.filter((task) => task.status === "processing" || task.status === "starting").length}{" "}
                active · {downloadTasks.length} total
              </p>
            </div>
            {downloadTasks.map((task) => {
              const clipLabel = `${formatTimeDisplay(task.startMs)} - ${formatTimeDisplay(task.endMs)} (${getExportSpeedLabel(task.speed)})`;
              return (
                <div key={task.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">{task.title}</p>
                      <p className="text-xs text-gray-400">{clipLabel}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveTask(task.id)}
                      className="btn-secondary px-3 py-1 text-xs"
                    >
                      Remove
                    </button>
                  </div>

                  {task.status !== "ready" && (
                    <div className="mt-3">
                      <LiveProgressBar
                        title={task.status === "failed" ? "Failed" : "Processing"}
                        message={task.error ?? task.message}
                        percent={task.progress}
                        active={task.status === "processing" || task.status === "starting"}
                      />
                    </div>
                  )}

                  {task.status === "ready" && (
                    <div className="mt-3 flex items-center justify-between rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2">
                      <p className="text-sm text-emerald-300">Ready to download</p>
                      <button
                        type="button"
                        onClick={() => handleSaveReadyDownload(task)}
                        className="btn-primary px-3 py-1 text-sm"
                      >
                        Save Again
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {!videoInfo && !isLoading && (
          <section className="glass-panel p-8 text-center text-gray-400">
            <p>Paste a YouTube link above to get started.</p>
            <p className="text-sm mt-2">Works with public and unlisted videos.</p>
          </section>
        )}
      </div>
    </div>
  );
}
