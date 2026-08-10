import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationUrls = [
  new URL("../drizzle/0000_organic_cassandra_nova.sql", import.meta.url),
  new URL("../drizzle/0001_processing_jobs.sql", import.meta.url),
  new URL("../drizzle/0002_dispatch_leases.sql", import.meta.url),
];

async function migrationSql() {
  return Promise.all(migrationUrls.map((url) => readFile(url, "utf8")));
}

function executeMigration(database, sql) {
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) database.exec(statement);
  }
}

test("D1 migration creates the complete versioned metadata graph", async () => {
  const sql = (await migrationSql()).join("\n");
  for (const table of [
    "projects",
    "assets",
    "project_revisions",
    "processing_jobs",
    "render_jobs",
    "export_artifacts",
  ]) {
    assert.match(sql, new RegExp("CREATE TABLE `" + table + "`"));
  }
  assert.match(sql, /document_r2_key/);
  assert.match(sql, /source_r2_key/);
  assert.match(sql, /\br2_key\b/);
  assert.doesNotMatch(sql, /\bblob\b/i);
});

test("D1 guards immutable snapshots and render boundaries", async () => {
  const sql = (await migrationSql()).join("\n");
  assert.doesNotMatch(sql, /PRAGMA\s+foreign_keys\s*=\s*(?:OFF|0)/i);
  assert.doesNotMatch(sql, /DROP\s+TABLE\s+`render_jobs`/i);
  assert.match(
    sql,
    /ALTER TABLE `render_jobs` ADD `dispatch_attempts` integer DEFAULT 0 NOT NULL/,
  );
  assert.match(
    sql,
    /CONSTRAINT "render_jobs_dispatch_attempts_check" CHECK \(`dispatch_attempts` >= 0\)/,
  );
  assert.match(sql, /CREATE TRIGGER `project_revisions_immutable`/);
  assert.match(sql, /CREATE TRIGGER `projects_head_revision_project_guard`/);
  assert.match(sql, /CREATE TRIGGER `render_jobs_boundary_immutable`/);
  assert.match(sql, /CREATE TRIGGER `processing_jobs_boundary_immutable`/);
  assert.match(sql, /CREATE TRIGGER `export_artifacts_immutable`/);
  assert.match(
    sql,
    /UNIQUE INDEX `render_jobs_project_idempotency_unique`[\s\S]*`project_id`,`idempotency_key`/,
  );
  assert.match(sql, /caption_status[\s\S]*review_required/);
  assert.match(sql, /source_asset_id/);
  assert.match(sql, /renderer_revision/);
  assert.match(sql, /callback_capability_hash/);
  assert.match(sql, /dispatch_attempts/);
  assert.match(sql, /dispatched_at/);
  assert.match(sql, /dispatch_error/);
  assert.match(
    sql,
    /callback_capability_hash`[^\n]*`export_spec_json`[^\n]*`renderer_revision`\nON `render_jobs`/,
  );
});

test("migrations upgrade existing render and artifact rows with foreign keys enabled", async () => {
  const [initialSql, processingSql, leaseSql] = await migrationSql();
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  executeMigration(database, initialSql);
  database.exec(`
    INSERT INTO projects (id, title, capability_hash)
    VALUES ('project-1', 'Migration test', '${"a".repeat(64)}');
    INSERT INTO assets (
      id, project_id, kind, status, original_name, content_type,
      byte_size, source_r2_key, source_etag, finalized_at
    ) VALUES (
      'asset-1', 'project-1', 'source_video', 'ready', 'source.mp4',
      'video/mp4', 10, 'projects/project-1/assets/asset-1/source.mp4',
      'etag', CURRENT_TIMESTAMP
    );
    INSERT INTO project_revisions (
      id, project_id, source_asset_id, schema_version, document_r2_key,
      document_hash, caption_status, caption_language
    ) VALUES (
      'revision-1', 'project-1', 'asset-1', 1,
      'projects/project-1/revisions/revision-1/document-v1.json',
      '${"b".repeat(64)}', 'ready', 'as-IN'
    );
    INSERT INTO render_jobs (
      id, project_id, revision_id, idempotency_key, request_fingerprint,
      callback_capability_hash, export_spec_json, renderer_revision
    ) VALUES (
      'render-1', 'project-1', 'revision-1', 'render-key',
      '${"c".repeat(64)}', '${"d".repeat(64)}', '{}', 'renderer-v1'
    );
    INSERT INTO export_artifacts (
      id, render_job_id, project_id, revision_id, kind, r2_key,
      content_type, byte_size, etag, sha256, codec_manifest_json
    ) VALUES (
      'artifact-1', 'render-1', 'project-1', 'revision-1', 'video',
      'projects/project-1/exports/artifact-1/video.mp4', 'video/mp4',
      1234, 'artifact-etag', '${"e".repeat(64)}', '{"videoCodec":"h264"}'
    );
  `);
  executeMigration(database, processingSql);
  executeMigration(database, leaseSql);

  const tables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, [
    "assets",
    "export_artifacts",
    "processing_jobs",
    "project_revisions",
    "projects",
    "render_jobs",
  ]);
  const triggers = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(triggers, [
    "export_artifacts_immutable",
    "processing_jobs_boundary_immutable",
    "project_revisions_immutable",
    "projects_head_revision_project_guard",
    "render_jobs_boundary_immutable",
  ]);
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT id, dispatch_attempts, dispatched_at, dispatch_error,
                  dispatch_lease_expires_at FROM render_jobs`,
        )
        .get(),
    },
    {
      id: "render-1",
      dispatch_attempts: 0,
      dispatched_at: null,
      dispatch_error: null,
      dispatch_lease_expires_at: null,
    },
  );
  assert.throws(
    () =>
      database
        .prepare("UPDATE render_jobs SET dispatch_attempts = -1 WHERE id = 'render-1'")
        .run(),
    /render_jobs_dispatch_attempts_check/,
  );
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT id, render_job_id, project_id, revision_id, kind, r2_key,
                  content_type, byte_size, etag, sha256, codec_manifest_json
           FROM export_artifacts`,
        )
        .get(),
    },
    {
      id: "artifact-1",
      render_job_id: "render-1",
      project_id: "project-1",
      revision_id: "revision-1",
      kind: "video",
      r2_key: "projects/project-1/exports/artifact-1/video.mp4",
      content_type: "video/mp4",
      byte_size: 1234,
      etag: "artifact-etag",
      sha256: "e".repeat(64),
      codec_manifest_json: '{"videoCodec":"h264"}',
    },
  );
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});
