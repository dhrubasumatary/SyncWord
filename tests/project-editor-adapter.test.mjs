import assert from "node:assert/strict";
import test from "node:test";

import {
  editorCaptionsFromProject,
  jobAfterProjectRevisionSave,
  projectProcessingStatusForHydration,
  projectDocumentFromEditor,
  projectRenderRequestScope,
  projectSessionAfterTerminalRender,
  reconcileProjectSessionHead,
  safeProjectSession,
  selectCompletedRenderArtifact,
  selectProjectRenderDispatchIdentity,
} from "../shared/project-editor-adapter.mjs";

const sourceAssetId = "22222222-2222-4222-8222-222222222222";
const baseCaption = {
  id: "cue-1",
  text: "নমস্কাৰ",
  start: 0.1,
  end: 1.2,
  language: "as",
  words: [
    {
      id: "word-1",
      text: "নমস্কাৰ",
      start: 0.1,
      end: 1.2,
      displaySize: "small",
      confidence: 0.93,
      source: "mms-fa",
    },
  ],
};

test("builds a renderable immutable revision only from fresh speech coverage", () => {
  const document = projectDocumentFromEditor({
    sourceAssetId,
    durationSeconds: 2,
    canvas: { width: 720, height: 1280 },
    languageCode: "as-IN",
    captions: [baseCaption],
    style: { fontFamily: "Noto Sans Bengali" },
    speechIntervals: [{ start: 0.15, end: 1.15 }],
  });

  assert.equal(document.captionTrack.status, "ready");
  assert.equal(document.captionTrack.coverage.complete, true);
  assert.equal(document.captionTrack.cues[0].startMs, 100);
  assert.equal(document.captionTrack.cues[0].words[0].source, "mms-fa");
  assert.deepEqual(editorCaptionsFromProject(document), [baseCaption]);
});

test("persists and restores large words through immutable project revisions", () => {
  const largeCaption = structuredClone(baseCaption);
  largeCaption.words[0].displaySize = "large";
  const document = projectDocumentFromEditor({
    sourceAssetId,
    durationSeconds: 2,
    canvas: { width: 720, height: 1280 },
    languageCode: "as-IN",
    captions: [largeCaption],
    style: { fontFamily: "Noto Sans Bengali" },
    speechIntervals: [{ start: 0.15, end: 1.15 }],
  });

  assert.equal(
    document.captionTrack.cues[0].words[0].displaySize,
    "large",
  );
  assert.deepEqual(editorCaptionsFromProject(document), [largeCaption]);
});

test("rejects unsupported project language codes", () => {
  assert.throws(
    () =>
      projectDocumentFromEditor({
        sourceAssetId,
        durationSeconds: 2,
        canvas: { width: 720, height: 1280 },
        languageCode: "unknown",
        captions: [baseCaption],
        style: {},
        speechIntervals: [{ start: 0.1, end: 1.2 }],
      }),
    /must be as-IN or brx-IN/,
  );
});

test("missing speech activity fails closed instead of blessing a ready revision", () => {
  const document = projectDocumentFromEditor({
    sourceAssetId,
    durationSeconds: 2,
    canvas: { width: 720, height: 1280 },
    languageCode: "as-IN",
    captions: [baseCaption],
    style: {},
  });

  assert.equal(document.captionTrack.status, "review_required");
  assert.equal(document.captionTrack.coverage.complete, false);
  assert.deepEqual(document.captionTrack.coverage.reasons, [
    "speech_intervals_missing",
  ]);
});

test("keeps automatically repaired timing in review until its words are edited", () => {
  const repairedCaption = structuredClone(baseCaption);
  repairedCaption.words[0].source = "speech-window-review";

  const reviewDocument = projectDocumentFromEditor({
    sourceAssetId,
    durationSeconds: 2,
    canvas: { width: 720, height: 1280 },
    languageCode: "as-IN",
    captions: [repairedCaption],
    speechIntervals: [{ start: 0.15, end: 1.15 }],
    requestedStatus: "ready",
  });
  assert.equal(reviewDocument.captionTrack.coverage.complete, true);
  assert.equal(reviewDocument.captionTrack.status, "review_required");

  repairedCaption.words[0].source = "manual";
  const approvedDocument = projectDocumentFromEditor({
    sourceAssetId,
    durationSeconds: 2,
    canvas: { width: 720, height: 1280 },
    languageCode: "as-IN",
    captions: [repairedCaption],
    speechIntervals: [{ start: 0.15, end: 1.15 }],
    requestedStatus: "ready",
  });
  assert.equal(approvedDocument.captionTrack.status, "ready");
});

test("an edited gap is re-evaluated and remains review-required", () => {
  const document = projectDocumentFromEditor({
    sourceAssetId,
    durationSeconds: 12,
    canvas: { width: 720, height: 1280 },
    languageCode: "brx-IN",
    captions: [baseCaption],
    style: {},
    speechIntervals: [
      { start: 0.1, end: 1.2 },
      { start: 7, end: 10 },
    ],
  });

  assert.equal(document.captionTrack.status, "review_required");
  assert.equal(document.captionTrack.coverage.complete, false);
  assert.deepEqual(document.captionTrack.coverage.uncoveredIntervals, [
    { start: 7, end: 10, duration: 3 },
  ]);
});

test("rejects overlapping captions before a revision can be saved", () => {
  assert.throws(
    () =>
      projectDocumentFromEditor({
        sourceAssetId,
        durationSeconds: 4,
        canvas: { width: 720, height: 1280 },
        languageCode: "as-IN",
        captions: [
          baseCaption,
          { ...baseCaption, id: "cue-2", start: 1, end: 2 },
        ],
        speechIntervals: [{ start: 0.1, end: 2 }],
      }),
    /overlaps the preceding caption/,
  );
});

test("keeps only non-secret project recovery identifiers", () => {
  assert.deepEqual(
    safeProjectSession({
      projectId: "project",
      sourceAssetId: "asset",
      activeProcessingJobId: "processing",
      headRevisionId: "revision",
      headEditorRevisionId: "local-revision",
      activeRenderIdempotencyKey: "render-key",
      activeRenderRequestScope: "render-scope",
      activeRenderAttemptDiscriminator: "render-terminal",
      lastCompletedRenderJobId: "render-complete",
      capabilityToken: "secret",
      callbackCapabilityToken: "secret-2",
    }),
    {
      projectId: "project",
      sourceAssetId: "asset",
      activeProcessingJobId: "processing",
      headRevisionId: "revision",
      headEditorRevisionId: "local-revision",
      activeRenderJobId: null,
      activeRenderIdempotencyKey: "render-key",
      activeRenderRequestScope: "render-scope",
      activeRenderAttemptDiscriminator: "render-terminal",
      lastCompletedRenderJobId: "render-complete",
      lastExportArtifactId: null,
    },
  );
});

test("a remote project head replaces the stale base and invalidates pending dispatch input", () => {
  const reconciled = reconcileProjectSessionHead(
    {
      projectId: "project",
      sourceAssetId: "asset",
      headRevisionId: "revision-old",
      headEditorRevisionId: "editor-old",
      activeRenderJobId: "render-running",
      activeRenderIdempotencyKey: "render-key-old",
      activeRenderRequestScope: "render-scope-old",
    },
    "revision-remote",
    "editor-remote",
  );

  assert.equal(reconciled.headRevisionId, "revision-remote");
  assert.equal(reconciled.headEditorRevisionId, "editor-remote");
  assert.equal(reconciled.activeRenderJobId, "render-running");
  assert.equal(reconciled.activeRenderIdempotencyKey, null);
  assert.equal(reconciled.activeRenderRequestScope, null);
  assert.equal(reconciled.activeRenderAttemptDiscriminator, null);
});

test("terminal processing stays non-editable until immutable revision hydration", () => {
  assert.equal(projectProcessingStatusForHydration("ready"), "aligning");
  assert.equal(
    projectProcessingStatusForHydration("review_required"),
    "aligning",
  );
  assert.equal(
    projectProcessingStatusForHydration("ready", true),
    "ready",
  );
  assert.equal(projectProcessingStatusForHydration("transcribing"), "transcribing");
});

test("repair save and crash reload reuse deterministic identity until an explicit terminal retry", async () => {
  const document = projectDocumentFromEditor({
    sourceAssetId,
    durationSeconds: 2,
    canvas: { width: 720, height: 1280 },
    languageCode: "as-IN",
    captions: [baseCaption],
    style: {},
    speechIntervals: [{ start: 0.15, end: 1.15 }],
  });
  const savedJob = jobAfterProjectRevisionSave(
    {
      id: "processing-1",
      status: "review_required",
      progress: 100,
      captions: [baseCaption],
      alignment: { coverage: { complete: false } },
    },
    document,
    [baseCaption],
  );
  assert.equal(savedJob.status, "ready");
  assert.equal(savedJob.alignment.coverage.complete, true);

  const exportSpec = {
    width: 720,
    height: 1280,
    fps: "source",
    quality: "balanced",
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    captionMode: "burned",
  };
  const requestScope = projectRenderRequestScope("revision-repaired", exportSpec);
  const first = await selectProjectRenderDispatchIdentity(
    { projectId: "project", sourceAssetId: "asset" },
    "revision-repaired",
    requestScope,
  );
  const crashReload = await selectProjectRenderDispatchIdentity(
    { projectId: "project", sourceAssetId: "asset" },
    "revision-repaired",
    requestScope,
  );
  assert.equal(crashReload.idempotencyKey, first.idempotencyKey);

  const transientRetry = await selectProjectRenderDispatchIdentity(
    {
      projectId: "project",
      sourceAssetId: "asset",
      activeRenderIdempotencyKey: first.idempotencyKey,
      activeRenderRequestScope: first.requestScope,
    },
    "revision-repaired",
    requestScope,
  );
  assert.equal(transientRetry.idempotencyKey, first.idempotencyKey);
  assert.equal(transientRetry.reused, true);

  const terminalSession = projectSessionAfterTerminalRender(
    {
      projectId: "project",
      sourceAssetId: "asset",
      activeRenderIdempotencyKey: transientRetry.idempotencyKey,
      activeRenderRequestScope: transientRetry.requestScope,
    },
    requestScope,
    "render-terminal-1",
  );
  const explicitRetry = await selectProjectRenderDispatchIdentity(
    safeProjectSession(terminalSession),
    "revision-repaired",
    requestScope,
  );
  assert.notEqual(explicitRetry.idempotencyKey, first.idempotencyKey);
  assert.equal(explicitRetry.attemptDiscriminator, "render-terminal-1");
  const retryAfterReload = await selectProjectRenderDispatchIdentity(
    safeProjectSession({
      ...terminalSession,
      activeRenderIdempotencyKey: explicitRetry.idempotencyKey,
    }),
    "revision-repaired",
    requestScope,
  );
  assert.equal(retryAfterReload.idempotencyKey, explicitRetry.idempotencyKey);

  const changedScope = projectRenderRequestScope("revision-edited", exportSpec);
  const changedRevision = await selectProjectRenderDispatchIdentity(
    {
      projectId: "project",
      sourceAssetId: "asset",
      activeRenderIdempotencyKey: retryAfterReload.idempotencyKey,
      activeRenderRequestScope: retryAfterReload.requestScope,
      activeRenderAttemptDiscriminator: "render-terminal-1",
    },
    "revision-edited",
    changedScope,
  );
  assert.notEqual(changedRevision.idempotencyKey, retryAfterReload.idempotencyKey);
  assert.equal(changedRevision.attemptDiscriminator, null);
  assert.equal(changedRevision.reused, false);
});

test("completed artifact fallback never crosses render-job or revision boundaries", () => {
  const artifacts = [
    {
      id: "video-newer-wrong-render",
      renderJobId: "render-newer",
      revisionId: "revision-newer",
      kind: "video",
      contentUrl: "/wrong",
    },
    {
      id: "ass-completed",
      renderJobId: "render-completed",
      revisionId: "revision-completed",
      kind: "captions_ass",
      contentUrl: "/right-ass",
    },
    {
      id: "video-completed",
      renderJobId: "render-completed",
      revisionId: "revision-completed",
      kind: "video",
      contentUrl: "/right-video",
    },
  ];

  assert.equal(
    selectCompletedRenderArtifact(
      artifacts,
      "render-completed",
      "video",
      "video-completed",
    ).contentUrl,
    "/right-video",
  );
  assert.equal(
    selectCompletedRenderArtifact(
      artifacts,
      "render-completed",
      "captions_ass",
    ).contentUrl,
    "/right-ass",
  );
  assert.equal(
    selectCompletedRenderArtifact(
      artifacts,
      "render-completed",
      "video",
      "video-newer-wrong-render",
    ),
    null,
  );
});
