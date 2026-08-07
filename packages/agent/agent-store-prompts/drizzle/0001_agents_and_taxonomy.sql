CREATE TABLE `registry_agents` (
	`slug` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`model_hint` text,
	`taxonomy_category` text,
	`default_posture` text DEFAULT 'needs_work' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`taxonomy_category`) REFERENCES `registry_taxonomy_categories`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `registry_agents_status_idx` ON `registry_agents` (`status`);--> statement-breakpoint
CREATE INDEX `registry_agents_category_idx` ON `registry_agents` (`taxonomy_category`);--> statement-breakpoint
CREATE TABLE `registry_taxonomy_categories` (
	`slug` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`parent_slug` text,
	FOREIGN KEY (`parent_slug`) REFERENCES `registry_taxonomy_categories`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `registry_taxonomy_categories_position_idx` ON `registry_taxonomy_categories` (`position`);--> statement-breakpoint
CREATE INDEX `registry_taxonomy_categories_parent_idx` ON `registry_taxonomy_categories` (`parent_slug`);