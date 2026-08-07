PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`parent_task_id` text,
	`is_ephemeral` integer DEFAULT 0 NOT NULL,
	`recursion_depth` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`prompt` text NOT NULL,
	`result` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`cancelled_at` text,
	`depends_on` text,
	`on_upstream_failure` text,
	`inputs` text,
	`resume_token` text
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "session_id", "parent_task_id", "is_ephemeral", "recursion_depth", "status", "prompt", "result", "error", "created_at", "updated_at", "completed_at", "cancelled_at", "depends_on", "on_upstream_failure", "inputs", "resume_token") SELECT "id", "session_id", "parent_task_id", 0, "recursion_depth", "status", "prompt", "result", "error", "created_at", "updated_at", "completed_at", "cancelled_at", "depends_on", "on_upstream_failure", "inputs", "resume_token" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;