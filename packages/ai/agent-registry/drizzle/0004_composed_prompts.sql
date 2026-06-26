CREATE TABLE `registry_composed_prompts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_slug` text NOT NULL,
	`context_hash` text NOT NULL,
	`content` text NOT NULL,
	`component_versions` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `registry_composed_prompts_agent_hash_idx` ON `registry_composed_prompts` (`agent_slug`,`context_hash`);
