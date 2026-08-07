CREATE TABLE `provider_tool_formats` (
	`provider_id` text NOT NULL,
	`canonical_tool` text NOT NULL,
	`emit_shape` text NOT NULL,
	`type_tag` text,
	`note` text,
	PRIMARY KEY(`provider_id`, `canonical_tool`)
);
--> statement-breakpoint
CREATE INDEX `idx_provider_tool_formats_provider_id` ON `provider_tool_formats` (`provider_id`);
