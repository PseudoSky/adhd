-- runtime-sink-schema: composed_prompts cache + experiment_assignments + sessions.composed_prompt_id
-- Migration is additive (new tables + nullable column) — backward-compatible with existing rows.

CREATE TABLE `composed_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_slug` text NOT NULL,
	`context_hash` text NOT NULL,
	`content` text NOT NULL,
	`component_versions` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_composed_prompts_agent_ctx` ON `composed_prompts` (`agent_slug`,`context_hash`);
--> statement-breakpoint
CREATE TABLE `experiment_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`experiment_slug` text NOT NULL,
	`variant` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `composed_prompt_id` text;
