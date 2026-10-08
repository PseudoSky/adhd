-- 1f1c8598 / 37f6c511 (S0) — cost provenance on task_usage + append-only price history
-- + pull ledger. Additive only: the six task_usage columns are nullable (legacy rows keep
-- NULL = "provenance unknown" and an unchanged est_cost_usd); the two tables are new.
ALTER TABLE `task_usage` ADD `response_model` text;--> statement-breakpoint
ALTER TABLE `task_usage` ADD `cost_basis` text;--> statement-breakpoint
ALTER TABLE `task_usage` ADD `pricing_ref` text;--> statement-breakpoint
ALTER TABLE `task_usage` ADD `cost_status` text;--> statement-breakpoint
ALTER TABLE `task_usage` ADD `priced_cost_usd` real;--> statement-breakpoint
ALTER TABLE `task_usage` ADD `unpriced_tokens` integer;--> statement-breakpoint
CREATE TABLE `model_price_history` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`observed_at` text NOT NULL,
	`source` text NOT NULL,
	`kind` text DEFAULT 'model' NOT NULL,
	`input_per_m` real,
	`cache_read_per_m` real,
	`cache_write_per_m` real,
	`output_per_m` real,
	`raw_json` text NOT NULL,
	`overrides_json` text,
	`ledger_id` text
);--> statement-breakpoint
CREATE INDEX `idx_price_history_model_observed` ON `model_price_history` (`model_id`,`observed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_price_history_obs` ON `model_price_history` (`model_id`,`observed_at`,`source`);--> statement-breakpoint
CREATE TRIGGER `model_price_history_no_update` BEFORE UPDATE ON `model_price_history` BEGIN SELECT RAISE(ABORT, 'model_price_history is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `model_price_history_no_delete` BEFORE DELETE ON `model_price_history` BEGIN SELECT RAISE(ABORT, 'model_price_history is append-only'); END;--> statement-breakpoint
CREATE TABLE `price_pull_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`http_status` integer,
	`models_seen` integer,
	`new_count` integer,
	`changed_count` integer,
	`unchanged_count` integer,
	`anomalies_json` text,
	`error` text,
	`duration_ms` integer,
	`source_url` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_price_pull_ledger_started` ON `price_pull_ledger` (`started_at`);
