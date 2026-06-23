CREATE TABLE `provider_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`transport` text NOT NULL,
	`auth_pattern` text NOT NULL,
	`base_url` text,
	`endpoint_template` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_models` (
	`id` text PRIMARY KEY NOT NULL,
	`context_window` integer NOT NULL,
	`output_limit` integer NOT NULL,
	`vision` integer DEFAULT false NOT NULL,
	`prompt_caching` integer DEFAULT false NOT NULL,
	`extended_thinking` integer DEFAULT false NOT NULL,
	`pricing_tier` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_provider_models_pricing_tier` ON `provider_models` (`pricing_tier`);
