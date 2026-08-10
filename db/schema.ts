import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    status: text("status").notNull().default("active"),
    headRevisionId: text("head_revision_id").references(
      (): AnySQLiteColumn => projectRevisions.id,
      { onDelete: "set null" },
    ),
    capabilityHash: text("capability_hash").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "projects_status_check",
      sql`${table.status} in ('active', 'archived')`,
    ),
    uniqueIndex("projects_capability_hash_unique").on(table.capabilityHash),
    index("projects_updated_at_idx").on(table.updatedAt),
  ],
);

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceAssetId: text("source_asset_id").references(
      (): AnySQLiteColumn => assets.id,
      { onDelete: "cascade" },
    ),
    kind: text("kind").notNull().default("source_video"),
    status: text("status").notNull().default("pending"),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sourceR2Key: text("source_r2_key").notNull(),
    sourceEtag: text("source_etag"),
    sha256: text("sha256"),
    durationMs: integer("duration_ms"),
    width: integer("width"),
    height: integer("height"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    finalizedAt: text("finalized_at"),
  },
  (table) => [
    check(
      "assets_kind_check",
      sql`${table.kind} in ('source_video', 'source_audio', 'preview_video', 'thumbnail_strip', 'waveform', 'hls_manifest')`,
    ),
    check(
      "assets_status_check",
      sql`${table.status} in ('pending', 'ready', 'failed', 'deleted')`,
    ),
    check("assets_byte_size_check", sql`${table.byteSize} > 0`),
    check(
      "assets_source_relationship_check",
      sql`(
        ${table.kind} in ('source_video', 'source_audio')
        and ${table.sourceAssetId} is null
      ) or (
        ${table.kind} in ('preview_video', 'thumbnail_strip', 'waveform', 'hls_manifest')
        and ${table.sourceAssetId} is not null
      )`,
    ),
    uniqueIndex("assets_source_r2_key_unique").on(table.sourceR2Key),
    index("assets_project_created_at_idx").on(
      table.projectId,
      table.createdAt,
    ),
    index("assets_source_asset_idx").on(table.sourceAssetId),
  ],
);

export const projectRevisions = sqliteTable(
  "project_revisions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    parentRevisionId: text("parent_revision_id").references(
      (): AnySQLiteColumn => projectRevisions.id,
      { onDelete: "restrict" },
    ),
    sourceAssetId: text("source_asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "restrict" }),
    schemaVersion: integer("schema_version").notNull(),
    documentR2Key: text("document_r2_key").notNull(),
    documentHash: text("document_hash").notNull(),
    captionStatus: text("caption_status").notNull(),
    captionLanguage: text("caption_language").notNull(),
    changeSummary: text("change_summary").notNull().default(""),
    createdBy: text("created_by").notNull().default("editor"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "project_revisions_caption_status_check",
      sql`${table.captionStatus} in ('queued', 'extracting', 'transcribing', 'aligning', 'recovering', 'ready', 'complete', 'review_required', 'failed')`,
    ),
    uniqueIndex("project_revisions_document_r2_key_unique").on(
      table.documentR2Key,
    ),
    index("project_revisions_project_created_at_idx").on(
      table.projectId,
      table.createdAt,
    ),
    index("project_revisions_parent_idx").on(table.parentRevisionId),
  ],
);

export const renderJobs = sqliteTable(
  "render_jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    revisionId: text("revision_id")
      .notNull()
      .references(() => projectRevisions.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    callbackCapabilityHash: text("callback_capability_hash").notNull(),
    exportSpecJson: text("export_spec_json").notNull(),
    rendererRevision: text("renderer_revision").notNull(),
    status: text("status").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    message: text("message").notNull().default("Queued for rendering"),
    failureCode: text("failure_code"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "render_jobs_status_check",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      "render_jobs_progress_check",
      sql`${table.progress} >= 0 and ${table.progress} <= 100`,
    ),
    uniqueIndex("render_jobs_project_idempotency_unique").on(
      table.projectId,
      table.idempotencyKey,
    ),
    index("render_jobs_project_created_at_idx").on(
      table.projectId,
      table.createdAt,
    ),
    index("render_jobs_revision_idx").on(table.revisionId),
  ],
);

export const exportArtifacts = sqliteTable(
  "export_artifacts",
  {
    id: text("id").primaryKey(),
    renderJobId: text("render_job_id")
      .notNull()
      .references(() => renderJobs.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    revisionId: text("revision_id")
      .notNull()
      .references(() => projectRevisions.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    r2Key: text("r2_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    etag: text("etag").notNull(),
    sha256: text("sha256"),
    codecManifestJson: text("codec_manifest_json"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "export_artifacts_kind_check",
      sql`${table.kind} in ('video', 'captions_ass', 'captions_srt', 'captions_vtt')`,
    ),
    check("export_artifacts_byte_size_check", sql`${table.byteSize} > 0`),
    uniqueIndex("export_artifacts_job_kind_unique").on(
      table.renderJobId,
      table.kind,
    ),
    uniqueIndex("export_artifacts_r2_key_unique").on(table.r2Key),
    index("export_artifacts_project_created_at_idx").on(
      table.projectId,
      table.createdAt,
    ),
  ],
);
