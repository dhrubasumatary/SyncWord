import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { projectDocumentFromProcessingJob } from "../server/project-processing-contract.mjs";
import { executeProjectProcessing } from "../server/project-processing-executor.mjs";
import { parseProjectProcessingRequest } from "../server/project-processing-protocol.mjs";

const id = "55555555-5555-4555-8555-555555555555";
const projectId = "11111111-1111-4111-8111-111111111111";
const sourceAssetId = "22222222-2222-4222-8222-222222222222";
const origin = "https://syncword.example";
const base = `${origin}/api/projects/${projectId}/processing-jobs/${id}`;
const sourceBytes = new Uint8Array([1, 2, 3, 4]);

function plan() {
  return parseProjectProcessingRequest(
    {
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
        etag: null,
        sha256: null,
      },
      processing: { language: "as-IN", mode: "codemix" },
      callback: {
        baseUrl: base,
        stateUrl: `${base}/state`,
        resultUrl: `${base}/result`,
      },
      authorization: { processingCapabilityToken: "b".repeat(64) },
    },
    { allowedOrigins: [origin] },
  );
}

function document(processingPlan) {
  return projectDocumentFromProcessingJob(processingPlan, {
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
  });
}

function remote(events) {
  return async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/source")) return new Response(sourceBytes);
    if (target.endsWith("/state")) {
      events.push({ kind: "state", payload: JSON.parse(options.body) });
      return new Response("{}", { status: 200 });
    }
    if (target.endsWith("/result")) {
      events.push({ kind: "result", payload: JSON.parse(options.body) });
      return new Response("{}", { status: 201 });
    }
    throw new Error(`Unexpected URL: ${target}`);
  };
}

test("PUTs the immutable result after source, progress, alignment, and recovery", async () => {
  const processingPlan = plan();
  const events = [];
  const temporary = await mkdtemp(path.join(os.tmpdir(), "syncword-processing-executor-"));
  try {
    const result = await executeProjectProcessing({
      plan: processingPlan,
      directory: temporary,
      fetchImpl: remote(events),
      process: async ({ inputPath, onState }) => {
        assert.equal(path.basename(inputPath), "source.mp4");
        await onState({ status: "transcribing", progress: 40, message: "STT" });
        await onState({ status: "aligning", progress: 70, message: "Aligning" });
        await onState({ status: "recovering", progress: 79, message: "Recovery" });
        return { document: document(processingPlan), changeSummary: "Initial captions" };
      },
    });
    assert.equal(result.document.captionTrack.status, "ready");
    assert.equal(events.at(-1).kind, "result");
    assert.equal(events.at(-1).payload.changeSummary, "Initial captions");
    assert.equal(
      events.some((event) => event.kind === "state" && event.payload.status === "ready"),
      false,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("reports canonical failure and never PUTs a result after pipeline failure", async () => {
  const events = [];
  const temporary = await mkdtemp(path.join(os.tmpdir(), "syncword-processing-executor-"));
  try {
    await assert.rejects(
      () =>
        executeProjectProcessing({
          plan: plan(),
          directory: temporary,
          fetchImpl: remote(events),
          process: async () => {
            const error = new Error("Alignment unavailable");
            error.code = "alignment_unavailable";
            throw error;
          },
        }),
      /Alignment unavailable/,
    );
    assert.equal(events.some((event) => event.kind === "result"), false);
    assert.equal(events.at(-1).payload.status, "failed");
    assert.equal(events.at(-1).payload.failureCode, "alignment_unavailable");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
