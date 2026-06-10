CREATE TABLE `task_usage` (
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
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_task_usage_root_task_id` ON `task_usage` (`root_task_id`);