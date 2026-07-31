import assert from "node:assert/strict";
import test from "node:test";

import {
  combineSegmentTranscripts,
  parseSilenceIntervals,
  planSpeechSegments,
} from "../server/speech-segments.mjs";

test("parses ffmpeg silence intervals and closes trailing silence", () => {
  const intervals = parseSilenceIntervals(
    [
      "[silencedetect] silence_start: 8.2",
      "[silencedetect] silence_end: 8.8 | silence_duration: 0.6",
      "[silencedetect] silence_start: 18.5",
    ].join("\n"),
    20,
  );

  assert.deepEqual(intervals, [
    { start: 8.2, end: 8.8 },
    { start: 18.5, end: 20 },
  ]);
});

test("plans short windows at nearby silence without crossing REST limit", () => {
  const segments = planSpeechSegments(36, [
    { start: 8.8, end: 9.4 },
    { start: 18.7, end: 19.3 },
    { start: 28.1, end: 28.7 },
  ]);

  assert.deepEqual(
    segments.map(({ start, end }) => ({ start, end })),
    [
      { start: 0, end: 9.1 },
      { start: 9.1, end: 19 },
      { start: 19, end: 28.4 },
      { start: 28.4, end: 36 },
    ],
  );
  assert.ok(segments.every((segment) => segment.duration < 30));
});

test("combines relative captions into one absolute timeline", () => {
  const transcript = combineSegmentTranscripts(
    [
      {
        segment: { id: "speech-1", start: 0, end: 9, duration: 9 },
        languageCode: "as-IN",
        captions: [{ start: 0.4, end: 2, text: "মই ভাল আছোঁ" }],
      },
      {
        segment: { id: "speech-2", start: 9, end: 18, duration: 9 },
        languageCode: "as-IN",
        captions: [{ start: 0.7, end: 3.2, text: "this is SyncWord" }],
      },
    ],
    "as-IN",
  );

  assert.equal(transcript.language_code, "as-IN");
  assert.deepEqual(transcript.timestamps.start_time_seconds, [0.4, 9.7]);
  assert.deepEqual(transcript.timestamps.end_time_seconds, [2, 12.2]);
  assert.equal(transcript.syncword_segmentation.segment_count, 2);
});
