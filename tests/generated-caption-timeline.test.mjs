import assert from "node:assert/strict";
import test from "node:test";

import { mergeRecoveredCaptions } from "../shared/caption-coverage.mjs";
import { projectDocumentFromEditor } from "../shared/project-editor-adapter.mjs";
import { stitchShortCaptionPhrases } from "../server/caption-groups.mjs";
import {
  GeneratedCaptionTimelineError,
  finalizeGeneratedCaptionTimeline,
  finalizeGeneratedCaptionTimelineWithDiagnostics,
} from "../server/generated-caption-timeline.mjs";

function caption(id, text, start, end, wordBounds) {
  return {
    id,
    text,
    start,
    end,
    language: "as",
    words: wordBounds.map(([wordStart, wordEnd], index) => ({
      id: `${id}-word-${index + 1}`,
      text: text.split(" ")[index] ?? `word-${index + 1}`,
      start: wordStart,
      end: wordEnd,
      confidence: 0.82,
      source: "mms-fa",
    })),
  };
}

function assertValidTimeline(captions, durationSeconds) {
  let previousCaptionEnd = 0;
  for (const item of captions) {
    assert.ok(item.start >= previousCaptionEnd, `${item.id} follows its neighbor`);
    assert.ok(item.end > item.start, `${item.id} has a positive duration`);
    assert.ok(item.end <= durationSeconds, `${item.id} stays within the video`);
    let previousWordEnd = item.start;
    for (const word of item.words) {
      assert.ok(word.start >= previousWordEnd, `${word.id} follows its neighbor`);
      assert.ok(word.end > word.start, `${word.id} has a positive duration`);
      assert.ok(word.end <= item.end, `${word.id} stays within its caption`);
      previousWordEnd = word.end;
    }
    previousCaptionEnd = item.end;
  }
}

test("silently repairs a small alignment collision without downgrading its source", () => {
  const input = [
    caption("first", "one two", 0, 1, [
      [0, 0.5],
      [0.5, 1],
    ]),
    caption("second", "three four", 1, 2.04, [
      [1, 1.5],
      [1.5, 2.04],
    ]),
    caption("third", "five six", 2, 3, [
      [2, 2.5],
      [2.5, 3],
    ]),
  ];

  const { captions: result, diagnostics } =
    finalizeGeneratedCaptionTimelineWithDiagnostics(input, {
      durationSeconds: 3,
    });

  assert.equal(result[1].end, 2.02);
  assert.equal(result[2].start, 2.02);
  assert.equal(result[1].words.at(-1).end, 2.02);
  assert.equal(result[2].words[0].start, 2.02);
  assert.deepEqual(
    [result[1].words.at(-1), result[2].words[0]].map((word) => [
      word.source,
      word.timingSource,
      word.confidence,
    ]),
    [
      ["mms-fa", undefined, 0.82],
      ["mms-fa", undefined, 0.82],
    ],
  );
  assert.equal(diagnostics.maximumOverlapMilliseconds, 40);
  assert.equal(diagnostics.reviewRequired, false);
  assert.equal(result[2].text, "five six");
  assert.equal(input[1].end, 2.04, "the processor result is not mutated");

  assert.doesNotThrow(() =>
    projectDocumentFromEditor({
      sourceAssetId: "11111111-1111-4111-8111-111111111111",
      durationSeconds: 3,
      canvas: { width: 720, height: 1280 },
      languageCode: "as-IN",
      captions: result,
      speechIntervals: [{ start: 0, end: 3 }],
    }),
  );
});

test("splits the observed 31.840/31.811 collision at 31.826 seconds", () => {
  const input = [
    caption("preceding", "one two", 30, 31.84, [
      [30, 31],
      [31, 31.84],
    ]),
    caption("following", "three four", 31.811, 33, [
      [31.811, 32.4],
      [32.4, 33],
    ]),
  ];

  const result = finalizeGeneratedCaptionTimeline(input, {
    durationSeconds: 33,
  });
  assert.equal(result[0].end, 31.826);
  assert.equal(result[1].start, 31.826);
  assert.deepEqual(
    finalizeGeneratedCaptionTimeline(result, { durationSeconds: 33 }),
    result,
    "timeline finalization is idempotent",
  );
});

test("repairs chained small collisions in transcript order", () => {
  const result = finalizeGeneratedCaptionTimeline(
    [
      caption("first", "one", 0, 1.04, [[0, 1.04]]),
      caption("second", "two", 1, 2.04, [[1, 2.04]]),
      caption("third", "three", 2, 3, [[2, 3]]),
    ],
    { durationSeconds: 3 },
  );

  assert.deepEqual(
    result.map(({ start, end }) => [start, end]),
    [
      [0, 1.02],
      [1.02, 2.02],
      [2.02, 3],
    ],
  );
});

test("keeps recovery-window context while resolving its padded overlap", () => {
  const primary = [
    { id: "before", text: "one two", start: 0, end: 4, language: "as" },
    { id: "after", text: "five six", start: 8, end: 12, language: "as" },
  ];
  const recovered = [
    {
      id: "recovered",
      text: "three four",
      start: 3.95,
      end: 8,
      language: "as",
    },
  ];
  const merged = mergeRecoveredCaptions(primary, recovered, [
    { start: 4, end: 8 },
  ]);
  assert.equal(merged.addedCaptionCount, 1);
  assert.ok(merged.captions[1].start < merged.captions[0].end);

  const aligned = merged.captions.map((item) =>
    caption(item.id, item.text, item.start, item.end, [
      [item.start, (item.start + item.end) / 2],
      [(item.start + item.end) / 2, item.end],
    ]),
  );
  const stitched = stitchShortCaptionPhrases(aligned);
  assert.ok(stitched[1].start < stitched[0].end);

  const result = finalizeGeneratedCaptionTimeline(stitched, {
    durationSeconds: 12,
  });
  assert.equal(result[0].end, result[1].start);
  assert.ok(result.every((item, index) => !index || item.start >= result[index - 1].end));
});

test("silently repairs a small word overlap after orphan captions are stitched", () => {
  const stitched = stitchShortCaptionPhrases([
    caption("orphan", "one", 0, 1.04, [[0, 1.04]]),
    caption("phrase", "two three", 1, 2, [
      [1, 1.5],
      [1.5, 2],
    ]),
  ]);
  assert.equal(stitched.length, 1);
  assert.ok(stitched[0].words[1].start < stitched[0].words[0].end);

  const [result] = finalizeGeneratedCaptionTimeline(stitched, {
    durationSeconds: 2,
  });
  assert.equal(result.words[0].end, 1.02);
  assert.equal(result.words[1].start, 1.02);
  assert.deepEqual(
    result.words
      .slice(0, 2)
      .map((word) => [word.source, word.timingSource, word.confidence]),
    [
      ["mms-fa", undefined, 0.82],
      ["mms-fa", undefined, 0.82],
    ],
  );
});

test("repairs large and short adjacent-word collisions without changing word order", () => {
  const cases = [
    caption("large", "one two", 0, 2, [
      [0, 1.2],
      [1.1, 2],
    ]),
    caption("short", "one two", 0, 1.04, [
      [0, 1.02],
      [1.01, 1.04],
    ]),
  ];

  for (const input of cases) {
    const { captions: [result], diagnostics } =
      finalizeGeneratedCaptionTimelineWithDiagnostics([input], {
        durationSeconds: 2,
      });
    const requiresReview = input.id === "large";
    assertValidTimeline([result], 2);
    assert.deepEqual(result.words.map((word) => word.text), ["one", "two"]);
    assert.equal(diagnostics.reviewRequired, requiresReview);
    assert.ok(
      result.words.every(
        (word) =>
          word.source ===
            (requiresReview ? "speech-window-review" : "mms-fa") &&
          word.confidence === (requiresReview ? 0 : 0.82),
      ),
    );
  }
});

test("repairs overlap above 80 ms and reports a substantial forced review", () => {
  const input = [
    caption("first", "one two", 0, 2.2, [
      [0, 1],
      [1, 2.2],
    ]),
    caption("second", "three four", 2, 3, [
      [2, 2.5],
      [2.5, 3],
    ]),
  ];

  const { captions: result, diagnostics } =
    finalizeGeneratedCaptionTimelineWithDiagnostics(input, {
      durationSeconds: 3,
    });

  assertValidTimeline(result, 3);
  assert.equal(result[0].end, 2.1);
  assert.equal(result[1].start, 2.1);
  assert.equal(diagnostics.repairedBoundaryCount, 1);
  assert.equal(diagnostics.crossCaptionBoundaryCount, 1);
  assert.equal(diagnostics.substantialOverlapBoundaryCount, 1);
  assert.equal(diagnostics.maximumOverlapMilliseconds, 200);
  assert.equal(diagnostics.reviewRequired, true);
  assert.deepEqual(
    result.flatMap((item) => item.words).map((word) => word.text),
    ["one", "two", "three", "four"],
  );
  assert.doesNotThrow(() =>
    projectDocumentFromEditor({
      sourceAssetId: "11111111-1111-4111-8111-111111111111",
      durationSeconds: 3,
      canvas: { width: 720, height: 1280 },
      languageCode: "as-IN",
      captions: result,
      speechIntervals: [{ start: 0, end: 3 }],
    }),
  );
});

test("repairs a contained duplicate-like caption while preserving semantic order", () => {
  const input = [
    caption("first", "one two", 0, 2, [
      [0, 1],
      [1, 2],
    ]),
    caption("contained", "three four", 0.25, 1.75, [
      [0.25, 1],
      [1, 1.75],
    ]),
  ];

  const { captions: result, diagnostics } =
    finalizeGeneratedCaptionTimelineWithDiagnostics(input, {
      durationSeconds: 2,
    });

  assertValidTimeline(result, 2);
  assert.deepEqual(result.map((item) => item.id), ["first", "contained"]);
  assert.deepEqual(result.map((item) => item.text), ["one two", "three four"]);
  assert.equal(diagnostics.maximumOverlapMilliseconds, 1_750);
  assert.equal(diagnostics.reviewRequired, true);
  assert.deepEqual(
    finalizeGeneratedCaptionTimeline(result, { durationSeconds: 2 }),
    result,
    "contained repairs remain idempotent",
  );
});

test("falls back from the preferred 40 ms edge duration for a dense timeline", () => {
  const input = [
    caption("dense", "one two three four", 0, 0.1, [
      [0, 0.06],
      [0.01, 0.07],
      [0.02, 0.08],
      [0.03, 0.1],
    ]),
  ];

  const { captions: result, diagnostics } =
    finalizeGeneratedCaptionTimelineWithDiagnostics(input, {
      durationSeconds: 0.1,
    });

  assertValidTimeline(result, 0.1);
  assert.equal(diagnostics.minimumDurationFallbackUsed, true);
  assert.equal(diagnostics.reviewRequired, true);
  assert.deepEqual(result[0].words.map((word) => word.text), [
    "one",
    "two",
    "three",
    "four",
  ]);
});

test("fails only when the video cannot contain one positive millisecond per word", () => {
  const input = [
    caption("impossible", "one two three", 0, 0.001, [
      [0, 0.001],
      [0, 0.001],
      [0, 0.001],
    ]),
  ];

  assert.throws(
    () => finalizeGeneratedCaptionTimeline(input, { durationSeconds: 0.002 }),
    (error) =>
      error instanceof GeneratedCaptionTimelineError &&
      error.code === "caption_timeline_capacity",
  );
});

test("canonicalizes valid generated boundaries without changing semantic fields", () => {
  const input = [
    caption("first", "one two", 0, 1.0004, [
      [0, 0.5004],
      [0.5006, 1.0004],
    ]),
    caption("second", "three four", 1.001, 2.0004, [
      [1.001, 1.5],
      [1.5, 2.0004],
    ]),
  ];

  const result = finalizeGeneratedCaptionTimeline(input, {
    durationSeconds: 2,
  });

  assert.deepEqual(
    result.map(({ id, text, start, end }) => ({ id, text, start, end })),
    [
      { id: "first", text: "one two", start: 0, end: 1 },
      { id: "second", text: "three four", start: 1.001, end: 2 },
    ],
  );
  assert.ok(result.every((item, index) => !index || item.start >= result[index - 1].end));
});
