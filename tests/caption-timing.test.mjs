import assert from "node:assert/strict";
import test from "node:test";
import { retimeCaption } from "../shared/caption-timing.mjs";

const caption = {
  id: "line-1",
  start: 2,
  end: 4,
  text: "one two",
  words: [
    { id: "one", text: "one", start: 2, end: 3, confidence: 0.4 },
    { id: "two", text: "two", start: 3, end: 4, confidence: 0.4 },
  ],
};

test("moves an entire caption without changing its internal rhythm", () => {
  const result = retimeCaption(caption, 3, 5, 0, 8);
  assert.equal(result.start, 3);
  assert.equal(result.end, 5);
  assert.deepEqual(
    result.words.map((word) => [word.start, word.end]),
    [
      [3, 4],
      [4, 5],
    ],
  );
  assert.ok(result.words.every((word) => word.source === "manual"));
});

test("stretches word timing proportionally when a creator drags an edge", () => {
  const result = retimeCaption(caption, 1, 5, 0, 8);
  assert.deepEqual(
    result.words.map((word) => [word.start, word.end]),
    [
      [1, 3],
      [3, 5],
    ],
  );
});

test("never overlaps the captions on either side", () => {
  const result = retimeCaption(caption, 0, 10, 1.5, 4.5);
  assert.equal(result.start, 1.5);
  assert.equal(result.end, 4.5);
  assert.ok(result.words[0].start >= 1.5);
  assert.ok(result.words.at(-1).end <= 4.5);
});

test("uses the available positive gap when neighboring captions are closer than 180ms", () => {
  const result = retimeCaption(caption, 0, 10, 1.5, 1.6);

  assert.equal(result.start, 1.5);
  assert.equal(result.end, 1.6);
  assert.deepEqual(
    result.words.map((word) => [word.start, word.end]),
    [
      [1.5, 1.55],
      [1.55, 1.6],
    ],
  );
});

test("fails only when neighboring captions leave no positive interval", () => {
  for (const followingStart of [1.5, 1.4]) {
    assert.throws(
      () => retimeCaption(caption, 0, 10, 1.5, followingStart),
      /positive gap between its neighbors/,
    );
  }
});
