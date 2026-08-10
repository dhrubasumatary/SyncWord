CREATE TABLE `processing_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_asset_id` text NOT NULL,
	`revision_id` text,
	`idempotency_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`callback_capability_hash` text NOT NULL,
	`language` text NOT NULL,
	`mode` text NOT NULL,
	`processor_revision` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`message` text DEFAULT 'Queued for captioning' NOT NULL,
	`failure_code` text,
	`dispatch_attempts` integer DEFAULT 0 NOT NULL,
	`dispatched_at` text,
	`dispatch_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`completed_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`revision_id`) REFERENCES `project_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "processing_jobs_status_check" CHECK("processing_jobs"."status" in ('queued', 'extracting', 'transcribing', 'aligning', 'recovering', 'ready', 'review_required', 'failed', 'cancelled')),
	CONSTRAINT "processing_jobs_progress_check" CHECK("processing_jobs"."progress" >= 0 and "processing_jobs"."progress" <= 100),
	CONSTRAINT "processing_jobs_dispatch_attempts_check" CHECK("processing_jobs"."dispatch_attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `processing_jobs_project_idempotency_unique` ON `processing_jobs` (`project_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `processing_jobs_project_created_at_idx` ON `processing_jobs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `processing_jobs_source_asset_idx` ON `processing_jobs` (`source_asset_id`);--> statement-breakpoint
ALTER TABLE `render_jobs` ADD `dispatch_attempts` integer DEFAULT 0 NOT NULL CONSTRAINT "render_jobs_dispatch_attempts_check" CHECK (`dispatch_attempts` >= 0);--> statement-breakpoint
ALTER TABLE `render_jobs` ADD `dispatched_at` text;--> statement-breakpoint
ALTER TABLE `render_jobs` ADD `dispatch_error` text;--> statement-breakpoint
CREATE TRIGGER `processing_jobs_boundary_immutable`
BEFORE UPDATE OF `project_id`, `source_asset_id`, `idempotency_key`, `request_fingerprint`, `callback_capability_hash`, `language`, `mode`, `processor_revision`
ON `processing_jobs`
BEGIN
	SELECT RAISE(ABORT, 'processing job boundary is immutable');
END;
