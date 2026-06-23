CREATE TABLE `agent_tools` (
	`agent_slug` text NOT NULL,
	`tool_name` text NOT NULL,
	`permission` text NOT NULL,
	`context_condition` text DEFAULT 'null',
	PRIMARY KEY(`agent_slug`, `tool_name`),
	FOREIGN KEY (`tool_name`) REFERENCES `tools`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_tools_agent_slug` ON `agent_tools` (`agent_slug`);