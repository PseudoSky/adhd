-- 79aebb26 (BK8) -- explicit model resolution on task_usage. Additive only: three nullable columns;
-- legacy rows keep NULL = "not recorded" and an unchanged model / est_cost_usd.
--   requested_model        the model the task was requested with (may be an alias such as "haiku");
--                          `model` holds the concrete id the provider resolved it to, when it reports one.
--   cli_reported_cost_usd  provider-reported cost (claudecli total_cost_usd); informational cross-check.
--   model_breakdown_json   per-resolved-model token totals + pricing status / unpriced reason.
ALTER TABLE `task_usage` ADD `requested_model` text;--> statement-breakpoint
ALTER TABLE `task_usage` ADD `cli_reported_cost_usd` real;--> statement-breakpoint
ALTER TABLE `task_usage` ADD `model_breakdown_json` text;
