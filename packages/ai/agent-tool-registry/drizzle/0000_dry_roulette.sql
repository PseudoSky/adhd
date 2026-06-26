CREATE TABLE `tool_types` (
	`slug` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tools` (
	`name` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`description` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`requires_approval` integer DEFAULT false NOT NULL,
	`is_destructive` integer DEFAULT false NOT NULL,
	`dependency_tool_ids` text DEFAULT '[]' NOT NULL,
	`capabilities` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`type`) REFERENCES `tool_types`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_tools_type` ON `tools` (`type`);