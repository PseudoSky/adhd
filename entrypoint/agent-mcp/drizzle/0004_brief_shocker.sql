ALTER TABLE `tasks` ADD `depends_on` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `on_upstream_failure` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `inputs` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `resume_token` text;