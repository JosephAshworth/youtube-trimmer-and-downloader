import { v4 as uuidv4 } from "uuid";
import {
  cleanupFiles,
  cleanupTmpDirectory,
  createProcessedPaths,
  processVideoToOutputFile,
  type ProcessProgress,
} from "@/lib/videoPipeline";
import { type ExportSpeed } from "@/lib/utils";

type JobStatus = "processing" | "completed" | "failed";

interface Job {
  id: string;
  status: JobStatus;
  progress: ProcessProgress;
  canonicalUrl: string;
  startTime: number;
  endTime: number;
  speed: ExportSpeed;
  title: string;
  filename: string;
  paths: ReturnType<typeof createProcessedPaths>;
  error: string | null;
  createdAt: number;
  sessionId: string;
  videoKey: string;
  abortController: AbortController;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

const jobs = new Map<string, Job>();
const JOB_TTL_MS = 10 * 60 * 1000;
let lifecycleInitialized = false;

function debugLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>
) {
  // #region agent log
  fetch("http://127.0.0.1:7932/ingest/0ee73f06-2d76-4a1b-8b74-1c95c424e7fc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "974ac8",
    },
    body: JSON.stringify({
      sessionId: "974ac8",
      runId: "pre-fix",
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

function sanitizeTitle(title: string): string {
  return (
    title
      .replace(/[^a-zA-Z0-9_\-\s]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 80) || "trimmed_video"
  );
}

function scheduleExpiry(jobId: string) {
  const existing = jobs.get(jobId);
  if (!existing) return;
  if (existing.expiryTimer) clearTimeout(existing.expiryTimer);
  existing.expiryTimer = setTimeout(() => {
    const job = jobs.get(jobId);
    if (!job) return;
    cleanupFiles(job.paths.downloadedPath, job.paths.trimmedPath, job.paths.outputPath);
    jobs.delete(jobId);
  }, JOB_TTL_MS);
  existing.expiryTimer.unref?.();
}

function initializeLifecycleCleanup() {
  if (lifecycleInitialized) return;
  lifecycleInitialized = true;
  cleanupTmpDirectory();

  const handleShutdown = () => {
    abortAllJobs("Application shutting down");
    cleanupTmpDirectory();
  };

  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

export function createProcessingJob(input: {
  canonicalUrl: string;
  startTime: number;
  endTime: number;
  speed: ExportSpeed;
  title?: string;
  sessionId?: string;
}): string {
  initializeLifecycleCleanup();
  const id = uuidv4();
  const titleBase = sanitizeTitle(input.title ?? "trimmed_video");
  const speedSuffix = input.speed === 1 ? "" : "_1.5x";
  const filename = `${titleBase}${speedSuffix}.mp4`;
  const paths = createProcessedPaths(id);

  const abortController = new AbortController();
  const job: Job = {
    id,
    status: "processing",
    progress: {
      stage: "download",
      percent: 1,
      message: "Queued...",
    },
    canonicalUrl: input.canonicalUrl,
    startTime: input.startTime,
    endTime: input.endTime,
    speed: input.speed,
    title: titleBase,
    filename,
    paths,
    error: null,
    createdAt: Date.now(),
    sessionId: input.sessionId ?? "anonymous",
    videoKey: input.canonicalUrl,
    abortController,
    expiryTimer: null,
  };
  jobs.set(id, job);
  debugLog("H1,H2", "processJobs.ts:createProcessingJob", "job created", {
    jobId: id,
    sessionId: job.sessionId,
    speed: input.speed,
    clipMs: input.endTime - input.startTime,
    activeJobs: jobs.size,
  });

  void (async () => {
    try {
      await processVideoToOutputFile(
        input.canonicalUrl,
        input.startTime,
        input.endTime,
        paths,
        input.speed,
        (progress) => {
          const existing = jobs.get(id);
          if (!existing) return;
          existing.progress = progress;
        },
        abortController.signal
      );
      const existing = jobs.get(id);
      if (!existing) return;
      existing.status = "completed";
      existing.progress = {
        stage: "finalize",
        percent: 100,
        message: "Ready",
      };
      debugLog("H1,H3", "processJobs.ts:jobComplete", "job completed", {
        jobId: id,
        outputPath: paths.outputPath,
        exists: true,
      });
      scheduleExpiry(id);
    } catch (error) {
      const existing = jobs.get(id);
      if (!existing) return;
      if (abortController.signal.aborted) {
        existing.status = "failed";
        existing.error = "Cancelled";
        existing.progress = {
          stage: "finalize",
          percent: existing.progress.percent,
          message: "Cancelled",
        };
        debugLog("H2,H4", "processJobs.ts:jobCancelled", "job cancelled", {
          jobId: id,
          sessionId: existing.sessionId,
          reason: "abort-signal",
        });
        cleanupFiles(paths.downloadedPath, paths.trimmedPath, paths.outputPath);
        scheduleExpiry(id);
        return;
      }
      existing.status = "failed";
      existing.error = error instanceof Error ? error.message : "Processing failed";
      existing.progress = {
        stage: "finalize",
        percent: existing.progress.percent,
        message: "Failed",
      };
      debugLog("H1,H3,H5", "processJobs.ts:jobFailed", "job failed", {
        jobId: id,
        sessionId: existing.sessionId,
        error:
          error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400),
      });
      cleanupFiles(paths.downloadedPath, paths.trimmedPath, paths.outputPath);
      scheduleExpiry(id);
    }
  })();

  return id;
}

export function getJobSnapshot(jobId: string): {
  id: string;
  status: JobStatus;
  progress: ProcessProgress;
  error: string | null;
  createdAt: number;
} | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    createdAt: job.createdAt,
  };
}

export function getCompletedJobFile(jobId: string): {
  outputPath: string;
  filename: string;
} | null {
  const job = jobs.get(jobId);
  if (!job || job.status !== "completed") return null;
  return {
    outputPath: job.paths.outputPath,
    filename: job.filename,
  };
}

export function cleanupJob(jobId: string, options?: { cleanupRelatedVideo?: boolean }) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.expiryTimer) clearTimeout(job.expiryTimer);
  job.abortController.abort();
  cleanupFiles(job.paths.downloadedPath, job.paths.trimmedPath, job.paths.outputPath);
  jobs.delete(jobId);
  if (options?.cleanupRelatedVideo) {
    cleanupSettledJobsForVideo(job.videoKey);
  }
}

export function cleanupSettledJobsForVideo(videoKey: string) {
  for (const [id, job] of jobs.entries()) {
    if (job.videoKey !== videoKey) continue;
    if (job.status === "processing") continue;
    if (job.expiryTimer) clearTimeout(job.expiryTimer);
    cleanupFiles(job.paths.downloadedPath, job.paths.trimmedPath, job.paths.outputPath);
    jobs.delete(id);
  }
}

export function abortJob(jobId: string, reason = "Cancelled") {
  const job = jobs.get(jobId);
  if (!job) return;
  job.abortController.abort();
  job.status = "failed";
  job.error = reason;
  job.progress = {
    stage: "finalize",
    percent: job.progress.percent,
    message: reason,
  };
  cleanupFiles(job.paths.downloadedPath, job.paths.trimmedPath, job.paths.outputPath);
  scheduleExpiry(jobId);
}

export function abortAllJobs(reason = "Cancelled") {
  debugLog("H4", "processJobs.ts:abortAllJobs", "aborting all jobs", {
    reason,
    activeJobs: jobs.size,
  });
  for (const jobId of jobs.keys()) {
    abortJob(jobId, reason);
  }
  cleanupTmpDirectory();
}

export function abortSessionJobs(sessionId: string, reason = "Session ended") {
  let aborted = 0;
  for (const [jobId, job] of jobs.entries()) {
    if (job.sessionId === sessionId) {
      abortJob(jobId, reason);
      aborted += 1;
    }
  }
  debugLog("H4", "processJobs.ts:abortSessionJobs", "aborting session jobs", {
    sessionId,
    reason,
    aborted,
    activeJobs: jobs.size,
  });
}
