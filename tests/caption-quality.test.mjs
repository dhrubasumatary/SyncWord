import assert from "node:assert/strict";
import test from "node:test";

import {
  alignmentQualityReport,
  annotateTimingSafety,
  canHighlightGroup,
  chooseBetterAlignment,
  wordHighlightDecision,
} from "../shared/caption-quality.mjs";

function caption(words) {
  return {
    id: "phrase-1",
    start: words[0]?.start ?? 0,
    end: words.at(-1)?.end ?? 0,
    text: words.map((word) => word.text).join(" "),
    words,
  };
}

function word(text, start, end, confidence = 0.8, source = "mms-fa") {
  return {
    id: `${text}-${start}`,
    text,
    start,
    end,
    confidence,
    source,
  };
}

test("allows only credible word animation", () => {
  assert.equal(wordHighlightDecision(word("ভাল", 0.2, 0.72)).safe, true);
  assert.deepEqual(wordHighlightDecision(word("ভাল", 0.2, 0.72, 0.16)), {
    safe: false,
    reason: "weak_acoustic_match",
  });
  assert.deepEqual(wordHighlightDecision(word("photo-ত", 1, 3.1)), {
    safe: false,
    reason: "stretched_word",
  });
  assert.equal(
    wordHighlightDecision(word("নিজৰ", 1, 1.4, 1, "manual")).safe,
    true,
  );
});

test("falls back to a steady phrase when any word is unsafe", () => {
  const safe = word("মই", 0, 0.3);
  const unsafe = word("ভাল", 0.3, 2.3);
  assert.equal(canHighlightGroup([safe]), true);
  assert.equal(canHighlightGroup([safe, unsafe]), false);

  const [annotated] = annotateTimingSafety([caption([safe, unsafe])]);
  assert.equal(annotated.wordHighlightCoverage, 0.5);
  assert.equal(annotated.words[1].highlightReason, "stretched_word");
});

test("quality report recommends recovery for perceptually unsafe timing", () => {
  const result = alignmentQualityReport({
    captions: [
      caption([
        word("I", 0, 0.25, 0.72),
        word("love", 0.25, 0.7, 0.71),
        word("woohoo", 0.7, 3.4, 0.67),
      ]),
    ],
    summary: { averageConfidence: 0.7 },
  });

  assert.equal(result.safeWords, 2);
  assert.equal(result.phraseTimedWords, 1);
  assert.equal(result.recoveryRecommended, true);
});

test("keeps the primary transcript when a verbatim retry is worse", () => {
  const primary = {
    captions: [
      caption([
        word("মই", 0, 0.3, 0.66),
        word("ভাল", 0.3, 0.75, 0.62),
        word("আছোঁ", 0.75, 1.3, 0.64),
      ]),
    ],
    summary: { averageConfidence: 0.64 },
  };
  const hallucinatedVerbatim = {
    captions: [
      caption([
        word("মই", 0, 0.35, 0.51),
        word("ধেই", 0.35, 1.9, 0.1),
        word("অ", 1.9, 2.4, 0.12),
        word("আছোঁ", 2.4, 3.3, 0.43),
      ]),
    ],
    summary: { averageConfidence: 0.29 },
  };

  const selection = chooseBetterAlignment(primary, hallucinatedVerbatim);
  assert.equal(selection.selected, "primary");
  assert.equal(selection.alignment.captions[0].words.length, 3);
});

test("selects a retry only when it materially improves timing", () => {
  const primary = {
    captions: [
      caption([
        word("hello", 0, 0.5, 0.5),
        word("world", 0.5, 2.8, 0.2),
      ]),
    ],
    summary: { averageConfidence: 0.35 },
  };
  const recovery = {
    captions: [
      caption([
        word("hello", 0, 0.46, 0.76),
        word("world", 0.46, 1.05, 0.72),
      ]),
    ],
    summary: { averageConfidence: 0.74 },
  };

  assert.equal(chooseBetterAlignment(primary, recovery).selected, "recovery");
});
