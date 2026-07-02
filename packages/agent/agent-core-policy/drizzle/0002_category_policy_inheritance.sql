-- policy-inheritance: lazy category→policy attachment tables
-- Decision 1 (decisions.md): LAZY resolution at query time — no fanout trigger.
-- `category_slug` and `agent_slug` are logical cross-package references (plain text,
-- no SQLite FK to cross-prefix tables). [Decision 0]

CREATE TABLE `policy_category_policies` (
	`category_slug` text NOT NULL,
	`policy_slug` text NOT NULL,
	`is_mandatory` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`category_slug`, `policy_slug`),
	FOREIGN KEY (`policy_slug`) REFERENCES `policy_policy_templates`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_category_policies_category_slug` ON `policy_category_policies` (`category_slug`);
--> statement-breakpoint
CREATE TABLE `policy_agent_categories` (
	`agent_slug` text NOT NULL,
	`category_slug` text NOT NULL,
	PRIMARY KEY(`agent_slug`, `category_slug`)
);
--> statement-breakpoint
CREATE INDEX `idx_agent_categories_agent_slug` ON `policy_agent_categories` (`agent_slug`);
