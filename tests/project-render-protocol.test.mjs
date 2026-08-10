import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, sha256Hex } from "../shared/project-contract.mjs";
import {
  downloadProjectSource,
  fetchProjectRevision,
  parseProjectRenderRequest,
  putProjectRenderState,
  uploadProjectRenderArtifact,
} from "../server/project-render-protocol.mjs";

const id = "44444444-4444-4444-8444-444444444444";
const projectId = "11111111-1111-4111-8111-111111111111";
const revisionId = "33333333-3333-4333-8333-333333333333";
const sourceAssetId = "22222222-2222-4222-8222-222222222222";
const origin = "https://syncword.example";
const base = `${origin}/api/projects/${projectId}/render-jobs/${id}`;

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
        text: "নমস্কাৰ",
        startMs: 100,
        endMs: 1_200,
        words: [
          {
            id: "word-1",
            text: "নমস্কাৰ",
            startMs: 100,
            endMs: 1_200,
            confidence: 0.95,
            source: "mms-fa",
          },
        ],
      },
    ],
    style: {},
    coverage: {
      complete: true,
      speechDurationSeconds: 1.1,
      speechIntervals: [{ start: 0.1, end: 1.2 }],
    },
  },
};

async function requestPayload(overrides = {}) {
  const documentText = canonicalJson(document);
  return {
    schemaVersion: 1,
    id,
    projectId,
    requestFingerprint: "a".repeat(64),
    rendererRevision: "render-v3-test",
    revision: {
      id: revisionId,
      documentHash: await sha256Hex(documentText),
      schemaVersion: 1,
      sourceAssetId,
      url: `${base}/revision`,
    },
    source: {
      assetId: sourceAssetId,
      url: `${base}/source`,
      contentType: "video/mp4",
      byteSize: 4,
      etag: "etag",
      sha256: null,
    },
    exportSpec: {
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
      captionMode: "burned",
      width: 720,
      height: 1280,
      fps: 30,
      quality: "balanced",
    },
    callback: {
      baseUrl: base,
      stateUrl: `${base}/state`,
      artifacts: {
        video: `${base}/artifacts/video`,
        captions_ass: `${base}/artifacts/captions_ass`,
        captions_srt: `${base}/artifacts/captions_srt`,
        captions_vtt: `${base}/artifacts/captions_vtt`,
      },
    },
    authorization: {
      renderCapabilityToken: "b".repeat(64),
      sitesAuthorization: "site-bypass-token-with-at-least-32-characters",
    },
    ...overrides,
  };
}

test("parses one immutable project render request and exact callback routes", async () => {
  const plan = parseProjectRenderRequest(await requestPayload(), {
    allowedOrigins: [origin],
  });
  assert.equal(plan.id, id);
  assert.equal(plan.revision.id, revisionId);
  assert.equal(plan.callback.artifacts.video.pathname, `${new URL(base).pathname}/artifacts/video`);

  const bad = await requestPayload();
  bad.source.url = "https://evil.example/source";
  assert.throws(
    () => parseProjectRenderRequest(bad, { allowedOrigins: [origin] }),
    /allowed HTTPS origin/,
  );
});

test("downloads hash-verified revision and exact-size source with render auth", async () => {
  const payload = await requestPayload();
  const plan = parseProjectRenderRequest(payload, { allowedOrigins: [origin] });
  const documentText = canonicalJson(document);
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers });
    if (String(url).endsWith("/revision")) {
      return new Response(documentText, {
        headers: { "content-length": String(Buffer.byteLength(documentText)) },
      });
    }
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { "content-length": "4" },
    });
  };
  const temporary = await mkdtemp(path.join(os.tmpdir(), "syncword-v3-"));
  try {
    const revision = await fetchProjectRevision(plan, fakeFetch);
    assert.equal(revision.renderInput.captions[0].text, "নমস্কাৰ");
    await downloadProjectSource(plan, path.join(temporary, "source.mp4"), fakeFetch);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.authorization, `Bearer ${"b".repeat(64)}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("callbacks carry canonical state, verified hashes, and no owner capability", async () => {
  const plan = parseProjectRenderRequest(await requestPayload(), {
    allowedOrigins: [origin],
  });
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    let bytes = 0;
    if (options.body && typeof options.body !== "string") {
      for await (const chunk of options.body) bytes += chunk.length;
    }
    calls.push({ url: String(url), options, bytes });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const temporary = await mkdtemp(path.join(os.tmpdir(), "syncword-v3-"));
  try {
    const artifact = path.join(temporary, "captions.ass");
    await writeFile(artifact, "caption artifact", "utf8");
    await putProjectRenderState(
      plan,
      { status: "running", progress: 15, message: "Loading" },
      fakeFetch,
    );
    const uploaded = await uploadProjectRenderArtifact(
      plan,
      "captions_ass",
      artifact,
      "text/x-ssa; charset=utf-8",
      { fetchImpl: fakeFetch },
    );
    assert.equal(calls[0].options.headers.authorization, `Bearer ${"b".repeat(64)}`);
    assert.equal(calls[1].bytes, Buffer.byteLength("caption artifact"));
    assert.equal(calls[1].options.headers["x-content-sha256"], uploaded.sha256);
    assert.equal("ownerCapability" in calls[1].options.headers, false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("revision hash mismatch stops compute before rendering", async () => {
  const payload = await requestPayload();
  payload.revision.documentHash = "c".repeat(64);
  const plan = parseProjectRenderRequest(payload, { allowedOrigins: [origin] });
  await assert.rejects(
    () =>
      fetchProjectRevision(
        plan,
        async () => new Response(canonicalJson(document)),
      ),
    /failed its SHA-256 check/,
  );
});
