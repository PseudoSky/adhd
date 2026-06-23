PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_registry_agent_components` (
	`agent_slug` text NOT NULL,
	`component_slug` text NOT NULL,
	`position` integer NOT NULL,
	`version_pin` integer,
	`context_condition` text,
	`is_required` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`agent_slug`, `component_slug`, `position`),
	FOREIGN KEY (`agent_slug`) REFERENCES `registry_agents`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_registry_agent_components`("agent_slug", "component_slug", "position", "version_pin", "context_condition", "is_required") SELECT "agent_slug", "component_slug", "position", "version_pin", "context_condition", "is_required" FROM `registry_agent_components`;--> statement-breakpoint
DROP TABLE `registry_agent_components`;--> statement-breakpoint
ALTER TABLE `__new_registry_agent_components` RENAME TO `registry_agent_components`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `registry_agent_components_agent_idx` ON `registry_agent_components` (`agent_slug`);--> statement-breakpoint
CREATE INDEX `registry_agent_components_position_idx` ON `registry_agent_components` (`agent_slug`,`position`);--> statement-breakpoint
CREATE TABLE `__new_registry_component_usage` (
	`component_slug` text NOT NULL,
	`use_case_slug` text NOT NULL,
	`weight` integer,
	PRIMARY KEY(`component_slug`, `use_case_slug`),
	FOREIGN KEY (`use_case_slug`) REFERENCES `registry_use_cases`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_registry_component_usage`("component_slug", "use_case_slug", "weight") SELECT "component_slug", "use_case_slug", "weight" FROM `registry_component_usage`;--> statement-breakpoint
DROP TABLE `registry_component_usage`;--> statement-breakpoint
ALTER TABLE `__new_registry_component_usage` RENAME TO `registry_component_usage`;--> statement-breakpoint
CREATE INDEX `registry_component_usage_use_case_idx` ON `registry_component_usage` (`use_case_slug`);--> statement-breakpoint
CREATE INDEX `registry_component_usage_component_idx` ON `registry_component_usage` (`component_slug`);--> statement-breakpoint
CREATE TABLE `__new_registry_prompt_components` (
	`slug` text NOT NULL,
	`type` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`content` text NOT NULL,
	`is_shared` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`slug`, `version`),
	FOREIGN KEY (`type`) REFERENCES `registry_prompt_types`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_registry_prompt_components`("slug", "type", "version", "content", "is_shared", "created_at", "updated_at") SELECT "slug", "type", "version", "content", "is_shared", "created_at", "updated_at" FROM `registry_prompt_components`;--> statement-breakpoint
DROP TABLE `registry_prompt_components`;--> statement-breakpoint
ALTER TABLE `__new_registry_prompt_components` RENAME TO `registry_prompt_components`;--> statement-breakpoint
CREATE INDEX `registry_prompt_components_slug_idx` ON `registry_prompt_components` (`slug`);--> statement-breakpoint
CREATE INDEX `registry_prompt_components_type_idx` ON `registry_prompt_components` (`type`);