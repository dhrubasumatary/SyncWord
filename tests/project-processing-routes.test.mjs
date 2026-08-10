import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { projectDocumentFromProcessingJob } from "../server/project-processing-contract.mjs";
import {
  createProjectProcessingRouter,
  projectJobCapabilityMatches,
} from "../server/project-processing-routes.mjs";

const id = "55555555-5555-4555-8555-555555555555";
const secondId = "66666666-6666-4666-8666-666666666666";
const projectId = "11111111-1111-4111-8111-111111111111";
const sourceAssetId = "22222222-2222-4222-8222-222222222222";
const origin = "https://syncword.example";
const token = "b".repeat(64);

function payload(jobId = id, fingerprint = "a".repeat(64)) {
  const base = `${origin}/api/projects/${projectId}/processing-jobs/${jobId}`;
  return {
    schemaVersion: 1,
    id: jobId,
    projectId,
    requestFingerprint: fingerprint,
    processorRevision: "syncword-caption-v3-test",
    source: {
      assetId: sourceAssetId,
      url: `${base}/source`,
      contentType: "video/mp4",
      byteSize: 4,
      etag: null,
      sha256: null,
    },
    processing: { language: "as-IN", mode: "codemix" },
    callback: {
      baseUrl: base,
      stateUrl: `${base}/state`,
      resultUrl: `${base}/result`,
    },
    authorization: { processingCapabilityToken: token },
  };
}

function document(plan) {
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
          { id: "word-1", text: "hello", start: 0, end: 2, timingSource: "manual" },
        ],
      },
    ],
    speechAnalysis: { speechIntervals: [{ start: 0, end: 2 }] },
  });
}

async function post(baseUrl, body, headers = {}) {
  return fetch(`${baseUrl}/v3/processing-jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("processing route is idempotent, queues once, and exposes only canonical state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "syncword-processing-route-"));
  const jobs = new Map();
  const tasks = [];
  const states = [];
  const app = express();
  app.use(express.json());
  app.use(
    "/v3/processing-jobs",
    createProjectProcessingRouter({
      root,
      jobs,
      maxQueuedJobs: 2,
      jobLifetimeMs: 60_000,
      allowedOrigins: [origin],
      captionQualityRevision: "quality-v2",
      supportedProcessorRevision: "syncword-caption-v3-test",
      enqueue(_job, run) {
        tasks.push(run);
      },
      ensureRuntime() {},
      cancelRuntime(job) {
        job.cancelRequested = true;
        job.status = "cancelled";
        job.message = "Processing cancelled";
      },
      async runJob({ plan }) {
        return { document: document(plan) };
      },
      async putState(_plan, state) {
        states.push(state);
      },
    }),
  );
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const missingKey = await post(baseUrl, payload());
  assert.equal(missingKey.status, 409);

  const wrongRevisionBody = payload();
  wrongRevisionBody.processorRevision = "syncword-caption-v2";
  const wrongRevision = await post(baseUrl, wrongRevisionBody, {
    "idempotency-key": id,
  });
  assert.equal(wrongRevision.status, 409);
  assert.equal(
    (await wrongRevision.json()).code,
    "project_processing_revision_unsupported",
  );

  const accepted = await post(baseUrl, payload(), {
    "idempotency-key": id,
    "x-syncword-request-fingerprint": "a".repeat(64),
  });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).status, "queued");
  assert.equal(tasks.length, 1);

  const replay = await post(baseUrl, payload(), { "idempotency-key": id });
  assert.equal(replay.status, 202);
  assert.equal(tasks.length, 1);

  await tasks[0]();
  const completeReplay = await post(baseUrl, payload(), { "idempotency-key": id });
  assert.equal(completeReplay.status, 200);
  assert.equal((await completeReplay.json()).status, "ready");

  const second = await post(baseUrl, payload(secondId, "c".repeat(64)), {
    "idempotency-key": secondId,
  });
  assert.equal(second.status, 202);
  const wrongCancel = await fetch(`${baseUrl}/v3/processing-jobs/${secondId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${"d".repeat(64)}` },
  });
  assert.equal(wrongCancel.status, 401);
  const rightCancel = await fetch(`${baseUrl}/v3/processing-jobs/${secondId}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": secondId,
    },
  });
  assert.equal(rightCancel.status, 202);
  assert.equal((await rightCancel.json()).status, "cancelled");
  assert.equal(states.at(-1).status, "cancelled");
});

test("one constant-time capability helper protects both processing and render DELETE routes", async () => {
  const request = { headers: { authorization: `Bearer ${token}` } };
  assert.equal(projectJobCapabilityMatches(request, token), true);
  assert.equal(projectJobCapabilityMatches(request, "c".repeat(64)), false);

  const serverSource = await readFile(
    new URL("../server/index.mjs", import.meta.url),
    "utf8",
  );
  const routeSource = await readFile(
    new URL("../server/project-processing-routes.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    serverSource,
    /app\.delete\("\/v3\/render-jobs\/:id"[\s\S]{0,400}!hasCapability\(request, job\)/,
  );
  assert.match(
    serverSource,
    /function hasCapability\(request, job\)[\s\S]{0,160}projectJobCapabilityMatches/,
  );
  assert.match(
    routeSource,
    /router\.delete\("\/:id"[\s\S]{0,500}!projectJobCapabilityMatches\(request, job\.capabilityToken\)/,
  );
});
