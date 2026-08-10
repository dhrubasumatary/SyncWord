import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTION_QUALITY_REVISION,
  canRenderCaptionTrack,
  coverageMateriallyImproves,
  defaultCaptionCoveragePolicy,
  evaluateCaptionCoverage,
  isCaptionPlaceholderText,
  mergeRecoveredCaptions,
  planCoverageRecoveryWindows,
  speechIntervalsFromSilences,
} from "../shared/caption-coverage.mjs";

function caption(text, start, end) {
  return { id: `${text}-${start}`, text, start, end };
}

test("derives speech-active intervals as the complement of detected silence", () => {
  assert.deepEqual(
    speechIntervalsFromSilences(20, [
      { start: 0, end: 0.8 },
      { start: 8.2, end: 8.8 },
      { start: 18.5, end: 20 },
    ]),
    [
      { start: 0.8, end: 8.2 },
      { start: 8.8, end: 18.5 },
    ],
  );
});

test("accepts a caption track that covers speech within the policy", () => {
  const report = evaluateCaptionCoverage(
    [
      { start: 0.5, end: 4 },
      { start: 4.3, end: 9.8 },
    ],
    [caption("first phrase", 0.55, 4), caption("second phrase", 4.35, 9.7)],
    { durationSeconds: 10 },
  );

  assert.equal(report.complete, true);
  assert.equal(report.coverageRatio, 0.998);
  assert.equal(report.largestUncoveredGapSeconds, 0.02);
  assert.deepEqual(report.reasons, []);
});

test("default completeness permits only residual timing jitter", () => {
  assert.equal(CAPTION_QUALITY_REVISION, "perceptual-and-coverage-gate-v3");
  assert.deepEqual(defaultCaptionCoveragePolicy, {
    minimumCoverageRatio: 0.995,
    maximumUncoveredGapSeconds: 0.25,
    captionBoundaryPaddingSeconds: 0.08,
    captionMergeGapSeconds: 0.12,
    minimumSpeechIntervalSeconds: 0.12,
  });

  const boundaryJitter = evaluateCaptionCoverage(
    [{ start: 0, end: 10 }],
    [caption("jitter", 0.04, 9.96)],
    { durationSeconds: 10 },
  );
  assert.equal(boundaryJitter.complete, true);
  assert.equal(boundaryJitter.revision, "speech-active-v2");

  const aggregateMiss = evaluateCaptionCoverage(
    [{ start: 0, end: 10 }],
    [caption("short clip", 0, 9.82)],
    { durationSeconds: 10 },
  );
  assert.equal(aggregateMiss.coverageRatio, 0.99);
  assert.equal(aggregateMiss.largestUncoveredGapSeconds, 0.1);
  assert.deepEqual(aggregateMiss.reasons, ["coverage_below_threshold"]);

  const materialGap = evaluateCaptionCoverage(
    [{ start: 0, end: 100 }],
    [caption("long clip", 0, 99.55)],
    { durationSeconds: 100 },
  );
  assert.equal(materialGap.coverageRatio, 0.996);
  assert.equal(materialGap.largestUncoveredGapSeconds, 0.37);
  assert.deepEqual(materialGap.reasons, ["uncovered_gap_too_long"]);
});

test("placeholder copy never counts as spoken-caption coverage", () => {
  for (const text of ["Type here", "Type-here", "TYPE_HERE…", "Enter caption here"]) {
    assert.equal(isCaptionPlaceholderText(text), true, text);
    const report = evaluateCaptionCoverage(
      [{ start: 0, end: 4 }],
      [caption(text, 0, 4)],
      { durationSeconds: 4 },
    );
    assert.equal(report.complete, false, text);
    assert.equal(report.coverageRatio, 0, text);
    assert.equal(report.ignoredPlaceholderCaptionCount, 1, text);
    assert.deepEqual(report.uncoveredIntervals, [
      { start: 0, end: 4, duration: 4 },
    ]);
  }

  assert.equal(isCaptionPlaceholderText("Please type here now"), false);
});

test("uses aligned word bounds instead of trusting a coarse phrase envelope", () => {
  const report = evaluateCaptionCoverage(
    [{ start: 0, end: 10 }],
    [
      {
        ...caption("coarse phrase", 0, 10),
        words: [
          { text: "coarse", start: 2, end: 4 },
          { text: "phrase", start: 4.2, end: 6 },
        ],
      },
    ],
    {
      durationSeconds: 10,
      policy: {
        captionBoundaryPaddingSeconds: 0,
        captionMergeGapSeconds: 0,
      },
    },
  );

  assert.equal(report.coverageRatio, 0.38);
  assert.deepEqual(report.uncoveredIntervals, [
    { start: 0, end: 2, duration: 2 },
    { start: 4, end: 4.2, duration: 0.2 },
    { start: 6, end: 10, duration: 4 },
  ]);
});

test("detects Kapwing-like missing speech spans deterministically", () => {
  const report = evaluateCaptionCoverage(
    [{ start: 0, end: 45 }],
    [
      caption("opening", 0, 16),
      caption("middle", 26.9, 39.57),
      caption("ending", 44.39, 45),
    ],
    {
      durationSeconds: 45,
      policy: {
        captionBoundaryPaddingSeconds: 0,
        captionMergeGapSeconds: 0,
      },
    },
  );

  assert.equal(report.complete, false);
  assert.equal(report.coverageRatio, 0.651);
  assert.equal(report.largestUncoveredGapSeconds, 10.9);
  assert.deepEqual(report.uncoveredIntervals, [
    { start: 16, end: 26.9, duration: 10.9 },
    { start: 39.57, end: 44.39, duration: 4.82 },
  ]);
  assert.deepEqual(report.reasons, [
    "coverage_below_threshold",
    "uncovered_gap_too_long",
  ]);
});

test("fails a long uncovered gap independently of the ratio threshold", () => {
  const report = evaluateCaptionCoverage(
    [{ start: 0, end: 20 }],
    [caption("before", 0, 18.1), caption("after", 19.7, 20)],
    {
      durationSeconds: 20,
      policy: {
        minimumCoverageRatio: 0.9,
        captionBoundaryPaddingSeconds: 0,
        captionMergeGapSeconds: 0,
      },
    },
  );

  assert.equal(report.coverageRatio, 0.92);
  assert.equal(report.complete, false);
  assert.deepEqual(report.reasons, ["uncovered_gap_too_long"]);
});

test("plans only uncovered retry windows with modest context padding", () => {
  const windows = planCoverageRecoveryWindows(
    [
      { start: 16, end: 26.9 },
      { start: 39.57, end: 44.39 },
    ],
    45,
  );

  assert.deepEqual(windows, [
    {
      id: "coverage-recovery-1",
      start: 15.55,
      end: 27.35,
      duration: 11.8,
    },
    {
      id: "coverage-recovery-2",
      start: 39.12,
      end: 44.84,
      duration: 5.72,
    },
  ]);
  assert.ok(windows.every((window) => window.duration < 30));
});

test("splits and bounds long recovery windows below the REST duration limit", () => {
  const windows = planCoverageRecoveryWindows(
    [{ start: 1, end: 75 }],
    80,
    { paddingSeconds: 0, maximumWindowSeconds: 28, maximumWindows: 2 },
  );

  assert.equal(windows.length, 2);
  assert.ok(windows.every((window) => window.duration <= 28));
  assert.deepEqual(
    windows.map(({ start, end }) => ({ start, end })),
    [
      { start: 1, end: 29 },
      { start: 28.55, end: 56.55 },
    ],
  );
});

test("keeps a single recovery pass bounded even with unsafe configuration", () => {
  const gaps = Array.from({ length: 20 }, (_, index) => ({
    start: index * 3 + 0.5,
    end: index * 3 + 1,
  }));
  const windows = planCoverageRecoveryWindows(gaps, 65, {
    paddingSeconds: 0,
    mergeGapSeconds: 0,
    maximumWindows: 10_000,
  });

  assert.equal(windows.length, 12);
});

test("merges new gap captions while discarding padded-context duplicates", () => {
  const result = mergeRecoveredCaptions(
    [
      caption("before", 0, 4),
      caption("after", 8, 12),
    ],
    [
      caption("before", 3.5, 4.1),
      caption("context paraphrase", 3.5, 4.2),
      caption("Type-here", 4.2, 7.8),
      caption("recovered words", 4.2, 7.8),
      caption("outside", 13, 14),
    ],
    [{ start: 4, end: 8 }],
  );

  assert.equal(result.addedCaptionCount, 1);
  assert.deepEqual(
    result.captions.map((item) => item.text),
    ["before", "recovered words", "after"],
  );
  assert.equal(result.additions[0]._coverage_recovery, true);
});

test("selects only material coverage gains and blocks incomplete rendering", () => {
  const primary = {
    complete: false,
    coverageRatio: 0.65,
    largestUncoveredGapSeconds: 10.9,
  };
  const improved = {
    complete: true,
    coverageRatio: 0.97,
    largestUncoveredGapSeconds: 0.4,
  };
  const unchanged = {
    complete: false,
    coverageRatio: 0.6505,
    largestUncoveredGapSeconds: 10.88,
  };

  assert.equal(coverageMateriallyImproves(primary, improved), true);
  assert.equal(coverageMateriallyImproves(primary, unchanged), false);
  assert.equal(canRenderCaptionTrack("ready", improved), true);
  assert.equal(canRenderCaptionTrack("ready", primary), false);
  assert.equal(canRenderCaptionTrack("review_required", improved), false);
  assert.equal(canRenderCaptionTrack("complete", undefined), false);
});

test("preserves Assamese, Bodo, and code-mixed text through gap recovery", () => {
  const corpus = [
    { name: "Assamese", text: "মই আজি আপোনালোকক ক'ব বিচাৰোঁ" },
    { name: "Bodo", text: "आं नोंथांमोनखौ बुंनो लुबैयो" },
    { name: "code-mix", text: "মই SyncWord use কৰোঁ" },
  ];

  for (const sample of corpus) {
    const merged = mergeRecoveredCaptions(
      [caption(`${sample.name} before`, 0, 2), caption(`${sample.name} after`, 4, 6)],
      [caption(sample.text, 2, 4)],
      [{ start: 2, end: 4 }],
    );
    assert.equal(merged.addedCaptionCount, 1, sample.name);
    assert.equal(merged.additions[0].text, sample.text, sample.name);
    const coverage = evaluateCaptionCoverage(
      [{ start: 0, end: 6 }],
      merged.captions,
      {
        durationSeconds: 6,
        policy: {
          captionBoundaryPaddingSeconds: 0,
          captionMergeGapSeconds: 0,
        },
      },
    );
    assert.equal(coverage.complete, true, sample.name);
  }
});
