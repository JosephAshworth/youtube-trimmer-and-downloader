export interface JobProgressSnapshot {
  status: "processing" | "completed" | "failed";
  progress?: {
    percent?: number;
    message?: string;
  };
  error?: string | null;
}

const POLL_INTERVAL_MS = 1500;
// While the tab is backgrounded the device may go offline / throttle timers.
// Tolerate a long stretch of transient failures before giving up so that
// switching tabs (especially on mobile) never kills an in-flight job.
const MAX_CONSECUTIVE_ERRORS = 40;
const MAX_BACKOFF_MS = 8000;

/** Thrown for definitive, non-retryable job outcomes (expired / server error). */
class FatalJobError extends Error {}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request aborted"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error("Request aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Polls a job to completion. This is intentionally resilient: the server runs
 * the job independently of any client connection, so transient network errors
 * (offline tab, throttled background timers, sleeping device) are retried
 * rather than treated as failures. Polling is used instead of SSE because SSE
 * connections are unreliable across background/foreground transitions on
 * mobile.
 */
export async function waitForJobProgress(
  jobId: string,
  options: {
    signal?: AbortSignal;
    onProgress: (snapshot: JobProgressSnapshot) => void;
  }
): Promise<JobProgressSnapshot> {
  const { signal, onProgress } = options;
  let consecutiveErrors = 0;

  while (true) {
    if (signal?.aborted) throw new Error("Request aborted");

    let snapshot: JobProgressSnapshot;
    try {
      const response = await fetch(`/api/process/progress/${jobId}`, {
        cache: "no-store",
        signal,
      });
      if (response.status === 404) {
        throw new FatalJobError(
          "This download job is no longer available. It may have expired - please start it again."
        );
      }
      const data = (await response.json()) as JobProgressSnapshot & {
        error?: string;
      };
      if (!response.ok) {
        throw new FatalJobError(data.error ?? "Progress request failed");
      }
      snapshot = data;
      consecutiveErrors = 0;
    } catch (error) {
      if (error instanceof FatalJobError) throw error;
      if (signal?.aborted) throw new Error("Request aborted");

      // Transient error (offline / backgrounded). Back off and retry.
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        throw new Error("Lost connection to the server while processing.");
      }
      await delay(
        Math.min(POLL_INTERVAL_MS * consecutiveErrors, MAX_BACKOFF_MS),
        signal
      );
      continue;
    }

    onProgress(snapshot);
    if (snapshot.status === "failed") {
      throw new Error(snapshot.error ?? "Processing failed");
    }
    if (snapshot.status === "completed") {
      return snapshot;
    }

    await delay(POLL_INTERVAL_MS, signal);
  }
}
