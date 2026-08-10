import {
  parseProjectDocument,
  renderBlockReason,
} from "../shared/project-contract.mjs";
import { validateRenderCaptionSubmission } from "./render-coverage.mjs";

export class ProjectRenderContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProjectRenderContractError";
    this.code = code;
  }
}

function assertRenderBoundary(document, captions) {
  if (document.captionTrack.coverage?.complete !== true) {
    throw new ProjectRenderContractError(
      "speech_coverage_unverified",
      "The immutable revision does not contain a complete speech-coverage report.",
    );
  }
  const coverageDecision = validateRenderCaptionSubmission({
    status: document.captionTrack.status,
    persistedCoverage: document.captionTrack.coverage,
    captions,
    durationSeconds: document.durationMs / 1_000,
  });
  if (!coverageDecision.allowed) {
    const error = new ProjectRenderContractError(
      coverageDecision.code,
      coverageDecision.error,
    );
    error.coverage = coverageDecision.coverage;
    error.uncoveredIntervals = coverageDecision.uncoveredIntervals;
    throw error;
  }
  const reason = renderBlockReason(document);
  if (reason) {
    throw new ProjectRenderContractError(
      reason,
      "The immutable revision has not passed the caption render boundary.",
    );
  }
}

/**
 * Converts a validated immutable project revision into the existing caption
 * renderer's seconds-based input. This is the only mutable-looking shape the
 * compute process receives; it is derived from a hash-verified revision.
 */
export function projectRevisionToRenderInput(documentInput) {
  const document = parseProjectDocument(documentInput);
  const captions = document.captionTrack.cues.map((cue) => ({
    id: cue.id,
    text: cue.text,
    start: cue.startMs / 1_000,
    end: cue.endMs / 1_000,
    words: cue.words.map((word) => ({
      id: word.id,
      text: word.text,
      start: word.startMs / 1_000,
      end: word.endMs / 1_000,
      displaySize: word.displaySize === "large" ? "large" : "small",
      ...(word.confidence === undefined ? {} : { confidence: word.confidence }),
      source: word.source ?? "manual",
    })),
  }));
  assertRenderBoundary(document, captions);

  return {
    captions,
    style: document.captionTrack.style,
    languageCode: document.captionTrack.languageCode,
    alignment: { coverage: document.captionTrack.coverage },
    video: {
      duration: document.durationMs / 1_000,
      width: document.canvas.width,
      height: document.canvas.height,
    },
  };
}

export function canonicalProjectRenderState(status, progress, message, failureCode) {
  if (!new Set(["queued", "running", "succeeded", "failed", "cancelled"]).has(status)) {
    throw new ProjectRenderContractError(
      "invalid_render_status",
      `Unsupported project render status: ${status}`,
    );
  }
  const boundedProgress = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
  return {
    status,
    progress: status === "succeeded" ? 100 : boundedProgress,
    message: String(message ?? "").slice(0, 500),
    ...(failureCode ? { failureCode: String(failureCode).slice(0, 100) } : {}),
  };
}

export function validateProjectRenderUrls({ sourceUrl, revisionUrl, callbackBase }, allowedOrigins) {
  let source;
  let revision;
  let callback;
  try {
    source = new URL(sourceUrl);
    revision = new URL(revisionUrl);
    callback = new URL(callbackBase);
  } catch {
    throw new ProjectRenderContractError(
      "invalid_project_render_url",
      "Project render URLs must be absolute URLs.",
    );
  }
  const allowlist = new Set(allowedOrigins ?? []);
  if (
    source.protocol !== "https:" ||
    revision.protocol !== "https:" ||
    callback.protocol !== "https:" ||
    source.origin !== callback.origin ||
    revision.origin !== callback.origin ||
    !allowlist.has(callback.origin)
  ) {
    throw new ProjectRenderContractError(
      "project_render_origin_not_allowed",
      "Project render URLs must use an allowed HTTPS origin.",
    );
  }
  return { source, revision, callback };
}
