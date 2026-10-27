import { v4 as uuidv4 } from "uuid";
import { existsSync } from "fs";
import {
  cleanupFiles,
  cleanupTmpDirectory,
  createProcessedPaths,
  processVideoToOutputFile,
  type ProcessProgress,
} from "@/lib/videoPipeline";
import { type ExportSpeed } from "@/lib/utils";

type JobStatus = "queued" | "processing" | "completed" | "failed";
type JobKind = "preview" | "download";

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
  kind: JobKind;
  runnerStarted: boolean;
  completedAt: number | null;
  localSourcePath: string | null;
}

const jobs = new Map<string, Job>();
const JOB_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_JOBS = 3;
const COMPLETED_OUTPUT_GRACE_MS = 20 * 1000;
let lifecycleInitialized = false;

function resolveMaxConcurrentJobs(): number {
  const raw = process.env.YT_PROCESS_MAX_CONCURRENT_JOBS?.trim();
  if (!raw) return DEFAULT_MAX_CONCURRENT_JOBS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_CONCURRENT_JOBS;
  return Math.max(1, Math.floor(parsed));
}

const MAX_CONCURRENT_JOBS = resolveMaxConcurrentJobs();

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

function countActiveProcessingJobs(): number {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status === "processing") count += 1;
  }
  return count;
}

function maybeSweepTmpWhenIdle() {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.status === "queued" || job.status === "processing") return;
    if (
      job.status === "completed" &&
      existsSync(job.paths.outputPath) &&
      (!job.completedAt || now - job.completedAt < COMPLETED_OUTPUT_GRACE_MS)
    ) {
      return;
    }
  }

  for (const [id, job] of jobs.entries()) {
    if (job.status !== "completed") continue;
    if (!existsSync(job.paths.outputPath)) continue;
    cleanupFiles(job.paths.downloadedPath, job.paths.trimmedPath, job.paths.outputPath);
    if (job.expiryTimer) clearTimeout(job.expiryTimer);
    jobs.delete(id);
  }
  cleanupTmpDirectory();
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
    maybeSweepTmpWhenIdle();
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

function findActiveDuplicateJob(input: {
  canonicalUrl: string;
  startTime: number;
  endTime: number;
  speed: ExportSpeed;
  sessionId?: string;
  kind?: JobKind;
}): Job | null {
  // Allow parallel download jobs, even for identical clips in the same session.
  // Only preview jobs are deduped to avoid duplicate expensive preview renders
  // from quick repeated taps/reloads.
  if ((input.kind ?? "download") !== "preview") return null;
  const targetSession = input.sessionId ?? "anonymous";
  for (const job of jobs.values()) {
    if (job.status === "completed" || job.status === "failed") continue;
    if (job.kind !== "preview") continue;
    if (job.sessionId !== targetSession) continue;
    if (job.canonicalUrl !== input.canonicalUrl) continue;
    if (job.startTime !== input.startTime) continue;
    if (job.endTime !== input.endTime) continue;
    if (job.speed !== input.speed) continue;
    return job;
  }
  return null;
}

function dispatchQueuedJobs() {
  let available = MAX_CONCURRENT_JOBS - countActiveProcessingJobs();
  if (available <= 0) return;
  for (const job of jobs.values()) {
    if (available <= 0) break;
    if (job.status !== "queued") continue;
    startJobRunner(job.id);
    available -= 1;
  }
}

function startJobRunner(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.runnerStarted) return;
  if (job.status !== "queued" && job.status !== "processing") return;
  if (job.status === "queued" && countActiveProcessingJobs() >= MAX_CONCURRENT_JOBS) return;

  job.runnerStarted = true;
  job.status = "processing";
  if (job.progress.percent < 1) {
    job.progress = {
      stage: "download",
      percent: 1,
      message: "Starting processing...",
    };
  }

  void (async () => {
    try {
      await processVideoToOutputFile(
        job.canonicalUrl,
        job.startTime,
        job.endTime,
        job.paths,
        job.speed,
        (progress) => {
          const existing = jobs.get(jobId);
          if (!existing) return;
          existing.progress = progress;
        },
        job.abortController.signal,
        job.localSourcePath
      );
      const existing = jobs.get(jobId);
      if (!existing) return;
      existing.status = "completed";
      existing.completedAt = Date.now();
      existing.progress = {
        stage: "finalize",
        percent: 100,
        message: "Ready",
      };
      debugLog("H1,H3", "processJobs.ts:jobComplete", "job completed", {
        jobId,
        outputPath: job.paths.outputPath,
        exists: true,
      });
      scheduleExpiry(jobId);
    } catch (error) {
      const existing = jobs.get(jobId);
      if (!existing) return;
      if (job.abortController.signal.aborted) {
        existing.status = "failed";
        existing.completedAt = Date.now();
        existing.error = "Cancelled";
        existing.progress = {
          stage: "finalize",
          percent: existing.progress.percent,
          message: "Cancelled",
        };
        debugLog("H2,H4", "processJobs.ts:jobCancelled", "job cancelled", {
          jobId,
          sessionId: existing.sessionId,
          reason: "abort-signal",
        });
        cleanupFiles(job.paths.downloadedPath, job.paths.trimmedPath, job.paths.outputPath);
        scheduleExpiry(jobId);
        return;
      }
      existing.status = "failed";
      existing.completedAt = Date.now();
      existing.error = error instanceof Error ? error.message : "Processing failed";
      existing.progress = {
        stage: "finalize",
        percent: existing.progress.percent,
        message: "Failed",
      };
      debugLog("H1,H3,H5", "processJobs.ts:jobFailed", "job failed", {
        jobId,
        sessionId: existing.sessionId,
        error:
          error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400),
      });
      cleanupFiles(job.paths.downloadedPath, job.paths.trimmedPath, job.paths.outputPath);
      scheduleExpiry(jobId);
    } finally {
      const existing = jobs.get(jobId);
      if (existing) {
        existing.runnerStarted = false;
      }
      dispatchQueuedJobs();
      maybeSweepTmpWhenIdle();
    }
  })();
}

export function createProcessingJob(input: {
  canonicalUrl: string;
  startTime: number;
  endTime: number;
  speed: ExportSpeed;
  title?: string;
  sessionId?: string;
  kind?: JobKind;
  localSourcePath?: string | null;
}): string {
  initializeLifecycleCleanup();
  const duplicate = findActiveDuplicateJob(input);
  if (duplicate) {
    debugLog("H3", "processJobs.ts:createProcessingJob", "deduped duplicate job", {
      existingJobId: duplicate.id,
      sessionId: duplicate.sessionId,
      speed: duplicate.speed,
      clipMs: duplicate.endTime - duplicate.startTime,
      activeJobs: jobs.size,
    });
    return duplicate.id;
  }

  const id = uuidv4();
  const titleBase = sanitizeTitle(input.title ?? "trimmed_video");
  const speedSuffix = input.speed === 1 ? "" : "_1.5x";
  const filename = `${titleBase}${speedSuffix}.mp4`;
  const paths = createProcessedPaths(id);

  const abortController = new AbortController();
  const job: Job = {
    id,
    // Every new job enters queued state first; dispatcher promotes to
    // processing only when a slot is actually granted.
    status: "queued",
    progress: {
      stage: "download",
      percent: 0,
      message: `Queued - waiting for a processing slot (${MAX_CONCURRENT_JOBS} max active)`,
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
    kind: input.kind ?? "download",
    runnerStarted: false,
    completedAt: null,
    localSourcePath: input.localSourcePath ?? null,
  };
  jobs.set(id, job);
  debugLog("H1,H2", "processJobs.ts:createProcessingJob", "job created", {
    jobId: id,
    sessionId: job.sessionId,
    speed: input.speed,
    clipMs: input.endTime - input.startTime,
    activeJobs: jobs.size,
    status: "queued",
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
  });

  dispatchQueuedJobs();

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
  dispatchQueuedJobs();
  maybeSweepTmpWhenIdle();
}

export function cleanupSettledJobsForVideo(videoKey: string) {
  for (const [id, job] of jobs.entries()) {
    if (job.videoKey !== videoKey) continue;
    if (job.status === "processing") continue;
    if (job.expiryTimer) clearTimeout(job.expiryTimer);
    cleanupFiles(job.paths.downloadedPath, job.paths.trimmedPath, job.paths.outputPath);
    jobs.delete(id);
  }
  maybeSweepTmpWhenIdle();
}

export function abortJob(jobId: string, reason = "Cancelled") {
  const job = jobs.get(jobId);
  if (!job) return;
  const wasQueued = job.status === "queued";
  job.abortController.abort();
  job.status = "failed";
  job.completedAt = Date.now();
  job.error = reason;
  job.progress = {
    stage: "finalize",
    percent: job.progress.percent,
    message: reason,
  };
  cleanupFiles(job.paths.downloadedPath, job.paths.trimmedPath, job.paths.outputPath);
  scheduleExpiry(jobId);
  if (wasQueued) {
    dispatchQueuedJobs();
    maybeSweepTmpWhenIdle();
  }
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

export function getProcessingStatus() {
  let queued = 0;
  let processing = 0;
  let completed = 0;
  let failed = 0;

  for (const job of jobs.values()) {
    if (job.status === "queued") queued += 1;
    else if (job.status === "processing") processing += 1;
    else if (job.status === "completed") completed += 1;
    else if (job.status === "failed") failed += 1;
  }

  return {
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    processingJobs: processing,
    queuedJobs: queued,
    completedJobs: completed,
    failedJobs: failed,
    totalJobs: jobs.size,
    availableSlots: Math.max(0, MAX_CONCURRENT_JOBS - processing),
  };
}
