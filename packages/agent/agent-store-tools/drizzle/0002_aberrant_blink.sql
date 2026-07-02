CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`transport` text NOT NULL,
	`name` text NOT NULL,
	`provided_tool_ids` text DEFAULT '[]' NOT NULL,
	`config_schema` text DEFAULT '{}' NOT NULL
);
