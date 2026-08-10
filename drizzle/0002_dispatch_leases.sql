ALTER TABLE `render_jobs` ADD `dispatch_lease_expires_at` text;--> statement-breakpoint
ALTER TABLE `processing_jobs` ADD `dispatch_lease_expires_at` text;
