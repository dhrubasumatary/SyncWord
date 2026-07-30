import cors from "cors";
import "dotenv/config";
import express from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import {
  groupWordsForReels,
  stitchShortCaptionPhrases,
} from "./caption-groups.mjs";
import { alignTranscriptWords } from "./word-aligner.mjs";

const app = express();
const port = Number(process.env.PORT ?? 8787);
const runtimeRoot = path.resolve(
  process.env.RUNTIME_DIR ?? path.join(process.cwd(), ".runtime"),
);
const uploadRoot = path.join(runtimeRoot, "incoming");
const jobsRoot = path.join(runtimeRoot, "jobs");
const sarvamBaseUrl =
  process.env.SARVAM_BASE_URL ?? "https://api.sarvam.ai";
const jobs = new Map();
const taskQueue = [];
const persistenceQueue = new Map();
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
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    captions: job.captions,
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

async function probeVideo(job) {
  const output = await runCapture(
    process.env.FFPROBE_PATH ?? "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate:format=duration",
      "-of",
      "json",
      path.basename(job.inputPath),
    ],
    { cwd: job.directory, job },
  );
  const probe = JSON.parse(output);
  const stream = probe.streams?.[0];
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

async function waitForSarvamJob(job, sarvamJobId) {
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
      Math.min(76, 31 + Math.floor(attempt / 3)),
      state === "running"
        ? "Saaras is aligning phrases"
        : "Waiting for Saaras Batch",
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

function languageTag(languageCode) {
  if (languageCode === "as-IN") return "as";
  if (languageCode === "brx-IN") return "brx";
  return "mix";
}

function transcriptToCaptions(transcript) {
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
        language: languageTag(transcript.language_code),
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
        language: languageTag(transcript.language_code),
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

    updateJob(job, "transcribing", 24, "Creating Saaras v3 Batch job");
    const audioFileName = `${job.id}.wav`;
    const init = await sarvamJson(
      "/speech-to-text/job/v1",
      {
        method: "POST",
        body: JSON.stringify({
          job_parameters: {
            model: "saaras:v3",
            mode: job.mode ?? "codemix",
            language_code: job.language,
            with_timestamps: true,
            with_diarization: false,
          },
        }),
      },
      job,
    );

    job.sarvamJobId = init.job_id;
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

    updateJob(job, "transcribing", 32, "Saaras is aligning phrases");
    const status = await waitForSarvamJob(job, init.job_id);
    const transcript = await downloadTranscript(job, init.job_id, status);
    job.languageCode = transcript.language_code ?? job.language;
    job.captions = transcriptToCaptions(transcript);
    job.transcriptPath = path.join(job.directory, "transcript.json");
    await writeFile(
      job.transcriptPath,
      JSON.stringify(transcript, null, 2),
      "utf8",
    );
    updateJob(job, "transcribing", 76, "Aligning words to waveform valleys");
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
    throwIfCancelled(job);
    const aligned = alignTranscriptWords(
      job.captions,
      await readFile(path.join(job.directory, "audio.pcm")),
      { sampleRate: 16_000, frameMs: 20 },
    );
    job.captions = aligned.captions;
    job.captions = stitchShortCaptionPhrases(job.captions);
    job.alignment = aligned.summary;
    updateJob(
      job,
      "ready",
      82,
      `${aligned.summary.totalWords} words aligned · ${aligned.summary.needsReview} need review`,
    );
  } catch (error) {
    if (isCancelled(job)) return;
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

function createAss(captions, rawStyle, languageCode, video = {}) {
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
    fontSize: clamp(rawStyle?.fontSize, 24, 84, 48),
    textColor: safeHex(rawStyle?.textColor, "#fff9ee"),
    backgroundColor: safeHex(rawStyle?.backgroundColor, "#171a27"),
    backgroundOpacity: clamp(rawStyle?.backgroundOpacity, 0, 100, 78),
    highlightColor: safeHex(rawStyle?.highlightColor, "#ffde59"),
    outlineColor: safeHex(rawStyle?.outlineColor, "#171a27"),
    outlineWidth: clamp(rawStyle?.outlineWidth, 0, 8, 2),
    position: clamp(rawStyle?.position, 52, 92, 83),
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
        if (!Array.isArray(caption.words) || !caption.words.length) {
          return `Dialogue: 0,${assTime(words[0].start)},${assTime(
            words.at(-1).end,
          )},Default,,0,0,0,,${animationTag(
            style.animation,
            style.position,
            playResX,
            playResY,
          )}${escapeAssText(words[0].text, style.uppercaseEnglish)}`;
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
              return `{\\1c${color}&${scale}}${wordText}${
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
Title: SyncWord captions
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

async function renderVideo(job, captions, style) {
  try {
    ensureJobRuntime(job);
    throwIfCancelled(job);
    updateJob(job, "rendering", 82, "Writing styled ASS captions");
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

    updateJob(job, "rendering", 88, "Burning captions with ffmpeg");
    await run(
      process.env.FFMPEG_PATH ?? "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        path.basename(job.inputPath),
        "-vf",
        `ass=captions.ass${fontOption},format=yuv420p`,
        "-c:v",
        "libx264",
        "-preset",
        process.env.FFMPEG_PRESET ?? "medium",
        "-crf",
        process.env.FFMPEG_CRF ?? "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        path.basename(job.outputPath),
      ],
      { cwd: job.directory, job },
    );
    throwIfCancelled(job);

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
  if (job.status === "ready") {
    await renderVideo(job, job.captions, job.style ?? {});
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

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    service: "syncword-render",
    sarvamConfigured: Boolean(process.env.SARVAM_API_KEY),
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

  const language = ["as-IN", "brx-IN", "unknown"].includes(
    request.body.language,
  )
    ? request.body.language
    : "unknown";
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
  await persistJob(job);
  response.status(202).json(publicJob(job));
  enqueue(job, () => processJob(job));
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

app.post("/v1/jobs/:id/render", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }
  if (!["ready", "complete"].includes(job.status)) {
    response.status(409).json({
      error: `Job is not ready for a render. Current status: ${job.status}.`,
    });
    return;
  }
  const captions = Array.isArray(request.body.captions)
    ? request.body.captions
    : job.captions;
  if (!captions.length) {
    response.status(400).json({ error: "At least one caption is required." });
    return;
  }

  job.style = objectFromField(request.body.style);
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

app.listen(port, "0.0.0.0", () => {
  console.log(`SyncWord render API listening on http://localhost:${port}`);
});
