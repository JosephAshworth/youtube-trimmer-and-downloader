export type LiveScrubSession = {
  pendingMs: number | null;
  awaitingSeek: boolean;
};

export function createLiveScrubSession(): LiveScrubSession {
  return { pendingMs: null, awaitingSeek: false };
}

/**
 * Apply the newest scrub time, but wait until the current seek has painted
 * before issuing the next one. Assigning currentTime on every pointer move
 * aborts the in-flight seek, so the frame stays put until the pointer is released.
 */
export function pushLiveScrub(
  video: HTMLVideoElement,
  session: LiveScrubSession,
  ms: number
) {
  const durationMs =
    Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : ms;
  session.pendingMs = Math.min(Math.max(0, ms), Math.max(durationMs, 0));
  pumpLiveScrub(video, session);
}

export function flushLiveScrub(video: HTMLVideoElement, session: LiveScrubSession) {
  if (session.pendingMs == null) return;
  const seconds = session.pendingMs / 1000;
  session.pendingMs = null;
  video.currentTime = seconds;
}

function pumpLiveScrub(video: HTMLVideoElement, session: LiveScrubSession) {
  if (session.pendingMs == null) return;
  if (session.awaitingSeek || video.seeking) {
    if (!session.awaitingSeek) armSeeked(video, session);
    return;
  }
  const nextMs = session.pendingMs;
  session.pendingMs = null;
  const seconds = nextMs / 1000;
  if (Math.abs(video.currentTime - seconds) < 0.03) {
    if (session.pendingMs != null) pumpLiveScrub(video, session);
    return;
  }

  const cancel = armSeeked(video, session);
  try {
    video.currentTime = seconds;
  } catch {
    cancel();
    return;
  }
  if (!video.seeking) cancel();
}

function armSeeked(video: HTMLVideoElement, session: LiveScrubSession) {
  session.awaitingSeek = true;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(fallback);
    video.removeEventListener("seeked", finish);
    session.awaitingSeek = false;
    pumpLiveScrub(video, session);
  };
  const fallback = window.setTimeout(finish, 180);
  video.addEventListener("seeked", finish);
  return finish;
}
