import cors from "cors";
import "dotenv/config";
import express from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const app = express();
const port = Number(process.env.PORT ?? 8787);
const runtimeRoot = path.resolve(
  process.env.RUNTIME_DIR ?? path.join(process.cwd(), ".runtime"),
);
const uploadRoot = path.join(runtimeRoot, "incoming");
const sarvamBaseUrl = "https://api.sarvam.ai";
const jobs = new Map();

await mkdir(uploadRoot, { recursive: true });

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
    fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 4_294_967_296),
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
    languageCode: job.languageCode,
    downloadUrl:
      job.status === "complete" ? `/v1/jobs/${job.id}/download` : undefined,
    assUrl:
      ["ready", "rendering", "complete"].includes(job.status) &&
      job.assPath
        ? `/v1/jobs/${job.id}/captions.ass`
        : undefined,
  };
}

function updateJob(job, status, progress, message) {
  Object.assign(job, {
    status,
    progress,
    message,
    updatedAt: new Date().toISOString(),
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      ...options,
    });
    let errorOutput = "";
    child.stderr.on("data", (chunk) => {
      errorOutput = `${errorOutput}${chunk.toString()}`.slice(-12_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
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

async function sarvamJson(endpoint, options = {}) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SARVAM_API_KEY is not configured on the render service.",
    );
  }

  const response = await fetch(`${sarvamBaseUrl}${endpoint}`, {
    ...options,
    headers: {
      "api-subscription-key": apiKey,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });

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

async function uploadAudio(jobId, fileName, audioPath, storageType) {
  const uploadResponse = await sarvamJson(
    "/speech-to-text/job/v1/upload-files",
    {
      method: "POST",
      body: JSON.stringify({ job_id: jobId, files: [fileName] }),
    },
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
  });
  if (!response.ok) {
    throw new Error(`Audio upload failed with status ${response.status}.`);
  }
}

async function waitForSarvamJob(job, sarvamJobId) {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const status = await sarvamJson(
      `/speech-to-text/job/v1/${encodeURIComponent(sarvamJobId)}/status`,
      { method: "GET" },
    );
    const state = String(status.job_state ?? "").toLowerCase();
    job.progress = Math.min(76, 31 + Math.floor(attempt / 3));
    job.message =
      state === "running"
        ? "Saaras is aligning phrases"
        : "Waiting for Saaras Batch";

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

async function downloadTranscript(sarvamJobId, status) {
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
  );

  const source = resolveStorageUrl(response.download_urls?.[outputFiles[0]]);
  if (!source) throw new Error("Sarvam did not return a transcript URL.");

  const transcriptResponse = await fetch(source);
  if (!transcriptResponse.ok) {
    throw new Error(
      `Transcript download failed with status ${transcriptResponse.status}.`,
    );
  }
  return transcriptResponse.json();
}

async function transcribe(job) {
  try {
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
      { cwd: job.directory },
    );

    updateJob(job, "transcribing", 24, "Creating Saaras v3 Batch job");
    const audioFileName = `${job.id}.wav`;
    const init = await sarvamJson("/speech-to-text/job/v1", {
      method: "POST",
      body: JSON.stringify({
        job_parameters: {
          model: "saaras:v3",
          mode: "codemix",
          language_code: job.language,
          input_audio_codec: "pcm_s16le",
          with_timestamps: true,
          with_diarization: false,
        },
      }),
    });

    job.sarvamJobId = init.job_id;
    await uploadAudio(
      init.job_id,
      audioFileName,
      path.join(job.directory, "audio.wav"),
      init.storage_container_type,
    );
    await sarvamJson(
      `/speech-to-text/job/v1/${encodeURIComponent(init.job_id)}/start`,
      { method: "POST", body: "{}" },
    );

    updateJob(job, "transcribing", 32, "Saaras is aligning phrases");
    const status = await waitForSarvamJob(job, init.job_id);
    const transcript = await downloadTranscript(init.job_id, status);
    job.languageCode = transcript.language_code ?? job.language;
    job.captions = transcriptToCaptions(transcript);
    job.transcriptPath = path.join(job.directory, "transcript.json");
    await writeFile(
      job.transcriptPath,
      JSON.stringify(transcript, null, 2),
      "utf8",
    );
    updateJob(
      job,
      "ready",
      78,
      `${job.captions.length} phrase blocks ready for review`,
    );
  } catch (error) {
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

function hexToAss(hex, opacity = 100) {
  const normalized = String(hex ?? "#ffffff")
    .replace("#", "")
    .padEnd(6, "f")
    .slice(0, 6);
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

function animationTag(animation) {
  if (animation === "fade") return "{\\fad(150,120)}";
  if (animation === "slide")
    return "{\\move(960,1010,960,900,0,240)\\fad(90,120)}";
  return "{\\fscx84\\fscy84\\t(0,190,\\fscx100\\fscy100)\\fad(60,100)}";
}

function createAss(captions, rawStyle, languageCode) {
  const style = {
    fontFamily:
      rawStyle?.fontFamily ??
      (languageCode === "brx-IN"
        ? "Noto Sans Devanagari"
        : "Noto Sans Bengali"),
    fontSize: clamp(rawStyle?.fontSize, 24, 84, 48),
    textColor: rawStyle?.textColor ?? "#fff9ee",
    backgroundColor: rawStyle?.backgroundColor ?? "#171a27",
    backgroundOpacity: clamp(rawStyle?.backgroundOpacity, 0, 100, 78),
    outlineColor: rawStyle?.outlineColor ?? "#171a27",
    outlineWidth: clamp(rawStyle?.outlineWidth, 0, 8, 2),
    position: clamp(rawStyle?.position, 52, 92, 83),
    animation: ["pop", "fade", "slide"].includes(rawStyle?.animation)
      ? rawStyle.animation
      : "pop",
    weight: ["600", "700", "800"].includes(String(rawStyle?.weight))
      ? Number(rawStyle.weight)
      : 700,
    uppercaseEnglish: Boolean(rawStyle?.uppercaseEnglish),
  };

  const marginV = Math.round(1080 * (1 - style.position / 100));
  const borderStyle = style.backgroundOpacity > 0 ? 3 : 1;
  const bold = style.weight >= 700 ? -1 : 0;
  const primary = hexToAss(style.textColor);
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
    .map((caption) => {
      const text = escapeAssText(
        caption.text,
        style.uppercaseEnglish,
      );
      return `Dialogue: 0,${assTime(caption.start)},${assTime(
        caption.end,
      )},Default,,0,0,0,,${animationTag(style.animation)}${text}`;
    })
    .join("\n");

  return `[Script Info]
Title: SyncWord captions
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes
WrapStyle: 0
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontFamily},${style.fontSize},${primary},${primary},${outline},${background},${bold},0,0,0,100,100,0,0,${borderStyle},${style.outlineWidth},0,2,90,90,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
}

async function renderVideo(job, captions, style) {
  try {
    updateJob(job, "rendering", 82, "Writing styled ASS captions");
    job.captions = captions;
    job.assPath = path.join(job.directory, "captions.ass");
    await writeFile(
      job.assPath,
      createAss(captions, style, job.languageCode),
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
        `ass=captions.ass${fontOption}`,
        "-c:v",
        "libx264",
        "-preset",
        process.env.FFMPEG_PRESET ?? "medium",
        "-crf",
        process.env.FFMPEG_CRF ?? "18",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        path.basename(job.outputPath),
      ],
      { cwd: job.directory },
    );

    updateJob(job, "complete", 100, "Captioned video ready");
  } catch (error) {
    updateJob(
      job,
      "failed",
      job.progress,
      error instanceof Error ? error.message : "Rendering failed.",
    );
  }
}

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    service: "syncword-render",
    sarvamConfigured: Boolean(process.env.SARVAM_API_KEY),
    ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg",
  });
});

app.post("/v1/jobs", upload.single("video"), async (request, response) => {
  if (!request.file) {
    response.status(400).json({ error: "A video file is required." });
    return;
  }

  const id = randomUUID();
  const directory = path.join(runtimeRoot, "jobs", id);
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
  const job = {
    id,
    directory,
    inputPath,
    originalName: request.file.originalname,
    language,
    status: "queued",
    progress: 3,
    message: "Queued for audio extraction",
    captions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  response.status(202).json(publicJob(job));
  void transcribe(job);
});

app.get("/v1/jobs/:id", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }
  response.json(publicJob(job));
});

app.post("/v1/jobs/:id/render", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }
  if (job.status !== "ready") {
    response.status(409).json({
      error: `Job must be ready before rendering. Current status: ${job.status}.`,
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

  void renderVideo(job, captions, request.body.style ?? {});
  response.status(202).json(publicJob(job));
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

app.listen(port, "0.0.0.0", () => {
  console.log(`SyncWord render API listening on http://localhost:${port}`);
});
