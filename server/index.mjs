import cors from "cors";
import "dotenv/config";
import express from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  captionsHaveWordTimings,
  groupWordsForReels,
  stitchShortCaptionPhrases,
} from "./caption-groups.mjs";
import { finalizeGeneratedCaptionTimeline } from "./generated-caption-timeline.mjs";
import {
  languageTag,
  resolveTranscriptLanguage,
} from "./transcript-language.mjs";
import { alignTranscriptWords } from "./word-aligner.mjs";
import {
  alignmentQualityReport,
  annotateTimingSafety,
  canHighlightGroup,
  chooseBetterAlignment,
} from "../shared/caption-quality.mjs";
import {
  CAPTION_QUALITY_REVISION,
  defaultCaptionCoveragePolicy,
  evaluateCaptionCoverage,
  speechIntervalsFromSilences,
} from "../shared/caption-coverage.mjs";
import { isSupportedLanguageCode } from "../shared/project-contract.mjs";
import { miithiiColors } from "../shared/miithii-tokens.mjs";
import { runTargetedCoverageRecovery } from "./coverage-recovery.mjs";
import {
  acceptedRenderCaptionState,
  validateRenderCaptionSubmission,
} from "./render-coverage.mjs";
import {
  buildExportMediaPolicy,
  exportFrameRateMatchesSource,
  exportVideoArgs,
} from "./export-policy.mjs";
import {
  projectDocumentFromProcessingJob,
  projectProcessingCallbackStatus,
} from "./project-processing-contract.mjs";
import { executeProjectProcessing } from "./project-processing-executor.mjs";
import {
  createProjectProcessingRouter,
  projectJobCapabilityMatches,
} from "./project-processing-routes.mjs";
import { executeProjectRender } from "./project-render-executor.mjs";
import {
  parseProjectRenderRequest,
  putProjectRenderState,
} from "./project-render-protocol.mjs";
import {
  combineSegmentTranscripts,
  parseSilenceIntervals,
  planSpeechSegments,
} from "./speech-segments.mjs";

const app = express();
const port = Number(process.env.PORT ?? 8787);
const captionQualityRevision = CAPTION_QUALITY_REVISION;
// These identify the running code contract. Generic process environment
// variables can collide with hosting/tooling internals, so revisions advance
// with the binary rather than being silently overridden at runtime.
const processorRevision = "syncword-caption-v3";
const rendererRevision = "syncword-render-v2";
const runtimeRoot = path.resolve(
  process.env.RUNTIME_DIR ?? path.join(process.cwd(), ".runtime"),
);
const uploadRoot = path.join(runtimeRoot, "incoming");
const jobsRoot = path.join(runtimeRoot, "jobs");
const projectProcessingRoot = path.join(runtimeRoot, "project-processing");
const projectRendersRoot = path.join(runtimeRoot, "project-renders");
const sarvamBaseUrl =
  process.env.SARVAM_BASE_URL ?? "https://api.sarvam.ai";
const sarvamModel = process.env.SARVAM_MODEL ?? "saaras:v3";
const defaultModalAlignerUrl =
  "https://dhrubasumatary--syncword-aligner-alignment-api.modal.run";
const jobs = new Map();
const projectProcessingJobs = new Map();
const projectRenderJobs = new Map();
const taskQueue = [];
const persistenceQueue = new Map();
const remoteSyncQueue = new Map();
const configuredRetentionHours = Number(
  process.env.JOB_RETENTION_HOURS ?? 24,
);
const jobLifetimeMs =
  (Number.isFinite(configuredRetentionHours)
    ? Math.max(1, Math.min(168, configuredRetentionHours))
    : 24) *
  60 *
  60 *
  1000;
const configuredQueueLimit = Number(process.env.MAX_QUEUED_JOBS ?? 4);
const maxQueuedJobs = Number.isFinite(configuredQueueLimit)
  ? Math.max(1, Math.min(20, configuredQueueLimit))
  : 4;
let queueRunning = false;

await Promise.all([
  mkdir(uploadRoot, { recursive: true }),
  mkdir(jobsRoot, { recursive: true }),
  mkdir(projectProcessingRoot, { recursive: true }),
  mkdir(projectRendersRoot, { recursive: true }),
]);

const configuredOrigins = (process.env.ALLOWED_ORIGINS ?? "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (
        !origin ||
        configuredOrigins.includes("*") ||
        configuredOrigins.includes(origin)
      ) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed"));
    },
  }),
);
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  dest: uploadRoot,
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 524_288_000),
    files: 1,
  },
});

function publicJob(job) {
  const captions = captionsHaveWordTimings(job.captions)
    ? job.captions
    : [];
  return {
    id: job.id,
    captionQualityRevision,
    status: job.status,
    progress: job.progress,
    message: job.message,
    captions,
    alignment: job.alignment,
    languageCode: job.languageCode,
    style: job.style,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    queuePosition:
      job.status === "queued"
        ? Math.max(
            1,
            taskQueue.findIndex((item) => item.job.id === job.id) + 1,
          )
        : undefined,
    previewUrl:
      job.status === "complete"
        ? `/v1/jobs/${job.id}/result`
        : undefined,
    downloadUrl:
      job.status === "complete" ? `/v1/jobs/${job.id}/download` : undefined,
    assUrl:
      ["ready", "rendering", "complete"].includes(job.status) &&
      job.assPath
        ? `/v1/jobs/${job.id}/captions.ass`
        : undefined,
  };
}

function persistJob(job) {
  const snapshot = JSON.stringify(job, null, 2);
  const previous = persistenceQueue.get(job.id) ?? Promise.resolve();
  const pending = previous
    .catch(() => {})
    .then(() =>
      writeFile(path.join(job.directory, "job.json"), snapshot, "utf8"),
    )
    .catch((error) => {
      console.error(`Could not persist job ${job.id}:`, error);
    });
  persistenceQueue.set(job.id, pending);
  return pending;
}

function updateJob(job, status, progress, message) {
  Object.assign(job, {
    status,
    progress,
    message,
    updatedAt: new Date().toISOString(),
  });
  void persistJob(job);
  void syncRemoteJob(job);
  if (typeof job.projectProcessingStateCallback === "function") {
    void Promise.resolve(
      job.projectProcessingStateCallback({ status, progress, message }),
    ).catch((error) => {
      console.error(`Could not sync project processing job ${job.id}:`, error);
    });
  }
}

function remoteAuthorization(job) {
  return {
    authorization: `Bearer ${job.remote.capabilityToken}`,
    ...(job.remote.sitesAuthorization
      ? {
          "oai-sites-authorization": `Bearer ${job.remote.sitesAuthorization}`,
        }
      : {}),
  };
}

function syncRemoteJob(job) {
  if (!job.remote) return Promise.resolve();
  const snapshot = publicJob(job);
  const previous = remoteSyncQueue.get(job.id) ?? Promise.resolve();
  const pending = previous
    .catch(() => {})
    .then(async () => {
      const response = await fetch(`${job.remote.callbackBase}/state`, {
        method: "PUT",
        headers: {
          ...remoteAuthorization(job),
          "content-type": "application/json",
        },
        body: JSON.stringify(snapshot),
      });
      if (!response.ok) {
        throw new Error(`Remote state callback returned ${response.status}.`);
      }
    })
    .catch((error) => {
      console.error(`Could not sync remote job ${job.id}:`, error);
    });
  remoteSyncQueue.set(job.id, pending);
  return pending;
}

async function uploadRemoteArtifact(job, artifact, filePath, contentType) {
  if (!job.remote) return;
  const response = await fetch(`${job.remote.callbackBase}/${artifact}`, {
    method: "PUT",
    headers: {
      ...remoteAuthorization(job),
      "content-type": contentType,
    },
    body: await readFile(filePath),
    signal: ensureJobRuntime(job).abortController.signal,
  });
  throwIfCancelled(job);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Could not save ${artifact} to durable storage (${response.status}). ${detail}`.trim(),
    );
  }
}

function isCancelled(job) {
  return Boolean(job) && (job.cancelRequested === true || job.status === "cancelled");
}

function cancelledError() {
  const error = new Error("Processing cancelled.");
  error.code = "SYNCWORD_CANCELLED";
  return error;
}

function throwIfCancelled(job) {
  if (isCancelled(job)) throw cancelledError();
}

function ensureJobRuntime(job) {
  if (!job.abortController) {
    Object.defineProperty(job, "abortController", {
      value: new AbortController(),
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  if (!job.children) {
    Object.defineProperty(job, "children", {
      value: new Set(),
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  return job;
}

function trackChild(job, child) {
  if (!job) return;
  ensureJobRuntime(job).children.add(child);
  child.once("close", () => job.children.delete(child));
}

function removeQueuedTasks(job) {
  for (let index = taskQueue.length - 1; index >= 0; index -= 1) {
    if (taskQueue[index].job.id === job.id) taskQueue.splice(index, 1);
  }
}

function cancelJob(job) {
  if (isCancelled(job) || ["complete", "failed"].includes(job.status)) {
    return false;
  }
  job.cancelRequested = true;
  removeQueuedTasks(job);
  ensureJobRuntime(job).abortController.abort();
  for (const child of job.children) child.kill("SIGTERM");
  job.expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  updateJob(job, "cancelled", job.progress, "Processing cancelled");
  return true;
}

async function removeJob(job) {
  removeQueuedTasks(job);
  jobs.delete(job.id);
  await rm(job.directory, { recursive: true, force: true });
}

async function cleanupExpiredJobs() {
  const now = Date.now();
  const expired = [...jobs.values()].filter(
    (job) =>
      !["extracting", "transcribing", "rendering"].includes(job.status) &&
      Date.parse(job.expiresAt ?? 0) <= now,
  );
  await Promise.all(expired.map(removeJob));
}

async function restoreJobs() {
  const entries = await readdir(jobsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(jobsRoot, entry.name);
    try {
      const job = JSON.parse(
        await readFile(path.join(directory, "job.json"), "utf8"),
      );
      if (!job?.id || Date.parse(job.expiresAt ?? 0) <= Date.now()) {
        await rm(directory, { recursive: true, force: true });
        continue;
      }
      job.directory = directory;
      job.mode = ["codemix", "verbatim", "transcribe"].includes(job.mode)
        ? job.mode
        : "codemix";
      ensureJobRuntime(job);
      for (const pathKey of [
        "inputPath",
        "transcriptPath",
        "coverageRecoveryPath",
        "assPath",
        "outputPath",
      ]) {
        if (job[pathKey]) {
          job[pathKey] = path.join(directory, path.basename(job[pathKey]));
        }
      }
      if (
        ["queued", "extracting", "transcribing", "rendering"].includes(
          job.status,
        )
      ) {
        Object.assign(job, {
          status: "failed",
          message:
            "The render service restarted during processing. Upload the video again.",
          updatedAt: new Date().toISOString(),
        });
        await persistJob(job);
      }
      jobs.set(job.id, job);
    } catch (error) {
      console.warn(`Skipping unreadable job directory ${entry.name}:`, error);
    }
  }
}

async function drainQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (taskQueue.length) {
    const task = taskQueue.shift();
    if (isCancelled(task.job)) continue;
    try {
      await task.run();
    } catch (error) {
      if (isCancelled(task.job)) continue;
      updateJob(
        task.job,
        "failed",
        task.job.progress,
        error instanceof Error ? error.message : "Processing failed.",
      );
    }
  }
  queueRunning = false;
}

function enqueue(job, runTask) {
  if (isCancelled(job)) return;
  taskQueue.push({ job, run: runTask });
  void drainQueue();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { job, ...spawnOptions } = options;
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      ...spawnOptions,
    });
    trackChild(job, child);
    let errorOutput = "";
    child.stderr.on("data", (chunk) => {
      errorOutput = `${errorOutput}${chunk.toString()}`.slice(-12_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (job && isCancelled(job)) {
        reject(cancelledError());
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} exited with code ${code}. ${errorOutput}`.trim(),
          ),
        );
      }
    });
  });
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { job, ...spawnOptions } = options;
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
    });
    trackChild(job, child);
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk.toString()}`;
    });
    child.stderr.on("data", (chunk) => {
      errorOutput = `${errorOutput}${chunk.toString()}`.slice(-12_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (job && isCancelled(job)) {
        reject(cancelledError());
        return;
      }
      if (code === 0) {
        resolve(output);
      } else {
        reject(
          new Error(
            `${command} exited with code ${code}. ${errorOutput}`.trim(),
          ),
        );
      }
    });
  });
}

function runCaptureStreams(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { job, ...spawnOptions } = options;
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
    });
    trackChild(job, child);
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-24_000);
    });
    child.stderr.on("data", (chunk) => {
      errorOutput = `${errorOutput}${chunk.toString()}`.slice(-24_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (job && isCancelled(job)) {
        reject(cancelledError());
        return;
      }
      if (code === 0) {
        resolve({ stdout: output, stderr: errorOutput });
      } else {
        reject(
          new Error(
            `${command} exited with code ${code}. ${errorOutput}`.trim(),
          ),
        );
      }
    });
  });
}

async function probeVideo(job) {
  const output = await runCapture(
    process.env.FFPROBE_PATH ?? "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name,profile,width,height,r_frame_rate,duration,sample_rate,channels:format=duration,format_name",
      "-of",
      "json",
      path.basename(job.inputPath),
    ],
    { cwd: job.directory, job },
  );
  const probe = JSON.parse(output);
  const stream = probe.streams?.find(
    (candidate) => candidate.codec_type === "video",
  );
  const audioStream = probe.streams?.find(
    (candidate) => candidate.codec_type === "audio",
  );
  if (!stream?.width || !stream?.height) {
    throw new Error("The upload does not contain a readable video stream.");
  }
  const duration = Number(probe.format?.duration);
  const maxDuration = Number(
    process.env.MAX_VIDEO_DURATION_SECONDS ?? 600,
  );
  if (
    Number.isFinite(duration) &&
    Number.isFinite(maxDuration) &&
    duration > maxDuration
  ) {
    throw new Error(
      `Keep this reel under ${Math.floor(maxDuration / 60)} minutes for the hobby beta.`,
    );
  }
  job.video = {
    width: Number(stream.width),
    height: Number(stream.height),
    frameRate: String(stream.r_frame_rate ?? ""),
    duration: Number.isFinite(duration) ? duration : undefined,
    streamDuration: Number.isFinite(Number(stream.duration))
      ? Number(stream.duration)
      : undefined,
    formatName: String(probe.format?.format_name ?? ""),
    ...(audioStream
      ? {
          audio: {
            codecName: String(audioStream.codec_name ?? ""),
            profile: String(audioStream.profile ?? ""),
            sampleRate: Number.isFinite(Number(audioStream.sample_rate))
              ? Number(audioStream.sample_rate)
              : undefined,
            channels: Number.isFinite(Number(audioStream.channels))
              ? Number(audioStream.channels)
              : undefined,
            duration: Number.isFinite(Number(audioStream.duration))
              ? Number(audioStream.duration)
              : undefined,
          },
        }
      : {}),
  };
  void persistJob(job);
}

async function sarvamJson(endpoint, options = {}, job) {
  throwIfCancelled(job);
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey && sarvamBaseUrl === "https://api.sarvam.ai") {
    throw new Error(
      "SARVAM_API_KEY is not configured on the render service.",
    );
  }

  const response = await fetch(`${sarvamBaseUrl}${endpoint}`, {
    ...options,
    signal: job ? ensureJobRuntime(job).abortController.signal : options.signal,
    headers: {
      ...(apiKey ? { "api-subscription-key": apiKey } : {}),
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  throwIfCancelled(job);

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { detail: text };
  }

  if (!response.ok) {
    const reason =
      payload?.detail ??
      payload?.message ??
      payload?.error_message ??
      `Sarvam API returned ${response.status}`;
    throw new Error(
      typeof reason === "string" ? reason : JSON.stringify(reason),
    );
  }

  return payload;
}

function resolveStorageUrl(record) {
  if (typeof record === "string") return record;
  return (
    record?.file_url ??
    record?.url ??
    record?.upload_url ??
    record?.download_url ??
    ""
  );
}

async function uploadAudio(job, jobId, fileName, audioPath, storageType) {
  const uploadResponse = await sarvamJson(
    "/speech-to-text/job/v1/upload-files",
    {
      method: "POST",
      body: JSON.stringify({ job_id: jobId, files: [fileName] }),
    },
    job,
  );
  const target = resolveStorageUrl(uploadResponse.upload_urls?.[fileName]);
  if (!target) throw new Error("Sarvam did not return an audio upload URL.");

  const audio = await readFile(audioPath);
  const headers = { "content-type": "audio/wav" };
  if (String(storageType).toLowerCase().includes("azure")) {
    headers["x-ms-blob-type"] = "BlockBlob";
  }

  const response = await fetch(target, {
    method: "PUT",
    headers,
    body: audio,
    signal: ensureJobRuntime(job).abortController.signal,
  });
  throwIfCancelled(job);
  if (!response.ok) {
    throw new Error(`Audio upload failed with status ${response.status}.`);
  }
}

async function waitForSarvamJob(
  job,
  sarvamJobId,
  progressFloor = 31,
) {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    throwIfCancelled(job);
    const status = await sarvamJson(
      `/speech-to-text/job/v1/${encodeURIComponent(sarvamJobId)}/status`,
      { method: "GET" },
      job,
    );
    const state = String(status.job_state ?? "").toLowerCase();
    updateJob(
      job,
      "transcribing",
      Math.min(
        76,
        Math.max(progressFloor, 31 + Math.floor(attempt / 3)),
      ),
      state === "running"
        ? "Finding the spoken phrases"
        : "Creating captions from the speech",
    );

    if (["completed", "partiallycompleted"].includes(state)) return status;
    if (state === "failed") {
      throw new Error(
        status.error_message || "Sarvam Batch transcription failed.",
      );
    }
    await sleep(5000);
  }
  throw new Error("Sarvam Batch did not finish within 30 minutes.");
}

function transcriptToCaptions(transcript, requestedLanguage) {
  const captionLanguage = languageTag(
    resolveTranscriptLanguage(
      transcript.language_code,
      requestedLanguage,
    ),
  );
  const timestamps =
    transcript.timestamps ??
    transcript.diarized_transcript?.timestamps ??
    transcript.diarized_transcript;
  const chunks =
    timestamps?.chunks ??
    timestamps?.words ??
    timestamps?.text ??
    [];
  const starts =
    timestamps?.start_time_seconds ??
    timestamps?.start_times ??
    timestamps?.starts ??
    [];
  const ends =
    timestamps?.end_time_seconds ??
    timestamps?.end_times ??
    timestamps?.ends ??
    [];
  const sourceSegmentIds = timestamps?.source_segment_ids ?? [];

  if (
    Array.isArray(chunks) &&
    Array.isArray(starts) &&
    Array.isArray(ends) &&
    chunks.length
  ) {
    return chunks
      .map((text, index) => ({
        id: `stt-${index + 1}`,
        start: Number(starts[index]),
        end: Number(ends[index]),
        text: String(text).trim(),
        language: captionLanguage,
        ...(sourceSegmentIds[index]
          ? {
              _source_segment_id: String(sourceSegmentIds[index]),
              _alignment_padding_before: 0.45,
              _alignment_padding_after: 0.45,
            }
          : {}),
      }))
      .filter(
        (caption) =>
          caption.text &&
          Number.isFinite(caption.start) &&
          Number.isFinite(caption.end) &&
          caption.end > caption.start,
      );
  }

  const entries =
    transcript.diarized_transcript?.entries ??
    transcript.diarized_transcript?.segments ??
    [];
  if (Array.isArray(entries) && entries.length) {
    return entries
      .map((entry, index) => ({
        id: `speaker-${index + 1}`,
        start: Number(entry.start_time_seconds ?? entry.start),
        end: Number(entry.end_time_seconds ?? entry.end),
        text: String(entry.transcript ?? entry.text ?? "").trim(),
        language: captionLanguage,
      }))
      .filter(
        (caption) =>
          caption.text &&
          Number.isFinite(caption.start) &&
          Number.isFinite(caption.end) &&
          caption.end > caption.start,
      );
  }

  throw new Error(
    "Sarvam returned a transcript without usable chunk timestamps.",
  );
}

async function prepareSpeechAnalysis(job) {
  if (
    Array.isArray(job.speechAnalysis?.speechIntervals) &&
    Array.isArray(job.speechAnalysis?.silenceIntervals)
  ) {
    return job.speechAnalysis;
  }
  const duration = Number(job.video?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("The video duration is unavailable for speech timing.");
  }
  const detected = await runCaptureStreams(
    process.env.FFMPEG_PATH ?? "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      "audio.wav",
      "-af",
      "silencedetect=noise=-35dB:d=0.22",
      "-f",
      "null",
      "-",
    ],
    { cwd: job.directory, job },
  );
  const silences = parseSilenceIntervals(detected.stderr, duration);
  const speechIntervals = speechIntervalsFromSilences(duration, silences);
  job.speechAnalysis = {
    revision: "ffmpeg-silencedetect-v1",
    durationSeconds: duration,
    silenceIntervals: silences,
    speechIntervals,
  };
  void persistJob(job);
  return job.speechAnalysis;
}

async function prepareSpeechSegments(job) {
  const speechAnalysis = await prepareSpeechAnalysis(job);
  if (Array.isArray(job.speechSegments) && job.speechSegments.length) {
    return job.speechSegments;
  }

  const duration = Number(speechAnalysis.durationSeconds);
  const plan = planSpeechSegments(
    duration,
    speechAnalysis.silenceIntervals,
  );

  for (const [index, segment] of plan.entries()) {
    const fileName = `speech-segment-${index + 1}.wav`;
    await run(
      process.env.FFMPEG_PATH ?? "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        String(segment.start),
        "-t",
        String(segment.duration),
        "-i",
        "audio.wav",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        fileName,
      ],
      { cwd: job.directory, job },
    );
    segment.fileName = fileName;
  }

  job.speechSegments = plan;
  console.info(
    JSON.stringify({
      event: "speech_segments_ready",
      jobId: job.id,
      durationSeconds: duration,
      silenceCount: speechAnalysis.silenceIntervals.length,
      speechIntervalCount: speechAnalysis.speechIntervals.length,
      segmentCount: plan.length,
      segments: plan.map(({ start, end, duration: segmentDuration }) => ({
        start,
        end,
        duration: segmentDuration,
      })),
    }),
  );
  void persistJob(job);
  return plan;
}

async function sarvamRestTranscript(job, segment, mode) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey && sarvamBaseUrl === "https://api.sarvam.ai") {
    throw new Error(
      "SARVAM_API_KEY is not configured on the render service.",
    );
  }

  const audio = await readFile(path.join(job.directory, segment.fileName));

  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfCancelled(job);
    // A Fetch multipart body is single-use. Rebuild it for every retry so a
    // transient 429/5xx does not turn the next attempt into an empty upload.
    const payload = new FormData();
    payload.append(
      "file",
      new Blob([audio], { type: "audio/wav" }),
      segment.fileName,
    );
    payload.append("model", sarvamModel);
    payload.append("mode", mode);
    payload.append("language_code", job.language);
    payload.append("with_timestamps", "true");
    const response = await fetch(`${sarvamBaseUrl}/speech-to-text`, {
      method: "POST",
      headers: {
        ...(apiKey ? { "api-subscription-key": apiKey } : {}),
      },
      body: payload,
      signal: ensureJobRuntime(job).abortController.signal,
    });
    throwIfCancelled(job);
    const text = await response.text();
    let result;
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      result = { detail: text };
    }
    if (response.ok) return result;

    const reason =
      result?.detail ??
      result?.message ??
      result?.error_message ??
      `Sarvam REST returned ${response.status}`;
    lastError = new Error(
      typeof reason === "string" ? reason : JSON.stringify(reason),
    );
    if (
      ![429, 500, 502, 503, 504].includes(response.status) ||
      attempt === 2
    ) {
      throw lastError;
    }
    await sleep(700 * 2 ** attempt);
  }
  throw lastError ?? new Error("Sarvam REST transcription failed.");
}

function segmentTranscriptResult(job, segment, response) {
  let captions = [];
  if (String(response?.transcript ?? "").trim()) {
    try {
      captions = transcriptToCaptions(response, job.language);
    } catch {
      captions = [
        {
          id: `${segment.id}-phrase`,
          start: 0,
          end: segment.duration,
          text: String(response.transcript).trim(),
          language: languageTag(
            resolveTranscriptLanguage(
              response.language_code,
              job.language,
            ),
          ),
        },
      ];
    }
  }
  return {
    segment,
    languageCode: resolveTranscriptLanguage(
      response?.language_code,
      job.language,
    ),
    captions,
    response,
  };
}

async function runSegmentedSarvamTranscript(
  job,
  mode,
  progressFloor = 24,
) {
  updateJob(
    job,
    "transcribing",
    progressFloor,
    mode === "verbatim"
      ? "Double-checking difficult speech"
      : "Listening section by section",
  );
  const segments = await prepareSpeechSegments(job);
  const results = new Array(segments.length);
  const concurrency = Math.max(
    1,
    Math.min(3, Number(process.env.SARVAM_SEGMENT_CONCURRENCY ?? 2)),
  );
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < segments.length) {
      const index = nextIndex;
      nextIndex += 1;
      const segment = segments[index];
      const response = await sarvamRestTranscript(job, segment, mode);
      results[index] = segmentTranscriptResult(job, segment, response);
      completed += 1;
      updateJob(
        job,
        "transcribing",
        Math.min(
          67,
          Math.max(
            progressFloor,
            progressFloor +
              Math.floor((completed / Math.max(1, segments.length)) * 35),
          ),
        ),
        mode === "verbatim"
          ? "Double-checking difficult speech"
          : "Building accurate speech windows",
      );
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, segments.length) },
      () => worker(),
    ),
  );
  const combined = combineSegmentTranscripts(results, job.language);
  if (!combined.timestamps.words.length) {
    throw new Error("No spoken captions were found in this video.");
  }
  console.info(
    JSON.stringify({
      event: "segmented_transcript_ready",
      jobId: job.id,
      mode,
      segmentCount: segments.length,
      phraseCount: combined.timestamps.words.length,
      transcriptCharacters: combined.transcript.length,
    }),
  );
  return combined;
}

async function runPreferredSarvamTranscript(
  job,
  mode,
  progressFloor = 24,
) {
  const segmentedEnabled =
    String(process.env.SARVAM_SEGMENTED_STT ?? "true").toLowerCase() !==
    "false";
  if (segmentedEnabled) {
    try {
      job.sarvamTransport = "rest-segmented";
      return await runSegmentedSarvamTranscript(job, mode, progressFloor);
    } catch (error) {
      if (isCancelled(job)) throw error;
      console.error(
        JSON.stringify({
          event: "segmented_transcript_failed",
          jobId: job.id,
          mode,
          message:
            error instanceof Error ? error.message : "Unknown REST error",
        }),
      );
      updateJob(
        job,
        "transcribing",
        progressFloor,
        "Retrying the speech safely",
      );
    }
  }
  job.sarvamTransport = "batch";
  return runSarvamTranscript(job, mode, progressFloor);
}

async function downloadTranscript(job, sarvamJobId, status) {
  const outputFiles = (status.job_details ?? [])
    .flatMap((detail) => detail.outputs ?? [])
    .map((output) => output.file_name)
    .filter(Boolean);

  if (!outputFiles.length) {
    throw new Error("Sarvam completed without an output transcript file.");
  }

  const response = await sarvamJson(
    "/speech-to-text/job/v1/download-files",
    {
      method: "POST",
      body: JSON.stringify({ job_id: sarvamJobId, files: outputFiles }),
    },
    job,
  );

  const source = resolveStorageUrl(response.download_urls?.[outputFiles[0]]);
  if (!source) throw new Error("Sarvam did not return a transcript URL.");

  const transcriptResponse = await fetch(source, {
    signal: ensureJobRuntime(job).abortController.signal,
  });
  throwIfCancelled(job);
  if (!transcriptResponse.ok) {
    throw new Error(
      `Transcript download failed with status ${transcriptResponse.status}.`,
    );
  }
  return transcriptResponse.json();
}

function modalAlignerEndpoint() {
  const configured = String(
    process.env.MODAL_ALIGNER_URL ?? defaultModalAlignerUrl,
  )
    .trim()
    .replace(/\/+$/, "");
  if (!configured) return "";
  return configured.endsWith("/v1/align")
    ? configured
    : `${configured}/v1/align`;
}

async function alignTranscriptWithModal(
  job,
  {
    captions: rawCaptions = job.captions,
    displayCaptions = null,
    progress = 76,
  } = {},
) {
  const endpoint = modalAlignerEndpoint();
  if (!endpoint) return null;

  const audio = await readFile(path.join(job.directory, "audio.wav"));
  const captions = rawCaptions.map(({ words: _words, ...caption }) => {
    void _words;
    return caption;
  });
  const payload = new FormData();
  payload.append(
    "audio",
    new Blob([audio], { type: "audio/wav" }),
    `${job.id}.wav`,
  );
  payload.append("captions", JSON.stringify(captions));
  if (Array.isArray(displayCaptions) && displayCaptions.length) {
    payload.append(
      "display_captions",
      JSON.stringify(
        displayCaptions.map(({ words: _words, ...caption }) => {
          void _words;
          return caption;
        }),
      ),
    );
  }

  updateJob(
    job,
    "transcribing",
    progress,
    "Syncing captions to the voice",
  );
  const response = await fetch(endpoint, {
    method: "POST",
    body: payload,
    signal: ensureJobRuntime(job).abortController.signal,
  });
  throwIfCancelled(job);

  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    result = { detail: text };
  }
  if (!response.ok) {
    const reason =
      result?.detail ??
      result?.error ??
      `GPU aligner returned ${response.status}`;
    throw new Error(
      typeof reason === "string" ? reason : JSON.stringify(reason),
    );
  }
  if (!captionsHaveWordTimings(result?.captions)) {
    throw new Error("GPU aligner returned incomplete word timings.");
  }
  if (
    !result?.alignment ||
    !Number.isFinite(Number(result.alignment.totalWords))
  ) {
    throw new Error("GPU aligner returned an incomplete alignment summary.");
  }
  return {
    captions: result.captions,
    summary: result.alignment,
  };
}

async function runSarvamTranscript(job, mode, progressFloor = 24) {
  updateJob(
    job,
    "transcribing",
    progressFloor,
    mode === "verbatim"
      ? "Double-checking difficult speech"
      : "Creating captions from the speech",
  );
  const audioFileName = `${job.id}-${mode}.wav`;
  const init = await sarvamJson(
    "/speech-to-text/job/v1",
    {
      method: "POST",
      body: JSON.stringify({
        job_parameters: {
          model: sarvamModel,
          mode,
          language_code: job.language,
          with_timestamps: true,
          with_diarization: false,
        },
      }),
    },
    job,
  );

  job.sarvamJobId = init.job_id;
  job.sarvamJobIds = [...(job.sarvamJobIds ?? []), init.job_id];
  await uploadAudio(
    job,
    init.job_id,
    audioFileName,
    path.join(job.directory, "audio.wav"),
    init.storage_container_type,
  );
  await sarvamJson(
    `/speech-to-text/job/v1/${encodeURIComponent(init.job_id)}/start`,
    { method: "POST", body: "{}" },
    job,
  );

  updateJob(
    job,
    "transcribing",
    Math.max(32, progressFloor),
    "Finding the spoken phrases",
  );
  const status = await waitForSarvamJob(
    job,
    init.job_id,
    Math.max(31, progressFloor),
  );
  return downloadTranscript(job, init.job_id, status);
}

function captionCoveragePolicy() {
  return {
    minimumCoverageRatio: Number(
      process.env.MIN_SPEECH_CAPTION_COVERAGE ??
        defaultCaptionCoveragePolicy.minimumCoverageRatio,
    ),
    maximumUncoveredGapSeconds: Number(
      process.env.MAX_UNCOVERED_SPEECH_GAP_SECONDS ??
        defaultCaptionCoveragePolicy.maximumUncoveredGapSeconds,
    ),
  };
}

function captionCoverageReport(job, captions) {
  return evaluateCaptionCoverage(
    job.speechAnalysis?.speechIntervals ?? [],
    captions,
    {
      durationSeconds: Number(job.video?.duration),
      policy: captionCoveragePolicy(),
    },
  );
}

function renderCaptionSubmissionDecision(job, captions) {
  return validateRenderCaptionSubmission({
    status: job.status,
    persistedCoverage: job.alignment?.coverage,
    captions,
    durationSeconds: Number(job.video?.duration),
    policy: captionCoveragePolicy(),
  });
}

function rejectRenderCaptionSubmission(response, decision) {
  response.status(409).json({
    error: decision.error,
    code: decision.code,
    coverage: decision.coverage,
    uncoveredIntervals: decision.uncoveredIntervals,
  });
}

function acceptRenderCaptionSubmission(job, captions, decision) {
  const state = acceptedRenderCaptionState({
    status: job.status,
    alignment: job.alignment,
    captions,
    decision,
  });
  job.captions = state.captions;
  job.alignment = state.alignment;
}

async function ensurePcmAudio(job) {
  const audioPath = path.join(job.directory, "audio.pcm");
  try {
    await readFile(audioPath);
    return audioPath;
  } catch {
    await run(
      process.env.FFMPEG_PATH ?? "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        "audio.wav",
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ac",
        "1",
        "-ar",
        "16000",
        "audio.pcm",
      ],
      { cwd: job.directory, job },
    );
    return audioPath;
  }
}

async function alignCoverageRecoveryCandidate(
  job,
  captions,
  displayCaptions,
) {
  try {
    const modalAlignment = await alignTranscriptWithModal(job, {
      captions,
      displayCaptions,
      progress: 80,
    });
    if (modalAlignment) return modalAlignment;
  } catch (error) {
    const requiresGpu =
      String(process.env.MODAL_ALIGNMENT_REQUIRED ?? "true").toLowerCase() !==
      "false";
    if (requiresGpu) throw error;
    console.error(
      "Coverage recovery GPU alignment failed; using local fallback.",
      error,
    );
  }

  await ensurePcmAudio(job);
  throwIfCancelled(job);
  return alignTranscriptWords(
    captions,
    await readFile(path.join(job.directory, "audio.pcm")),
    { sampleRate: 16_000, frameMs: 20 },
  );
}

async function transcribeCoverageWindows(job, windows) {
  const segments = [];
  for (const window of windows) {
    const segment = {
      ...window,
      fileName: `${window.id}.wav`,
    };
    await run(
      process.env.FFMPEG_PATH ?? "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        String(segment.start),
        "-t",
        String(segment.duration),
        "-i",
        "audio.wav",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        segment.fileName,
      ],
      { cwd: job.directory, job },
    );
    segments.push(segment);
  }

  const results = new Array(segments.length);
  const configuredConcurrency = Number(
    process.env.SARVAM_COVERAGE_RECOVERY_CONCURRENCY ?? 2,
  );
  const concurrency = Number.isFinite(configuredConcurrency)
    ? Math.max(1, Math.min(2, Math.floor(configuredConcurrency)))
    : 2;
  const mode = job.mode === "codemix" ? "verbatim" : job.mode;
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < segments.length) {
      const index = nextIndex;
      nextIndex += 1;
      const segment = segments[index];
      const response = await sarvamRestTranscript(job, segment, mode);
      results[index] = segmentTranscriptResult(job, segment, response);
      completed += 1;
      updateJob(
        job,
        "transcribing",
        Math.min(80, 77 + Math.floor((completed / segments.length) * 3)),
        "Recovering missed speech",
      );
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, segments.length) },
      () => worker(),
    ),
  );
  return combineSegmentTranscripts(results, job.language);
}

async function recoverSpeechCoverage(job, aligned) {
  await prepareSpeechAnalysis(job);
  const primaryCoverage = captionCoverageReport(job, aligned.captions);
  let attemptedWindows = [];
  try {
    const result = await runTargetedCoverageRecovery({
      alignment: aligned,
      speechIntervals: job.speechAnalysis.speechIntervals,
      durationSeconds: Number(job.video?.duration),
      policy: captionCoveragePolicy(),
      recoveryWindowOptions: {
        paddingSeconds: Number(
          process.env.SPEECH_COVERAGE_RETRY_PADDING_SECONDS ?? 0.45,
        ),
        maximumWindows: Number(
          process.env.MAX_SPEECH_COVERAGE_RETRY_WINDOWS ?? 8,
        ),
      },
      transcribeWindows: async (windows) => {
        attemptedWindows = windows;
        updateJob(job, "transcribing", 77, "Recovering missed speech");
        console.info(
          JSON.stringify({
            event: "speech_coverage_recovery_started",
            jobId: job.id,
            coverageRatio: primaryCoverage.coverageRatio,
            largestUncoveredGapSeconds:
              primaryCoverage.largestUncoveredGapSeconds,
            windows: windows.map(({ start, end, duration }) => ({
              start,
              end,
              duration,
            })),
          }),
        );
        const transcript = await transcribeCoverageWindows(job, windows);
        return {
          transcript,
          captions: transcriptToCaptions(transcript, job.language),
        };
      },
      alignCaptions: (captions) =>
        alignCoverageRecoveryCandidate(job, captions, captions),
    });

    if (result.recovery.attempted) {
      const artifact = {
        revision: "targeted-speech-coverage-recovery-v1",
        windows: result.windows,
        transcript: result.transcriptResult?.transcript,
        addedCaptionCount: result.recovery.addedCaptionCount,
        selected: result.recovery.selected,
        primaryCoverage: result.primaryCoverage,
        candidateCoverage: result.candidateCoverage,
      };
      job.coverageRecoveryPath = path.join(
        job.directory,
        "coverage-recovery.json",
      );
      await writeFile(
        job.coverageRecoveryPath,
        JSON.stringify(artifact, null, 2),
        "utf8",
      );
      console.info(
        JSON.stringify({
          event: "speech_coverage_recovery_finished",
          jobId: job.id,
          selected: result.recovery.selected,
          addedCaptionCount: result.recovery.addedCaptionCount,
          primaryCoverageRatio: result.primaryCoverage.coverageRatio,
          candidateCoverageRatio:
            result.candidateCoverage?.coverageRatio ??
            result.primaryCoverage.coverageRatio,
          primaryLargestGapSeconds:
            result.primaryCoverage.largestUncoveredGapSeconds,
          candidateLargestGapSeconds:
            result.candidateCoverage?.largestUncoveredGapSeconds ??
            result.primaryCoverage.largestUncoveredGapSeconds,
        }),
      );
    }
    return {
      aligned: result.alignment,
      coverage: result.coverage,
      recovery: result.recovery,
    };
  } catch (error) {
    if (isCancelled(job)) throw error;
    const recovery = {
      attempted: attemptedWindows.length > 0,
      selected: false,
      windowCount: attemptedWindows.length,
      addedCaptionCount: 0,
      error: error instanceof Error ? error.message : "Unknown recovery error",
    };
    console.error(
      JSON.stringify({
        event: "speech_coverage_recovery_failed",
        jobId: job.id,
        message: recovery.error,
      }),
    );
    return { aligned, coverage: primaryCoverage, recovery };
  }
}

async function transcribe(job) {
  try {
    ensureJobRuntime(job);
    updateJob(job, "extracting", 7, "Inspecting the video");
    await probeVideo(job);
    throwIfCancelled(job);
    updateJob(job, "extracting", 10, "Extracting clean mono audio");
    await run(
      process.env.FFMPEG_PATH ?? "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        path.basename(job.inputPath),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "audio.wav",
      ],
      { cwd: job.directory, job },
    );
    throwIfCancelled(job);

    const transcript = await runPreferredSarvamTranscript(
      job,
      job.mode ?? "codemix",
    );
    job.languageCode = resolveTranscriptLanguage(
      transcript.language_code,
      job.language,
    );
    job.captions = transcriptToCaptions(transcript, job.language);
    job.transcriptPath = path.join(job.directory, "transcript.json");
    await writeFile(
      job.transcriptPath,
      JSON.stringify(transcript, null, 2),
      "utf8",
    );
    let aligned;
    let transcriptRecoveryAttempted = false;
    let transcriptRecoverySelected = false;
    try {
      aligned = await alignTranscriptWithModal(job);
      const primaryQuality = alignmentQualityReport(aligned);
      if (
        job.mode === "codemix" &&
        (
          Number(aligned?.summary?.recoveredWords) > 0 ||
          primaryQuality.recoveryRecommended
        )
      ) {
        transcriptRecoveryAttempted = true;
        try {
          const displayCaptions = job.captions;
          updateJob(
            job,
            "transcribing",
            68,
            "Double-checking difficult speech",
          );
          const verbatimTranscript = await runPreferredSarvamTranscript(
            job,
            "verbatim",
            68,
          );
          const verbatimCaptions = transcriptToCaptions(
            verbatimTranscript,
            job.language,
          );
          const recoveredAlignment = await alignTranscriptWithModal(job, {
            captions: verbatimCaptions,
            displayCaptions,
          });
          const recoveryQuality =
            alignmentQualityReport(recoveredAlignment);
          const selection = chooseBetterAlignment(
            aligned,
            recoveredAlignment,
          );
          aligned = selection.alignment;
          transcriptRecoverySelected = selection.selected === "recovery";
          if (transcriptRecoverySelected) {
            job.languageCode = resolveTranscriptLanguage(
              verbatimTranscript.language_code,
              job.language,
            );
          }
          const displayQualitySummary = { ...primaryQuality };
          const acousticQualitySummary = { ...recoveryQuality };
          delete displayQualitySummary.captions;
          delete acousticQualitySummary.captions;
          await writeFile(
            job.transcriptPath,
            JSON.stringify(
              {
                display: transcript,
                acoustic: verbatimTranscript,
                selected: transcriptRecoverySelected
                  ? "acoustic"
                  : "display",
                quality: {
                  display: displayQualitySummary,
                  acoustic: acousticQualitySummary,
                },
              },
              null,
              2,
            ),
            "utf8",
          );
        } catch (recoveryError) {
          console.error(
            JSON.stringify({
              event: "transcript_gap_recovery_failed",
              jobId: job.id,
              message:
                recoveryError instanceof Error
                  ? recoveryError.message
                  : "Unknown recovery error",
            }),
          );
          updateJob(
            job,
            "transcribing",
            76,
            "Using the clearest caption timing",
          );
        }
      }
    } catch (error) {
      const requiresGpu =
        String(process.env.MODAL_ALIGNMENT_REQUIRED ?? "true").toLowerCase() !==
        "false";
      if (requiresGpu) {
        throw new Error(
          `Precision word alignment is temporarily unavailable. ${
            error instanceof Error ? error.message : ""
          }`.trim(),
        );
      }
      console.error("Modal word alignment failed; using local fallback.", error);
    }

    if (!aligned) {
      updateJob(
        job,
        "transcribing",
        76,
        "Finishing caption timing",
      );
      await ensurePcmAudio(job);
      throwIfCancelled(job);
      aligned = alignTranscriptWords(
        job.captions,
        await readFile(path.join(job.directory, "audio.pcm")),
        { sampleRate: 16_000, frameMs: 20 },
      );
    }
    const coverageRecoveryResult = await recoverSpeechCoverage(job, aligned);
    aligned = coverageRecoveryResult.aligned;
    job.captions = annotateTimingSafety(aligned.captions);
    job.captions = stitchShortCaptionPhrases(job.captions);
    job.captions = finalizeGeneratedCaptionTimeline(job.captions, {
      durationSeconds: Number(job.video?.duration),
    });
    const timingQuality = alignmentQualityReport({
      ...aligned,
      captions: job.captions,
    });
    job.captions = timingQuality.captions;
    const finalCoverage = captionCoverageReport(job, job.captions);
    finalCoverage.recovery = coverageRecoveryResult.recovery;
    job.alignment = {
      ...aligned.summary,
      highlightSafeWords: timingQuality.safeWords,
      phraseTimedWords: timingQuality.phraseTimedWords,
      qualityScore: timingQuality.score,
      transcriptTransport: job.sarvamTransport,
      transcriptRecoveryAttempted,
      transcriptRecoverySelected,
      coverage: finalCoverage,
    };
    if (
      timingQuality.totalWords >= 4 &&
      (
        timingQuality.score < 0.2 ||
        timingQuality.safeRatio < 0.25 ||
        timingQuality.averageConfidence < 0.2
      )
    ) {
      throw new Error(
        "Automatic timing could not lock onto this voice. No inaccurate caption track was created; try a cleaner clip or a different language choice.",
      );
    }
    if (!finalCoverage.complete) {
      console.warn(
        JSON.stringify({
          event: "caption_job_review_required",
          jobId: job.id,
          coverageRatio: finalCoverage.coverageRatio,
          largestUncoveredGapSeconds:
            finalCoverage.largestUncoveredGapSeconds,
          uncoveredIntervals: finalCoverage.uncoveredIntervals,
          recovery: finalCoverage.recovery,
        }),
      );
      updateJob(
        job,
        "review_required",
        82,
        "Some spoken audio still needs captions. Review the uncovered sections before rendering.",
      );
      return;
    }
    console.info(
      JSON.stringify({
        event: "caption_job_ready",
        jobId: job.id,
        language: job.language,
        mode: job.mode,
        durationSeconds: Number(job.video?.duration ?? 0),
        phraseCount: job.captions.length,
        totalWords: timingQuality.totalWords,
        highlightSafeWords: timingQuality.safeWords,
        phraseTimedWords: timingQuality.phraseTimedWords,
        qualityScore: timingQuality.score,
        averageConfidence: Number(
          aligned?.summary?.averageConfidence ?? 0,
        ),
        transcriptTransport: job.sarvamTransport,
        transcriptRecoveryAttempted,
        transcriptRecoverySelected,
        coverageRatio: finalCoverage.coverageRatio,
        largestUncoveredGapSeconds:
          finalCoverage.largestUncoveredGapSeconds,
        coverageRecoveryAttempted:
          coverageRecoveryResult.recovery.attempted,
        coverageRecoverySelected:
          coverageRecoveryResult.recovery.selected,
      }),
    );
    updateJob(
      job,
      "ready",
      82,
      "Captions ready to edit",
    );
  } catch (error) {
    if (isCancelled(job)) return;
    console.error(
      JSON.stringify({
        event: "caption_job_failed",
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        message:
          error instanceof Error ? error.message : "Transcription failed.",
      }),
    );
    updateJob(
      job,
      "failed",
      job.progress,
      error instanceof Error ? error.message : "Transcription failed.",
    );
  }
}

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.max(min, Math.min(max, numeric))
    : fallback;
}

function safeHex(value, fallback) {
  const candidate = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : fallback;
}

function hexToAss(hex, opacity = 100) {
  const candidate = String(hex ?? "").trim();
  const normalized = /^#[0-9a-f]{6}$/i.test(candidate)
    ? candidate.slice(1)
    : "ffffff";
  const red = normalized.slice(0, 2);
  const green = normalized.slice(2, 4);
  const blue = normalized.slice(4, 6);
  const alpha = Math.round(255 * (1 - clamp(opacity, 0, 100, 100) / 100))
    .toString(16)
    .padStart(2, "0");
  return `&H${alpha}${blue}${green}${red}`.toUpperCase();
}

function assTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const wholeSeconds = Math.floor(total % 60);
  const centiseconds = Math.floor((total % 1) * 100);
  return `${hours}:${minutes
    .toString()
    .padStart(2, "0")}:${wholeSeconds
    .toString()
    .padStart(2, "0")}.${centiseconds.toString().padStart(2, "0")}`;
}

function escapeAssText(text, uppercaseEnglish) {
  let value = String(text ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replaceAll("\r", "")
    .replaceAll("\n", "\\N");
  if (uppercaseEnglish) {
    value = value.replace(/[A-Za-z]+/g, (word) => word.toUpperCase());
  }
  return value;
}

function animationTag(animation, position, playResX, playResY) {
  if (animation === "fade") return "{\\fad(150,120)}";
  if (animation === "slide") {
    const x = Math.round(playResX / 2);
    const endY = Math.round(playResY * (position / 100));
    const startY = Math.round(endY + playResY * 0.055);
    return `{\\move(${x},${startY},${x},${endY},0,240)\\fad(90,120)}`;
  }
  return "{\\fscx84\\fscy84\\t(0,190,\\fscx100\\fscy100)\\fad(60,100)}";
}

export function createAss(captions, rawStyle, languageCode, video = {}) {
  const supportedFonts = new Set([
    "Noto Sans Bengali",
    "Noto Sans Devanagari",
  ]);
  const fallbackFont =
    languageCode === "brx-IN"
      ? "Noto Sans Devanagari"
      : "Noto Sans Bengali";
  const style = {
    fontFamily: supportedFonts.has(rawStyle?.fontFamily)
      ? rawStyle.fontFamily
      : fallbackFont,
    fontSize: clamp(rawStyle?.fontSize, 24, 84, 72),
    textColor: safeHex(rawStyle?.textColor, miithiiColors.cream50),
    backgroundColor: safeHex(rawStyle?.backgroundColor, miithiiColors.teal950),
    backgroundOpacity: clamp(rawStyle?.backgroundOpacity, 0, 100, 78),
    highlightColor: safeHex(rawStyle?.highlightColor, miithiiColors.lime400),
    outlineColor: safeHex(rawStyle?.outlineColor, miithiiColors.teal950),
    outlineWidth: clamp(rawStyle?.outlineWidth, 0, 8, 2),
    position: clamp(rawStyle?.position, 52, 92, 74),
    animation: ["pop", "fade", "slide"].includes(rawStyle?.animation)
      ? rawStyle.animation
      : "pop",
    weight: ["600", "700", "800"].includes(String(rawStyle?.weight))
      ? Number(rawStyle.weight)
      : 700,
    wordsPerCard: Math.round(clamp(rawStyle?.wordsPerCard, 2, 7, 4)),
    uppercaseEnglish: Boolean(rawStyle?.uppercaseEnglish),
  };

  const portrait = Number(video.width) < Number(video.height);
  const playResX = portrait ? 1080 : 1920;
  const playResY = portrait ? 1920 : 1080;
  const marginV = Math.round(playResY * (1 - style.position / 100));
  const borderStyle = style.backgroundOpacity > 0 ? 3 : 1;
  const bold = style.weight >= 700 ? -1 : 0;
  const primary = hexToAss(style.textColor);
  const secondary = hexToAss(style.highlightColor);
  const outline = hexToAss(style.outlineColor);
  const background = hexToAss(
    style.backgroundColor,
    style.backgroundOpacity,
  );
  const baseWordFontSize = Math.round(style.fontSize);
  const largeWordFontSize = Math.round(style.fontSize * 1.46);
  const wordFontSize = (word) =>
    word?.displaySize === "large"
      ? largeWordFontSize
      : baseWordFontSize;

  const events = captions
    .filter(
      (caption) =>
        Number(caption.end) > Number(caption.start) &&
        String(caption.text ?? "").trim(),
    )
    .flatMap((caption) => {
      const groups =
        Array.isArray(caption.words) && caption.words.length
          ? groupWordsForReels(caption.words, style.wordsPerCard)
          : [
              [
                {
                  text: caption.text,
                  start: caption.start,
                  end: caption.end,
                },
              ],
            ];
      return groups.flatMap((words) => {
        if (
          !Array.isArray(caption.words) ||
          !caption.words.length ||
          !canHighlightGroup(words)
        ) {
          const phraseText = words
            .map((word, index) => {
              const wordText = escapeAssText(
                String(word.text ?? "").trim(),
                style.uppercaseEnglish,
              );
              if (!wordText) return "";
              return `{\\fs${wordFontSize(word)}}${wordText}${
                index === words.length - 1 ? "" : " "
              }`;
            })
            .join("");
          return `Dialogue: 0,${assTime(words[0].start)},${assTime(
            words.at(-1).end,
          )},Default,,0,0,0,,${animationTag(
            style.animation,
            style.position,
            playResX,
            playResY,
          )}${phraseText}`;
        }

        return words.map((activeWord, activeIndex) => {
          const eventEnd =
            words[activeIndex + 1]?.start ?? activeWord.end;
          const text = words
            .map((word, index) => {
              const wordText = escapeAssText(
                word.text,
                style.uppercaseEnglish,
              );
              const color = index === activeIndex ? secondary : primary;
              const scale = index === activeIndex
                ? "\\fscx116\\fscy116\\t(0,120,\\fscx106\\fscy106)"
                : "\\fscx100\\fscy100";
              return `{\\1c${color}&\\fs${wordFontSize(word)}${scale}}${wordText}${
                index === words.length - 1 ? "" : " "
              }`;
            })
            .join("");
          const entrance =
            activeIndex === 0
              ? animationTag(
                  style.animation,
                  style.position,
                  playResX,
                  playResY,
                )
              : "";
          return `Dialogue: 0,${assTime(activeWord.start)},${assTime(
            eventEnd,
          )},Default,,0,0,0,,${entrance}${text}`;
        });
      });
    })
    .join("\n");

  return `[Script Info]
Title: subtitles by miithii
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
ScaledBorderAndShadow: yes
WrapStyle: 0
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontFamily},${style.fontSize},${primary},${secondary},${outline},${background},${bold},0,0,0,100,100,0,0,${borderStyle},${style.outlineWidth},0,2,90,90,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
}

async function encodeCaptionVideo(
  job,
  captions,
  style,
  { onProgress = async () => {} } = {},
) {
  ensureJobRuntime(job);
  throwIfCancelled(job);
  await onProgress(82, "Preparing your caption style");
  job.captions = captions;
  job.style = style;
  job.assPath = path.join(job.directory, "captions.ass");
  await writeFile(
    job.assPath,
    createAss(captions, style, job.languageCode, job.video),
    "utf8",
  );

  const fontsDir = process.env.CAPTION_FONTS_DIR;
  const fontOption = fontsDir
    ? `:fontsdir=${fontsDir
        .replaceAll("\\", "/")
        .replaceAll(":", "\\:")
        .replaceAll("'", "\\'")}`
    : "";
  job.outputPath = path.join(job.directory, "captioned.mp4");
  const exportPolicy = buildExportMediaPolicy(job.video, {
    gopSeconds: Number(process.env.FFMPEG_GOP_SECONDS ?? 2),
  });
  const videoFilters = [
    ...(exportPolicy.tailPadSeconds > 0
      ? [
          `tpad=stop_mode=clone:stop_duration=${exportPolicy.tailPadSeconds}`,
        ]
      : []),
    `ass=captions.ass${fontOption}`,
    "format=yuv420p",
  ];
  job.exportMedia = {
    audioMode: exportPolicy.audioMode,
    gopSeconds: exportPolicy.gopSeconds,
    keyframeIntervalFrames: exportPolicy.keyframeIntervalFrames,
    tailPadSeconds: exportPolicy.tailPadSeconds,
  };

  await onProgress(88, "Adding captions to your video");
  await run(
    process.env.FFMPEG_PATH ?? "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      path.basename(job.inputPath),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-vf",
      videoFilters.join(","),
      "-c:v",
      "libx264",
      "-preset",
      process.env.FFMPEG_PRESET ?? "medium",
      "-crf",
      process.env.FFMPEG_CRF ?? "18",
      "-pix_fmt",
      "yuv420p",
      ...exportVideoArgs(exportPolicy),
      ...exportPolicy.audioFilterArgs,
      ...exportPolicy.audioArgs,
      ...(exportPolicy.useShortest ? ["-shortest"] : []),
      "-movflags",
      "+faststart",
      path.basename(job.outputPath),
    ],
    { cwd: job.directory, job },
  );
  throwIfCancelled(job);

  return {
    captionsAssPath: job.assPath,
    videoPath: job.outputPath,
    codecManifest: {
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
      width: Number(job.video?.width) || null,
      height: Number(job.video?.height) || null,
      frameRate: job.video?.frameRate ?? null,
      pixelFormat: "yuv420p",
      ...job.exportMedia,
    },
  };
}

async function renderVideo(job, captions, style) {
  try {
    const output = await encodeCaptionVideo(job, captions, style, {
      onProgress(progress, message) {
        updateJob(job, "rendering", progress, message);
      },
    });

    if (job.remote) {
      updateJob(job, "rendering", 97, "Saving your export");
      await uploadRemoteArtifact(
        job,
        "captions.ass",
        output.captionsAssPath,
        "text/x-ssa; charset=utf-8",
      );
      await uploadRemoteArtifact(
        job,
        "result",
        output.videoPath,
        "video/mp4",
      );
    }

    updateJob(job, "complete", 100, "Captioned video ready");
    await Promise.allSettled([
      unlink(path.join(job.directory, "audio.wav")),
      unlink(path.join(job.directory, "audio.pcm")),
    ]);
  } catch (error) {
    if (isCancelled(job)) return;
    updateJob(
      job,
      "failed",
      job.progress,
      error instanceof Error ? error.message : "Rendering failed.",
    );
  }
}

async function processJob(job) {
  await transcribe(job);
}

async function downloadRemoteSource(job) {
  try {
    ensureJobRuntime(job);
    updateJob(job, "extracting", 4, "Loading your uploaded video");
    const response = await fetch(job.remote.sourceUrl, {
      headers: remoteAuthorization(job),
      signal: job.abortController.signal,
    });
    throwIfCancelled(job);
    if (!response.ok || !response.body) {
      throw new Error(
        `Durable video storage returned ${response.status}.`,
      );
    }
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(job.inputPath, { flags: "wx" }),
    );
    throwIfCancelled(job);
    await processJob(job);
  } catch (error) {
    if (isCancelled(job)) return;
    updateJob(
      job,
      "failed",
      job.progress,
      error instanceof Error ? error.message : "Could not load the source video.",
    );
  }
}

function objectFromField(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function projectRenderAllowedOrigins() {
  return (
    process.env.MEDIA_CALLBACK_ORIGINS ??
    "https://syncword-caption-studio.dhrub404.chatgpt.site"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function hasCapability(request, job) {
  return projectJobCapabilityMatches(request, job?.capabilityToken);
}

function publicProjectRenderJob(job) {
  return {
    id: job.id,
    projectId: job.projectId,
    revisionId: job.revisionId,
    requestFingerprint: job.requestFingerprint,
    rendererRevision: job.rendererRevision,
    status: job.status,
    progress: job.progress,
    message: job.message,
    captionQualityRevision,
  };
}

function assertImmutableSourceFacts(job, renderInput, exportSpec) {
  const expected = renderInput.video;
  if (
    Number(job.video?.width) !== Number(expected.width) ||
    Number(job.video?.height) !== Number(expected.height)
  ) {
    const error = new Error(
      "The immutable revision canvas does not match the source video.",
    );
    error.code = "project_source_canvas_mismatch";
    throw error;
  }
  const actualDuration = Number(job.video?.duration);
  const expectedDuration = Number(expected.duration);
  if (
    !Number.isFinite(actualDuration) ||
    !Number.isFinite(expectedDuration) ||
    Math.abs(actualDuration - expectedDuration) > 0.35
  ) {
    const error = new Error(
      "The immutable revision duration does not match the source video.",
    );
    error.code = "project_source_duration_mismatch";
    throw error;
  }
  if (
    exportSpec.width !== Number(expected.width) ||
    exportSpec.height !== Number(expected.height)
  ) {
    const error = new Error(
      "This caption renderer currently requires export dimensions to match the immutable canvas.",
    );
    error.code = "project_export_canvas_unsupported";
    throw error;
  }
  if (!exportFrameRateMatchesSource(job.video?.frameRate, exportSpec.fps)) {
    const error = new Error(
      "This caption renderer currently requires export FPS to match the source timeline.",
    );
    error.code = "project_export_fps_unsupported";
    throw error;
  }
}

async function runImmutableProjectProcessing({ job, plan, directory }) {
  return executeProjectProcessing({
    plan,
    directory,
    isCancelled: () => isCancelled(job),
    signal: ensureJobRuntime(job).abortController.signal,
    process: async ({ inputPath, onState }) => {
      job.inputPath = inputPath;
      Object.defineProperty(job, "projectProcessingStateCallback", {
        value({ status, progress, message }) {
          const callbackStatus = projectProcessingCallbackStatus(
            status,
            message,
          );
          if (!callbackStatus) return Promise.resolve();
          return onState({
            status: callbackStatus,
            progress,
            message,
          });
        },
        writable: true,
        configurable: true,
        enumerable: false,
      });
      try {
        await transcribe(job);
      } finally {
        delete job.projectProcessingStateCallback;
      }
      if (isCancelled(job)) throw cancelledError();
      if (job.status === "failed") {
        const error = new Error(job.message || "Caption processing failed.");
        error.code = "caption_processing_failed";
        throw error;
      }
      return {
        document: projectDocumentFromProcessingJob(plan, job),
        changeSummary: "Automatic captions with speech-coverage validation",
      };
    },
  });
}

app.use(
  "/v3/processing-jobs",
  createProjectProcessingRouter({
    root: projectProcessingRoot,
    jobs: projectProcessingJobs,
    maxQueuedJobs,
    jobLifetimeMs,
    allowedOrigins: projectRenderAllowedOrigins,
    captionQualityRevision,
    supportedProcessorRevision: processorRevision,
    enqueue,
    ensureRuntime: ensureJobRuntime,
    cancelRuntime: cancelJob,
    runJob: runImmutableProjectProcessing,
  }),
);

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    service: "miithii-subtitles-render",
    captionQualityRevision,
    processorRevision,
    rendererRevision,
    sarvamConfigured: Boolean(process.env.SARVAM_API_KEY),
    modalAlignerConfigured: Boolean(modalAlignerEndpoint()),
    ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg",
    queueDepth: taskQueue.length,
    active: queueRunning,
    retentionHours: jobLifetimeMs / 3_600_000,
    deploymentMode: process.env.DEPLOYMENT_MODE ?? "standard",
  });
});

app.post("/v1/jobs", upload.single("video"), async (request, response) => {
  if (!request.file) {
    response.status(400).json({ error: "A video file is required." });
    return;
  }

  const acceptedExtensions = new Set([
    ".mp4",
    ".mov",
    ".webm",
    ".mkv",
    ".m4v",
  ]);
  const sourceExtension = path.extname(request.file.originalname).toLowerCase();
  if (
    !acceptedExtensions.has(sourceExtension) &&
    !request.file.mimetype.startsWith("video/")
  ) {
    await unlink(request.file.path).catch(() => {});
    response.status(415).json({
      error: "Choose an MP4, MOV, WebM, MKV, or M4V video.",
    });
    return;
  }

  const language = String(request.body.language ?? "").trim();
  if (!isSupportedLanguageCode(language)) {
    await unlink(request.file.path).catch(() => {});
    response.status(400).json({
      error: "Choose Assamese or Bodo before captioning.",
    });
    return;
  }

  const activeJobs = [...jobs.values()].filter((job) =>
    ["queued", "extracting", "transcribing", "rendering"].includes(
      job.status,
    ),
  ).length;
  if (activeJobs >= maxQueuedJobs) {
    await unlink(request.file.path).catch(() => {});
    response.status(429).json({
      error: "The render queue is full. Try again in a few minutes.",
    });
    return;
  }

  const id = randomUUID();
  const directory = path.join(jobsRoot, id);
  await mkdir(directory, { recursive: true });
  const extension =
    path.extname(request.file.originalname).replace(/[^a-zA-Z0-9.]/g, "") ||
    ".mp4";
  const inputPath = path.join(directory, `source${extension}`);

  try {
    await rename(request.file.path, inputPath);
  } catch {
    await copyFile(request.file.path, inputPath);
  }

  const mode = ["codemix", "verbatim", "transcribe"].includes(
    request.body.mode,
  )
    ? request.body.mode
    : "codemix";
  const job = {
    id,
    directory,
    inputPath,
    originalName: request.file.originalname,
    language,
    mode,
    style: objectFromField(request.body.style),
    status: "queued",
    progress: 3,
    message: "Queued for captioning",
    captions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + jobLifetimeMs).toISOString(),
  };
  ensureJobRuntime(job);
  jobs.set(id, job);
  console.info(
    JSON.stringify({
      event: "caption_job_queued",
      jobId: id,
      language,
      mode,
      bytes: request.file.size,
      extension: sourceExtension,
    }),
  );
  await persistJob(job);
  response.status(202).json(publicJob(job));
  enqueue(job, () => processJob(job));
});

app.post("/v2/jobs", async (request, response) => {
  const {
    id,
    sourceUrl,
    callbackBase,
    capabilityToken,
    sitesAuthorization,
    originalName,
    contentType,
    language: rawLanguage,
    mode: rawMode,
    style: rawStyle,
  } = request.body ?? {};
  if (
    !/^[0-9a-f-]{36}$/i.test(String(id ?? "")) ||
    !/^[0-9a-f]{64}$/i.test(String(capabilityToken ?? ""))
  ) {
    response.status(400).json({ error: "Invalid durable job capability." });
    return;
  }
  const language = String(rawLanguage ?? "").trim();
  if (!isSupportedLanguageCode(language)) {
    response.status(400).json({
      error: "Choose Assamese or Bodo before captioning.",
    });
    return;
  }
  if (jobs.has(id)) {
    const existing = jobs.get(id);
    if (existing.language !== language) {
      response.status(409).json({
        error: "Durable job language does not match the original request.",
      });
      return;
    }
    response.status(202).json(publicJob(existing));
    return;
  }

  let source;
  let callback;
  try {
    source = new URL(sourceUrl);
    callback = new URL(callbackBase);
  } catch {
    response.status(400).json({ error: "Invalid durable storage URL." });
    return;
  }
  const callbackOrigins = (
    process.env.MEDIA_CALLBACK_ORIGINS ??
    "https://syncword-caption-studio.dhrub404.chatgpt.site"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (
    source.protocol !== "https:" ||
    source.origin !== callback.origin ||
    !callbackOrigins.includes(callback.origin) ||
    !source.pathname.startsWith(`/api/media/jobs/${id}/`) ||
    callback.pathname !== `/api/media/jobs/${id}`
  ) {
    response.status(400).json({ error: "Durable storage origin is not allowed." });
    return;
  }

  const activeJobs = [...jobs.values()].filter((job) =>
    ["queued", "extracting", "transcribing", "rendering"].includes(
      job.status,
    ),
  ).length;
  if (activeJobs >= maxQueuedJobs) {
    response.status(429).json({
      error: "The render queue is full. Try again in a few minutes.",
    });
    return;
  }

  const directory = path.join(jobsRoot, id);
  await mkdir(directory, { recursive: true });
  const safeOriginalName =
    path.basename(String(originalName ?? "video.mp4")).slice(0, 160) ||
    "video.mp4";
  const extension =
    path.extname(safeOriginalName).replace(/[^a-zA-Z0-9.]/g, "") ||
    ".mp4";
  const inputPath = path.join(directory, `source${extension}`);
  const mode = ["codemix", "verbatim", "transcribe"].includes(rawMode)
    ? rawMode
    : "codemix";
  const job = {
    id,
    directory,
    inputPath,
    originalName: safeOriginalName,
    contentType: String(contentType ?? "video/mp4"),
    language,
    mode,
    style: objectFromField(rawStyle),
    status: "queued",
    progress: 3,
    message: "Queued for captioning",
    captions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + jobLifetimeMs).toISOString(),
  };
  Object.defineProperty(job, "remote", {
    value: {
      sourceUrl: source.toString(),
      callbackBase: callback.toString().replace(/\/+$/, ""),
      capabilityToken,
      sitesAuthorization:
        typeof sitesAuthorization === "string" &&
        sitesAuthorization.length >= 32
          ? sitesAuthorization
          : "",
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
  ensureJobRuntime(job);
  jobs.set(id, job);
  console.info(
    JSON.stringify({
      event: "caption_job_queued",
      jobId: id,
      language,
      mode,
      contentType: job.contentType,
      source: "durable-upload",
    }),
  );
  await persistJob(job);
  void syncRemoteJob(job);
  response.status(202).json(publicJob(job));
  enqueue(job, () => downloadRemoteSource(job));
});

app.post("/v3/render-jobs", async (request, response) => {
  let plan;
  try {
    plan = parseProjectRenderRequest(request.body, {
      allowedOrigins: projectRenderAllowedOrigins(),
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Invalid project render request.",
      code: error?.code ?? "invalid_project_render_request",
    });
    return;
  }
  if (plan.rendererRevision !== rendererRevision) {
    response.status(409).json({
      error: `This compute service supports renderer revision ${rendererRevision}.`,
      code: "project_renderer_revision_unsupported",
    });
    return;
  }
  const idempotencyKey = request.headers["idempotency-key"];
  if (idempotencyKey && idempotencyKey !== plan.id) {
    response.status(409).json({
      error: "Idempotency-Key must equal the immutable render job id.",
      code: "project_render_idempotency_mismatch",
    });
    return;
  }
  const existing = projectRenderJobs.get(plan.id);
  if (existing) {
    if (existing.requestFingerprint !== plan.requestFingerprint) {
      response.status(409).json({
        error: "This render job id already names different immutable input.",
        code: "project_render_fingerprint_conflict",
      });
      return;
    }
    if (!["failed", "cancelled"].includes(existing.status)) {
      response.status(existing.status === "succeeded" ? 200 : 202).json(
        publicProjectRenderJob(existing),
      );
      return;
    }
  }
  const activeProjectRenders = [...projectRenderJobs.values()].filter((job) =>
    ["queued", "running"].includes(job.status),
  ).length;
  if (activeProjectRenders >= maxQueuedJobs) {
    response.status(429).json({
      error: "The render queue is full. Try again in a few minutes.",
      code: "project_render_queue_full",
    });
    return;
  }

  const directory = path.join(projectRendersRoot, plan.id);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const projectJob = {
    id: plan.id,
    projectId: plan.projectId,
    revisionId: plan.revision.id,
    requestFingerprint: plan.requestFingerprint,
    rendererRevision: plan.rendererRevision,
    directory,
    inputPath: path.join(directory, "source.mp4"),
    status: "queued",
    progress: 0,
    message: "Queued for immutable rendering",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + jobLifetimeMs).toISOString(),
  };
  Object.defineProperties(projectJob, {
    plan: { value: plan, enumerable: false },
    capabilityToken: {
      value: plan.authorization.renderCapabilityToken,
      enumerable: false,
    },
  });
  ensureJobRuntime(projectJob);
  projectRenderJobs.set(plan.id, projectJob);
  response.status(202).json(publicProjectRenderJob(projectJob));

  enqueue(projectJob, async () => {
    projectJob.status = "running";
    projectJob.progress = 1;
    projectJob.message = "Starting immutable render";
    try {
      await executeProjectRender({
        plan,
        directory,
        isCancelled: () => isCancelled(projectJob),
        render: async ({ renderInput, inputPath, onProgress }) => {
          projectJob.inputPath = inputPath;
          projectJob.languageCode = renderInput.languageCode;
          projectJob.alignment = renderInput.alignment;
          await probeVideo(projectJob);
          assertImmutableSourceFacts(projectJob, renderInput, plan.exportSpec);
          return encodeCaptionVideo(
            projectJob,
            renderInput.captions,
            renderInput.style,
            {
              async onProgress(progress, message) {
                projectJob.progress = progress;
                projectJob.message = message;
                projectJob.updatedAt = new Date().toISOString();
                await onProgress(progress, message);
              },
            },
          );
        },
      });
      projectJob.status = "succeeded";
      projectJob.progress = 100;
      projectJob.message = "Captioned video ready";
    } catch (error) {
      if (isCancelled(projectJob)) {
        projectJob.status = "cancelled";
        projectJob.message = "Rendering cancelled";
      } else {
        projectJob.status = "failed";
        projectJob.message =
          error instanceof Error ? error.message : "Project render failed";
        console.error(
          JSON.stringify({
            event: "project_render_failed",
            renderJobId: projectJob.id,
            projectId: projectJob.projectId,
            message: projectJob.message,
          }),
        );
      }
    } finally {
      projectJob.updatedAt = new Date().toISOString();
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      const retentionTimer = setTimeout(
        () => projectRenderJobs.delete(projectJob.id),
        jobLifetimeMs,
      );
      retentionTimer.unref();
    }
  });
});

app.delete("/v3/render-jobs/:id", async (request, response) => {
  const job = projectRenderJobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ error: "Project render job not found." });
    return;
  }
  if (!hasCapability(request, job)) {
    response.status(401).json({ error: "Render cancellation capability is invalid." });
    return;
  }
  if (!["succeeded", "failed", "cancelled"].includes(job.status)) {
    cancelJob(job);
    await putProjectRenderState(
      job.plan,
      { status: "cancelled", progress: job.progress, message: "Rendering cancelled" },
    ).catch(() => undefined);
  }
  response.status(202).json(publicProjectRenderJob(job));
});

app.get("/v1/jobs/:id", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }
  response.json(publicJob(job));
});

app.delete("/v1/jobs/:id", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }
  if (!cancelJob(job)) {
    response.status(409).json({
      error: `Job cannot be cancelled. Current status: ${job.status}.`,
    });
    return;
  }
  response.status(202).json(publicJob(job));
});

app.delete("/v2/jobs/:id", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }
  if (!cancelJob(job)) {
    response.status(409).json({
      error: `Job cannot be cancelled. Current status: ${job.status}.`,
    });
    return;
  }
  response.status(202).json(publicJob(job));
});

app.post("/v1/jobs/:id/render", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }
  const captions = Array.isArray(request.body?.captions)
    ? request.body.captions
    : job.captions;
  if (!captions.length) {
    response.status(400).json({ error: "At least one caption is required." });
    return;
  }
  const coverageDecision = renderCaptionSubmissionDecision(job, captions);
  if (!coverageDecision.allowed) {
    rejectRenderCaptionSubmission(response, coverageDecision);
    return;
  }

  job.style = objectFromField(request.body?.style);
  acceptRenderCaptionSubmission(job, captions, coverageDecision);
  updateJob(job, "rendering", 82, "Re-render queued");
  enqueue(job, () => renderVideo(job, captions, job.style));
  response.status(202).json(publicJob(job));
});

app.post("/v2/jobs/:id/render", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job?.remote) {
    response.status(404).json({ error: "Job not found." });
    return;
  }
  const captions = Array.isArray(request.body?.captions)
    ? request.body.captions
    : job.captions;
  if (!captionsHaveWordTimings(captions)) {
    response.status(400).json({ error: "Complete word timings are required." });
    return;
  }
  const coverageDecision = renderCaptionSubmissionDecision(job, captions);
  if (!coverageDecision.allowed) {
    rejectRenderCaptionSubmission(response, coverageDecision);
    return;
  }
  job.style = objectFromField(request.body?.style);
  acceptRenderCaptionSubmission(job, captions, coverageDecision);
  updateJob(job, "rendering", 82, "Re-render queued");
  enqueue(job, () => renderVideo(job, captions, job.style));
  response.status(202).json(publicJob(job));
});

app.get("/v1/jobs/:id/result", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job?.outputPath || job.status !== "complete") {
    response.status(404).json({ error: "Rendered video is not ready." });
    return;
  }
  response.setHeader("content-type", "video/mp4");
  response.setHeader("cache-control", "private, no-store");
  response.sendFile(path.basename(job.outputPath), {
    root: job.directory,
    dotfiles: "deny",
  });
});

app.get("/v1/jobs/:id/download", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job?.outputPath || job.status !== "complete") {
    response.status(404).json({ error: "Rendered video is not ready." });
    return;
  }
  const baseName = path
    .basename(job.originalName, path.extname(job.originalName))
    .replace(/[^a-zA-Z0-9-_]/g, "-");
  response.download(job.outputPath, `${baseName}-captioned.mp4`);
});

app.get("/v1/jobs/:id/captions.ass", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job?.assPath) {
    response.status(404).json({ error: "ASS captions are not ready." });
    return;
  }
  response.download(job.assPath, "captions.ass");
});

app.use((error, _request, response, _next) => {
  void _next;
  if (error instanceof multer.MulterError) {
    response.status(413).json({ error: error.message });
    return;
  }
  response.status(500).json({
    error: error instanceof Error ? error.message : "Unexpected server error.",
  });
});

await restoreJobs();
await cleanupExpiredJobs();
const cleanupTimer = setInterval(() => {
  void cleanupExpiredJobs();
}, 60 * 60 * 1000);
cleanupTimer.unref();

export const renderServer = app.listen(port, "0.0.0.0", () => {
  console.log(`subtitles by miithii render API listening on http://localhost:${port}`);
});
