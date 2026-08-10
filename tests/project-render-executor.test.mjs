import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, sha256Hex } from "../shared/project-contract.mjs";
import { executeProjectRender } from "../server/project-render-executor.mjs";
import { parseProjectRenderRequest } from "../server/project-render-protocol.mjs";

const id = "44444444-4444-4444-8444-444444444444";
const projectId = "11111111-1111-4111-8111-111111111111";
const revisionId = "33333333-3333-4333-8333-333333333333";
const sourceAssetId = "22222222-2222-4222-8222-222222222222";
const origin = "https://syncword.example";
const callbackBase = `${origin}/api/projects/${projectId}/render-jobs/${id}`;
const sourceBytes = new Uint8Array([0, 1, 2, 3]);
const document = {
  schemaVersion: 1,
  sourceAssetId,
  durationMs: 2_000,
  canvas: { width: 720, height: 1280 },
  captionTrack: {
    id: "captions-primary",
    languageCode: "as-IN",
    status: "ready",
    cues: [
      {
        id: "cue-1",
        text: "hello",
        startMs: 0,
        endMs: 2_000,
        words: [{ id: "word-1", text: "hello", startMs: 0, endMs: 2_000, source: "manual" }],
      },
    ],
    style: {},
    coverage: {
      complete: true,
      speechDurationSeconds: 2,
      speechIntervals: [{ start: 0, end: 2 }],
    },
  },
};

async function plan() {
  const text = canonicalJson(document);
  return parseProjectRenderRequest(
    {
      schemaVersion: 1,
      id,
      projectId,
      requestFingerprint: "a".repeat(64),
      rendererRevision: "render-v3-test",
      revision: {
        id: revisionId,
        documentHash: await sha256Hex(text),
        schemaVersion: 1,
        sourceAssetId,
        url: `${callbackBase}/revision`,
      },
      source: {
        assetId: sourceAssetId,
        url: `${callbackBase}/source`,
        contentType: "video/mp4",
        byteSize: sourceBytes.length,
      },
      exportSpec: {
        width: 720,
        height: 1280,
        fps: 30,
        quality: "balanced",
      },
      callback: {
        baseUrl: callbackBase,
        stateUrl: `${callbackBase}/state`,
        artifacts: {
          video: `${callbackBase}/artifacts/video`,
          captions_ass: `${callbackBase}/artifacts/captions_ass`,
        },
      },
      authorization: { renderCapabilityToken: "b".repeat(64) },
    },
    { allowedOrigins: [origin] },
  );
}

function fakeRemote(documentText, events) {
  return async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/revision")) return new Response(documentText);
    if (target.endsWith("/source")) return new Response(sourceBytes);
    if (target.endsWith("/state")) {
      events.push({ kind: "state", payload: JSON.parse(options.body) });
      return new Response("{}", { status: 200 });
    }
    if (target.includes("/artifacts/")) {
      let bytes = 0;
      for await (const chunk of options.body) bytes += chunk.length;
      events.push({ kind: "artifact", target, bytes });
      return new Response("{}", { status: 201 });
    }
    throw new Error(`Unexpected URL: ${target}`);
  };
}

test("uploads durable artifacts before marking a project render succeeded", async () => {
  const renderPlan = await plan();
  const events = [];
  const temporary = await mkdtemp(path.join(os.tmpdir(), "syncword-executor-"));
  try {
    await executeProjectRender({
      plan: renderPlan,
      directory: temporary,
      fetchImpl: fakeRemote(canonicalJson(document), events),
      render: async ({ directory, renderInput, onProgress }) => {
        assert.equal(renderInput.captions[0].text, "hello");
        await onProgress(70, "Encoding");
        const captionsAssPath = path.join(directory, "captions.ass");
        const videoPath = path.join(directory, "captioned.mp4");
        await writeFile(captionsAssPath, "ass");
        await writeFile(videoPath, "video");
        return { captionsAssPath, videoPath, codecManifest: { videoCodec: "h264" } };
      },
    });

    assert.deepEqual(
      events.filter((event) => event.kind === "artifact").map((event) => path.basename(event.target)),
      ["captions_ass", "video"],
    );
    assert.equal(events.at(-1).kind, "state");
    assert.equal(events.at(-1).payload.status, "succeeded");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("reports failure and never succeeds when the renderer omits video", async () => {
  const renderPlan = await plan();
  const events = [];
  const temporary = await mkdtemp(path.join(os.tmpdir(), "syncword-executor-"));
  try {
    await assert.rejects(
      () =>
        executeProjectRender({
          plan: renderPlan,
          directory: temporary,
          fetchImpl: fakeRemote(canonicalJson(document), events),
          render: async ({ directory }) => {
            const captionsAssPath = path.join(directory, "captions.ass");
            await writeFile(captionsAssPath, "ass");
            return { captionsAssPath };
          },
        }),
      /required artifacts/,
    );
    assert.equal(events.some((event) => event.payload?.status === "succeeded"), false);
    assert.equal(events.at(-1).payload.status, "failed");
    assert.equal(events.at(-1).payload.failureCode, "render_artifacts_missing");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
