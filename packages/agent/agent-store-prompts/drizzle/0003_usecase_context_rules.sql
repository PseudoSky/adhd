CREATE TABLE `registry_use_cases` (
	`slug` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `registry_component_usage` (
	`component_slug` text NOT NULL,
	`use_case_slug` text NOT NULL,
	`weight` integer,
	FOREIGN KEY (`use_case_slug`) REFERENCES `registry_use_cases`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `registry_component_usage_pkey` ON `registry_component_usage` (`component_slug`,`use_case_slug`);
--> statement-breakpoint
CREATE INDEX `registry_component_usage_use_case_idx` ON `registry_component_usage` (`use_case_slug`);
--> statement-breakpoint
CREATE INDEX `registry_component_usage_component_idx` ON `registry_component_usage` (`component_slug`);
--> statement-breakpoint
CREATE TABLE `registry_context_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_slug` text NOT NULL,
	`condition` text NOT NULL,
	`component_slug` text NOT NULL,
	`position` integer,
	FOREIGN KEY (`agent_slug`) REFERENCES `registry_agents`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `registry_context_rules_agent_idx` ON `registry_context_rules` (`agent_slug`);
--> statement-breakpoint
CREATE INDEX `registry_context_rules_component_idx` ON `registry_context_rules` (`component_slug`);
