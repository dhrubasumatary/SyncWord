import {
  CAPTION_QUALITY_REVISION,
  evaluateCaptionCoverage,
} from "./caption-coverage.mjs";
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  canonicalJson,
  parseExportSpec,
  parseProjectDocument,
  sha256Hex,
} from "./project-contract.mjs";

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function requiredText(value, path) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${path} must not be empty.`);
  return text;
}

function milliseconds(value, path, durationMs) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    throw new TypeError(`${path} must be a finite number of seconds.`);
  }
  return Math.max(0, Math.min(durationMs, Math.round(seconds * 1_000)));
}

function cueFromCaption(caption, index, durationMs, previousEndMs) {
  const path = `captions[${index}]`;
  const startMs = milliseconds(caption?.start, `${path}.start`, durationMs);
  const endMs = milliseconds(caption?.end, `${path}.end`, durationMs);
  if (endMs <= startMs) {
    throw new TypeError(`${path} must have a positive duration.`);
  }
  if (startMs < previousEndMs) {
    throw new TypeError(`${path} overlaps the preceding caption.`);
  }

  const words = Array.isArray(caption?.words) ? caption.words : [];
  let previousWordEndMs = startMs;
  const parsedWords = words.map((word, wordIndex) => {
    const wordPath = `${path}.words[${wordIndex}]`;
    const wordStartMs = milliseconds(
      word?.start,
      `${wordPath}.start`,
      durationMs,
    );
    const wordEndMs = milliseconds(word?.end, `${wordPath}.end`, durationMs);
    if (wordStartMs < startMs || wordEndMs > endMs || wordEndMs <= wordStartMs) {
      throw new TypeError(`${wordPath} must stay within its caption.`);
    }
    if (wordStartMs < previousWordEndMs) {
      throw new TypeError(`${wordPath} overlaps the preceding word.`);
    }
    previousWordEndMs = wordEndMs;
    const confidence = Number(word?.confidence);
    return {
      id: requiredText(word?.id ?? `${caption?.id ?? index}-word-${wordIndex}`, `${wordPath}.id`),
      text: requiredText(word?.text, `${wordPath}.text`),
      startMs: wordStartMs,
      endMs: wordEndMs,
      displaySize: word?.displaySize === "large" ? "large" : "small",
      ...(Number.isFinite(confidence)
        ? { confidence: Math.max(0, Math.min(1, confidence)) }
        : {}),
      source: requiredText(word?.timingSource ?? word?.source ?? "manual", `${wordPath}.source`),
    };
  });

  return {
    id: requiredText(caption?.id ?? `caption-${index + 1}`, `${path}.id`),
    text: requiredText(
      caption?.text ?? parsedWords.map((word) => word.text).join(" "),
      `${path}.text`,
    ),
    startMs,
    endMs,
    words: parsedWords,
  };
}

function missingSpeechCoverage() {
  return {
    revision: CAPTION_QUALITY_REVISION,
    complete: false,
    speechDurationSeconds: 0,
    coveredSpeechDurationSeconds: 0,
    uncoveredDurationSeconds: 0,
    coverageRatio: 0,
    largestUncoveredGapSeconds: 0,
    speechIntervals: [],
    captionIntervals: [],
    coveredIntervals: [],
    uncoveredIntervals: [],
    reasons: ["speech_intervals_missing"],
  };
}

/**
 * Converts the live editor's second-based captions into the immutable,
 * millisecond-based project document. Coverage is always recomputed from the
 * speech intervals captured during processing; a missing activity record is
 * deliberately non-renderable.
 */
export function projectDocumentFromEditor({
  sourceAssetId,
  durationSeconds,
  canvas,
  languageCode,
  captions,
  style,
  speechIntervals,
  requestedStatus = "ready",
  captionTrackId = "captions-primary",
}) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new TypeError("durationSeconds must be positive.");
  }
  const durationMs = Math.max(1, Math.round(duration * 1_000));
  const orderedCaptions = Array.isArray(captions) ? captions : [];
  let previousEndMs = 0;
  const cues = orderedCaptions.map((caption, index) => {
    const cue = cueFromCaption(caption, index, durationMs, previousEndMs);
    previousEndMs = cue.endMs;
    return cue;
  });

  const coverage = Array.isArray(speechIntervals)
    ? evaluateCaptionCoverage(speechIntervals, orderedCaptions, {
        durationSeconds: duration,
      })
    : missingSpeechCoverage();
  const status = coverage.complete
    ? requestedStatus === "complete"
      ? "complete"
      : "ready"
    : "review_required";

  return parseProjectDocument({
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    sourceAssetId,
    durationMs,
    canvas: {
      width: Math.round(finiteNumber(canvas?.width)),
      height: Math.round(finiteNumber(canvas?.height)),
    },
    captionTrack: {
      id: requiredText(captionTrackId, "captionTrackId"),
      languageCode: requiredText(languageCode, "languageCode"),
      status,
      cues,
      style: style && typeof style === "object" ? style : {},
      coverage,
    },
  });
}

export function editorCaptionsFromProject(documentInput) {
  const document = parseProjectDocument(documentInput);
  const captionLanguage =
    document.captionTrack.languageCode === "as-IN" ? "as" : "brx";
  const timingSources = new Set([
    "mms-fa",
    "mms-fa-star",
    "speech-window-review",
    "acoustic-dp",
    "grapheme-prior",
    "manual",
  ]);
  return document.captionTrack.cues.map((cue) => ({
    id: cue.id,
    text: cue.text,
    start: cue.startMs / 1_000,
    end: cue.endMs / 1_000,
    language: captionLanguage,
    words: cue.words.map((word) => ({
      id: word.id,
      text: word.text,
      start: word.startMs / 1_000,
      end: word.endMs / 1_000,
      displaySize: word.displaySize === "large" ? "large" : "small",
      confidence: word.confidence ?? 0.72,
      source: timingSources.has(word.source) ? word.source : "manual",
    })),
  }));
}

export function safeProjectSession(input) {
  if (!input || typeof input !== "object") return null;
  const projectId = String(input.projectId ?? "");
  const sourceAssetId = String(input.sourceAssetId ?? "");
  if (!projectId || !sourceAssetId) return null;
  return {
    projectId,
    sourceAssetId,
    activeProcessingJobId:
      typeof input.activeProcessingJobId === "string"
        ? input.activeProcessingJobId
        : null,
    headRevisionId:
      typeof input.headRevisionId === "string" ? input.headRevisionId : null,
    headEditorRevisionId:
      typeof input.headEditorRevisionId === "string"
        ? input.headEditorRevisionId
        : null,
    activeRenderJobId:
      typeof input.activeRenderJobId === "string"
        ? input.activeRenderJobId
        : null,
    activeRenderIdempotencyKey:
      typeof input.activeRenderIdempotencyKey === "string"
        ? input.activeRenderIdempotencyKey
        : null,
    activeRenderRequestScope:
      typeof input.activeRenderRequestScope === "string"
        ? input.activeRenderRequestScope
        : null,
    activeRenderAttemptDiscriminator:
      typeof input.activeRenderAttemptDiscriminator === "string"
        ? input.activeRenderAttemptDiscriminator
        : null,
    lastCompletedRenderJobId:
      typeof input.lastCompletedRenderJobId === "string"
        ? input.lastCompletedRenderJobId
        : null,
    lastExportArtifactId:
      typeof input.lastExportArtifactId === "string"
        ? input.lastExportArtifactId
        : null,
  };
}

/**
 * The remote project head is authoritative after a reload. A changed head also
 * invalidates any pre-dispatch idempotency key because that key names immutable
 * input from the previous head. An already-running render remains pollable.
 *
 * @param {unknown} input
 * @param {string | null | undefined} remoteHeadRevisionId
 * @param {string | null | undefined} remoteHeadEditorRevisionId
 */
export function reconcileProjectSessionHead(
  input,
  remoteHeadRevisionId,
  remoteHeadEditorRevisionId = null,
) {
  const session = safeProjectSession(input);
  if (!session) return null;
  const remoteHead =
    typeof remoteHeadRevisionId === "string" && remoteHeadRevisionId
      ? remoteHeadRevisionId
      : null;
  if (remoteHead === session.headRevisionId) return session;
  return {
    ...session,
    headRevisionId: remoteHead,
    headEditorRevisionId:
      remoteHead &&
      typeof remoteHeadEditorRevisionId === "string" &&
      remoteHeadEditorRevisionId
        ? remoteHeadEditorRevisionId
        : null,
    activeRenderIdempotencyKey: null,
    activeRenderRequestScope: null,
    activeRenderAttemptDiscriminator: null,
  };
}

/**
 * A terminal processing response is not editable until its immutable revision
 * has been fetched and committed to editor history.
 */
export function projectProcessingStatusForHydration(
  status,
  revisionHydrated = false,
) {
  return !revisionHydrated && ["ready", "review_required"].includes(status)
    ? "aligning"
    : status;
}

/**
 * Canonical local scope for a render dispatch idempotency key. It deliberately
 * includes exactly the immutable revision and normalized export specification.
 */
export function projectRenderRequestScope(revisionId, exportSpec) {
  return canonicalJson({
    revisionId: requiredText(revisionId, "revisionId"),
    exportSpec: parseExportSpec(exportSpec),
  });
}

export async function selectProjectRenderDispatchIdentity(
  sessionInput,
  revisionId,
  requestScope,
) {
  const session = safeProjectSession(sessionInput);
  if (!session) throw new TypeError("A valid project session is required.");
  const revision = requiredText(revisionId, "revisionId");
  const scope = requiredText(requestScope, "requestScope");
  const attemptDiscriminator =
    session.activeRenderRequestScope === scope
      ? session.activeRenderAttemptDiscriminator
      : null;
  const digest = await sha256Hex(
    canonicalJson({
      version: 1,
      projectId: session.projectId,
      revisionId: revision,
      requestScope: scope,
      attemptDiscriminator: attemptDiscriminator ?? "initial",
    }),
  );
  const idempotencyKey = `render:v1:${digest}`;
  return {
    requestScope: scope,
    attemptDiscriminator,
    idempotencyKey,
    reused: session.activeRenderIdempotencyKey === idempotencyKey,
  };
}

export function projectSessionAfterTerminalRender(
  sessionInput,
  requestScope,
  terminalRenderJobId,
) {
  const session = safeProjectSession(sessionInput);
  if (!session) throw new TypeError("A valid project session is required.");
  return {
    ...session,
    activeRenderJobId: null,
    activeRenderIdempotencyKey: null,
    activeRenderRequestScope: requiredText(requestScope, "requestScope"),
    activeRenderAttemptDiscriminator: requiredText(
      terminalRenderJobId,
      "terminalRenderJobId",
    ),
  };
}

/**
 * @param {unknown} artifactsInput
 * @param {string} completedRenderJobId
 * @param {string} kind
 * @param {string | null | undefined} exactArtifactId
 */
export function selectCompletedRenderArtifact(
  artifactsInput,
  completedRenderJobId,
  kind,
  exactArtifactId = null,
) {
  const renderJobId = requiredText(
    completedRenderJobId,
    "completedRenderJobId",
  );
  const artifactKind = requiredText(kind, "kind");
  const artifacts = Array.isArray(artifactsInput) ? artifactsInput : [];
  const matchingRender = artifacts.filter(
    (artifact) =>
      artifact &&
      typeof artifact === "object" &&
      artifact.renderJobId === renderJobId,
  );
  if (typeof exactArtifactId === "string" && exactArtifactId) {
    return (
      matchingRender.find(
        (artifact) =>
          artifact.id === exactArtifactId && artifact.kind === artifactKind,
      ) ?? null
    );
  }
  return matchingRender.find((artifact) => artifact.kind === artifactKind) ?? null;
}

/**
 * Project revisions are saved before render dispatch. Reflect that durable save
 * immediately so a transient dispatch error remains retryable without a fake
 * edit and coverage never falls back to the pre-save processing snapshot.
 */
export function jobAfterProjectRevisionSave(jobInput, documentInput, captionsInput) {
  if (!jobInput || typeof jobInput !== "object") return null;
  const document = parseProjectDocument(documentInput);
  const captions = Array.isArray(captionsInput) ? captionsInput : [];
  const alignment =
    jobInput.alignment && typeof jobInput.alignment === "object"
      ? jobInput.alignment
      : {};
  const totalWords = captions.reduce(
    (total, caption) =>
      total + (Array.isArray(caption?.words) ? caption.words.length : 0),
    0,
  );
  const waveformAlignedWords = captions.reduce(
    (total, caption) =>
      total +
      (Array.isArray(caption?.words)
        ? caption.words.filter(
            (word) => (word?.source ?? word?.timingSource) !== "manual",
          ).length
        : 0),
    0,
  );
  const status =
    document.captionTrack.status === "review_required"
      ? "review_required"
      : "ready";
  return {
    ...jobInput,
    status,
    progress: 100,
    message:
      status === "ready"
        ? "Saved revision is ready to render."
        : "Some spoken audio is still missing a caption.",
    captions,
    alignment: {
      ...alignment,
      method:
        typeof alignment.method === "string"
          ? alignment.method
          : "project-caption-v3",
      totalWords,
      waveformAlignedWords,
      averageConfidence: Number.isFinite(alignment.averageConfidence)
        ? Number(alignment.averageConfidence)
        : 0,
      needsReview: status === "review_required" ? 1 : 0,
      coverage: document.captionTrack.coverage,
    },
  };
}
