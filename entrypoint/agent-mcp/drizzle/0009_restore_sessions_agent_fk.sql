-- BUG-ORCH-012 — restore the sessions.agent_name -> agents.name ON DELETE CASCADE FK.
--
-- Migration 0000 created `sessions` WITH this FK. The engine refactor moved `agentsTable`
-- (entrypoint/agent-mcp) and `sessionsTable` (agent-store-runtime) into different packages,
-- so drizzle-kit could no longer see the relationship and migration 0007 silently rebuilt
-- the table WITHOUT the FK. `AgentStore.delete()` relies entirely on this cascade, so with
-- it gone `agent_delete` orphans closed sessions + their messages forever, and reusing a
-- deleted agent's name resurfaces old orphaned sessions under the new agent.
--
-- This rebuilds `sessions` with the FK restored, matching the 0000 definition. The
-- migration runner disables foreign_keys for the duration of the rebuild (see
-- migrate-runner.ts), so copying existing rows will not trip the constraint mid-flight.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_name` text NOT NULL,
	`agent_version` integer NOT NULL,
	`agent_data` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`closed_at` text,
	`composed_prompt_id` text,
	FOREIGN KEY (`agent_name`) REFERENCES `agents`(`name`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "agent_name", "agent_version", "agent_data", "status", "created_at", "updated_at", "closed_at", "composed_prompt_id") SELECT "id", "agent_name", "agent_version", "agent_data", "status", "created_at", "updated_at", "closed_at", "composed_prompt_id" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
