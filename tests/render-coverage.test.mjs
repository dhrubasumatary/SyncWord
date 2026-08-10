import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCaptionCoverage } from "../shared/caption-coverage.mjs";
import {
  acceptedRenderCaptionState,
  validateRenderCaptionSubmission,
} from "../server/render-coverage.mjs";

const durationSeconds = 12;
const speechIntervals = [{ start: 0, end: durationSeconds }];
const policy = {
  minimumCoverageRatio: 0.92,
  maximumUncoveredGapSeconds: 1.5,
  captionBoundaryPaddingSeconds: 0,
  captionMergeGapSeconds: 0,
};

function caption(id, start, end) {
  return {
    id,
    text: id,
    start,
    end,
    words: [
      {
        id: `${id}-word`,
        text: id,
        start,
        end,
        confidence: 1,
        source: "manual",
      },
    ],
  };
}

const completeCaptions = [
  caption("first", 0, 6),
  caption("second", 6, 12),
];
const completeCoverage = evaluateCaptionCoverage(
  speechIntervals,
  completeCaptions,
  { durationSeconds, policy },
);

function validate(options = {}) {
  const status = options.status ?? "ready";
  const persistedCoverage = Object.hasOwn(options, "persistedCoverage")
    ? options.persistedCoverage
    : completeCoverage;
  const captions = options.captions ?? completeCaptions;
  return validateRenderCaptionSubmission({
    status,
    persistedCoverage,
    captions,
    durationSeconds,
    policy,
  });
}

test("accepts a ready track only after checking its submitted captions", () => {
  const decision = validate();
  assert.equal(decision.allowed, true);
  assert.equal(decision.coverage.complete, true);
  assert.equal(decision.coverage.coverageRatio, 1);
});

test("blocks a deleted caption despite stale complete job coverage", () => {
  const decision = validate({ captions: [completeCaptions[0]] });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "caption_coverage_incomplete");
  assert.equal(decision.coverage.coverageRatio, 0.5);
  assert.deepEqual(decision.uncoveredIntervals, [
    { start: 6, end: 12, duration: 6 },
  ]);
});

test("blocks retiming that creates a speech gap despite stale coverage", () => {
  const decision = validate({
    captions: [caption("first", 0, 4), caption("second", 8, 12)],
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "caption_coverage_incomplete");
  assert.equal(decision.coverage.largestUncoveredGapSeconds, 4);
  assert.deepEqual(decision.uncoveredIntervals, [
    { start: 4, end: 8, duration: 4 },
  ]);
});

test("blocks a full-duration placeholder despite stale complete coverage", () => {
  const placeholder = caption("placeholder", 0, 12);
  placeholder.text = "Type-here";
  placeholder.words[0].text = "Type-here";

  const decision = validate({ captions: [placeholder] });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "caption_coverage_incomplete");
  assert.equal(decision.coverage.coverageRatio, 0);
  assert.equal(decision.coverage.ignoredPlaceholderCaptionCount, 1);
  assert.deepEqual(decision.uncoveredIntervals, [
    { start: 0, end: 12, duration: 12 },
  ]);
});

test("missing persisted coverage fails closed", () => {
  const decision = validate({ persistedCoverage: undefined });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "caption_coverage_unverified");
  assert.equal(decision.coverage, null);
  assert.deepEqual(decision.uncoveredIntervals, []);
});

test("empty or corrupt persisted speech activity fails closed", () => {
  for (const persistedCoverage of [
    { ...completeCoverage, speechIntervals: [] },
    {
      ...completeCoverage,
      speechIntervals: [{ start: 9, end: 3 }],
    },
    { ...completeCoverage, speechDurationSeconds: 0 },
    { ...completeCoverage, speechDurationSeconds: 1 },
  ]) {
    const decision = validate({ persistedCoverage });
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, "caption_coverage_unverified");
  }
});

test("review-required captions unlock only when the submitted repair passes", () => {
  const incompleteCaptions = [
    caption("first", 0, 4),
    caption("second", 8, 12),
  ];
  const incompleteCoverage = evaluateCaptionCoverage(
    speechIntervals,
    incompleteCaptions,
    { durationSeconds, policy },
  );

  const stillIncomplete = validate({
    status: "review_required",
    persistedCoverage: incompleteCoverage,
    captions: incompleteCaptions,
  });
  assert.equal(stillIncomplete.allowed, false);
  assert.equal(stillIncomplete.code, "caption_coverage_incomplete");

  const repaired = validate({
    status: "review_required",
    persistedCoverage: incompleteCoverage,
    captions: completeCaptions,
  });
  assert.equal(repaired.allowed, true);
  assert.equal(repaired.repairedReview, true);
  assert.equal(repaired.coverage.complete, true);

  const acceptedState = acceptedRenderCaptionState({
    status: "review_required",
    alignment: {
      coverage: {
        ...incompleteCoverage,
        recovery: { attempted: true, selected: false },
      },
    },
    captions: completeCaptions,
    decision: repaired,
    verifiedAt: "2026-08-10T12:00:00.000Z",
  });
  assert.equal(acceptedState.captions, completeCaptions);
  assert.equal(acceptedState.alignment.coverage.complete, true);
  assert.deepEqual(acceptedState.alignment.coverage.recovery, {
    attempted: true,
    selected: false,
  });
  assert.deepEqual(acceptedState.alignment.coverage.verification, {
    source: "render-submission",
    previousStatus: "review_required",
    verifiedAt: "2026-08-10T12:00:00.000Z",
  });
});

test("a contradictory ready status with persisted incomplete coverage blocks", () => {
  const incompleteCoverage = evaluateCaptionCoverage(
    speechIntervals,
    [caption("first", 0, 4), caption("second", 8, 12)],
    { durationSeconds, policy },
  );
  const decision = validate({ persistedCoverage: incompleteCoverage });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "caption_coverage_incomplete");
});
