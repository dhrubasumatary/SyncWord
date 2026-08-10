import { projectDocumentFromEditor } from "../shared/project-editor-adapter.mjs";
import { parseProjectDocument } from "../shared/project-contract.mjs";

export const PROJECT_PROCESSING_STATE_CALLBACK_STATUSES = Object.freeze([
  "queued",
  "extracting",
  "transcribing",
  "aligning",
  "recovering",
  "failed",
  "cancelled",
]);

const PROJECT_PROCESSING_STATE_CALLBACK_STATUS_SET = new Set(
  PROJECT_PROCESSING_STATE_CALLBACK_STATUSES,
);

export class ProjectProcessingContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProjectProcessingContractError";
    this.code = code;
  }
}

export function canonicalProjectProcessingState(
  status,
  progress,
  message,
  failureCode,
) {
  if (!PROJECT_PROCESSING_STATE_CALLBACK_STATUS_SET.has(status)) {
    throw new ProjectProcessingContractError(
      "invalid_processing_status",
      `Unsupported project processing callback status: ${status}`,
    );
  }
  const boundedProgress = Math.max(
    0,
    Math.min(100, Math.round(Number(progress) || 0)),
  );
  return {
    status,
    progress: boundedProgress,
    message: String(message ?? "").slice(0, 500),
    ...(failureCode
      ? { failureCode: String(failureCode).slice(0, 100) }
      : {}),
  };
}

/**
 * The legacy processor intentionally keeps its public v1/v2 statuses. This
 * adapter gives the project callback its more precise canonical phase without
 * changing those compatibility APIs.
 */
export function projectProcessingCallbackStatus(status, message = "") {
  if (status !== "transcribing") {
    return PROJECT_PROCESSING_STATE_CALLBACK_STATUS_SET.has(status)
      ? status
      : null;
  }
  const detail = String(message).toLowerCase();
  if (detail.includes("recover") || detail.includes("missed speech")) {
    return "recovering";
  }
  if (
    detail.includes("align") ||
    detail.includes("caption timing") ||
    detail.includes("timing")
  ) {
    return "aligning";
  }
  return "transcribing";
}

/**
 * Produces the first immutable project revision from the existing caption
 * processor. Speech coverage is recomputed from the captured activity windows;
 * a stale `job.alignment.coverage` value is never trusted.
 */
export function projectDocumentFromProcessingJob(plan, job) {
  if (!plan?.source?.assetId) {
    throw new ProjectProcessingContractError(
      "processing_source_missing",
      "The processing plan does not identify its immutable source asset.",
    );
  }
  if (!new Set(["ready", "review_required"]).has(job?.status)) {
    throw new ProjectProcessingContractError(
      "processing_result_not_ready",
      "Caption processing must finish as ready or review_required before a revision is saved.",
    );
  }

  let document;
  try {
    document = projectDocumentFromEditor({
      sourceAssetId: plan.source.assetId,
      durationSeconds: Number(job.video?.duration),
      canvas: {
        width: Number(job.video?.width),
        height: Number(job.video?.height),
      },
      languageCode: plan.processing.language,
      captions: job.captions,
      style: job.style ?? {},
      speechIntervals:
        Array.isArray(job.speechAnalysis?.speechIntervals) &&
        job.speechAnalysis.speechIntervals.length > 0
          ? job.speechAnalysis.speechIntervals
          : undefined,
      requestedStatus: job.status,
    });
  } catch (error) {
    throw new ProjectProcessingContractError(
      "processing_result_invalid",
      error instanceof Error
        ? error.message
        : "Caption processing produced an invalid project document.",
    );
  }

  if (!new Set(["ready", "review_required"]).has(document.captionTrack.status)) {
    throw new ProjectProcessingContractError(
      "processing_result_status_invalid",
      "The normalized project document must be ready or review_required.",
    );
  }

  const recovery = job.alignment?.coverage?.recovery;
  if (recovery && typeof recovery === "object") {
    document = parseProjectDocument({
      ...document,
      captionTrack: {
        ...document.captionTrack,
        coverage: {
          ...document.captionTrack.coverage,
          recovery,
        },
      },
    });
  }
  return document;
}

export function assertProjectProcessingResult(plan, documentInput) {
  let document;
  try {
    document = parseProjectDocument(documentInput);
  } catch (error) {
    throw new ProjectProcessingContractError(
      "processing_result_invalid",
      error instanceof Error ? error.message : "Invalid project document.",
    );
  }
  if (document.sourceAssetId !== plan.source.assetId) {
    throw new ProjectProcessingContractError(
      "processing_result_source_mismatch",
      "The processing result references a different source asset.",
    );
  }
  if (document.captionTrack.languageCode !== plan.processing.language) {
    throw new ProjectProcessingContractError(
      "processing_result_language_mismatch",
      "The processing result language must match the selected language.",
    );
  }
  if (!new Set(["ready", "review_required"]).has(document.captionTrack.status)) {
    throw new ProjectProcessingContractError(
      "processing_result_status_invalid",
      "The processing result status must be ready or review_required.",
    );
  }
  return document;
}
