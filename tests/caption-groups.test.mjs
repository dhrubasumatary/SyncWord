import assert from "node:assert/strict";
import test from "node:test";
import {
  captionsHaveWordTimings,
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

test("starts a fresh card after an audible pause", () => {
  const source = [
    { id: "i", text: "I", start: 0, end: 0.18 },
    { id: "love", text: "love", start: 0.19, end: 0.46 },
    { id: "you", text: "you", start: 0.47, end: 0.66 },
    {
      id: "chatgpt",
      text: "ChatGPT",
      start: 0.68,
      end: 1.08,
    },
    {
      id: "woohoo",
      text: "woohoo",
      start: 2.04,
      end: 2.55,
    },
  ];

  const groups = groupWordsForReels(source, 4);
  assert.deepEqual(
    groups.map((group) => group.map((word) => word.text)),
    [["I", "love", "you", "ChatGPT"], ["woohoo"]],
  );
});

test("does not split a card across natural articulation gaps", () => {
  const source = [
    { id: "one", text: "one", start: 0, end: 0.2 },
    { id: "two", text: "two", start: 0.48, end: 0.7 },
    { id: "three", text: "three", start: 0.84, end: 1.1 },
  ];

  assert.deepEqual(
    groupWordsForReels(source, 4).map((group) =>
      group.map((word) => word.text),
    ),
    [["one", "two", "three"]],
  );
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

test("does not publish phrase chunks before word timings exist", () => {
  assert.equal(
    captionsHaveWordTimings([
      {
        id: "partial",
        start: 1,
        end: 3,
        text: "आंनि राव",
      },
    ]),
    false,
  );
  assert.equal(
    captionsHaveWordTimings([
      {
        id: "ready",
        start: 1,
        end: 3,
        text: "आंनि राव",
        words: [
          { text: "आंनि", start: 1, end: 2 },
          { text: "राव", start: 2, end: 3 },
        ],
      },
    ]),
    true,
  );
});
