import assert from "node:assert/strict";
import test from "node:test";

import {
  ProjectProcessingContractError,
  assertProjectProcessingResult,
  canonicalProjectProcessingState,
  projectDocumentFromProcessingJob,
  projectProcessingCallbackStatus,
} from "../server/project-processing-contract.mjs";

const sourceAssetId = "22222222-2222-4222-8222-222222222222";
const plan = {
  source: { assetId: sourceAssetId },
  processing: { language: "as-IN", mode: "codemix" },
};

function processingJob(overrides = {}) {
  return {
    status: "ready",
    languageCode: "as-IN",
    video: { duration: 2, width: 720, height: 1280 },
    captions: [
      {
        id: "cue-1",
        text: "নমস্কাৰ",
        start: 0.1,
        end: 1.2,
        words: [
          {
            id: "word-1",
            text: "নমস্কাৰ",
            start: 0.1,
            end: 1.2,
            confidence: 0.95,
            timingSource: "mms-fa",
          },
        ],
      },
    ],
    speechAnalysis: { speechIntervals: [{ start: 0.1, end: 1.2 }] },
    alignment: {
      coverage: {
        complete: true,
        recovery: { attempted: true, selected: true, windowCount: 1 },
      },
    },
    style: {},
    ...overrides,
  };
}

test("normalizes processing output into one immutable ready ProjectDocument", () => {
  const document = projectDocumentFromProcessingJob(plan, processingJob());
  assert.equal(document.sourceAssetId, sourceAssetId);
  assert.equal(document.captionTrack.status, "ready");
  assert.equal(document.captionTrack.coverage.complete, true);
  assert.equal(document.captionTrack.cues[0].startMs, 100);
  assert.equal(document.captionTrack.cues[0].words[0].source, "mms-fa");
  assert.deepEqual(document.captionTrack.coverage.recovery, {
    attempted: true,
    selected: true,
    windowCount: 1,
  });
});

test("keeps the selected language authoritative over provider detection", () => {
  const document = projectDocumentFromProcessingJob(
    plan,
    processingJob({ languageCode: "brx-IN" }),
  );
  assert.equal(document.captionTrack.languageCode, "as-IN");
});

test("rejects a processing result with a different language", () => {
  const document = projectDocumentFromProcessingJob(plan, processingJob());
  assert.throws(
    () =>
      assertProjectProcessingResult(plan, {
        ...document,
        captionTrack: {
          ...document.captionTrack,
          languageCode: "brx-IN",
        },
      }),
    /must match the selected language/,
  );
});

test("recomputes actual coverage and cannot trust a stale complete report", () => {
  const job = processingJob({
    speechAnalysis: {
      speechIntervals: [
        { start: 0.1, end: 1.2 },
        { start: 5, end: 8 },
      ],
    },
    video: { duration: 10, width: 720, height: 1280 },
  });
  const document = projectDocumentFromProcessingJob(plan, job);
  assert.equal(document.captionTrack.status, "review_required");
  assert.equal(document.captionTrack.coverage.complete, false);
  assert.deepEqual(document.captionTrack.coverage.uncoveredIntervals, [
    { start: 5, end: 8, duration: 3 },
  ]);
});

test("a silent or missing activity record cannot create a falsely verified ready revision", () => {
  const document = projectDocumentFromProcessingJob(
    plan,
    processingJob({ speechAnalysis: { speechIntervals: [] } }),
  );
  assert.equal(document.captionTrack.status, "review_required");
  assert.equal(document.captionTrack.coverage.complete, false);
  assert.deepEqual(document.captionTrack.coverage.reasons, [
    "speech_intervals_missing",
  ]);
});

test("allows only canonical non-result state callbacks", () => {
  assert.deepEqual(
    canonicalProjectProcessingState("recovering", 78.6, "Recovering"),
    { status: "recovering", progress: 79, message: "Recovering" },
  );
  assert.equal(
    projectProcessingCallbackStatus("transcribing", "Recovering missed speech"),
    "recovering",
  );
  assert.equal(projectProcessingCallbackStatus("ready", "Ready"), null);
  assert.throws(
    () => canonicalProjectProcessingState("ready", 100, "Ready"),
    ProjectProcessingContractError,
  );
});

test("refuses a document result before processing reaches a result status", () => {
  assert.throws(
    () =>
      projectDocumentFromProcessingJob(
        plan,
        processingJob({ status: "transcribing" }),
      ),
    /ready or review_required/,
  );
});
