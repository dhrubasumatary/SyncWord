import {
  coverageMateriallyImproves,
  evaluateCaptionCoverage,
  mergeRecoveredCaptions,
  planCoverageRecoveryWindows,
} from "../shared/caption-coverage.mjs";
import { alignmentQualityReport } from "../shared/caption-quality.mjs";

function captionsWithoutWords(captions) {
  return (captions ?? []).map(({ words: _words, ...caption }) => {
    void _words;
    return caption;
  });
}

function recoveredCaptionList(result) {
  return Array.isArray(result) ? result : result?.captions ?? [];
}

export async function runTargetedCoverageRecovery({
  alignment,
  speechIntervals,
  durationSeconds,
  policy,
  recoveryWindowOptions,
  transcribeWindows,
  alignCaptions,
}) {
  if (!alignment || !Array.isArray(alignment.captions)) {
    throw new TypeError("A timed primary alignment is required.");
  }
  if (typeof transcribeWindows !== "function") {
    throw new TypeError("A recovery transcription callback is required.");
  }
  if (typeof alignCaptions !== "function") {
    throw new TypeError("A recovery alignment callback is required.");
  }

  const primaryCoverage = evaluateCaptionCoverage(
    speechIntervals,
    alignment.captions,
    { durationSeconds, policy },
  );
  const recovery = {
    attempted: false,
    selected: false,
    windowCount: 0,
    addedCaptionCount: 0,
  };
  if (primaryCoverage.complete) {
    return {
      alignment,
      coverage: primaryCoverage,
      primaryCoverage,
      recovery,
      windows: [],
    };
  }

  const windows = planCoverageRecoveryWindows(
    primaryCoverage.uncoveredIntervals,
    durationSeconds,
    recoveryWindowOptions,
  );
  recovery.windowCount = windows.length;
  if (!windows.length) {
    return {
      alignment,
      coverage: primaryCoverage,
      primaryCoverage,
      recovery,
      windows,
    };
  }

  recovery.attempted = true;
  const transcriptResult = await transcribeWindows(windows, {
    primaryCoverage,
  });
  const merged = mergeRecoveredCaptions(
    captionsWithoutWords(alignment.captions),
    recoveredCaptionList(transcriptResult),
    primaryCoverage.uncoveredIntervals,
  );
  recovery.addedCaptionCount = merged.addedCaptionCount;
  if (!merged.addedCaptionCount) {
    return {
      alignment,
      coverage: primaryCoverage,
      primaryCoverage,
      recovery,
      windows,
      transcriptResult,
      mergedCaptions: merged.captions,
    };
  }

  const candidate = await alignCaptions(merged.captions);
  const candidateCoverage = evaluateCaptionCoverage(
    speechIntervals,
    candidate?.captions ?? [],
    { durationSeconds, policy },
  );
  const primaryQuality = alignmentQualityReport(alignment);
  const candidateQuality = alignmentQualityReport(candidate);
  const timingRemainsCredible =
    candidateQuality.totalWords > 0 &&
    candidateQuality.score >= primaryQuality.score - 0.08 &&
    candidateQuality.severeRatio <=
      Math.max(0.45, primaryQuality.severeRatio + 0.1);
  recovery.selected =
    timingRemainsCredible &&
    coverageMateriallyImproves(primaryCoverage, candidateCoverage);

  return {
    alignment: recovery.selected ? candidate : alignment,
    coverage: recovery.selected ? candidateCoverage : primaryCoverage,
    primaryCoverage,
    candidateCoverage,
    recovery,
    windows,
    transcriptResult,
    mergedCaptions: merged.captions,
  };
}
