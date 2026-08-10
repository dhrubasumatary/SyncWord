import assert from "node:assert/strict";
import test from "node:test";

import { runTargetedCoverageRecovery } from "../server/coverage-recovery.mjs";

function alignedCaption(id, text, start, end) {
  return {
    id,
    text,
    start,
    end,
    words: [
      {
        id: `${id}-word-1`,
        text,
        start,
        end,
        confidence: 0.82,
        source: "mms-fa",
      },
    ],
  };
}

const strictPolicy = {
  minimumCoverageRatio: 0.92,
  maximumUncoveredGapSeconds: 1.5,
  captionBoundaryPaddingSeconds: 0,
  captionMergeGapSeconds: 0,
};

function primaryAlignment() {
  return {
    captions: [
      alignedCaption("before", "before", 0, 4),
      alignedCaption("after", "after", 8, 12),
    ],
    summary: { averageConfidence: 0.82, totalWords: 2 },
  };
}

test("retries only planned gaps once, merges, realigns, and selects coverage gain", async () => {
  const primary = primaryAlignment();
  let transcriptionCalls = 0;
  let alignmentCalls = 0;
  let receivedWindows;

  const result = await runTargetedCoverageRecovery({
    alignment: primary,
    speechIntervals: [{ start: 0, end: 12 }],
    durationSeconds: 12,
    policy: strictPolicy,
    transcribeWindows: async (windows) => {
      transcriptionCalls += 1;
      receivedWindows = windows;
      return {
        captions: [{ id: "retry", text: "missing", start: 4, end: 8 }],
      };
    },
    alignCaptions: async (captions) => {
      alignmentCalls += 1;
      assert.deepEqual(
        captions.map((caption) => caption.text),
        ["before", "missing", "after"],
      );
      return {
        captions: [
          alignedCaption("before", "before", 0, 4),
          alignedCaption("missing", "missing", 4, 8),
          alignedCaption("after", "after", 8, 12),
        ],
        summary: { averageConfidence: 0.82, totalWords: 3 },
      };
    },
  });

  assert.equal(transcriptionCalls, 1);
  assert.equal(alignmentCalls, 1);
  assert.deepEqual(receivedWindows, [
    {
      id: "coverage-recovery-1",
      start: 3.55,
      end: 8.45,
      duration: 4.9,
    },
  ]);
  assert.equal(result.recovery.attempted, true);
  assert.equal(result.recovery.selected, true);
  assert.equal(result.recovery.addedCaptionCount, 1);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.coverageRatio, 1);
  assert.notEqual(result.alignment, primary);
});

test("a no-op retry remains on the primary alignment and never realigns", async () => {
  const primary = primaryAlignment();
  let transcriptionCalls = 0;
  let alignmentCalls = 0;

  const result = await runTargetedCoverageRecovery({
    alignment: primary,
    speechIntervals: [{ start: 0, end: 12 }],
    durationSeconds: 12,
    policy: strictPolicy,
    transcribeWindows: async () => {
      transcriptionCalls += 1;
      return { captions: [] };
    },
    alignCaptions: async () => {
      alignmentCalls += 1;
      throw new Error("should not realign without recovered captions");
    },
  });

  assert.equal(transcriptionCalls, 1);
  assert.equal(alignmentCalls, 0);
  assert.equal(result.recovery.attempted, true);
  assert.equal(result.recovery.selected, false);
  assert.equal(result.recovery.addedCaptionCount, 0);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.alignment, primary);
});

test("a placeholder retry cannot manufacture a complete recovery", async () => {
  const primary = primaryAlignment();
  let alignmentCalls = 0;

  const result = await runTargetedCoverageRecovery({
    alignment: primary,
    speechIntervals: [{ start: 0, end: 12 }],
    durationSeconds: 12,
    policy: strictPolicy,
    transcribeWindows: async () => ({
      captions: [{ id: "retry", text: "Type-here", start: 4, end: 8 }],
    }),
    alignCaptions: async () => {
      alignmentCalls += 1;
      throw new Error("placeholder recovery must not be aligned");
    },
  });

  assert.equal(alignmentCalls, 0);
  assert.equal(result.recovery.attempted, true);
  assert.equal(result.recovery.addedCaptionCount, 0);
  assert.equal(result.recovery.selected, false);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.alignment, primary);
});
