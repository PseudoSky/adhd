CREATE TABLE `registry_agent_components` (
	`agent_slug` text NOT NULL,
	`component_slug` text NOT NULL,
	`position` integer NOT NULL,
	`version_pin` integer,
	`context_condition` text,
	`is_required` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`agent_slug`) REFERENCES `registry_agents`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `registry_agent_components_pkey` ON `registry_agent_components` (`agent_slug`,`component_slug`,`position`);--> statement-breakpoint
CREATE INDEX `registry_agent_components_agent_idx` ON `registry_agent_components` (`agent_slug`);--> statement-breakpoint
CREATE INDEX `registry_agent_components_position_idx` ON `registry_agent_components` (`agent_slug`,`position`);