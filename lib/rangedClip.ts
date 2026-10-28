import { spawn } from "child_process";
import { existsSync } from "fs";
import http from "http";
import https from "https";
import { copyFile, open, stat, unlink, type FileHandle } from "fs/promises";
import { join } from "path";
import { getYtDlpAuthArgs } from "@/lib/ytDlpAuth";
import { type ExportSpeed } from "@/lib/utils";

const HEAD_BYTES = 1024 * 1024;
// YouTube slows a connection after a short burst. Smaller pieces on fresh
// sockets stay in that burst, and more of them run at once.
const RANGE_CHUNK_BYTES = 4 * 1024 * 1024;
const RANGE_CONCURRENCY = 16;
const PARALLEL_TRACK_CONCURRENCY = 8;
const CHUNK_ATTEMPTS = 3;
const SOCKET_STALL_MS = 12000;

const rangeHttpsAgent = new https.Agent({
  keepAlive: false,
  maxSockets: RANGE_CONCURRENCY * 2,
  maxCachedSessions: 64,
});
const rangeHttpAgent = new http.Agent({
  keepAlive: false,
  maxSockets: RANGE_CONCURRENCY * 2,
});
let preferIpv4 = true;
// 1x output can run past the selection until the next keyframe/segment.
const COPY_DURATION_SLACK_SEC = 30;
// 1.5x is trimmed exactly, then sped up. Allow a little frame rounding.
const SPEED_DURATION_SLACK_SEC = 0.75;
const MIN_DURATION_SHORTFALL_SEC = 0.35;

export interface SidxSegment {
  start: number;
  end: number;
  pos: number;
  size: number;
}

type Stage = "download" | "trim" | "speed";

export interface FastRangeExportInput {
  canonicalUrl: string;
  startMs: number;
  endMs: number;
  speed: ExportSpeed;
  outputPath: string;
  tmpDir: string;
  id: string;
  formatAttempts: { label: string; args: string[] }[];
  signal?: AbortSignal;
  onProgress?: (stage: Stage, percent: number, message: string) => void;
}

type YtFormat = {
  url?: string;
  vcodec?: string;
  acodec?: string;
  http_headers?: Record<string, unknown>;
};

type DownloadedTrack = {
  rawPath: string;
  origin: number;
  end: number;
};

export function durationCoversRequest(actual: number, expected: number, slack: number): boolean {
  return Number.isFinite(actual) && actual + MIN_DURATION_SHORTFALL_SEC >= expected && actual <= expected + slack;
}

export function selectCoveringSegments(
  segments: SidxSegment[],
  startSec: number,
  endSec: number
): SidxSegment[] {
  const chosen = segments.filter((segment) => segment.start < endSec && segment.end > startSec);
  if (chosen.length === 0) return [];
  const last = chosen[chosen.length - 1];
  const lastIndex = segments.indexOf(last);
  if (last.end < endSec + 0.05 && lastIndex >= 0 && lastIndex + 1 < segments.length) {
    chosen.push(segments[lastIndex + 1]);
  }
  return chosen;
}

export function parseSidxSegments(data: Buffer): { segments: SidxSegment[]; initEnd: number } | null {
  let offset = 0;
  let sidxOffset = -1;
  let sidxSize = 0;
  while (offset + 8 <= data.length) {
    let size = data.readUInt32BE(offset);
    const type = data.toString("latin1", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > data.length) return null;
      size = Number(data.readBigUInt64BE(offset + 8));
      header = 16;
    }
    if (!Number.isFinite(size) || size < header) return null;
    if (type === "sidx") {
      sidxOffset = offset;
      sidxSize = size;
      break;
    }
    if (offset + size > data.length) return null;
    offset += size;
  }
  if (sidxOffset < 0 || sidxOffset + sidxSize > data.length) return null;

  const body = data.subarray(sidxOffset + 8, sidxOffset + sidxSize);
  const version = body[0];
  let cursor = 4;
  cursor += 4;
  const timescale = body.readUInt32BE(cursor);
  cursor += 4;
  if (!timescale) return null;

  let earliest = 0;
  let firstOffset = 0;
  if (version === 0) {
    earliest = body.readUInt32BE(cursor);
    cursor += 4;
    firstOffset = body.readUInt32BE(cursor);
    cursor += 4;
  } else {
    earliest = Number(body.readBigUInt64BE(cursor));
    cursor += 8;
    firstOffset = Number(body.readBigUInt64BE(cursor));
    cursor += 8;
  }
  cursor += 2;
  const count = body.readUInt16BE(cursor);
  cursor += 2;
  if (cursor + count * 12 > body.length) return null;

  const segments: SidxSegment[] = [];
  let time = earliest;
  let pos = sidxOffset + sidxSize + firstOffset;
  for (let index = 0; index < count; index += 1) {
    const word = body.readUInt32BE(cursor);
    cursor += 4;
    const size = word & 0x7fffffff;
    const duration = body.readUInt32BE(cursor);
    cursor += 4;
    cursor += 4;
    const start = time / timescale;
    const seconds = duration / timescale;
    segments.push({ start, end: start + seconds, pos, size });
    time += duration;
    pos += size;
  }
  return { segments, initEnd: sidxOffset };
}

function headerRecord(raw: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string" && key.toLowerCase() !== "range") headers[key] = value;
    }
  }
  headers["Accept-Encoding"] = "identity";
  return headers;
}

function hasCodec(value: string | undefined): boolean {
  return Boolean(value && value !== "none");
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === "AbortError" || error.message === "Processing aborted")) ||
    (typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError")
  );
}

function createAbortError(): Error {
  return new Error("Processing aborted");
}

function runProcess(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const onAbort = () => {
      child.kill("SIGKILL");
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${command} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

function probeValue(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || "ffprobe failed"));
    });
  });
}

export async function probeMediaFile(filePath: string): Promise<{
  duration: number;
  hasAudio: boolean;
  sampleRate: number;
}> {
  const raw = await probeValue([
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type,sample_rate",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(raw) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; sample_rate?: string }[];
  };
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  return {
    duration: Number(parsed.format?.duration ?? NaN),
    hasAudio: Boolean(audio),
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : 44100,
  };
}

async function probeKeyframes(filePath: string, fromSec?: number, toSec?: number): Promise<number[]> {
  const args = ["-v", "error"];
  if (fromSec !== undefined && toSec !== undefined) {
    args.push("-read_intervals", `${Math.max(0, fromSec).toFixed(3)}%${Math.max(fromSec + 0.1, toSec).toFixed(3)}`);
  }
  args.push(
    "-select_streams",
    "v:0",
    "-skip_frame",
    "nokey",
    "-show_entries",
    "frame=pts_time",
    "-of",
    "csv=p=0",
    filePath
  );
  const raw = await probeValue(args);
  return raw
    .split(/\r?\n/)
    .map((line) => Number(line.replace(",", "").trim()))
    .filter((value) => Number.isFinite(value));
}

async function dumpJson(args: string[], signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw createAbortError();
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const onAbort = () => {
      child.kill("SIGKILL");
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `yt-dlp failed with exit code ${code ?? "unknown"}`));
    });
  });
  return JSON.parse(stdout);
}

function isRetryableDownloadError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (!(error instanceof Error)) return true;
  return !/^HTTP \d+/.test(error.message);
}

function requestRange(
  url: string,
  headers: Record<string, string>,
  start: number,
  end: number,
  signal?: AbortSignal,
  redirects = 0
): Promise<Buffer> {
  const expected = end - start + 1;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    let settled = false;
    const finish = (error: Error | null, body?: Buffer) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(body as Buffer);
    };
    const parsed = new URL(url);
    const secure = parsed.protocol === "https:";
    const req = (secure ? https : http).request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: {
          ...headers,
          Range: `bytes=${start}-${end}`,
          Connection: "close",
        },
        agent: secure ? rangeHttpsAgent : rangeHttpAgent,
        timeout: SOCKET_STALL_MS,
        ...(preferIpv4 ? { family: 4 as const } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location && redirects < 3) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          requestRange(next, headers, start, end, signal, redirects + 1).then(
            (body) => finish(null, body),
            (error: unknown) => finish(error instanceof Error ? error : new Error("Download failed"))
          );
          return;
        }
        if (status !== 200 && status !== 206) {
          res.resume();
          finish(new Error(`HTTP ${status}`));
          return;
        }
        const advertised = Number(res.headers["content-length"] || 0);
        if ((status === 200 && start > 0) || (advertised > expected + 1024 && status !== 206)) {
          res.resume();
          finish(new Error("HTTP 403"));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          if (settled || received >= expected) return;
          const room = expected - received;
          const next = chunk.length > room ? chunk.subarray(0, room) : chunk;
          chunks.push(next);
          received += next.length;
          if (received >= expected) {
            finish(null, Buffer.concat(chunks));
            res.destroy();
          }
        });
        res.on("end", () => {
          if (received >= expected) finish(null, Buffer.concat(chunks));
          else finish(new Error(`Short read (${received} of ${expected} bytes)`));
        });
        res.on("error", (error) => {
          if (received >= expected) finish(null, Buffer.concat(chunks));
          else if (signal?.aborted || isAbortError(error)) finish(createAbortError());
          else finish(error);
        });
      }
    );
    const onAbort = () => {
      req.destroy();
      finish(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("timeout", () => req.destroy(new Error("Download stalled")));
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (
        preferIpv4 &&
        (error.code === "ENETUNREACH" ||
          error.code === "EHOSTUNREACH" ||
          error.code === "EAFNOSUPPORT" ||
          error.code === "ENOTFOUND")
      ) {
        preferIpv4 = false;
      }
      finish(error);
    });
    req.end();
  });
}

async function fetchBuffer(
  url: string,
  headers: Record<string, string>,
  start: number,
  end: number,
  signal?: AbortSignal
): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CHUNK_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw createAbortError();
    try {
      return await requestRange(url, headers, start, end, signal);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw createAbortError();
      lastError = error;
      if (!isRetryableDownloadError(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Download failed");
}

async function writeRange(
  url: string,
  headers: Record<string, string>,
  start: number,
  end: number,
  dest: string,
  fileOffset: number,
  signal: AbortSignal | undefined,
  onBytes: (written: number, total: number) => void,
  concurrency: number
): Promise<void> {
  const total = end - start + 1;
  const pieces: { filePos: number; from: number; to: number }[] = [];
  for (let offset = 0; offset < total; offset += RANGE_CHUNK_BYTES) {
    const size = Math.min(RANGE_CHUNK_BYTES, total - offset);
    pieces.push({
      filePos: fileOffset + offset,
      from: start + offset,
      to: start + offset + size - 1,
    });
  }
  const workerCount = Math.min(concurrency, pieces.length);
  const handles = await Promise.all(
    Array.from({ length: workerCount }, () => open(dest, "r+"))
  );
  const cancel = new AbortController();
  const linked = signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal;
  let cursor = 0;
  let written = 0;
  const tasks = handles.map(async (handle) => {
    while (!linked.aborted) {
      const index = cursor;
      cursor += 1;
      if (index >= pieces.length) return;
      const piece = pieces[index];
      const data = await fetchBuffer(url, headers, piece.from, piece.to, linked);
      await handle.write(data, 0, data.length, piece.filePos);
      written += data.length;
      onBytes(written, total);
    }
  });
  try {
    await Promise.all(tasks);
    if (signal?.aborted) throw createAbortError();
  } catch (error) {
    cancel.abort();
    await Promise.allSettled(tasks);
    throw error;
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

type TrackPlan = {
  url: string;
  headers: Record<string, string>;
  origin: number;
  end: number;
  rangeStart: number;
  rangeEnd: number;
  includeInit: boolean;
  init: Buffer;
};

async function planTrack(
  format: YtFormat,
  startSec: number,
  endSec: number,
  signal?: AbortSignal
): Promise<TrackPlan | null> {
  if (!format.url) return null;
  const headers = headerRecord(format.http_headers);
  let head: Buffer;
  try {
    head = await fetchBuffer(format.url, headers, 0, HEAD_BYTES - 1, signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
  const index = parseSidxSegments(head);
  if (!index || index.segments.length === 0) return null;
  const chosen = selectCoveringSegments(index.segments, startSec, endSec);
  if (chosen.length === 0) return null;

  const origin = chosen[0].start;
  const end = chosen[chosen.length - 1].end;
  const mediaStart = chosen[0].pos;
  const mediaEnd = chosen[chosen.length - 1].pos + chosen[chosen.length - 1].size - 1;
  const init = head.subarray(0, Math.min(index.initEnd, head.length));
  if (init.length < index.initEnd) return null;
  if (mediaStart === 0) {
    return {
      url: format.url,
      headers,
      origin: 0,
      end,
      rangeStart: 0,
      rangeEnd: mediaEnd,
      includeInit: false,
      init,
    };
  }
  return {
    url: format.url,
    headers,
    origin,
    end,
    rangeStart: mediaStart,
    rangeEnd: mediaEnd,
    includeInit: true,
    init,
  };
}

async function writePlanned(
  plan: TrackPlan,
  dest: string,
  signal: AbortSignal | undefined,
  onBytes: (written: number, total: number) => void,
  concurrency: number
): Promise<void> {
  const mediaBytes = plan.rangeEnd - plan.rangeStart + 1;
  const total = (plan.includeInit ? plan.init.length : 0) + mediaBytes;
  const handle = await open(dest, "w");
  await handle.truncate(total);
  if (plan.includeInit) await handle.write(plan.init, 0, plan.init.length, 0);
  await handle.close();
  await writeRange(
    plan.url,
    plan.headers,
    plan.rangeStart,
    plan.rangeEnd,
    dest,
    plan.includeInit ? plan.init.length : 0,
    signal,
    onBytes,
    concurrency
  );
}

async function downloadPlanned(
  plan: TrackPlan,
  dest: string,
  signal: AbortSignal | undefined,
  onBytes: (written: number, total: number) => void,
  concurrency: number
): Promise<DownloadedTrack | null> {
  try {
    await writePlanned(plan, dest, signal, onBytes, concurrency);
    return { rawPath: dest, origin: plan.origin, end: plan.end };
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (plan.rangeStart <= 0 || !plan.includeInit) return null;
    try {
      await writePlanned(
        { ...plan, origin: 0, rangeStart: 0, includeInit: false },
        dest,
        signal,
        onBytes,
        concurrency
      );
      return { rawPath: dest, origin: 0, end: plan.end };
    } catch (prefixError) {
      if (isAbortError(prefixError)) throw prefixError;
      return null;
    }
  }
}

async function remuxCopy(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
  await runProcess(
    "ffmpeg",
    ["-y", "-i", inputPath, "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", outputPath],
    signal
  );
}

async function tightenCopy(
  inputPath: string,
  outputPath: string,
  offsetSec: number,
  durationSec: number,
  signal?: AbortSignal
): Promise<boolean> {
  const info = await probeMediaFile(inputPath);
  const keyframes = await probeKeyframes(
    inputPath,
    Math.max(0, offsetSec - 20),
    offsetSec + durationSec + 20
  );
  if (keyframes.length === 0 || !Number.isFinite(info.duration)) return false;
  const endSec = offsetSec + durationSec;
  const startCandidates = keyframes.filter((frame) => frame <= offsetSec + 0.001);
  const startKf = startCandidates.length > 0 ? startCandidates[startCandidates.length - 1] : keyframes[0];
  if (startKf > offsetSec + 0.05) return false;
  const endCandidates = keyframes.filter((frame) => frame + 0.001 >= endSec);
  const reachesTail = info.duration + 0.05 >= endSec;
  const endKf = endCandidates.length > 0 ? endCandidates[0] : reachesTail ? info.duration : null;
  if (endKf === null) return false;

  const args = ["-y", "-ss", startKf.toFixed(3)];
  if (endKf < info.duration - 0.15) args.push("-to", (endKf + 0.05).toFixed(3));
  args.push("-i", inputPath, "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", outputPath);
  await runProcess("ffmpeg", args, signal);
  const tightened = await probeMediaFile(outputPath);
  return durationCoversRequest(tightened.duration, durationSec, COPY_DURATION_SLACK_SEC);
}

async function renderSpeed(
  inputPath: string,
  outputPath: string,
  offsetSec: number,
  durationSec: number,
  speed: number,
  signal?: AbortSignal
): Promise<void> {
  const info = await probeMediaFile(inputPath);
  const rate = Math.round(info.sampleRate * speed);
  const args = [
    "-y",
    "-i",
    inputPath,
    "-vf",
    `trim=start=${offsetSec.toFixed(3)}:duration=${durationSec.toFixed(3)},setpts=(PTS-STARTPTS)/${speed}`,
  ];
  if (info.hasAudio) {
    args.push(
      "-af",
      `atrim=start=${offsetSec.toFixed(3)}:duration=${durationSec.toFixed(3)},asetpts=PTS-STARTPTS,asetrate=${rate},aresample=${info.sampleRate}`
    );
  } else {
    args.push("-an");
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "superfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    "0"
  );
  if (info.hasAudio) {
    args.push("-c:a", "aac", "-b:a", "192k");
  }
  args.push("-movflags", "+faststart", outputPath);
  await runProcess("ffmpeg", args, signal);
}

function formatsFromInfo(info: unknown): YtFormat[] {
  if (!info || typeof info !== "object") return [];
  const record = info as { requested_formats?: YtFormat[]; url?: string };
  if (Array.isArray(record.requested_formats) && record.requested_formats.length > 0) {
    return record.requested_formats;
  }
  if (record.url) return [record as YtFormat];
  return [];
}

export async function tryFastRangeExport(input: FastRangeExportInput): Promise<boolean> {
  const requestedSec = Math.max(0.001, (input.endMs - input.startMs) / 1000);
  const startSec = input.startMs / 1000;
  const endSec = input.endMs / 1000;
  const videoRaw = join(input.tmpDir, `${input.id}_range_v.mp4`);
  const audioRaw = join(input.tmpDir, `${input.id}_range_a.m4a`);
  const videoFixed = join(input.tmpDir, `${input.id}_range_v_fixed.mp4`);
  const audioFixed = join(input.tmpDir, `${input.id}_range_a_fixed.m4a`);
  const merged = join(input.tmpDir, `${input.id}_range_merged.mp4`);
  const tightened = join(input.tmpDir, `${input.id}_range_tight.mp4`);
  const temps = [videoRaw, audioRaw, videoFixed, audioFixed, merged, tightened];

  const removeTemps = async () => {
    await Promise.all(temps.map(async (file) => unlink(file).catch(() => undefined)));
  };

  try {
    let authArgs: string[] = [];
    try {
      authArgs = getYtDlpAuthArgs();
    } catch (error) {
      if (isAbortError(error)) throw error;
      return false;
    }

    for (const attempt of input.formatAttempts) {
      if (input.signal?.aborted) throw createAbortError();
      input.onProgress?.("download", 4, `Resolving source (${attempt.label})...`);
      let info: unknown;
      try {
        info = await dumpJson(
          [
            ...authArgs,
            ...attempt.args,
            "--skip-download",
            "-J",
            "--no-playlist",
            "--no-warnings",
            input.canonicalUrl,
          ],
          input.signal
        );
      } catch (error) {
        if (isAbortError(error)) throw error;
        continue;
      }

      const formats = formatsFromInfo(info);
      const video = formats.find((format) => hasCodec(format.vcodec) && format.url);
      const separateAudio = formats.find(
        (format) => hasCodec(format.acodec) && !hasCodec(format.vcodec) && format.url
      );
      if (!video?.url) continue;

      try {
      const videoPlan = await planTrack(video, startSec, endSec, input.signal);
      if (!videoPlan) continue;
      let audioPlan: TrackPlan | null = null;
      if (separateAudio?.url) {
        audioPlan = await planTrack(separateAudio, videoPlan.origin, videoPlan.end, input.signal);
        if (!audioPlan) continue;
      }

      input.onProgress?.("download", 8, "Downloading selected clip...");
      let videoBytes = 0;
      let audioBytes = 0;
      const report = () => {
        const total = videoBytes + audioBytes;
        const percent = 8 + Math.min(60, total / (1024 * 1024));
        input.onProgress?.("download", percent, "Downloading selected clip...");
      };
      const concurrency = audioPlan ? PARALLEL_TRACK_CONCURRENCY : RANGE_CONCURRENCY;

      let [videoTrack, audioTrack] = await Promise.all([
        downloadPlanned(videoPlan, videoRaw, input.signal, (written) => {
          videoBytes = written;
          report();
        }, concurrency),
        audioPlan
          ? downloadPlanned(audioPlan, audioRaw, input.signal, (written) => {
              audioBytes = written;
              report();
            }, concurrency)
          : Promise.resolve(null),
      ]);
      if (!videoTrack) continue;
      if (audioPlan && videoTrack.origin + 0.05 < audioPlan.origin && separateAudio?.url) {
        const repaired = await planTrack(separateAudio, videoTrack.origin, videoTrack.end, input.signal);
        if (!repaired) continue;
        audioPlan = repaired;
        audioTrack = await downloadPlanned(repaired, audioRaw, input.signal, (written) => {
          audioBytes = written;
          report();
        }, concurrency);
      }
      if (audioPlan && !audioTrack) continue;

      input.onProgress?.("trim", 74, "Assembling clip...");
      await Promise.all([
        remuxCopy(videoTrack.rawPath, videoFixed, input.signal),
        audioTrack ? remuxCopy(audioTrack.rawPath, audioFixed, input.signal) : Promise.resolve(),
      ]);
      let sourcePath = videoFixed;
      let origin = videoTrack.origin;
      if (audioTrack) {
        const videoInfo = await probeMediaFile(videoFixed);
        const audioHead = Math.max(0, videoTrack.origin - audioTrack.origin);
        await runProcess(
          "ffmpeg",
          [
            "-y",
            "-i",
            videoFixed,
            "-ss",
            audioHead.toFixed(3),
            "-t",
            Math.max(0.1, videoInfo.duration).toFixed(3),
            "-i",
            audioFixed,
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            merged,
          ],
          input.signal
        );
        sourcePath = merged;
        origin = videoTrack.origin;
      }

      const offset = Math.max(0, startSec - origin);
      if (input.speed === 1) {
        const tightOk = await tightenCopy(sourcePath, tightened, offset, requestedSec, input.signal).catch(
          () => false
        );
        const candidate = tightOk && existsSync(tightened) ? tightened : sourcePath;
        const probed = await probeMediaFile(candidate);
        if (!durationCoversRequest(probed.duration, requestedSec, COPY_DURATION_SLACK_SEC)) continue;
        if (audioTrack && !probed.hasAudio) continue;
        await copyFile(candidate, input.outputPath);
        input.onProgress?.("trim", 98, "Clip ready");
        return true;
      }

      input.onProgress?.("speed", 90, "Applying 1.5× speed...");
      await renderSpeed(sourcePath, input.outputPath, offset, requestedSec, input.speed, input.signal);
      const sped = await probeMediaFile(input.outputPath);
      const expected = requestedSec / input.speed;
      if (!durationCoversRequest(sped.duration, expected, SPEED_DURATION_SLACK_SEC) || (audioTrack && !sped.hasAudio)) {
        await unlink(input.outputPath).catch(() => undefined);
        continue;
      }
      input.onProgress?.("speed", 98, "Speed effect complete");
      return true;
      } catch (error) {
        if (isAbortError(error)) throw error;
        await unlink(input.outputPath).catch(() => undefined);
        continue;
      }
    }
    return false;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return false;
  } finally {
    await removeTemps();
    if (existsSync(input.outputPath)) {
      const size = await stat(input.outputPath).then((info) => info.size).catch(() => 0);
      if (size <= 0) {
        await unlink(input.outputPath).catch(() => undefined);
      }
    }
  }
}

export async function tryFastLocalExport(input: {
  sourcePath: string;
  outputPath: string;
  startMs: number;
  endMs: number;
  speed: ExportSpeed;
  signal?: AbortSignal;
  onProgress?: (stage: Stage, percent: number, message: string) => void;
}): Promise<boolean> {
  const requestedSec = Math.max(0.001, (input.endMs - input.startMs) / 1000);
  const startSec = Math.max(0, input.startMs / 1000);
  const sourceInfo = await probeMediaFile(input.sourcePath).catch(() => null);
  if (!sourceInfo) return false;

  try {
    if (input.speed === 1) {
      input.onProgress?.("trim", 8, "Trimming uploaded video...");
      const copied = await tightenCopy(
        input.sourcePath,
        input.outputPath,
        startSec,
        requestedSec,
        input.signal
      );
      if (!copied) return false;
      const probed = await probeMediaFile(input.outputPath);
      if (sourceInfo.hasAudio && !probed.hasAudio) return false;
      return durationCoversRequest(probed.duration, requestedSec, COPY_DURATION_SLACK_SEC);
    }

    input.onProgress?.("speed", 30, "Applying 1.5× speed...");
    const rate = Math.round(sourceInfo.sampleRate * input.speed);
    const args = [
      "-y",
      "-ss",
      startSec.toFixed(3),
      "-t",
      requestedSec.toFixed(3),
      "-i",
      input.sourcePath,
      "-vf",
      `setpts=(PTS-STARTPTS)/${input.speed}`,
    ];
    if (sourceInfo.hasAudio) {
      args.push(
        "-af",
        `asetrate=${rate},aresample=${sourceInfo.sampleRate},asetpts=PTS-STARTPTS`,
        "-c:a",
        "aac",
        "-b:a",
        "192k"
      );
    } else {
      args.push("-an");
    }
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "superfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "0",
      "-movflags",
      "+faststart",
      input.outputPath
    );
    await runProcess("ffmpeg", args, input.signal);
    const probed = await probeMediaFile(input.outputPath);
    const expected = requestedSec / input.speed;
    if (sourceInfo.hasAudio && !probed.hasAudio) return false;
    return durationCoversRequest(probed.duration, expected, SPEED_DURATION_SLACK_SEC);
  } catch (error) {
    if (isAbortError(error)) throw error;
    await unlink(input.outputPath).catch(() => undefined);
    return false;
  }
}
