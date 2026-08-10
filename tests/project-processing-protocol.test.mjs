import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { projectDocumentFromProcessingJob } from "../server/project-processing-contract.mjs";
import {
  downloadProjectProcessingSource,
  parseProjectProcessingRequest,
  putProjectProcessingResult,
  putProjectProcessingState,
} from "../server/project-processing-protocol.mjs";

const id = "55555555-5555-4555-8555-555555555555";
const projectId = "11111111-1111-4111-8111-111111111111";
const sourceAssetId = "22222222-2222-4222-8222-222222222222";
const origin = "https://syncword.example";
const base = `${origin}/api/projects/${projectId}/processing-jobs/${id}`;
const sourceBytes = new Uint8Array([1, 2, 3, 4]);
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
const token = "b".repeat(64);

function payload(overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    projectId,
    requestFingerprint: "a".repeat(64),
    processorRevision: "syncword-caption-v3-test",
    source: {
      assetId: sourceAssetId,
      url: `${base}/source`,
      contentType: "video/mp4",
      byteSize: sourceBytes.length,
      etag: "source-etag",
      sha256: sourceSha256,
    },
    processing: { language: "as-IN", mode: "codemix" },
    callback: {
      baseUrl: base,
      stateUrl: `${base}/state`,
      resultUrl: `${base}/result`,
    },
    authorization: {
      processingCapabilityToken: token,
      sitesAuthorization: "site-bypass-token-with-at-least-32-characters",
    },
    ...overrides,
  };
}

function resultDocument(plan) {
  return projectDocumentFromProcessingJob(plan, {
    status: "ready",
    languageCode: "as-IN",
    video: { duration: 2, width: 720, height: 1280 },
    captions: [
      {
        id: "cue-1",
        text: "hello",
        start: 0,
        end: 2,
        words: [
          {
            id: "word-1",
            text: "hello",
            start: 0,
            end: 2,
            timingSource: "manual",
          },
        ],
      },
    ],
    speechAnalysis: { speechIntervals: [{ start: 0, end: 2 }] },
    style: {},
  });
}

test("parses only the exact v3 processing schema and callback paths", () => {
  const plan = parseProjectProcessingRequest(payload(), {
    allowedOrigins: [origin],
  });
  assert.equal(plan.id, id);
  assert.equal(plan.source.assetId, sourceAssetId);
  assert.equal(plan.callback.resultUrl.pathname, `${new URL(base).pathname}/result`);

  const foreign = payload();
  foreign.callback.stateUrl = "https://evil.example/state";
  assert.throws(
    () => parseProjectProcessingRequest(foreign, { allowedOrigins: [origin] }),
    /does not match the immutable processing job route/,
  );

  const extra = payload({ unexpected: true });
  assert.throws(
    () => parseProjectProcessingRequest(extra, { allowedOrigins: [origin] }),
    /not part of processing schemaVersion 1/,
  );

  for (const language of ["auto", "unknown", "mix"]) {
    assert.throws(
      () =>
        parseProjectProcessingRequest(
          payload({ processing: { language, mode: "codemix" } }),
          { allowedOrigins: [origin] },
        ),
      /processing\.language must be as-IN or brx-IN/,
    );
  }
});

test("downloads a capability-scoped source and verifies size, ETag, and SHA-256", async () => {
  const plan = parseProjectProcessingRequest(payload(), {
    allowedOrigins: [origin],
  });
  const calls = [];
  const temporary = await mkdtemp(path.join(os.tmpdir(), "syncword-processing-"));
  try {
    const destination = path.join(temporary, "source.mp4");
    await downloadProjectProcessingSource(
      plan,
      destination,
      async (url, options) => {
        calls.push({ url: String(url), options });
        return new Response(sourceBytes, {
          headers: {
            "content-length": String(sourceBytes.length),
            etag: '"source-etag"',
          },
        });
      },
    );
    assert.deepEqual(new Uint8Array(await readFile(destination)), sourceBytes);
    assert.equal(calls[0].options.headers.authorization, `Bearer ${token}`);
    assert.match(
      calls[0].options.headers["oai-sites-authorization"],
      /^Bearer /,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("uses scoped bearer callbacks and retries the idempotent result PUT", async () => {
  const plan = parseProjectProcessingRequest(payload(), {
    allowedOrigins: [origin],
  });
  const document = resultDocument(plan);
  const calls = [];
  let resultAttempts = 0;
  const fakeFetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.endsWith("/result")) {
      resultAttempts += 1;
      if (resultAttempts === 1) return new Response("retry", { status: 503 });
    }
    return new Response("{}", { status: 200 });
  };
  await putProjectProcessingState(
    plan,
    { status: "aligning", progress: 70, message: "Aligning" },
    fakeFetch,
  );
  await putProjectProcessingResult(plan, document, {
    fetchImpl: fakeFetch,
    retryDelay: async () => {},
  });

  assert.equal(resultAttempts, 2);
  assert.equal(calls.every((call) => call.options.headers.authorization === `Bearer ${token}`), true);
  const resultBody = JSON.parse(calls.at(-1).options.body);
  assert.equal(resultBody.document.captionTrack.status, "ready");
  assert.equal(resultBody.changeSummary, "Automatic captions");
});

test("does not retry a non-retryable rejected result", async () => {
  const plan = parseProjectProcessingRequest(payload(), {
    allowedOrigins: [origin],
  });
  let attempts = 0;
  await assert.rejects(
    () =>
      putProjectProcessingResult(plan, resultDocument(plan), {
        fetchImpl: async () => {
          attempts += 1;
          return new Response("invalid", { status: 409 });
        },
        retryDelay: async () => {},
      }),
    /returned 409/,
  );
  assert.equal(attempts, 1);
});
