CREATE TABLE `policy_agent_policies` (
	`agent_slug` text NOT NULL,
	`policy_slug` text NOT NULL,
	`override_config` text,
	`is_mandatory` integer DEFAULT false NOT NULL,
	`inherited_from` text,
	PRIMARY KEY(`agent_slug`, `policy_slug`),
	FOREIGN KEY (`policy_slug`) REFERENCES `policy_policy_templates`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_policies_agent_slug` ON `policy_agent_policies` (`agent_slug`);