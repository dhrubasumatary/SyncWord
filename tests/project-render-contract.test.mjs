import assert from "node:assert/strict";
import test from "node:test";

import {
  ProjectRenderContractError,
  canonicalProjectRenderState,
  projectRevisionToRenderInput,
  validateProjectRenderUrls,
} from "../server/project-render-contract.mjs";

const baseDocument = {
  schemaVersion: 1,
  sourceAssetId: "22222222-2222-4222-8222-222222222222",
  durationMs: 2_000,
  canvas: { width: 720, height: 1280 },
  captionTrack: {
    id: "captions-primary",
    languageCode: "as-IN",
    status: "ready",
    cues: [
      {
        id: "cue-1",
        text: "নমস্কাৰ",
        startMs: 100,
        endMs: 1_200,
        words: [
          {
            id: "word-1",
            text: "নমস্কাৰ",
            startMs: 100,
            endMs: 1_200,
            displaySize: "large",
            confidence: 0.94,
            source: "mms-fa",
          },
        ],
      },
    ],
    style: { fontFamily: "Noto Sans Bengali" },
    coverage: {
      complete: true,
      speechDurationSeconds: 1.1,
      speechIntervals: [{ start: 0.1, end: 1.2 }],
    },
  },
};

test("derives renderer input only from an immutable renderable revision", () => {
  assert.deepEqual(projectRevisionToRenderInput(baseDocument), {
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
            displaySize: "large",
            confidence: 0.94,
            source: "mms-fa",
          },
        ],
      },
    ],
    style: { fontFamily: "Noto Sans Bengali" },
    languageCode: "as-IN",
    alignment: {
      coverage: {
        complete: true,
        speechDurationSeconds: 1.1,
        speechIntervals: [{ start: 0.1, end: 1.2 }],
      },
    },
    video: { duration: 2, width: 720, height: 1280 },
  });
});

test("missing coverage fails closed even if a revision claims ready", () => {
  const document = structuredClone(baseDocument);
  delete document.captionTrack.coverage;
  assert.throws(
    () => projectRevisionToRenderInput(document),
    /coverage\.complete: must be verified true|complete speech-coverage report/,
  );
});

test("review-required revisions cannot enter immutable render compute", () => {
  const document = structuredClone(baseDocument);
  document.captionTrack.status = "review_required";
  document.captionTrack.coverage.complete = false;
  assert.throws(
    () => projectRevisionToRenderInput(document),
    /complete speech-coverage report/,
  );
});

test("stale complete coverage cannot bless deleted or retimed revision cues", () => {
  const document = structuredClone(baseDocument);
  document.captionTrack.cues[0].endMs = 400;
  document.captionTrack.cues[0].words[0].endMs = 400;
  assert.throws(
    () => projectRevisionToRenderInput(document),
    (error) =>
      error instanceof ProjectRenderContractError &&
      error.code === "caption_coverage_incomplete" &&
      error.uncoveredIntervals?.length === 1,
  );
});

test("canonical states bound progress and force successful completion", () => {
  assert.deepEqual(canonicalProjectRenderState("running", 44.6, "Encoding"), {
    status: "running",
    progress: 45,
    message: "Encoding",
  });
  assert.equal(
    canonicalProjectRenderState("succeeded", 92, "Done").progress,
    100,
  );
  assert.throws(
    () => canonicalProjectRenderState("rendering", 50, "No"),
    /Unsupported project render status/,
  );
});

test("project render URLs stay on the allowlisted HTTPS callback origin", () => {
  const urls = validateProjectRenderUrls(
    {
      sourceUrl: "https://syncword.example/api/projects/p/render-jobs/j/source",
      revisionUrl: "https://syncword.example/api/projects/p/revisions/r/document",
      callbackBase: "https://syncword.example/api/projects/p/render-jobs/j",
    },
    ["https://syncword.example"],
  );
  assert.equal(urls.callback.origin, "https://syncword.example");
  assert.throws(
    () =>
      validateProjectRenderUrls(
        {
          sourceUrl: "https://evil.example/source",
          revisionUrl: "https://syncword.example/revision",
          callbackBase: "https://syncword.example/callback",
        },
        ["https://syncword.example"],
      ),
    /allowed HTTPS origin/,
  );
});
