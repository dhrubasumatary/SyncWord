import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExportMediaPolicy,
  exportVideoArgs,
  parseFrameRate,
} from "../server/export-policy.mjs";

test("parses rational frame rates without assuming 30 fps", () => {
  assert.equal(parseFrameRate("30000/1001"), 30000 / 1001);
  assert.equal(parseFrameRate("25/1"), 25);
  assert.equal(parseFrameRate("broken"), 30);
});

test("converts HE-AAC once and pads both timelines to the advertised audio tail", () => {
  const policy = buildExportMediaPolicy({
    frameRate: "30/1",
    streamDuration: 44.3,
    duration: 44.393696,
    audio: {
      codecName: "aac",
      profile: "HE-AAC",
      channels: 2,
      duration: 44.393696,
    },
  });

  assert.equal(policy.audioMode, "aac");
  assert.deepEqual(policy.audioArgs, ["-c:a", "aac", "-b:a", "128k"]);
  assert.deepEqual(policy.audioFilterArgs, [
    "-af",
    "apad=whole_dur=44.393696",
  ]);
  assert.equal(policy.keyframeIntervalFrames, 60);
  assert.equal(policy.useShortest, false);
  assert.ok(policy.tailPadSeconds >= 0.093);
  assert.ok(policy.tailPadSeconds <= 0.095);
});

test("stream-copies matching AAC-LC without an audio filter", () => {
  const policy = buildExportMediaPolicy({
    frameRate: "30/1",
    streamDuration: 12,
    audio: {
      codecName: "aac",
      profile: "LC",
      channels: 2,
      duration: 12,
    },
  });
  assert.equal(policy.audioMode, "copy");
  assert.deepEqual(policy.audioArgs, ["-c:a", "copy"]);
  assert.deepEqual(policy.audioFilterArgs, []);
});

test("transcodes unsupported audio once at a channel-appropriate bitrate", () => {
  const mono = buildExportMediaPolicy({
    frameRate: "25/1",
    duration: 12,
    audio: { codecName: "opus", channels: 1, duration: 12 },
  });
  const stereo = buildExportMediaPolicy({
    frameRate: "25/1",
    duration: 12,
    audio: { codecName: "opus", channels: 2, duration: 12 },
  });

  assert.deepEqual(mono.audioArgs, ["-c:a", "aac", "-b:a", "80k"]);
  assert.deepEqual(stereo.audioArgs, ["-c:a", "aac", "-b:a", "128k"]);
  assert.deepEqual(mono.audioFilterArgs, ["-af", "apad=whole_dur=12"]);
  assert.equal(mono.useShortest, false);
});

test("emits a fixed, bounded GOP for predictable seeking", () => {
  const policy = buildExportMediaPolicy(
    { frameRate: "60/1" },
    { gopSeconds: 99 },
  );
  assert.equal(policy.gopSeconds, 5);
  assert.deepEqual(exportVideoArgs(policy), [
    "-g",
    "300",
    "-keyint_min",
    "300",
    "-sc_threshold",
    "0",
  ]);
});
