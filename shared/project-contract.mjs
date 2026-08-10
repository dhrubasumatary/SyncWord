const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PROJECT_DOCUMENT_SCHEMA_VERSION = 1;

export const SUPPORTED_LANGUAGE_CODES = Object.freeze(["as-IN", "brx-IN"]);

export const WORD_DISPLAY_SIZES = Object.freeze(["small", "large"]);

export const CAPTION_PROCESSING_STATUSES = Object.freeze([
  "queued",
  "extracting",
  "transcribing",
  "aligning",
  "recovering",
  "ready",
  "complete",
  "review_required",
  "failed",
]);

export const RENDER_JOB_STATUSES = Object.freeze([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const EXPORT_ARTIFACT_KINDS = Object.freeze([
  "video",
  "captions_ass",
  "captions_srt",
  "captions_vtt",
]);

const CAPTION_PROCESSING_STATUS_SET = new Set(CAPTION_PROCESSING_STATUSES);
const RENDER_JOB_STATUS_SET = new Set(RENDER_JOB_STATUSES);
const EXPORT_ARTIFACT_KIND_SET = new Set(EXPORT_ARTIFACT_KINDS);
const SUPPORTED_LANGUAGE_CODE_SET = new Set(SUPPORTED_LANGUAGE_CODES);
const WORD_DISPLAY_SIZE_SET = new Set(WORD_DISPLAY_SIZES);

/**
 * @param {unknown} value
 * @returns {value is "as-IN" | "brx-IN"}
 */
export function isSupportedLanguageCode(value) {
  return (
    typeof value === "string" && SUPPORTED_LANGUAGE_CODE_SET.has(value)
  );
}

function contractError(path, message) {
  throw new TypeError(`${path}: ${message}`);
}

function objectAt(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    contractError(path, "must be an object");
  }
  return value;
}

function stringAt(value, path, maximumLength, { allowEmpty = false } = {}) {
  if (typeof value !== "string") contractError(path, "must be a string");
  const normalized = value.trim();
  if (!allowEmpty && !normalized) contractError(path, "must not be empty");
  if (normalized.length > maximumLength) {
    contractError(path, `must be at most ${maximumLength} characters`);
  }
  return normalized;
}

function finiteNumberAt(value, path, { minimum, maximum, integer = false }) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    contractError(path, "must be a finite number");
  }
  if (integer && !Number.isInteger(value)) {
    contractError(path, "must be an integer");
  }
  if (value < minimum || value > maximum) {
    contractError(path, `must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function uuidAt(value, path) {
  const id = stringAt(value, path, 36);
  if (!UUID_PATTERN.test(id)) contractError(path, "must be a UUID");
  return id.toLowerCase();
}

function jsonValueAt(value, path, depth = 0) {
  if (depth > 24) contractError(path, "is nested too deeply");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) contractError(path, "contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 20_000) contractError(path, "contains too many items");
    return value.map((item, index) =>
      jsonValueAt(item, `${path}[${index}]`, depth + 1),
    );
  }
  const object = objectAt(value, path);
  const entries = Object.entries(object);
  if (entries.length > 2_000) contractError(path, "contains too many fields");
  return Object.fromEntries(
    entries.map(([key, item]) => [
      stringAt(key, `${path} key`, 128),
      jsonValueAt(item, `${path}.${key}`, depth + 1),
    ]),
  );
}

function parseWord(value, cuePath, index) {
  const path = `${cuePath}.words[${index}]`;
  const word = objectAt(value, path);
  const startMs = finiteNumberAt(word.startMs, `${path}.startMs`, {
    minimum: 0,
    maximum: 86_400_000,
    integer: true,
  });
  const endMs = finiteNumberAt(word.endMs, `${path}.endMs`, {
    minimum: startMs + 1,
    maximum: 86_400_000,
    integer: true,
  });
  const parsed = {
    id: stringAt(word.id, `${path}.id`, 128),
    text: stringAt(word.text, `${path}.text`, 500),
    startMs,
    endMs,
    displaySize: "small",
  };
  if (word.displaySize !== undefined) {
    const displaySize = stringAt(
      word.displaySize,
      `${path}.displaySize`,
      16,
    );
    if (!WORD_DISPLAY_SIZE_SET.has(displaySize)) {
      contractError(`${path}.displaySize`, "must be small or large");
    }
    parsed.displaySize = displaySize;
  }
  if (word.confidence !== undefined) {
    parsed.confidence = finiteNumberAt(
      word.confidence,
      `${path}.confidence`,
      { minimum: 0, maximum: 1 },
    );
  }
  if (word.source !== undefined) {
    parsed.source = stringAt(word.source, `${path}.source`, 64);
  }
  return parsed;
}

function parseCue(value, index, durationMs) {
  const path = `document.captionTrack.cues[${index}]`;
  const cue = objectAt(value, path);
  const startMs = finiteNumberAt(cue.startMs, `${path}.startMs`, {
    minimum: 0,
    maximum: durationMs,
    integer: true,
  });
  const endMs = finiteNumberAt(cue.endMs, `${path}.endMs`, {
    minimum: startMs + 1,
    maximum: durationMs,
    integer: true,
  });
  const words = cue.words === undefined ? [] : cue.words;
  if (!Array.isArray(words)) contractError(`${path}.words`, "must be an array");
  if (words.length > 500) contractError(`${path}.words`, "has too many words");
  const parsedWords = words.map((word, wordIndex) =>
    parseWord(word, path, wordIndex),
  );
  for (let wordIndex = 0; wordIndex < parsedWords.length; wordIndex += 1) {
    const word = parsedWords[wordIndex];
    if (word.startMs < startMs || word.endMs > endMs) {
      contractError(`${path}.words[${wordIndex}]`, "must stay within its cue");
    }
    if (wordIndex > 0 && word.startMs < parsedWords[wordIndex - 1].endMs) {
      contractError(`${path}.words`, "must be ordered and non-overlapping");
    }
  }
  return {
    id: stringAt(cue.id, `${path}.id`, 128),
    text: stringAt(cue.text, `${path}.text`, 5_000),
    startMs,
    endMs,
    words: parsedWords,
  };
}

function parseCoverage(value) {
  if (value === undefined || value === null) return undefined;
  const coverage = objectAt(value, "document.captionTrack.coverage");
  if (typeof coverage.complete !== "boolean") {
    contractError(
      "document.captionTrack.coverage.complete",
      "must be a boolean",
    );
  }
  return jsonValueAt(coverage, "document.captionTrack.coverage");
}

export function parseProjectDocument(input) {
  const document = objectAt(input, "document");
  if (document.schemaVersion !== PROJECT_DOCUMENT_SCHEMA_VERSION) {
    contractError(
      "document.schemaVersion",
      `must equal ${PROJECT_DOCUMENT_SCHEMA_VERSION}`,
    );
  }
  const durationMs = finiteNumberAt(
    document.durationMs,
    "document.durationMs",
    { minimum: 1, maximum: 86_400_000, integer: true },
  );
  const canvas = objectAt(document.canvas, "document.canvas");
  const captionTrack = objectAt(
    document.captionTrack,
    "document.captionTrack",
  );
  const status = stringAt(
    captionTrack.status,
    "document.captionTrack.status",
    32,
  );
  if (!CAPTION_PROCESSING_STATUS_SET.has(status)) {
    contractError(
      "document.captionTrack.status",
      `must be one of ${CAPTION_PROCESSING_STATUSES.join(", ")}`,
    );
  }
  if (!Array.isArray(captionTrack.cues)) {
    contractError("document.captionTrack.cues", "must be an array");
  }
  if (captionTrack.cues.length > 10_000) {
    contractError("document.captionTrack.cues", "has too many cues");
  }
  const cues = captionTrack.cues.map((cue, index) =>
    parseCue(cue, index, durationMs),
  );
  const cueIds = new Set();
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    if (cueIds.has(cue.id)) {
      contractError(`document.captionTrack.cues[${index}].id`, "must be unique");
    }
    cueIds.add(cue.id);
    if (index > 0 && cue.startMs < cues[index - 1].endMs) {
      contractError(
        "document.captionTrack.cues",
        "must be ordered and non-overlapping",
      );
    }
  }

  const languageCode = stringAt(
    captionTrack.languageCode,
    "document.captionTrack.languageCode",
    32,
  );
  if (!isSupportedLanguageCode(languageCode)) {
    contractError(
      "document.captionTrack.languageCode",
      "must be as-IN or brx-IN",
    );
  }

  const parsedTrack = {
    id: stringAt(captionTrack.id, "document.captionTrack.id", 128),
    languageCode,
    status,
    cues,
    style:
      captionTrack.style === undefined
        ? {}
        : jsonValueAt(captionTrack.style, "document.captionTrack.style"),
  };
  const coverage = parseCoverage(captionTrack.coverage);
  if (
    (status === "ready" || status === "complete") &&
    coverage?.complete !== true
  ) {
    contractError(
      "document.captionTrack.coverage.complete",
      "must be verified true when caption status is ready or complete",
    );
  }
  if (coverage !== undefined) parsedTrack.coverage = coverage;

  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    sourceAssetId: uuidAt(
      document.sourceAssetId,
      "document.sourceAssetId",
    ),
    durationMs,
    canvas: {
      width: finiteNumberAt(canvas.width, "document.canvas.width", {
        minimum: 16,
        maximum: 8_192,
        integer: true,
      }),
      height: finiteNumberAt(canvas.height, "document.canvas.height", {
        minimum: 16,
        maximum: 8_192,
        integer: true,
      }),
    },
    captionTrack: parsedTrack,
  };
}

export function renderBlockReason(document) {
  const status = document?.captionTrack?.status;
  if (status === "review_required") return "caption_review_required";
  if (status !== "ready" && status !== "complete") {
    return "caption_processing_incomplete";
  }
  if (
    document?.captionTrack?.cues?.some((cue) =>
      cue?.words?.some(
        (word) => String(word?.source ?? "") === "speech-window-review",
      ),
    )
  ) {
    return "caption_timing_review_required";
  }
  if (document?.captionTrack?.coverage?.complete === false) {
    return "speech_coverage_incomplete";
  }
  if (document?.captionTrack?.coverage?.complete !== true) {
    return "speech_coverage_unverified";
  }
  return null;
}

export function parseExportSpec(input) {
  const spec = objectAt(input, "exportSpec");
  const container = spec.container ?? "mp4";
  const videoCodec = spec.videoCodec ?? "h264";
  const audioCodec = spec.audioCodec ?? "aac";
  const captionMode = spec.captionMode ?? "burned";
  if (container !== "mp4") contractError("exportSpec.container", "must be mp4");
  if (videoCodec !== "h264") {
    contractError("exportSpec.videoCodec", "must be h264");
  }
  if (audioCodec !== "aac") {
    contractError("exportSpec.audioCodec", "must be aac");
  }
  if (captionMode !== "burned") {
    contractError("exportSpec.captionMode", "must be burned");
  }
  const quality = spec.quality ?? "balanced";
  if (!["draft", "balanced", "high"].includes(quality)) {
    contractError("exportSpec.quality", "must be draft, balanced, or high");
  }
  let fps = spec.fps ?? "source";
  if (fps !== "source") {
    fps = finiteNumberAt(fps, "exportSpec.fps", {
      minimum: 1,
      maximum: 240,
    });
  }
  return {
    container,
    videoCodec,
    audioCodec,
    captionMode,
    width: finiteNumberAt(spec.width, "exportSpec.width", {
      minimum: 16,
      maximum: 8_192,
      integer: true,
    }),
    height: finiteNumberAt(spec.height, "exportSpec.height", {
      minimum: 16,
      maximum: 8_192,
      integer: true,
    }),
    fps,
    quality,
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(jsonValueAt(value, "value")));
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function deriveRenderCallbackToken(
  projectCapability,
  renderJobId,
  requestFingerprint,
) {
  const capability = stringAt(
    projectCapability,
    "projectCapability",
    256,
  );
  if (capability.length < 32) {
    contractError("projectCapability", "must contain at least 32 characters");
  }
  const fingerprint = stringAt(
    requestFingerprint,
    "requestFingerprint",
    64,
  );
  if (!/^[0-9a-f]{64}$/i.test(fingerprint)) {
    contractError("requestFingerprint", "must be a hex SHA-256 digest");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(capability),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      `syncword-render-callback:v1:${uuidAt(renderJobId, "renderJobId")}:${fingerprint.toLowerCase()}`,
    ),
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function renderRequestFingerprint(
  projectId,
  revisionId,
  spec,
  rendererRevision = "syncword-render-v2",
) {
  return sha256Hex(
    canonicalJson({
      projectId: uuidAt(projectId, "projectId"),
      revisionId: uuidAt(revisionId, "revisionId"),
      exportSpec: parseExportSpec(spec),
      rendererRevision: stringAt(
        rendererRevision,
        "rendererRevision",
        128,
      ),
    }),
  );
}

export function normalizeIdempotencyKey(value, fingerprint) {
  if (value === undefined || value === null || value === "") {
    return `auto:${stringAt(fingerprint, "fingerprint", 64)}`;
  }
  const key = stringAt(value, "idempotencyKey", 128);
  if (!/^[\x21-\x7e]+$/.test(key)) {
    contractError(
      "idempotencyKey",
      "must contain only visible ASCII characters",
    );
  }
  return key;
}

export function idempotencyDecision(existingFingerprint, nextFingerprint) {
  if (existingFingerprint === undefined || existingFingerprint === null) {
    return "create";
  }
  return existingFingerprint === nextFingerprint ? "replay" : "conflict";
}

export function revisionAdvanceDecision(currentHeadRevisionId, baseRevisionId) {
  if (currentHeadRevisionId === null && baseRevisionId === null) return "advance";
  return currentHeadRevisionId === baseRevisionId ? "advance" : "conflict";
}

const RENDER_TRANSITIONS = Object.freeze({
  queued: new Set(["queued", "running", "failed", "cancelled"]),
  running: new Set(["running", "succeeded", "failed", "cancelled"]),
  succeeded: new Set(["succeeded"]),
  failed: new Set(["failed"]),
  cancelled: new Set(["cancelled"]),
});

export function canTransitionRenderJob(currentStatus, nextStatus) {
  if (!RENDER_JOB_STATUS_SET.has(currentStatus)) return false;
  if (!RENDER_JOB_STATUS_SET.has(nextStatus)) return false;
  return RENDER_TRANSITIONS[currentStatus].has(nextStatus);
}

export function projectRouteAuthorization(method, segments) {
  if (
    method === "PUT" &&
    segments?.[0] === "render-jobs" &&
    ((segments.length === 3 && segments[2] === "state") ||
      (segments.length === 4 && segments[2] === "artifacts"))
  ) {
    return "render_callback";
  }
  return "project_owner";
}

export function assertArtifactKind(value) {
  const kind = stringAt(value, "artifactKind", 32);
  if (!EXPORT_ARTIFACT_KIND_SET.has(kind)) {
    contractError(
      "artifactKind",
      `must be one of ${EXPORT_ARTIFACT_KINDS.join(", ")}`,
    );
  }
  return kind;
}

function safeObjectSegment(value, path) {
  return uuidAt(value, path);
}

export function revisionDocumentKey(projectId, revisionId) {
  return `projects/${safeObjectSegment(projectId, "projectId")}/revisions/${safeObjectSegment(revisionId, "revisionId")}/document-v${PROJECT_DOCUMENT_SCHEMA_VERSION}.json`;
}

export function assetSourceKey(projectId, assetId, originalName) {
  const name = stringAt(originalName, "originalName", 255)
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[._-]+/, "")
    .replace(/-+$/g, "")
    .slice(0, 120);
  return `projects/${safeObjectSegment(projectId, "projectId")}/assets/${safeObjectSegment(assetId, "assetId")}/source/${name || "video.mp4"}`;
}

export function exportArtifactKey(projectId, renderJobId, artifactId, kind) {
  const extension = {
    video: "mp4",
    captions_ass: "ass",
    captions_srt: "srt",
    captions_vtt: "vtt",
  }[assertArtifactKind(kind)];
  return `projects/${safeObjectSegment(projectId, "projectId")}/renders/${safeObjectSegment(renderJobId, "renderJobId")}/${safeObjectSegment(artifactId, "artifactId")}.${extension}`;
}
