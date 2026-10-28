"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FallingLogos from "./components/FallingLogos";
import ColorPicker from "./components/ColorPicker";
import YouTubeInput, { type VideoSourceMode } from "./components/YouTubeInput";
import VideoPlayer from "./components/VideoPlayer";
import LocalVideoPlayer from "./components/LocalVideoPlayer";
import Timeline from "./components/Timeline";
import TimeInputs from "./components/TimeInputs";
import PreviewPlayer from "./components/PreviewPlayer";
import ExportSpeedSelector from "./components/ExportSpeedSelector";
import LiveProgressBar from "./components/LiveProgressBar";
import { useYouTubePlayer } from "./hooks/useYouTubePlayer";
import { useHtmlVideoPlayer } from "./hooks/useHtmlVideoPlayer";
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
  source: "youtube" | "upload";
  videoId: string;
  uploadId?: string;
  title: string;
  durationMs: number;
  thumbnail: string;
  uploader: string;
}

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

type DownloadTaskStatus = "starting" | "queued" | "processing" | "ready" | "failed";

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

interface ProcessingStatus {
  maxConcurrentJobs: number;
  processingJobs: number;
  queuedJobs: number;
  availableSlots: number;
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
    if (!parsed?.jobId || !parsed.videoInfo) return null;
    parsed.videoInfo = {
      ...parsed.videoInfo,
      source: parsed.videoInfo.source === "upload" ? "upload" : "youtube",
    };
    return parsed;
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
  const [sourceMode, setSourceMode] = useState<VideoSourceMode>("youtube");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
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
  const uploadRequestRef = useRef<XMLHttpRequest | null>(null);
  const resumedRef = useRef(false);
  const previewRestoredRef = useRef(false);
  const [resumePreviewJobId, setResumePreviewJobId] = useState<string | null>(null);
  const [tmpCleanupStatus, setTmpCleanupStatus] = useState<string>("Checking tmp cleanup...");
  const [tmpCleanupOk, setTmpCleanupOk] = useState<boolean>(true);
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus | null>(null);
  const [sessionId] = useState(() =>
    typeof window === "undefined" ? "ssr-session" : crypto.randomUUID()
  );

  const player = useYouTubePlayer();
  const htmlPlayer = useHtmlVideoPlayer();
  const timeRange = useTimeRange(videoInfo?.durationMs ?? 0);

  useEffect(() => {
    document.documentElement.style.setProperty("--accent", theme.value);
    document.documentElement.style.setProperty("--accent-glow", theme.glow);
  }, [theme]);

  useEffect(() => {
    return () => {
      uploadRequestRef.current?.abort();
      for (const objectUrl of downloadObjectUrlsRef.current) {
        URL.revokeObjectURL(objectUrl);
      }
      downloadObjectUrlsRef.current = [];
    };
  }, []);

  // Intentionally NOT aborting jobs on pagehide/visibilitychange: backgrounding
  // the tab (or switching apps on mobile) must let processing + download
  // continue. Server-side jobs self-expire via their own TTL.

  const hasActiveJobs =
    startingDownloadCount > 0 ||
    downloadTasks.some(
      (task) =>
        task.status === "starting" ||
        task.status === "queued" ||
        task.status === "processing"
    );

  useEffect(() => {
    let cancelled = false;
    const checkRuntimeStatus = async () => {
      try {
        const [tmpResponse, processResponse] = await Promise.all([
          fetch("/api/process/tmp-status", { cache: "no-store" }),
          fetch("/api/process/status", { cache: "no-store" }),
        ]);
        const tmpData = await tmpResponse.json();
        const processData = await processResponse.json();
        if (!tmpResponse.ok) {
          throw new Error(tmpData.error ?? "Failed to check tmp status");
        }
        if (cancelled) return;
        const count = Number(tmpData.fileCount ?? 0);
        if (count === 0) {
          setTmpCleanupOk(true);
          setTmpCleanupStatus("Tmp cleanup verified: folder is empty.");
        } else {
          setTmpCleanupOk(false);
          setTmpCleanupStatus(`Tmp cleanup warning: ${count} file(s) currently present.`);
        }
        if (processResponse.ok) {
          setProcessingStatus({
            maxConcurrentJobs: Number(processData.maxConcurrentJobs ?? 0),
            processingJobs: Number(processData.processingJobs ?? 0),
            queuedJobs: Number(processData.queuedJobs ?? 0),
            availableSlots: Number(processData.availableSlots ?? 0),
          });
        }
      } catch {
        if (cancelled) return;
        setTmpCleanupOk(false);
        setTmpCleanupStatus("Tmp cleanup status unavailable.");
      }
    };
    void checkRuntimeStatus();
    if (!hasActiveJobs) {
      return () => {
        cancelled = true;
      };
    }
    const interval = setInterval(() => {
      void checkRuntimeStatus();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [hasActiveJobs]);

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
              status:
                snapshot.status === "processing"
                  ? "processing"
                  : snapshot.status === "queued"
                    ? "queued"
                    : task.status,
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
    destroy: destroyHtmlPlayer,
    seekTo: seekHtmlPlayer,
    state: htmlPlayerState,
  } = htmlPlayer;

  const {
    startMs,
    endMs,
    setStart,
    setEnd,
    initRange,
    setRange,
  } = timeRange;

  useEffect(() => {
    if (!videoInfo || videoInfo.source === "upload") return;
    if (playerState.durationMs > 0) {
      initRange(playerState.durationMs);
    }
  }, [videoInfo, playerState.durationMs, initRange]);

  const clearLoadedVideo = useCallback(() => {
    setVideoInfo(null);
    setIsPreviewMode(false);
    setResumePreviewJobId(null);
    clearPreviewSession();
    destroyPlayer();
    destroyHtmlPlayer();
  }, [destroyPlayer, destroyHtmlPlayer]);

  const handleSourceModeChange = useCallback(
    (mode: VideoSourceMode) => {
      setSourceMode(mode);
      const activeUpload = uploadRequestRef.current;
      uploadRequestRef.current = null;
      activeUpload?.abort();
      setIsLoading(false);
      setUploadProgress(null);
      setError(null);
      clearLoadedVideo();
    },
    [clearLoadedVideo]
  );

  const handleProcess = useCallback(async () => {
    if (!url.trim()) return;

    setIsLoading(true);
    setError(null);
    setIsPreviewMode(false);
    setResumePreviewJobId(null);
    clearPreviewSession();
    destroyPlayer();
    destroyHtmlPlayer();

    try {
      const res = await fetch(
        `/api/video-info?url=${encodeURIComponent(url.trim())}`
      );
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Failed to process video");
      }

      setVideoInfo({
        source: "youtube",
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
  }, [url, destroyPlayer, destroyHtmlPlayer, initRange]);

  const handleUpload = useCallback(
    (file: File) => {
      if (file.size > MAX_UPLOAD_BYTES) {
        setError("File is larger than 2 GB.");
        return;
      }

      const previous = uploadRequestRef.current;
      uploadRequestRef.current = null;
      previous?.abort();
      setIsLoading(true);
      setUploadProgress(0);
      setError(null);
      setIsPreviewMode(false);
      setResumePreviewJobId(null);
      clearPreviewSession();
      destroyPlayer();
      destroyHtmlPlayer();

      const xhr = new XMLHttpRequest();
      uploadRequestRef.current = xhr;
      xhr.open("POST", "/api/upload");
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || event.total <= 0) return;
        setUploadProgress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onerror = () => {
        if (uploadRequestRef.current !== xhr) return;
        setIsLoading(false);
        setUploadProgress(null);
        setError("Upload failed");
      };
      xhr.onabort = () => {
        if (uploadRequestRef.current !== xhr) return;
        setIsLoading(false);
        setUploadProgress(null);
      };
      xhr.onload = () => {
        if (uploadRequestRef.current !== xhr) return;
        setIsLoading(false);
        setUploadProgress(null);
        let data: {
          error?: string;
          uploadId?: string;
          title?: string;
          durationMs?: number;
        } = {};
        try {
          data = JSON.parse(xhr.responseText) as typeof data;
        } catch {
          setError("Upload failed");
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300 || !data.uploadId || !data.durationMs) {
          setError(data.error ?? "Upload failed");
          setVideoInfo(null);
          return;
        }
        setVideoInfo({
          source: "upload",
          videoId: data.uploadId,
          uploadId: data.uploadId,
          title: data.title || file.name,
          durationMs: data.durationMs,
          thumbnail: "",
          uploader: "Uploaded file",
        });
        initRange(data.durationMs);
      };
      xhr.send(file);
    },
    [destroyPlayer, destroyHtmlPlayer, initRange]
  );

  const handleDownload = useCallback(async () => {
    if (!videoInfo) return;
    if (videoInfo.source !== "upload" && !url.trim()) return;

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
          ...(videoInfo.source === "upload"
            ? { uploadId: videoInfo.uploadId }
            : { url: url.trim() }),
          startTime: startMs,
          endTime: endMs,
          title: videoInfo.title,
          speed: exportSpeed,
          sessionId,
          kind: "download",
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
    setSourceMode(session.videoInfo.source === "upload" ? "upload" : "youtube");
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
    if (videoInfo?.source === "upload") {
      seekHtmlPlayer(startMs);
    } else {
      seekTo(startMs);
    }
  }, [seekTo, seekHtmlPlayer, startMs, videoInfo?.source]);

  // PreviewPlayer reports the jobId it started so we can persist the whole
  // editing session and resume the preview after a background reload.
  const handlePreviewJobStarted = useCallback(
    (jobId: string) => {
      if (!videoInfo) return;
      setResumePreviewJobId(null);
      writePreviewSession({
        jobId,
        url: videoInfo.source === "upload" ? "" : url.trim(),
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
              Trim, preview, and download a YouTube video or a file from your computer.
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
          {processingStatus && (
            <p className="mt-1 text-xs text-gray-300">
              Processing slots: {processingStatus.processingJobs}/{processingStatus.maxConcurrentJobs}{" "}
              active · {processingStatus.queuedJobs} queued · {processingStatus.availableSlots} available
            </p>
          )}
        </section>

        <section className="glass-panel p-6">
          <YouTubeInput
            mode={sourceMode}
            onModeChange={handleSourceModeChange}
            url={url}
            onUrlChange={setUrl}
            onProcess={handleProcess}
            onUpload={handleUpload}
            isLoading={isLoading}
            uploadProgress={uploadProgress}
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
              {videoInfo.source === "youtube" && (
                <p className="text-sm text-gray-400">by {videoInfo.uploader}</p>
              )}
            </section>

            {!isPreviewMode ? (
              <>
                {videoInfo.source === "upload" && videoInfo.uploadId ? (
                  <LocalVideoPlayer
                    src={`/api/upload/${videoInfo.uploadId}`}
                    durationMs={htmlPlayerState.durationMs || videoInfo.durationMs}
                    currentTimeMs={htmlPlayerState.currentTime}
                    isPlaying={htmlPlayerState.isPlaying}
                    volume={htmlPlayerState.volume}
                    onTogglePlay={htmlPlayer.togglePlay}
                    onSkip={htmlPlayer.skip}
                    onSeek={seekHtmlPlayer}
                    onScrubStart={htmlPlayer.beginScrub}
                    onScrubEnd={htmlPlayer.endScrub}
                    onVolumeChange={htmlPlayer.setVolume}
                    videoRef={htmlPlayer.setVideoNode}
                  />
                ) : (
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
                    onScrubStart={player.beginScrub}
                    onScrubEnd={player.endScrub}
                    onVolumeChange={setVolume}
                    onEndedAt={setDurationMs}
                    useNativeControls={false}
                    showCustomTimeline
                  />
                )}

                <Timeline
                  durationMs={
                    videoInfo.source === "upload"
                      ? htmlPlayerState.durationMs || videoInfo.durationMs
                      : playerState.durationMs || videoInfo.durationMs
                  }
                  currentTimeMs={
                    videoInfo.source === "upload"
                      ? htmlPlayerState.currentTime
                      : playerState.currentTime
                  }
                  startMs={startMs}
                  endMs={endMs}
                  onStartChange={setStart}
                  onEndChange={setEnd}
                />

                <TimeInputs
                  durationMs={
                    videoInfo.source === "upload"
                      ? htmlPlayerState.durationMs || videoInfo.durationMs
                      : playerState.durationMs || videoInfo.durationMs
                  }
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
                sourceUrl={videoInfo.source === "upload" ? "" : url.trim()}
                uploadId={videoInfo.uploadId ?? null}
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
                {downloadTasks.filter(
                  (task) =>
                    task.status === "processing" ||
                    task.status === "starting" ||
                    task.status === "queued"
                ).length}{" "}
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
                        active={
                          task.status === "processing" ||
                          task.status === "starting" ||
                          task.status === "queued"
                        }
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
            <p>Paste a YouTube link or upload a video file to get started.</p>
            <p className="text-sm mt-2">Works with public and unlisted videos.</p>
          </section>
        )}
      </div>
    </div>
  );
}
