import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTION_PLACEHOLDER_FIELD,
  evaluateCaptionCoverage,
} from "../shared/caption-coverage.mjs";
import {
  createManualCaptionForGap,
  normalizeRenderPreflight,
  normalizeUncoveredIntervals,
} from "../shared/editor-coverage.mjs";

test("coverage gaps are clamped, sorted, and invalid entries are dropped", () => {
  assert.deepEqual(
    normalizeUncoveredIntervals(
      [
        { start: 8.75, end: 14 },
        { start: -2, end: 1.23456 },
        { start: 4, end: 4 },
        { start: "bad", end: 3 },
      ],
      10,
    ),
    [
      { start: 0, end: 1.235, duration: 1.235 },
      { start: 8.75, end: 10, duration: 1.25 },
    ],
  );
});

test("a speech gap becomes one deterministic manual caption and word", () => {
  const caption = createManualCaptionForGap(
    { start: 6.25, end: 8.5, duration: 2.25 },
    { id: "manual-gap-2", language: "as" },
  );

  assert.deepEqual(caption, {
    id: "manual-gap-2",
    start: 6.25,
    end: 8.5,
    text: "Type-here",
    [CAPTION_PLACEHOLDER_FIELD]: "Type-here",
    language: "as",
    words: [
      {
        id: "manual-gap-2-word-0",
        text: "Type-here",
        start: 6.25,
        end: 8.5,
        confidence: 1,
        highlightSafe: true,
        source: "manual",
      },
    ],
  });

  const coverage = evaluateCaptionCoverage(
    [{ start: 6.25, end: 8.5 }],
    [caption],
    { durationSeconds: 10 },
  );
  assert.equal(coverage.complete, false);
  assert.equal(coverage.coverageRatio, 0);
  assert.equal(coverage.ignoredPlaceholderCaptionCount, 1);
});

test("a custom generated prompt remains blocked until its text changes", () => {
  const caption = createManualCaptionForGap(
    { start: 1, end: 2 },
    {
      id: "manual-custom",
      language: "as",
      placeholder: "Listen and transcribe",
    },
  );
  const blocked = evaluateCaptionCoverage(
    [{ start: 1, end: 2 }],
    [caption],
    { durationSeconds: 3 },
  );
  assert.equal(blocked.complete, false);
  assert.equal(blocked.ignoredPlaceholderCaptionCount, 1);

  caption.text = "actual words";
  caption.words[0].text = "actual words";
  const replaced = evaluateCaptionCoverage(
    [{ start: 1, end: 2 }],
    [caption],
    { durationSeconds: 3 },
  );
  assert.equal(replaced.complete, true);
  assert.equal(replaced.ignoredPlaceholderCaptionCount, 0);
});

test("manual captions reject an unsupported language", () => {
  assert.throws(
    () =>
      createManualCaptionForGap(
        { start: 1, end: 2 },
        { id: "manual-mix", language: "mix" },
      ),
    /supported caption language/,
  );
});

test("render preflight keeps fresh coverage diagnostics", () => {
  const result = normalizeRenderPreflight(
    {
      error: "Coverage remains incomplete.",
      code: "caption_coverage_incomplete",
      coverage: {
        complete: false,
        coverageRatio: 0.81,
        uncoveredIntervals: [{ start: 3, end: 6 }],
      },
    },
    { durationSeconds: 5 },
  );

  assert.equal(result.message, "Coverage remains incomplete.");
  assert.equal(result.code, "caption_coverage_incomplete");
  assert.equal(result.coverage.coverageRatio, 0.81);
  assert.deepEqual(result.uncoveredIntervals, [
    { start: 3, end: 5, duration: 2 },
  ]);
  assert.deepEqual(result.coverage.uncoveredIntervals, result.uncoveredIntervals);
});
