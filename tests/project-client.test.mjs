import assert from "node:assert/strict";
import test from "node:test";

import {
  ProjectClientError,
  createProject,
  createProjectProcessingJob,
  createProjectRenderJob,
  projectAssetContentUrl,
  reserveProjectAsset,
  uploadProjectAsset,
} from "../shared/project-client.mjs";

function queuedFetch(responses) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    },
  };
}

test("project upload uses one same-origin source and no bearer credentials", async () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const assetId = "22222222-2222-4222-8222-222222222222";
  const transport = queuedFetch([
    Response.json({ id: projectId }, { status: 201 }),
    Response.json(
      { id: assetId, uploadUrl: `/api/projects/${projectId}/assets/${assetId}/source` },
      { status: 201 },
    ),
    Response.json({ id: assetId, status: "ready" }, { status: 201 }),
  ]);
  const file = new Blob(["video-bytes"], { type: "video/mp4" });
  Object.defineProperties(file, {
    name: { value: "source.mp4" },
    size: { value: file.size },
  });

  await createProject(transport.fetch, "Source");
  const asset = await reserveProjectAsset(transport.fetch, projectId, file);
  await uploadProjectAsset(transport.fetch, asset.uploadUrl, file);

  assert.equal(transport.calls.length, 3);
  assert.equal(transport.calls[2].init.body, file);
  for (const call of transport.calls) {
    assert.equal(call.init.credentials, "same-origin");
    assert.equal(new Headers(call.init.headers).has("authorization"), false);
  }
  assert.equal(
    projectAssetContentUrl(projectId, assetId),
    `/api/projects/${projectId}/assets/${assetId}/content`,
  );
});

test("processing and render requests carry stable idempotency at their boundaries", async () => {
  const transport = queuedFetch([
    Response.json({ id: "processing", status: "queued" }, { status: 202 }),
    Response.json({ id: "render", status: "queued" }, { status: 202 }),
  ]);
  await createProjectProcessingJob(transport.fetch, "project", {
    sourceAssetId: "asset",
    language: "as-IN",
    mode: "codemix",
    idempotencyKey: "process-project-1",
  });
  await createProjectRenderJob(transport.fetch, "project", {
    revisionId: "revision",
    exportSpec: { width: 720, height: 1280 },
    idempotencyKey: "render-revision-1",
  });

  assert.equal(
    new Headers(transport.calls[0].init.headers).get("idempotency-key"),
    "process-project-1",
  );
  assert.equal(
    new Headers(transport.calls[1].init.headers).get("idempotency-key"),
    "render-revision-1",
  );
  const renderBody = JSON.parse(transport.calls[1].init.body);
  assert.deepEqual(Object.keys(renderBody).sort(), [
    "exportSpec",
    "idempotencyKey",
    "revisionId",
  ]);
});

test("structured project failures preserve conflict and coverage diagnostics", async () => {
  const transport = queuedFetch([
    Response.json(
      {
        error: "Coverage is stale",
        code: "invalid_project_coverage",
        details: { reason: "speech_coverage_stale" },
      },
      { status: 400 },
    ),
  ]);
  await assert.rejects(
    reserveProjectAsset(transport.fetch, "project", {
      name: "source.mp4",
      type: "video/mp4",
      size: 1,
    }),
    (error) => {
      assert.ok(error instanceof ProjectClientError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_project_coverage");
      assert.deepEqual(error.details, { reason: "speech_coverage_stale" });
      return true;
    },
  );
});
