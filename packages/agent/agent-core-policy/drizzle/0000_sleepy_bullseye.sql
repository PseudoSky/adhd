CREATE TABLE `policy_policy_templates` (
	`slug` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`description` text NOT NULL,
	`rules` text NOT NULL,
	`enforcement` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`type`) REFERENCES `policy_policy_types`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_policy_templates_type` ON `policy_policy_templates` (`type`);--> statement-breakpoint
CREATE TABLE `policy_policy_types` (
	`slug` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL
);
