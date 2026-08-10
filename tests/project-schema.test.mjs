import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationUrl = new URL(
  "../drizzle/0000_organic_cassandra_nova.sql",
  import.meta.url,
);

test("D1 migration creates the complete versioned metadata graph", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const table of [
    "projects",
    "assets",
    "project_revisions",
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
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /CREATE TRIGGER `project_revisions_immutable`/);
  assert.match(sql, /CREATE TRIGGER `projects_head_revision_project_guard`/);
  assert.match(sql, /CREATE TRIGGER `render_jobs_boundary_immutable`/);
  assert.match(sql, /CREATE TRIGGER `export_artifacts_immutable`/);
  assert.match(
    sql,
    /UNIQUE INDEX `render_jobs_project_idempotency_unique`[\s\S]*`project_id`,`idempotency_key`/,
  );
  assert.match(sql, /caption_status[\s\S]*review_required/);
  assert.match(sql, /source_asset_id/);
  assert.match(sql, /renderer_revision/);
  assert.match(sql, /callback_capability_hash/);
  assert.match(
    sql,
    /callback_capability_hash`[^\n]*`export_spec_json`[^\n]*`renderer_revision`\nON `render_jobs`/,
  );
});

test("the complete initial migration executes with foreign keys enabled", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) database.exec(statement);
  }

  const tables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, [
    "assets",
    "export_artifacts",
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
    "project_revisions_immutable",
    "projects_head_revision_project_guard",
    "render_jobs_boundary_immutable",
  ]);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});
