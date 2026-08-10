import assert from "node:assert/strict";
import test from "node:test";

import {
  assetSourceKey,
  canTransitionRenderJob,
  canonicalJson,
  deriveRenderCallbackToken,
  exportArtifactKey,
  idempotencyDecision,
  normalizeIdempotencyKey,
  parseExportSpec,
  parseProjectDocument,
  projectRouteAuthorization,
  renderBlockReason,
  renderRequestFingerprint,
  revisionAdvanceDecision,
  revisionDocumentKey,
} from "../shared/project-contract.mjs";

const projectId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
const renderJobId = "44444444-4444-4444-8444-444444444444";
const artifactId = "55555555-5555-4555-8555-555555555555";

function projectDocument({
  status = "ready",
  coverageComplete = true,
  languageCode = "as-IN",
} = {}) {
  return {
    schemaVersion: 1,
    sourceAssetId: assetId,
    durationMs: 12_000,
    canvas: { width: 720, height: 1280 },
    captionTrack: {
      id: "captions-main",
      languageCode,
      status,
      style: { preset: "karaoke", activeColor: "#ffe66d" },
      coverage: {
        revision: "speech-active-v1",
        complete: coverageComplete,
        coverageRatio: coverageComplete ? 0.98 : 0.64,
        largestUncoveredGapSeconds: coverageComplete ? 0.3 : 10.9,
      },
      cues: [
        {
          id: "cue-1",
          text: "নমস্কাৰ",
          startMs: 200,
          endMs: 1_100,
          words: [
            {
              id: "word-1",
              text: "নমস্কাৰ",
              startMs: 200,
              endMs: 1_100,
              confidence: 0.91,
              source: "mms-fa",
            },
          ],
        },
      ],
    },
  };
}

test("normalizes a caption-first revision document", () => {
  const parsed = parseProjectDocument(projectDocument());
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.sourceAssetId, assetId);
  assert.equal(parsed.captionTrack.status, "ready");
  assert.equal(parsed.captionTrack.coverage.complete, true);
  assert.equal(
    parsed.captionTrack.cues[0].words[0].displaySize,
    "small",
  );
  assert.equal(renderBlockReason(parsed), null);
});

test("validates optional per-word display sizes without breaking legacy revisions", () => {
  const large = projectDocument();
  large.captionTrack.cues[0].words[0].displaySize = "large";
  assert.equal(
    parseProjectDocument(large).captionTrack.cues[0].words[0].displaySize,
    "large",
  );

  const invalid = projectDocument();
  invalid.captionTrack.cues[0].words[0].displaySize = "medium";
  assert.throws(
    () => parseProjectDocument(invalid),
    /displaySize: must be small or large/,
  );
});

test("accepts only Assamese and Bodo project language codes", () => {
  assert.equal(
    parseProjectDocument(projectDocument({ languageCode: "brx-IN" }))
      .captionTrack.languageCode,
    "brx-IN",
  );
  for (const languageCode of ["auto", "unknown", "mix", "as"]) {
    assert.throws(
      () => parseProjectDocument(projectDocument({ languageCode })),
      /must be as-IN or brx-IN/,
    );
  }
});

test("blocks review-required and incomplete-coverage revisions from render", () => {
  const review = parseProjectDocument(
    projectDocument({ status: "review_required", coverageComplete: false }),
  );
  assert.equal(renderBlockReason(review), "caption_review_required");

  const incomplete = projectDocument({
    status: "ready",
    coverageComplete: false,
  });
  assert.throws(
    () => parseProjectDocument(incomplete),
    /must be verified true when caption status is ready or complete/,
  );
  assert.equal(renderBlockReason(incomplete), "speech_coverage_incomplete");

  const unverified = projectDocument({ status: "ready" });
  delete unverified.captionTrack.coverage;
  assert.throws(
    () => parseProjectDocument(unverified),
    /must be verified true when caption status is ready or complete/,
  );
  assert.equal(renderBlockReason(unverified), "speech_coverage_unverified");

  const processing = parseProjectDocument(
    projectDocument({ status: "recovering", coverageComplete: true }),
  );
  assert.equal(renderBlockReason(processing), "caption_processing_incomplete");
});

test("rejects invalid cue timing instead of persisting a corrupt snapshot", () => {
  const document = projectDocument();
  document.captionTrack.cues[0].words[0].endMs = 2_000;
  assert.throws(
    () => parseProjectDocument(document),
    /must stay within its cue/,
  );
});

test("rejects overlapping cues and word intervals", () => {
  const overlappingWords = projectDocument();
  overlappingWords.captionTrack.cues[0].words.push({
    id: "word-2",
    text: "আছে",
    startMs: 1_000,
    endMs: 1_100,
  });
  assert.throws(
    () => parseProjectDocument(overlappingWords),
    /ordered and non-overlapping/,
  );

  const overlappingCues = projectDocument();
  overlappingCues.captionTrack.cues.push({
    id: "cue-2",
    text: "আছে",
    startMs: 1_000,
    endMs: 1_500,
    words: [],
  });
  assert.throws(
    () => parseProjectDocument(overlappingCues),
    /ordered and non-overlapping/,
  );
});

test("canonical export fingerprints ignore object property order", async () => {
  const specA = {
    width: 720,
    height: 1280,
    fps: 30,
    quality: "balanced",
  };
  const specB = {
    quality: "balanced",
    fps: 30,
    height: 1280,
    width: 720,
  };
  assert.deepEqual(parseExportSpec(specA), parseExportSpec(specB));
  assert.equal(
    await renderRequestFingerprint(projectId, revisionId, specA),
    await renderRequestFingerprint(projectId, revisionId, specB),
  );
  assert.notEqual(
    await renderRequestFingerprint(
      projectId,
      revisionId,
      specA,
      "syncword-render-v1",
    ),
    await renderRequestFingerprint(
      projectId,
      revisionId,
      specA,
      "syncword-render-v2",
    ),
  );
  assert.equal(
    await renderRequestFingerprint(projectId, revisionId, specA),
    await renderRequestFingerprint(
      projectId,
      revisionId,
      specA,
      "syncword-render-v2",
    ),
  );
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
});

test("export specs preserve source frame rate and accept fractional timelines", () => {
  const source = parseExportSpec({ width: 720, height: 1280 });
  const ntsc = parseExportSpec({
    width: 720,
    height: 1280,
    fps: 30000 / 1001,
  });
  assert.equal(source.fps, "source");
  assert.equal(ntsc.fps, 30000 / 1001);
  assert.throws(
    () => parseExportSpec({ width: 720, height: 1280, fps: 0 }),
    /exportSpec\.fps/,
  );
});

test("idempotency distinguishes replay from key reuse with new input", () => {
  assert.equal(idempotencyDecision(null, "fingerprint-a"), "create");
  assert.equal(
    idempotencyDecision("fingerprint-a", "fingerprint-a"),
    "replay",
  );
  assert.equal(
    idempotencyDecision("fingerprint-a", "fingerprint-b"),
    "conflict",
  );
  assert.equal(
    normalizeIdempotencyKey(undefined, "a".repeat(64)),
    `auto:${"a".repeat(64)}`,
  );
  assert.throws(
    () => normalizeIdempotencyKey("contains a space", "a".repeat(64)),
    /visible ASCII/,
  );
});

test("render callbacks get a stable scoped token without persisting the owner token", async () => {
  const ownerCapability = "a".repeat(64);
  const fingerprint = "b".repeat(64);
  const first = await deriveRenderCallbackToken(
    ownerCapability,
    renderJobId,
    fingerprint,
  );
  const replay = await deriveRenderCallbackToken(
    ownerCapability,
    renderJobId,
    fingerprint,
  );
  const otherJob = await deriveRenderCallbackToken(
    ownerCapability,
    artifactId,
    fingerprint,
  );
  assert.equal(first, replay);
  assert.notEqual(first, ownerCapability);
  assert.notEqual(first, otherJob);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("only render state and artifact PUTs bypass owner auth for callback auth", () => {
  assert.equal(
    projectRouteAuthorization("PUT", ["render-jobs", renderJobId, "state"]),
    "render_callback",
  );
  assert.equal(
    projectRouteAuthorization("PUT", [
      "render-jobs",
      renderJobId,
      "artifacts",
      "video",
    ]),
    "render_callback",
  );
  assert.equal(
    projectRouteAuthorization("GET", ["render-jobs", renderJobId]),
    "project_owner",
  );
  assert.equal(
    projectRouteAuthorization("POST", ["render-jobs"]),
    "project_owner",
  );
  assert.equal(
    projectRouteAuthorization("PUT", ["assets", assetId, "source"]),
    "project_owner",
  );
});

test("optimistic revision advancement rejects a stale base", () => {
  assert.equal(revisionAdvanceDecision(null, null), "advance");
  assert.equal(
    revisionAdvanceDecision(revisionId, revisionId),
    "advance",
  );
  assert.equal(
    revisionAdvanceDecision(revisionId, projectId),
    "conflict",
  );
});

test("render status transitions cannot reopen terminal jobs", () => {
  assert.equal(canTransitionRenderJob("queued", "running"), true);
  assert.equal(canTransitionRenderJob("running", "succeeded"), true);
  assert.equal(canTransitionRenderJob("succeeded", "running"), false);
  assert.equal(canTransitionRenderJob("failed", "queued"), false);
});

test("R2 object keys remain within immutable project scopes", () => {
  assert.equal(
    revisionDocumentKey(projectId, revisionId),
    `projects/${projectId}/revisions/${revisionId}/document-v1.json`,
  );
  assert.equal(
    assetSourceKey(projectId, assetId, "../../My reel (final).mp4"),
    `projects/${projectId}/assets/${assetId}/source/My-reel-final-.mp4`,
  );
  assert.equal(
    exportArtifactKey(projectId, renderJobId, artifactId, "video"),
    `projects/${projectId}/renders/${renderJobId}/${artifactId}.mp4`,
  );
});
