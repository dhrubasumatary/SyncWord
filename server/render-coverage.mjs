import { evaluateCaptionCoverage } from "../shared/caption-coverage.mjs";

const acceptedRenderStatuses = new Set([
  "ready",
  "complete",
  "review_required",
]);

function rejection(code, error, coverage = null) {
  return {
    allowed: false,
    code,
    error,
    coverage,
    uncoveredIntervals: Array.isArray(coverage?.uncoveredIntervals)
      ? coverage.uncoveredIntervals
      : [],
  };
}

export function validateRenderCaptionSubmission({
  status,
  persistedCoverage,
  captions,
  durationSeconds,
  policy,
}) {
  const normalizedStatus = String(status ?? "");
  if (!acceptedRenderStatuses.has(normalizedStatus)) {
    return rejection(
      "caption_status_not_renderable",
      `Job is not ready for rendering (${normalizedStatus || "unknown"}).`,
    );
  }
  const timingReviewWordCount = Array.isArray(captions)
    ? captions.reduce(
        (count, caption) =>
          count +
          (Array.isArray(caption?.words)
            ? caption.words.filter(
                (word) =>
                  String(word?.source ?? word?.timingSource ?? "") ===
                  "speech-window-review",
              ).length
            : 0),
        0,
      )
    : 0;
  if (timingReviewWordCount > 0) {
    return rejection(
      "caption_timing_review_required",
      `${timingReviewWordCount} automatically repaired ${
        timingReviewWordCount === 1 ? "word needs" : "words need"
      } a quick timing edit before rendering.`,
    );
  }
  if (
    !persistedCoverage ||
    typeof persistedCoverage !== "object" ||
    typeof persistedCoverage.complete !== "boolean" ||
    !Array.isArray(persistedCoverage.speechIntervals)
  ) {
    return rejection(
      "caption_coverage_unverified",
      "Caption coverage has not been verified for this job. Reprocess it before rendering.",
    );
  }
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    return rejection(
      "caption_coverage_unverified",
      "The source duration is unavailable, so caption coverage cannot be verified.",
    );
  }
  const speechIntervalsAreValid =
    persistedCoverage.speechIntervals.length > 0 &&
    persistedCoverage.speechIntervals.every((interval, index, intervals) => {
      const start = Number(interval?.start);
      const end = Number(interval?.end);
      const previousEnd = Number(intervals[index - 1]?.end);
      return (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start >= 0 &&
        (index === 0 || start >= previousEnd) &&
        end > start &&
        end <= duration
      );
    });
  const reportedSpeechDuration = Number(
    persistedCoverage.speechDurationSeconds,
  );
  const computedSpeechDuration = persistedCoverage.speechIntervals.reduce(
    (sum, interval) =>
      sum + Number(interval?.end) - Number(interval?.start),
    0,
  );
  const durationTolerance = Math.max(0.1, reportedSpeechDuration * 0.005);
  if (
    !speechIntervalsAreValid ||
    !Number.isFinite(reportedSpeechDuration) ||
    reportedSpeechDuration <= 0 ||
    !Number.isFinite(computedSpeechDuration) ||
    Math.abs(computedSpeechDuration - reportedSpeechDuration) >
      durationTolerance
  ) {
    return rejection(
      "caption_coverage_unverified",
      "Speech activity diagnostics are missing or invalid. Reprocess the job before rendering.",
    );
  }
  if (
    normalizedStatus !== "review_required" &&
    persistedCoverage.complete !== true
  ) {
    return rejection(
      "caption_coverage_incomplete",
      "Caption coverage is incomplete. Review or recover the missed speech before rendering.",
      persistedCoverage,
    );
  }

  const coverage = evaluateCaptionCoverage(
    persistedCoverage.speechIntervals,
    captions,
    { durationSeconds: duration, policy },
  );
  if (!coverage.complete) {
    return rejection(
      "caption_coverage_incomplete",
      "Submitted captions leave spoken audio uncovered. Repair the reported intervals before rendering.",
      coverage,
    );
  }

  return {
    allowed: true,
    repairedReview: normalizedStatus === "review_required",
    coverage,
    uncoveredIntervals: [],
  };
}

export function acceptedRenderCaptionState({
  status,
  alignment,
  captions,
  decision,
  verifiedAt = new Date().toISOString(),
}) {
  if (!decision?.allowed || decision.coverage?.complete !== true) {
    throw new TypeError("An accepted complete coverage decision is required.");
  }
  const previousCoverage = alignment?.coverage;
  return {
    captions,
    alignment: {
      ...(alignment ?? {}),
      coverage: {
        ...decision.coverage,
        ...(previousCoverage?.recovery
          ? { recovery: previousCoverage.recovery }
          : {}),
        verification: {
          source: "render-submission",
          previousStatus: String(status ?? ""),
          verifiedAt,
        },
      },
    },
  };
}
