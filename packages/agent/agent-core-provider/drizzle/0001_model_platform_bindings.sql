CREATE TABLE `provider_model_platform_bindings` (
	`model_id` text NOT NULL,
	`platform` text NOT NULL,
	`platform_model_id` text NOT NULL,
	PRIMARY KEY(`model_id`, `platform`)
);
--> statement-breakpoint
CREATE INDEX `idx_provider_mpb_model_id` ON `provider_model_platform_bindings` (`model_id`);
