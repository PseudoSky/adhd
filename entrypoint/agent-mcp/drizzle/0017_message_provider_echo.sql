-- R9-hist AC11 (spec-v2 section 1) -- persisted provider echo: the Anthropic assistant blocks a chat history needs to be
-- replayed faithfully (thinking, redacted_thinking, text, client tool_use = tier T; server_tool_use and every
-- *_tool_result = tier S, third-party bodies that expire from replay when the session has been idle past the TTL).
-- One row per assistant message, keyed by message_id: a keyed INSERT, never a read-modify-write (ADR-0001/0012).
-- ADDITIVE ONLY: a new table and its index; `messages` is not altered, so a previous-version binary keeps reading and
-- writing a migrated database (it ignores this table; its clearMessages relies on the FK cascade, which the orphan
-- sweep backstops when foreign_keys is OFF). IDEMPOTENT: both statements are IF NOT EXISTS, so a rival opener that
-- already created them (parallel-process enabled, ADR-0012) is a no-op rather than an "already exists" failure.
-- `schema_v` guards future block formats; `bytes` = length(blocks); `server_bytes` = the tier S part of `bytes`
-- (0 once expiry stripped it). `session_id` carries no FK of its own: the row's lifetime follows its message.
CREATE TABLE IF NOT EXISTS `message_provider_echo` (
	`message_id` text PRIMARY KEY NOT NULL REFERENCES `messages`(`id`) ON DELETE CASCADE,
	`session_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`schema_v` integer NOT NULL DEFAULT 1,
	`blocks` text NOT NULL,
	`bytes` integer NOT NULL,
	`server_bytes` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_message_provider_echo_session` ON `message_provider_echo` (`session_id`);
