CREATE TABLE `platforms` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`header_format` text NOT NULL,
	`supports_tool_selection` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tool_platform_bindings` (
	`tool_name` text NOT NULL,
	`platform_id` text NOT NULL,
	`platform_tool_name` text NOT NULL,
	`availability` text NOT NULL,
	`requires_mcp` integer DEFAULT false NOT NULL,
	`invocation_note` text,
	PRIMARY KEY(`tool_name`, `platform_id`),
	FOREIGN KEY (`tool_name`) REFERENCES `tools`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_bindings_platform` ON `tool_platform_bindings` (`platform_id`);