CREATE TABLE `registry_prompt_components` (
	`slug` text NOT NULL,
	`type` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`content` text NOT NULL,
	`is_shared` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`type`) REFERENCES `registry_prompt_types`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `registry_prompt_components_pkey` ON `registry_prompt_components` (`slug`,`version`);--> statement-breakpoint
CREATE INDEX `registry_prompt_components_slug_idx` ON `registry_prompt_components` (`slug`);--> statement-breakpoint
CREATE INDEX `registry_prompt_components_type_idx` ON `registry_prompt_components` (`type`);--> statement-breakpoint
CREATE TABLE `registry_prompt_types` (
	`slug` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`is_system` integer DEFAULT false NOT NULL
);
