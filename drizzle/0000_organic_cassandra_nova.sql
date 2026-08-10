CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_asset_id` text,
	`kind` text DEFAULT 'source_video' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`original_name` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`source_r2_key` text NOT NULL,
	`source_etag` text,
	`sha256` text,
	`duration_ms` integer,
	`width` integer,
	`height` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`finalized_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assets_kind_check" CHECK("assets"."kind" in ('source_video', 'source_audio', 'preview_video', 'thumbnail_strip', 'waveform', 'hls_manifest')),
	CONSTRAINT "assets_status_check" CHECK("assets"."status" in ('pending', 'ready', 'failed', 'deleted')),
	CONSTRAINT "assets_byte_size_check" CHECK("assets"."byte_size" > 0),
	CONSTRAINT "assets_source_relationship_check" CHECK((
        "assets"."kind" in ('source_video', 'source_audio')
        and "assets"."source_asset_id" is null
      ) or (
        "assets"."kind" in ('preview_video', 'thumbnail_strip', 'waveform', 'hls_manifest')
        and "assets"."source_asset_id" is not null
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_source_r2_key_unique` ON `assets` (`source_r2_key`);--> statement-breakpoint
CREATE INDEX `assets_project_created_at_idx` ON `assets` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `assets_source_asset_idx` ON `assets` (`source_asset_id`);--> statement-breakpoint
CREATE TABLE `export_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`render_job_id` text NOT NULL,
	`project_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`kind` text NOT NULL,
	`r2_key` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`etag` text NOT NULL,
	`sha256` text,
	`codec_manifest_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`render_job_id`) REFERENCES `render_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revision_id`) REFERENCES `project_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "export_artifacts_kind_check" CHECK("export_artifacts"."kind" in ('video', 'captions_ass', 'captions_srt', 'captions_vtt')),
	CONSTRAINT "export_artifacts_byte_size_check" CHECK("export_artifacts"."byte_size" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `export_artifacts_job_kind_unique` ON `export_artifacts` (`render_job_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `export_artifacts_r2_key_unique` ON `export_artifacts` (`r2_key`);--> statement-breakpoint
CREATE INDEX `export_artifacts_project_created_at_idx` ON `export_artifacts` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `project_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`parent_revision_id` text,
	`source_asset_id` text NOT NULL,
	`schema_version` integer NOT NULL,
	`document_r2_key` text NOT NULL,
	`document_hash` text NOT NULL,
	`caption_status` text NOT NULL,
	`caption_language` text NOT NULL,
	`change_summary` text DEFAULT '' NOT NULL,
	`created_by` text DEFAULT 'editor' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_revision_id`) REFERENCES `project_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "project_revisions_caption_status_check" CHECK("project_revisions"."caption_status" in ('queued', 'extracting', 'transcribing', 'aligning', 'recovering', 'ready', 'complete', 'review_required', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_revisions_document_r2_key_unique` ON `project_revisions` (`document_r2_key`);--> statement-breakpoint
CREATE INDEX `project_revisions_project_created_at_idx` ON `project_revisions` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `project_revisions_parent_idx` ON `project_revisions` (`parent_revision_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`head_revision_id` text,
	`capability_hash` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`head_revision_id`) REFERENCES `project_revisions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "projects_status_check" CHECK("projects"."status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_capability_hash_unique` ON `projects` (`capability_hash`);--> statement-breakpoint
CREATE INDEX `projects_updated_at_idx` ON `projects` (`updated_at`);--> statement-breakpoint
CREATE TABLE `render_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`callback_capability_hash` text NOT NULL,
	`export_spec_json` text NOT NULL,
	`renderer_revision` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`message` text DEFAULT 'Queued for rendering' NOT NULL,
	`failure_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`completed_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revision_id`) REFERENCES `project_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "render_jobs_status_check" CHECK("render_jobs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "render_jobs_progress_check" CHECK("render_jobs"."progress" >= 0 and "render_jobs"."progress" <= 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `render_jobs_project_idempotency_unique` ON `render_jobs` (`project_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `render_jobs_project_created_at_idx` ON `render_jobs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `render_jobs_revision_idx` ON `render_jobs` (`revision_id`);
--> statement-breakpoint
CREATE TRIGGER `project_revisions_immutable`
BEFORE UPDATE ON `project_revisions`
BEGIN
	SELECT RAISE(ABORT, 'project revisions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `projects_head_revision_project_guard`
BEFORE UPDATE OF `head_revision_id` ON `projects`
WHEN NEW.`head_revision_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1
		FROM `project_revisions`
		WHERE `id` = NEW.`head_revision_id`
			AND `project_id` = NEW.`id`
	)
BEGIN
	SELECT RAISE(ABORT, 'project head revision must belong to the project');
END;
--> statement-breakpoint
CREATE TRIGGER `render_jobs_boundary_immutable`
BEFORE UPDATE OF `project_id`, `revision_id`, `idempotency_key`, `request_fingerprint`, `callback_capability_hash`, `export_spec_json`, `renderer_revision`
ON `render_jobs`
BEGIN
	SELECT RAISE(ABORT, 'render job boundary is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `export_artifacts_immutable`
BEFORE UPDATE ON `export_artifacts`
BEGIN
	SELECT RAISE(ABORT, 'export artifacts are immutable');
END;
