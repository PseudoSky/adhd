PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_name` text NOT NULL,
	`agent_version` integer NOT NULL,
	`agent_data` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`closed_at` text,
	`composed_prompt_id` text
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "agent_name", "agent_version", "agent_data", "status", "created_at", "updated_at", "closed_at", "composed_prompt_id") SELECT "id", "agent_name", "agent_version", "agent_data", "status", "created_at", "updated_at", "closed_at", "composed_prompt_id" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_task_usage` (
	`task_id` text PRIMARY KEY NOT NULL,
	`root_task_id` text,
	`agent_name` text NOT NULL,
	`provider_type` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`tool_call_count` integer DEFAULT 0 NOT NULL,
	`model_calls` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`is_complete` integer DEFAULT 0 NOT NULL,
	`stop_reason` text,
	`max_tokens` integer,
	`cache_read_input_tokens` integer,
	`cache_creation_input_tokens` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_task_usage`("task_id", "root_task_id", "agent_name", "provider_type", "model", "input_tokens", "output_tokens", "tool_call_count", "model_calls", "latency_ms", "is_complete", "stop_reason", "max_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "created_at") SELECT "task_id", "root_task_id", "agent_name", "provider_type", "model", "input_tokens", "output_tokens", "tool_call_count", "model_calls", "latency_ms", "is_complete", "stop_reason", "max_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "created_at" FROM `task_usage`;--> statement-breakpoint
DROP TABLE `task_usage`;--> statement-breakpoint
ALTER TABLE `__new_task_usage` RENAME TO `task_usage`;--> statement-breakpoint
CREATE INDEX `idx_task_usage_root_task_id` ON `task_usage` (`root_task_id`);