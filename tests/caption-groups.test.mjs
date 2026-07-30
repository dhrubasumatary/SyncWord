import assert from "node:assert/strict";
import test from "node:test";
import {
  groupWordsForReels,
  stitchShortCaptionPhrases,
} from "../server/caption-groups.mjs";

function words(count, start = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: `word-${index + 1}`,
    text: `w${index + 1}`,
    start: start + index * 0.42,
    end: start + (index + 1) * 0.42,
  }));
}

test("balances reel cards without orphaning the final word", () => {
  for (const count of [5, 6, 7, 9, 10]) {
    const groups = groupWordsForReels(words(count), 4);
    assert.deepEqual(
      groups.flat().map((word) => word.id),
      words(count).map((word) => word.id),
    );
    assert.ok(
      groups.every((group) => group.length >= 2),
      `${count} words produced ${groups.map((group) => group.length)}`,
    );
  }
});

test("keeps punctuation as a preferred phrase boundary", () => {
  const source = words(8);
  source[3].text = "পৰিচয়।";
  const groups = groupWordsForReels(source, 4);
  assert.equal(groups[0].at(-1).text, "পৰিচয়।");
  assert.deepEqual(groups.map((group) => group.length), [4, 4]);
});

test("stitches a one-word Sarvam edge chunk to its nearby phrase", () => {
  const stitched = stitchShortCaptionPhrases([
    {
      id: "a",
      start: 0,
      end: 0.5,
      text: "আৰু",
      language: "as",
      words: words(1),
    },
    {
      id: "b",
      start: 0.62,
      end: 2,
      text: "মোৰ নিজৰ পৰিচয়।",
      language: "as",
      words: words(3, 0.62),
    },
  ]);

  assert.equal(stitched.length, 1);
  assert.equal(stitched[0].text, "আৰু মোৰ নিজৰ পৰিচয়।");
  assert.equal(stitched[0].words.length, 4);
});
