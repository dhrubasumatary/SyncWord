import assert from "node:assert/strict";
import test from "node:test";
import {
  alignTranscriptWords,
  tokenizeWords,
} from "../server/word-aligner.mjs";

function syntheticPcm(seconds, valleys = []) {
  const sampleRate = 16_000;
  const buffer = Buffer.alloc(seconds * sampleRate * 2);
  for (let sample = 0; sample < seconds * sampleRate; sample += 1) {
    const time = sample / sampleRate;
    const inValley = valleys.some(
      (valley) => Math.abs(time - valley) < 0.08,
    );
    const amplitude = inValley ? 180 : 7_000;
    const value = Math.round(
      Math.sin(2 * Math.PI * 190 * time) * amplitude,
    );
    buffer.writeInt16LE(value, sample * 2);
  }
  return buffer;
}

test("tokenizes Assamese and Bodo without changing their scripts", () => {
  assert.deepEqual(tokenizeWords("মোৰ ভাষা, মোৰ পৰিচয়।"), [
    "মোৰ",
    "ভাষা,",
    "মোৰ",
    "পৰিচয়।",
  ]);
  assert.deepEqual(tokenizeWords("आंनि राव, आंनि सिनायथि।"), [
    "आंनि",
    "राव,",
    "आंनि",
    "सिनायथि।",
  ]);
});

test("uses low-energy valleys to place monotonic word boundaries", () => {
  const result = alignTranscriptWords(
    [
      {
        id: "phrase-1",
        start: 0,
        end: 4,
        text: "মোৰ ভাষা মোৰ পৰিচয়",
        language: "as",
      },
    ],
    syntheticPcm(4, [0.9, 1.8, 2.8]),
  );

  const words = result.captions[0].words;
  assert.equal(words.length, 4);
  assert.equal(words[0].start, 0);
  assert.equal(words.at(-1).end, 4);
  assert.ok(words.every((word) => word.end > word.start));
  assert.ok(words.every((word, index) => !index || word.start >= words[index - 1].end));
  assert.ok(Math.abs(words[0].end - 0.9) < 0.3);
  assert.ok(Math.abs(words[1].end - 1.8) < 0.3);
  assert.equal(result.summary.method, "phrase-anchored-acoustic-dp");
  assert.equal(result.summary.totalWords, 4);
});

test("never expands aligned words beyond Saaras phrase anchors", () => {
  const result = alignTranscriptWords(
    [
      {
        id: "fractional-phrase",
        start: 1.113,
        end: 3.947,
        text: "आंनि राव",
        language: "brx",
      },
    ],
    syntheticPcm(5, [2.4]),
  );

  const words = result.captions[0].words;
  assert.equal(words[0].start, 1.113);
  assert.equal(words.at(-1).end, 3.947);
});

test("uses acoustic changes when a word boundary has no silence", () => {
  const sampleRate = 16_000;
  const seconds = 2;
  const buffer = Buffer.alloc(seconds * sampleRate * 2);
  for (let sample = 0; sample < seconds * sampleRate; sample += 1) {
    const time = sample / sampleRate;
    const frequency = time < 1 ? 155 : 455;
    const value = Math.round(
      Math.sin(2 * Math.PI * frequency * time) * 7_000,
    );
    buffer.writeInt16LE(value, sample * 2);
  }

  const result = alignTranscriptWords(
    [
      {
        id: "continuous-phrase",
        start: 0,
        end: 2,
        text: "মোৰ পৰিচয়",
        language: "as",
      },
    ],
    buffer,
  );

  const words = result.captions[0].words;
  assert.equal(words.length, 2);
  assert.ok(Math.abs(words[0].end - 1) < 0.35);
  assert.equal(words[0].source, "acoustic-dp");
});
