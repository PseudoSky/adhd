-- Decision 5 (docs/plan/agent-registry-schema/decisions.md): split component
-- IDENTITY (registry_components, slug PK) from HISTORY
-- (registry_component_versions, version_id PK) so downstream tables can FK onto a
-- single-column PK. registry_prompt_components is DROPPED; component data is
-- re-established by the seed (registry is pre-release 0.0.1, no production rows to
-- preserve). registry_agent_components / registry_component_usage /
-- registry_context_rules are recreated with their component references now ENFORCED.
CREATE TABLE `registry_component_versions` (
	`version_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`slug`) REFERENCES `registry_components`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_component_versions_slug_version_uq` ON `registry_component_versions` (`slug`,`version`);--> statement-breakpoint
CREATE INDEX `registry_component_versions_slug_idx` ON `registry_component_versions` (`slug`);--> statement-breakpoint
CREATE TABLE `registry_components` (
	`slug` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`is_shared` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`type`) REFERENCES `registry_prompt_types`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `registry_components_type_idx` ON `registry_components` (`type`);--> statement-breakpoint
DROP TABLE `registry_prompt_components`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_registry_agent_components` (
	`agent_slug` text NOT NULL,
	`component_slug` text NOT NULL,
	`position` integer NOT NULL,
	`version_pin` integer,
	`context_condition` text,
	`is_required` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`agent_slug`, `component_slug`, `position`),
	FOREIGN KEY (`agent_slug`) REFERENCES `registry_agents`(`slug`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`component_slug`) REFERENCES `registry_components`(`slug`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_pin`) REFERENCES `registry_component_versions`(`version_id`) ON UPDATE no action ON DELETE no action
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
	FOREIGN KEY (`component_slug`) REFERENCES `registry_components`(`slug`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`use_case_slug`) REFERENCES `registry_use_cases`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_registry_component_usage`("component_slug", "use_case_slug", "weight") SELECT "component_slug", "use_case_slug", "weight" FROM `registry_component_usage`;--> statement-breakpoint
DROP TABLE `registry_component_usage`;--> statement-breakpoint
ALTER TABLE `__new_registry_component_usage` RENAME TO `registry_component_usage`;--> statement-breakpoint
CREATE INDEX `registry_component_usage_use_case_idx` ON `registry_component_usage` (`use_case_slug`);--> statement-breakpoint
CREATE INDEX `registry_component_usage_component_idx` ON `registry_component_usage` (`component_slug`);--> statement-breakpoint
CREATE TABLE `__new_registry_context_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_slug` text NOT NULL,
	`condition` text NOT NULL,
	`component_slug` text NOT NULL,
	`position` integer,
	FOREIGN KEY (`agent_slug`) REFERENCES `registry_agents`(`slug`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`component_slug`) REFERENCES `registry_components`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_registry_context_rules`("id", "agent_slug", "condition", "component_slug", "position") SELECT "id", "agent_slug", "condition", "component_slug", "position" FROM `registry_context_rules`;--> statement-breakpoint
DROP TABLE `registry_context_rules`;--> statement-breakpoint
ALTER TABLE `__new_registry_context_rules` RENAME TO `registry_context_rules`;--> statement-breakpoint
CREATE INDEX `registry_context_rules_agent_idx` ON `registry_context_rules` (`agent_slug`);--> statement-breakpoint
CREATE INDEX `registry_context_rules_component_idx` ON `registry_context_rules` (`component_slug`);