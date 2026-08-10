import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseProjectDocument } from "../shared/project-contract.mjs";

const ORIGIN = "https://syncword.example";
const migrationsDirectoryUrl = new URL("../drizzle/", import.meta.url);

let workerPromise;

async function committedMigrations() {
  const names = (await readdir(migrationsDirectoryUrl, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}_.+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.ok(names.length > 0, "At least one committed D1 migration is required.");

  const migrations = [];
  for (const name of names) {
    migrations.push(await readFile(new URL(name, migrationsDirectoryUrl), "utf8"));
  }
  return migrations;
}

function executeMigration(database, sql) {
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) database.exec(statement);
  }
}

async function loadWorker() {
  if (!workerPromise) {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("project-worker-test", `${process.pid}-${Date.now()}`);
    workerPromise = import(workerUrl.href).then((module) => module.default);
  }
  return workerPromise;
}

class FakeD1Statement {
  constructor(database, sql, parameters = []) {
    this.database = database;
    this.sql = sql;
    this.parameters = parameters;
  }

  bind(...parameters) {
    return new FakeD1Statement(this.database, this.sql, parameters);
  }

  sqliteParameters() {
    if (!/\?\d+/.test(this.sql)) return this.parameters;
    return Object.fromEntries(
      this.parameters.map((value, index) => [String(index + 1), value]),
    );
  }

  runSync() {
    const statement = this.database.sqlite.prepare(this.sql);
    const parameters = this.sqliteParameters();
    const result = Array.isArray(parameters)
      ? statement.run(...parameters)
      : statement.run(parameters);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }

  async run() {
    return this.runSync();
  }

  async first() {
    const statement = this.database.sqlite.prepare(this.sql);
    const parameters = this.sqliteParameters();
    const result = Array.isArray(parameters)
      ? statement.get(...parameters)
      : statement.get(parameters);
    return result ?? null;
  }

  async all() {
    const statement = this.database.sqlite.prepare(this.sql);
    const parameters = this.sqliteParameters();
    const results = Array.isArray(parameters)
      ? statement.all(...parameters)
      : statement.all(parameters);
    return {
      success: true,
      results,
      meta: { changes: 0 },
    };
  }
}

class FakeD1Database {
  constructor(sqlite) {
    this.sqlite = sqlite;
  }

  prepare(sql) {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

async function bodyBytes(value) {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  if (value instanceof Blob || value instanceof ReadableStream) {
    return new Uint8Array(await new Response(value).arrayBuffer());
  }
  throw new TypeError("Unsupported fake R2 body.");
}

function parseRange(headers, size) {
  const value = headers instanceof Headers ? headers.get("range") : null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value ?? "");
  if (!match) return null;
  if (!match[1]) {
    const length = Math.min(Number(match[2]), size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return { offset, length: Math.max(0, end - offset + 1) };
}

function fakeR2Object(key, stored, requestedRange) {
  const range = parseRange(requestedRange, stored.bytes.byteLength);
  const selected = range
    ? stored.bytes.slice(range.offset, range.offset + range.length)
    : stored.bytes.slice();
  return {
    key,
    version: "1",
    size: stored.bytes.byteLength,
    etag: stored.etag,
    httpEtag: `"${stored.etag}"`,
    checksums: {},
    uploaded: stored.uploaded,
    httpMetadata: stored.httpMetadata,
    customMetadata: stored.customMetadata,
    storageClass: "Standard",
    ...(range ? { range } : {}),
    body: new Blob([selected]).stream(),
    bodyUsed: false,
    async arrayBuffer() {
      return selected.buffer.slice(
        selected.byteOffset,
        selected.byteOffset + selected.byteLength,
      );
    },
    async bytes() {
      return selected.slice();
    },
    async text() {
      return new TextDecoder().decode(selected);
    },
    async json() {
      return JSON.parse(new TextDecoder().decode(selected));
    },
    async blob() {
      return new Blob([selected]);
    },
    writeHttpMetadata(headers) {
      if (stored.httpMetadata?.contentType) {
        headers.set("content-type", stored.httpMetadata.contentType);
      }
      if (stored.httpMetadata?.contentDisposition) {
        headers.set(
          "content-disposition",
          stored.httpMetadata.contentDisposition,
        );
      }
    },
  };
}

class FakeR2Bucket {
  constructor() {
    this.objects = new Map();
    this.nextEtag = 1;
  }

  async put(key, value, options = {}) {
    if (
      options.onlyIf?.etagDoesNotMatch === "*" &&
      this.objects.has(key)
    ) {
      return null;
    }
    const bytes = await bodyBytes(value);
    const stored = {
      bytes,
      etag: `fake-etag-${this.nextEtag++}`,
      uploaded: new Date(),
      httpMetadata: options.httpMetadata ?? {},
      customMetadata: options.customMetadata ?? {},
    };
    this.objects.set(key, stored);
    return fakeR2Object(key, stored, null);
  }

  async head(key) {
    const stored = this.objects.get(key);
    return stored ? fakeR2Object(key, stored, null) : null;
  }

  async get(key, options = {}) {
    const stored = this.objects.get(key);
    return stored
      ? fakeR2Object(key, stored, options.range ?? null)
      : null;
  }

  async delete(key) {
    if (Array.isArray(key)) {
      for (const item of key) this.objects.delete(item);
      return;
    }
    this.objects.delete(key);
  }
}

class FakeRenderer {
  constructor({ rejectedPosts = 0 } = {}) {
    this.calls = [];
    this.jobs = new Map();
    this.processingJobs = new Map();
    this.rejectedPosts = rejectedPosts;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v3/processing-jobs") {
      const payload = await request.json();
      this.calls.push({ method: request.method, url: request.url,
        headers: Object.fromEntries(request.headers), payload });
      const existing = this.processingJobs.get(payload.id);
      if (existing) {
        assert.deepEqual(payload, existing);
        return Response.json({ id: payload.id, status: "queued", idempotentReplay: true });
      }
      this.processingJobs.set(payload.id, payload);
      return Response.json({ id: payload.id, status: "queued" }, { status: 202 });
    }
    if (request.method === "POST" && url.pathname === "/v3/render-jobs") {
      const payload = await request.json();
      this.calls.push({
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
        payload,
      });
      if (this.rejectedPosts > 0) {
        this.rejectedPosts -= 1;
        return Response.json({ error: "renderer warming" }, { status: 503 });
      }
      const existing = this.jobs.get(payload.id);
      if (existing) {
        assert.deepEqual(payload, existing);
        return Response.json(
          { id: payload.id, status: "queued", idempotentReplay: true },
          { status: 200 },
        );
      }
      this.jobs.set(payload.id, payload);
      return Response.json({ id: payload.id, status: "queued" }, { status: 202 });
    }
    const deleteMatch = /^\/v3\/render-jobs\/([0-9a-f-]{36})$/i.exec(
      url.pathname,
    );
    if (request.method === "DELETE" && deleteMatch) {
      this.calls.push({
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
      });
      this.jobs.delete(deleteMatch[1]);
      return new Response(null, { status: 204 });
    }
    const processingDelete = /^\/v3\/processing-jobs\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (request.method === "DELETE" && processingDelete) {
      this.calls.push({ method: request.method, url: request.url,
        headers: Object.fromEntries(request.headers) });
      this.processingJobs.delete(processingDelete[1]);
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
}

async function createEnvironment(t, rendererOptions) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const migration of await committedMigrations()) {
    executeMigration(sqlite, migration);
  }
  t.after(() => sqlite.close());
  const renderer = new FakeRenderer(rendererOptions);
  return {
    env: {
      DB: new FakeD1Database(sqlite),
      MEDIA: new FakeR2Bucket(),
      RENDER_API: renderer,
      RENDER_API_URL: "https://renderer.example",
      RENDERER_REVISION: "syncword-render-test-v3",
      SITES_BYPASS_BEARER_TOKEN: "sites-test-token-that-never-reaches-the-browser",
    },
    renderer,
    sqlite,
  };
}

async function call(worker, env, path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.cookie) headers.set("cookie", options.cookie);
  let body = options.body;
  if (
    body !== undefined &&
    !(typeof body === "string") &&
    !(body instanceof Uint8Array) &&
    !(body instanceof ArrayBuffer) &&
    !(body instanceof Blob)
  ) {
    body = JSON.stringify(body);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }
  }
  const request = new Request(new URL(path, ORIGIN), {
    method: options.method ?? "GET",
    headers,
    ...(body === undefined ? {} : { body }),
  });
  return worker.fetch(request, env, {
    waitUntil() {},
    passThroughOnException() {},
  });
}

function cookieFrom(response) {
  return (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

function readyDocument(sourceAssetId) {
  return {
    schemaVersion: 1,
    sourceAssetId,
    durationMs: 4_000,
    canvas: { width: 720, height: 1280 },
    captionTrack: {
      id: "captions-primary",
      languageCode: "as-IN",
      status: "ready",
      style: { preset: "karaoke", activeColor: "#ffe66d" },
      coverage: {
        revision: "speech-active-v1",
        complete: true,
        speechDurationSeconds: 1.8,
        coveredSpeechDurationSeconds: 1.8,
        uncoveredDurationSeconds: 0,
        coverageRatio: 1,
        largestUncoveredGapSeconds: 0,
        speechIntervals: [{ start: 0.2, end: 2 }],
        captionIntervals: [{ start: 0.2, end: 2 }],
        coveredIntervals: [{ start: 0.2, end: 2 }],
        uncoveredIntervals: [],
        reasons: [],
        policy: {
          minimumCoverageRatio: 0.97,
          maximumUncoveredGapSeconds: 0.8,
        },
        recovery: {
          attempted: false,
          selected: false,
          windowCount: 0,
          addedCaptionCount: 0,
        },
      },
      cues: [
        {
          id: "cue-1",
          text: "নমস্কাৰ পৃথিৱী",
          startMs: 200,
          endMs: 2_000,
          words: [
            {
              id: "word-1",
              text: "নমস্কাৰ",
              startMs: 200,
              endMs: 1_000,
              confidence: 0.96,
              source: "mms-fa",
            },
            {
              id: "word-2",
              text: "পৃথিৱী",
              startMs: 1_000,
              endMs: 2_000,
              confidence: 0.94,
              source: "mms-fa",
            },
          ],
        },
      ],
    },
  };
}

const exportSpec = {
  width: 720,
  height: 1280,
  fps: "source",
  quality: "balanced",
};

async function createUploadedProject(worker, env) {
  const projectResponse = await call(worker, env, "/api/projects", {
    method: "POST", body: { title: "Processing test" },
  });
  assert.equal(projectResponse.status, 201);
  const cookie = cookieFrom(projectResponse);
  const project = await projectResponse.json();
  const sourceBytes = new TextEncoder().encode("one-project-source-video");
  const assetResponse = await call(worker, env, `/api/projects/${project.id}/assets`, {
    method: "POST", cookie, body: { originalName: "source.mp4", contentType: "video/mp4",
      byteSize: sourceBytes.byteLength, kind: "source_video" },
  });
  assert.equal(assetResponse.status, 201);
  const asset = await assetResponse.json();
  const upload = await call(worker, env, asset.uploadUrl, { method: "PUT", cookie,
    headers: { "content-length": String(sourceBytes.byteLength), "content-type": "video/mp4" }, body: sourceBytes });
  assert.equal(upload.status, 201);
  return { project, cookie, asset: await upload.json(), sourceBytes };
}

async function createReadyProject(worker, env) {
  const projectResponse = await call(worker, env, "/api/projects", {
    method: "POST",
    body: { title: "Lifecycle test" },
  });
  assert.equal(projectResponse.status, 201);
  const setCookie = projectResponse.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Max-Age=2592000/i);
  const cookie = cookieFrom(projectResponse);
  const ownerCapability = cookie.split("=", 2)[1];
  const project = await projectResponse.json();
  assert.equal(project.capabilityToken, undefined);
  assert.equal(project.session.transport, "http_only_cookie");

  const sourceBytes = new TextEncoder().encode("source-video-bytes");
  const assetResponse = await call(
    worker,
    env,
    `/api/projects/${project.id}/assets`,
    {
      method: "POST",
      cookie,
      body: {
        originalName: "clip.mp4",
        contentType: "video/mp4",
        byteSize: sourceBytes.byteLength,
        kind: "source_video",
      },
    },
  );
  assert.equal(assetResponse.status, 201);
  const asset = await assetResponse.json();
  const uploadResponse = await call(worker, env, asset.uploadUrl, {
    method: "PUT",
    cookie,
    headers: {
      "content-length": String(sourceBytes.byteLength),
      "content-type": "video/mp4",
    },
    body: sourceBytes,
  });
  assert.equal(uploadResponse.status, 201);

  const document = readyDocument(asset.id);
  const processingResponse = await call(
    worker,
    env,
    `/api/projects/${project.id}/processing-jobs`,
    {
      method: "POST",
      cookie,
      body: {
        sourceAssetId: asset.id,
        language: "as-IN",
        mode: "codemix",
        idempotencyKey: "initial-verified-captions",
      },
    },
  );
  assert.equal(processingResponse.status, 202);
  const processing = await processingResponse.json();
  const dispatch = env.RENDER_API.calls.find(
    (entry) =>
      entry.method === "POST" &&
      entry.payload.id === processing.id &&
      new URL(entry.url).pathname === "/v3/processing-jobs",
  );
  assert.ok(dispatch);
  const resultResponse = await call(
    worker,
    env,
    dispatch.payload.callback.resultUrl,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${dispatch.payload.authorization.processingCapabilityToken}`,
      },
      body: { document, changeSummary: "Initial verified captions" },
    },
  );
  assert.equal(resultResponse.status, 201, await resultResponse.clone().text());
  const revision = (await resultResponse.json()).revision;
  env.RENDER_API.calls.length = 0;
  return {
    project,
    cookie,
    ownerCapability,
    asset,
    sourceBytes,
    document,
    revision,
  };
}

test("durable media jobs require one selected supported language", async (t) => {
  const worker = await loadWorker();
  const { env } = await createEnvironment(t);
  const metadata = {
    originalName: "clip.mp4",
    contentType: "video/mp4",
    size: 1_024,
    mode: "codemix",
  };

  for (const language of [undefined, "auto", "unknown", "mix"]) {
    const rejected = await call(worker, env, "/api/media/jobs", {
      method: "POST",
      body: { ...metadata, ...(language === undefined ? {} : { language }) },
    });
    assert.equal(rejected.status, 400);
  }

  const accepted = await call(worker, env, "/api/media/jobs", {
    method: "POST",
    body: { ...metadata, language: "as-IN" },
  });
  assert.equal(accepted.status, 201);
  const job = await accepted.json();
  assert.equal(job.languageCode, "as-IN");

  const mismatchedCallback = await call(
    worker,
    env,
    `/api/media/jobs/${job.id}/state`,
    {
      method: "PUT",
      headers: { authorization: `Bearer ${job.capabilityToken}` },
      body: { languageCode: "brx-IN" },
    },
  );
  assert.equal(mismatchedCallback.status, 400);
});

test("project Worker executes immutable render lifecycle with scoped capabilities", async (t) => {
  const worker = await loadWorker();
  const { env, renderer, sqlite } = await createEnvironment(t);
  const ready = await createReadyProject(worker, env);

  const wrongOwner = await call(
    worker,
    env,
    `/api/projects/${ready.project.id}`,
    { headers: { authorization: `Bearer ${"0".repeat(64)}` } },
  );
  assert.equal(wrongOwner.status, 401);

  const staleCoverageDocument = structuredClone(ready.document);
  staleCoverageDocument.captionTrack.cues[0].text = "নমস্কাৰ";
  staleCoverageDocument.captionTrack.cues[0].endMs = 500;
  staleCoverageDocument.captionTrack.cues[0].words = [
    {
      id: "word-short",
      text: "নমস্কাৰ",
      startMs: 200,
      endMs: 500,
      confidence: 0.96,
      source: "manual",
    },
  ];
  staleCoverageDocument.captionTrack.coverage.policy = {
    minimumCoverageRatio: 0,
    maximumUncoveredGapSeconds: 999,
    captionBoundaryPaddingSeconds: 999,
    captionMergeGapSeconds: 999,
    minimumSpeechIntervalSeconds: 0,
  };
  const staleRevision = await call(
    worker,
    env,
    `/api/projects/${ready.project.id}/revisions`,
    {
      method: "POST",
      cookie: ready.cookie,
      body: {
        baseRevisionId: ready.revision.id,
        document: staleCoverageDocument,
        changeSummary: "Deleted speech and forged a loose coverage policy",
      },
    },
  );
  assert.equal(staleRevision.status, 400);
  const staleRevisionError = await staleRevision.json();
  assert.equal(staleRevisionError.code, "invalid_project_coverage");
  assert.equal(staleRevisionError.details.reason, "speech_coverage_stale");

  const shrunkBaselineDocument = structuredClone(ready.document);
  shrunkBaselineDocument.captionTrack.coverage.speechIntervals = [
    { start: 0.2, end: 1 },
  ];
  shrunkBaselineDocument.captionTrack.coverage.speechDurationSeconds = 0.8;
  shrunkBaselineDocument.captionTrack.coverage.coveredSpeechDurationSeconds = 0.8;
  const shrunkBaselineRevision = await call(
    worker,
    env,
    `/api/projects/${ready.project.id}/revisions`,
    {
      method: "POST",
      cookie: ready.cookie,
      body: {
        baseRevisionId: ready.revision.id,
        document: shrunkBaselineDocument,
        changeSummary: "Attempted to hide speech from the immutable baseline",
      },
    },
  );
  assert.equal(shrunkBaselineRevision.status, 409);
  const shrunkBaselineError = await shrunkBaselineRevision.json();
  assert.equal(shrunkBaselineError.code, "speech_activity_baseline_mismatch");
  assert.equal(
    shrunkBaselineError.details.reason,
    "speech_intervals_must_match_base",
  );

  const styleOnlyDocument = structuredClone(ready.document);
  styleOnlyDocument.captionTrack.style.activeColor = "#ffcc00";
  const styleOnlyRevision = await call(
    worker,
    env,
    `/api/projects/${ready.project.id}/revisions`,
    {
      method: "POST",
      cookie: ready.cookie,
      body: {
        baseRevisionId: ready.revision.id,
        document: styleOnlyDocument,
        changeSummary: "Changed caption styling with the same speech baseline",
      },
    },
  );
  assert.equal(styleOnlyRevision.status, 201, await styleOnlyRevision.clone().text());

  const renderPath = `/api/projects/${ready.project.id}/render-jobs`;
  const createBody = {
    revisionId: ready.revision.id,
    exportSpec,
    idempotencyKey: "lifecycle-render",
  };
  const renderResponse = await call(worker, env, renderPath, {
    method: "POST",
    cookie: ready.cookie,
    headers: { "idempotency-key": "lifecycle-render" },
    body: createBody,
  });
  assert.equal(renderResponse.status, 202);
  const renderText = await renderResponse.text();
  assert.doesNotMatch(renderText, /callbackCapabilityToken|renderCapabilityToken/);
  assert.doesNotMatch(renderText, new RegExp(ready.ownerCapability));
  const renderJob = JSON.parse(renderText);
  assert.equal(renderJob.status, "queued");
  assert.equal(renderJob.dispatch.state, "dispatched");
  assert.equal(renderJob.dispatch.attempts, 1);
  assert.ok(Date.parse(renderJob.dispatch.leaseExpiresAt) > Date.now());

  assert.equal(renderer.calls.length, 1);
  const dispatch = renderer.calls[0];
  assert.equal(dispatch.method, "POST");
  assert.equal(new URL(dispatch.url).pathname, "/v3/render-jobs");
  assert.equal(dispatch.headers["idempotency-key"], renderJob.id);
  assert.equal(dispatch.payload.schemaVersion, 1);
  assert.equal(dispatch.payload.id, renderJob.id);
  assert.equal(dispatch.payload.exportSpec.fps, "source");
  assert.equal(dispatch.payload.projectId, ready.project.id);
  assert.equal(dispatch.payload.revision.id, ready.revision.id);
  assert.equal(
    dispatch.payload.revision.documentHash,
    ready.revision.documentHash,
  );
  assert.deepEqual(dispatch.payload.exportSpec, {
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    captionMode: "burned",
    ...exportSpec,
  });
  const renderToken = dispatch.payload.authorization.renderCapabilityToken;
  assert.match(renderToken, /^[0-9a-f]{64}$/);
  assert.notEqual(renderToken, ready.ownerCapability);
  assert.equal(
    dispatch.payload.authorization.sitesAuthorization,
    env.SITES_BYPASS_BEARER_TOKEN,
  );
  assert.match(
    dispatch.payload.source.url,
    new RegExp(`/api/projects/${ready.project.id}/render-jobs/${renderJob.id}/source$`),
  );
  assert.match(
    dispatch.payload.revision.url,
    new RegExp(`/api/projects/${ready.project.id}/render-jobs/${renderJob.id}/revision$`),
  );

  const replayResponse = await call(worker, env, renderPath, {
    method: "POST",
    cookie: ready.cookie,
    headers: { "idempotency-key": "lifecycle-render" },
    body: createBody,
  });
  assert.equal(replayResponse.status, 200);
  assert.equal((await replayResponse.json()).idempotentReplay, true);
  assert.equal(renderer.calls.length, 1);
  const freshPoll = await call(
    worker,
    env,
    `/api/projects/${ready.project.id}/render-jobs/${renderJob.id}`,
    { cookie: ready.cookie },
  );
  assert.equal(freshPoll.status, 200);
  assert.equal(renderer.calls.length, 1);

  sqlite
    .prepare(
      "UPDATE render_jobs SET dispatch_lease_expires_at=? WHERE project_id=? AND id=?",
    )
    .run("2000-01-01T00:00:00.000Z", ready.project.id, renderJob.id);
  renderer.jobs.clear();
  const restartedPoll = await call(
    worker,
    env,
    `/api/projects/${ready.project.id}/render-jobs/${renderJob.id}`,
    { cookie: ready.cookie },
  );
  assert.equal(restartedPoll.status, 200);
  const restartedJob = await restartedPoll.json();
  assert.equal(restartedJob.dispatch.attempts, 2);
  assert.equal(renderer.calls.length, 2);
  assert.deepEqual(renderer.calls[1].payload, dispatch.payload);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM render_jobs").get().count,
    1,
  );

  for (const url of [dispatch.payload.source.url, dispatch.payload.revision.url]) {
    const denied = await call(worker, env, url, {
      headers: { authorization: `Bearer ${"f".repeat(64)}` },
    });
    assert.equal(denied.status, 401);
    assert.equal(
      (await denied.json()).code,
      "render_callback_capability_invalid",
    );
  }

  const sourceResponse = await call(worker, env, dispatch.payload.source.url, {
    headers: {
      authorization: `Bearer ${renderToken}`,
      range: "bytes=2-7",
    },
  });
  assert.equal(sourceResponse.status, 206);
  assert.deepEqual(
    new Uint8Array(await sourceResponse.arrayBuffer()),
    ready.sourceBytes.slice(2, 8),
  );

  const revisionResponse = await call(
    worker,
    env,
    dispatch.payload.revision.url,
    { headers: { authorization: `Bearer ${renderToken}` } },
  );
  assert.equal(revisionResponse.status, 200);
  assert.equal(
    revisionResponse.headers.get("x-syncword-document-sha256"),
    ready.revision.documentHash,
  );
  assert.deepEqual(
    await revisionResponse.json(),
    parseProjectDocument(ready.document),
  );

  const callbackBase = `/api/projects/${ready.project.id}/render-jobs/${renderJob.id}`;
  const ownerCannotForgeState = await call(
    worker,
    env,
    `${callbackBase}/state`,
    {
      method: "PUT",
      cookie: ready.cookie,
      body: { status: "running", progress: 15, message: "Encoding" },
    },
  );
  assert.equal(ownerCannotForgeState.status, 401);

  const runningResponse = await call(worker, env, `${callbackBase}/state`, {
    method: "PUT",
    headers: { authorization: `Bearer ${renderToken}` },
    body: { status: "running", progress: 15, message: "Encoding" },
  });
  assert.equal(runningResponse.status, 200);
  assert.equal((await runningResponse.json()).status, "running");

  const prematureSuccess = await call(worker, env, `${callbackBase}/state`, {
    method: "PUT",
    headers: { authorization: `Bearer ${renderToken}` },
    body: { status: "succeeded", progress: 100, message: "Done" },
  });
  assert.equal(prematureSuccess.status, 409);
  assert.equal(
    (await prematureSuccess.json()).code,
    "render_video_artifact_required",
  );

  const videoBytes = new TextEncoder().encode("rendered-video-payload");
  const wrongArtifactToken = await call(
    worker,
    env,
    `${callbackBase}/artifacts/video`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${"e".repeat(64)}`,
        "content-length": String(videoBytes.byteLength),
        "content-type": "video/mp4",
      },
      body: videoBytes,
    },
  );
  assert.equal(wrongArtifactToken.status, 401);

  const artifactResponse = await call(
    worker,
    env,
    `${callbackBase}/artifacts/video`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${renderToken}`,
        "content-length": String(videoBytes.byteLength),
        "content-type": "video/mp4",
      },
      body: videoBytes,
    },
  );
  assert.equal(artifactResponse.status, 201);
  const artifact = await artifactResponse.json();

  const successResponse = await call(worker, env, `${callbackBase}/state`, {
    method: "PUT",
    headers: { authorization: `Bearer ${renderToken}` },
    body: { status: "succeeded", progress: 99, message: "Done" },
  });
  assert.equal(successResponse.status, 200);
  assert.equal((await successResponse.json()).status, "succeeded");

  const exportDenied = await call(worker, env, artifact.contentUrl, {
    headers: { authorization: `Bearer ${"d".repeat(64)}` },
  });
  assert.equal(exportDenied.status, 401);
  const exportResponse = await call(worker, env, artifact.contentUrl, {
    cookie: ready.cookie,
    headers: { range: "bytes=3-9" },
  });
  assert.equal(exportResponse.status, 206);
  assert.deepEqual(
    new Uint8Array(await exportResponse.arrayBuffer()),
    videoBytes.slice(3, 10),
  );
  const downloadResponse = await call(
    worker,
    env,
    `${artifact.contentUrl}?download=1`,
    { cookie: ready.cookie },
  );
  assert.equal(downloadResponse.status, 200);
  assert.equal(
    downloadResponse.headers.get("content-disposition"),
    'attachment; filename="subtitles-by-miithii.mp4"',
  );

  const cancelCreate = await call(worker, env, renderPath, {
    method: "POST",
    cookie: ready.cookie,
    headers: { "idempotency-key": "cancel-render" },
    body: {
      revisionId: ready.revision.id,
      exportSpec,
      idempotencyKey: "cancel-render",
    },
  });
  assert.equal(cancelCreate.status, 202);
  const cancelJob = await cancelCreate.json();
  const cancelDispatch = renderer.calls.find(
    (entry) => entry.method === "POST" && entry.payload.id === cancelJob.id,
  );
  const cancelToken =
    cancelDispatch.payload.authorization.renderCapabilityToken;

  const cancelDenied = await call(
    worker,
    env,
    `/api/projects/${ready.project.id}/render-jobs/${cancelJob.id}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${"c".repeat(64)}` },
    },
  );
  assert.equal(cancelDenied.status, 401);
  const cancelResponse = await call(
    worker,
    env,
    `/api/projects/${ready.project.id}/render-jobs/${cancelJob.id}`,
    { method: "DELETE", cookie: ready.cookie },
  );
  assert.equal(cancelResponse.status, 202);
  assert.equal((await cancelResponse.json()).status, "cancelled");
  const deleteCall = renderer.calls.find(
    (entry) => entry.method === "DELETE" && entry.url.endsWith(cancelJob.id),
  );
  assert.equal(deleteCall.headers.authorization, `Bearer ${cancelToken}`);
  const cancelledSource = await call(
    worker,
    env,
    cancelDispatch.payload.source.url,
    { headers: { authorization: `Bearer ${cancelToken}` } },
  );
  assert.equal(cancelledSource.status, 409);
});

test("project processing uses one durable source and creates the first immutable revision", async (t) => {
  const worker = await loadWorker();
  const { env, renderer, sqlite } = await createEnvironment(t);
  const uploaded = await createUploadedProject(worker, env);

  const assetContent = await call(worker, env, uploaded.asset.contentUrl, {
    cookie: uploaded.cookie,
    headers: { range: "bytes=1-6" },
  });
  assert.equal(assetContent.status, 206);
  assert.deepEqual(new Uint8Array(await assetContent.arrayBuffer()), uploaded.sourceBytes.slice(1, 7));
  const assetDenied = await call(worker, env, uploaded.asset.contentUrl, {
    headers: { authorization: `Bearer ${"a".repeat(64)}` },
  });
  assert.equal(assetDenied.status, 401);

  const ownerClaimedFirstRevision = await call(
    worker,
    env,
    `/api/projects/${uploaded.project.id}/revisions`,
    {
      method: "POST",
      cookie: uploaded.cookie,
      body: {
        baseRevisionId: null,
        document: readyDocument(uploaded.asset.id),
        changeSummary: "Untrusted first revision",
      },
    },
  );
  assert.equal(ownerClaimedFirstRevision.status, 409);
  assert.equal((await ownerClaimedFirstRevision.json()).code, "revision_base_required");

  const path = `/api/projects/${uploaded.project.id}/processing-jobs`;
  const invalidLanguage = await call(worker, env, path, {
    method: "POST",
    cookie: uploaded.cookie,
    body: {
      sourceAssetId: uploaded.asset.id,
      language: "auto",
      mode: "codemix",
      idempotencyKey: "invalid-language",
    },
  });
  assert.equal(invalidLanguage.status, 400);
  assert.equal(
    (await invalidLanguage.json()).code,
    "invalid_processing_language",
  );
  const body = { sourceAssetId: uploaded.asset.id, language: "as-IN", mode: "codemix",
    idempotencyKey: "initial-captions" };
  const created = await call(worker, env, path, { method: "POST", cookie: uploaded.cookie,
    headers: { "idempotency-key": "initial-captions" }, body });
  assert.equal(created.status, 202);
  const processingText = await created.text();
  assert.doesNotMatch(processingText, /processingCapabilityToken/);
  const processing = JSON.parse(processingText);
  assert.equal(processing.revisionId, null);
  assert.equal(processing.dispatch.state, "dispatched");
  assert.ok(Date.parse(processing.dispatch.leaseExpiresAt) > Date.now());
  const dispatch = renderer.calls.find((entry) =>
    entry.method === "POST" && new URL(entry.url).pathname === "/v3/processing-jobs");
  const token = dispatch.payload.authorization.processingCapabilityToken;
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(dispatch.payload.source.assetId, uploaded.asset.id);

  const replay = await call(worker, env, path, { method: "POST", cookie: uploaded.cookie,
    headers: { "idempotency-key": "initial-captions" }, body });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).idempotentReplay, true);
  assert.equal(renderer.calls.filter((entry) => entry.method === "POST").length, 1);

  const freshPoll = await call(
    worker,
    env,
    `/api/projects/${uploaded.project.id}/processing-jobs/${processing.id}`,
    { cookie: uploaded.cookie },
  );
  assert.equal(freshPoll.status, 200);
  assert.equal(renderer.calls.filter((entry) => entry.method === "POST").length, 1);

  sqlite
    .prepare(
      "UPDATE processing_jobs SET dispatch_lease_expires_at=? WHERE project_id=? AND id=?",
    )
    .run("2000-01-01T00:00:00.000Z", uploaded.project.id, processing.id);
  renderer.processingJobs.clear();
  const restartedPoll = await call(
    worker,
    env,
    `/api/projects/${uploaded.project.id}/processing-jobs/${processing.id}`,
    { cookie: uploaded.cookie },
  );
  assert.equal(restartedPoll.status, 200);
  assert.equal((await restartedPoll.json()).dispatch.attempts, 2);
  const processingPosts = renderer.calls.filter(
    (entry) => entry.method === "POST" && new URL(entry.url).pathname === "/v3/processing-jobs",
  );
  assert.equal(processingPosts.length, 2);
  assert.deepEqual(processingPosts[1].payload, dispatch.payload);

  const sourceDenied = await call(worker, env, dispatch.payload.source.url, {
    headers: { authorization: `Bearer ${"b".repeat(64)}` },
  });
  assert.equal(sourceDenied.status, 401);
  const source = await call(worker, env, dispatch.payload.source.url, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(source.status, 200);
  assert.deepEqual(new Uint8Array(await source.arrayBuffer()), uploaded.sourceBytes);

  const state = await call(worker, env, dispatch.payload.callback.stateUrl, {
    method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: { status: "transcribing", progress: 42, message: "Transcribing" },
  });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).status, "transcribing");

  const document = readyDocument(uploaded.asset.id);
  const wrongResult = await call(worker, env, dispatch.payload.callback.resultUrl, {
    method: "PUT", headers: { authorization: `Bearer ${"c".repeat(64)}` }, body: { document },
  });
  assert.equal(wrongResult.status, 401);
  const mismatchedDocument = structuredClone(document);
  mismatchedDocument.captionTrack.languageCode = "brx-IN";
  const mismatchedResult = await call(
    worker,
    env,
    dispatch.payload.callback.resultUrl,
    {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: { document: mismatchedDocument },
    },
  );
  assert.equal(mismatchedResult.status, 400);
  assert.equal(
    (await mismatchedResult.json()).code,
    "processing_language_mismatch",
  );
  const result = await call(worker, env, dispatch.payload.callback.resultUrl, {
    method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: { document, changeSummary: "Initial automatic captions" },
  });
  assert.equal(result.status, 201, await result.clone().text());
  const finalized = await result.json();
  assert.equal(finalized.status, "ready");
  assert.equal(finalized.revisionId, processing.id);
  assert.equal(finalized.revision.id, processing.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM project_revisions").get().count, 1);

  const resultReplay = await call(worker, env, dispatch.payload.callback.resultUrl, {
    method: "PUT", headers: { authorization: `Bearer ${token}` }, body: { document },
  });
  assert.equal(resultReplay.status, 200);
  assert.equal((await resultReplay.json()).idempotentReplay, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM project_revisions").get().count, 1);
  const poll = await call(worker, env,
    `/api/projects/${uploaded.project.id}/processing-jobs/${processing.id}`,
    { cookie: uploaded.cookie });
  assert.equal((await poll.json()).revisionId, processing.id);

  const cancelUploaded = await createUploadedProject(worker, env);
  const cancelPath = `/api/projects/${cancelUploaded.project.id}/processing-jobs`;
  const cancelCreated = await call(worker, env, cancelPath, { method: "POST", cookie: cancelUploaded.cookie,
    body: { sourceAssetId: cancelUploaded.asset.id, language: "as-IN", mode: "verbatim",
      idempotencyKey: "cancel-processing" } });
  const cancelJob = await cancelCreated.json();
  const cancelled = await call(worker, env,
    `/api/projects/${cancelUploaded.project.id}/processing-jobs/${cancelJob.id}`,
    { method: "DELETE", cookie: cancelUploaded.cookie });
  assert.equal(cancelled.status, 202);
  assert.equal((await cancelled.json()).status, "cancelled");
  assert.ok(renderer.calls.some((entry) => entry.method === "DELETE" && entry.url.includes("/v3/processing-jobs/")));
});

test("processing cancellation cannot race an immutable first revision into the project", async (t) => {
  const worker = await loadWorker();
  const { env, renderer, sqlite } = await createEnvironment(t);
  const uploaded = await createUploadedProject(worker, env);
  const created = await call(
    worker,
    env,
    `/api/projects/${uploaded.project.id}/processing-jobs`,
    {
      method: "POST",
      cookie: uploaded.cookie,
      body: {
        sourceAssetId: uploaded.asset.id,
        language: "as-IN",
        mode: "verbatim",
        idempotencyKey: "cancel-during-result",
      },
    },
  );
  assert.equal(created.status, 202);
  const processing = await created.json();
  const dispatch = renderer.calls.find(
    (entry) => entry.method === "POST" && entry.payload.id === processing.id,
  );
  const token = dispatch.payload.authorization.processingCapabilityToken;

  const originalPut = env.MEDIA.put.bind(env.MEDIA);
  env.MEDIA.put = async (key, value, options) => {
    const object = await originalPut(key, value, options);
    if (key.includes(`/revisions/${processing.id}/`)) {
      const now = new Date().toISOString();
      sqlite.prepare(`UPDATE processing_jobs SET status='cancelled', completed_at=?, updated_at=?
        WHERE project_id=? AND id=?`).run(now, now, uploaded.project.id, processing.id);
    }
    return object;
  };

  const result = await call(worker, env, dispatch.payload.callback.resultUrl, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: { document: readyDocument(uploaded.asset.id) },
  });
  assert.equal(result.status, 409);
  assert.equal((await result.json()).code, "processing_revision_conflict");
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM project_revisions").get().count,
    0,
  );
  assert.equal(
    sqlite.prepare("SELECT head_revision_id FROM projects WHERE id=?").get(uploaded.project.id)
      .head_revision_id,
    null,
  );
  assert.equal(
    [...env.MEDIA.objects.keys()].some((key) => key.includes(`/revisions/${processing.id}/`)),
    false,
  );
});

test("failed dispatch retries the same durable job without duplicating metadata", async (t) => {
  const worker = await loadWorker();
  const { env, renderer, sqlite } = await createEnvironment(t, {
    rejectedPosts: 1,
  });
  const ready = await createReadyProject(worker, env);
  const renderPath = `/api/projects/${ready.project.id}/render-jobs`;
  const body = {
    revisionId: ready.revision.id,
    exportSpec,
    idempotencyKey: "retry-render",
  };

  const failed = await call(worker, env, renderPath, {
    method: "POST",
    cookie: ready.cookie,
    headers: { "idempotency-key": "retry-render" },
    body,
  });
  assert.equal(failed.status, 502);
  const failure = await failed.json();
  assert.equal(failure.code, "render_dispatch_rejected");
  const durableJobId = failure.details.renderJobId;
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM render_jobs").get().count,
    1,
  );

  const retry = await call(worker, env, renderPath, {
    method: "POST",
    cookie: ready.cookie,
    headers: { "idempotency-key": "retry-render" },
    body,
  });
  assert.equal(retry.status, 200);
  const retriedJob = await retry.json();
  assert.equal(retriedJob.id, durableJobId);
  assert.equal(retriedJob.idempotentReplay, true);
  assert.equal(retriedJob.dispatch.attempts, 2);
  assert.equal(retriedJob.dispatch.state, "dispatched");
  assert.deepEqual(
    renderer.calls.map((entry) => entry.payload.id),
    [durableJobId, durableJobId],
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM render_jobs").get().count,
    1,
  );
});
