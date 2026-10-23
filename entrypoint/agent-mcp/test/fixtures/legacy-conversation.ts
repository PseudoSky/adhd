/**
 * Raw-SQL conversation rows in the shape a PREVIOUS-VERSION binary writes (no knowledge of `message_provider_echo`),
 * for the R9-hist AC11 migration tests. Works against any schema from migration 0000 on: only the columns every
 * version has are named.
 */
import type Database from "better-sqlite3";

export const AGENT = "a1";
export const SESSION = "s1";

/** One agent and one session, the FK parents every message needs (messages -> sessions -> agents, all ON DELETE CASCADE). */
export function seedAgentAndSession(conn: Database.Database, session: string = SESSION): void {
  conn.prepare("INSERT OR IGNORE INTO agents (name, version, data, created_at, updated_at) VALUES (?, 1, '{}', ?, ?)").run(AGENT, "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z");
  conn
    .prepare("INSERT OR IGNORE INTO sessions (id, agent_name, agent_version, agent_data, status, created_at, updated_at) VALUES (?, ?, 1, '{}', 'active', ?, ?)")
    .run(session, AGENT, "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z");
}

/** Insert one assistant message the way the previous version does. `n` orders created_at deterministically. */
export function insertOldShapeMessage(conn: Database.Database, id: string, n: number, session: string = SESSION): void {
  conn
    .prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)")
    .run(id, session, `content of ${id}`, `2026-10-12T00:00:${String(n).padStart(2, "0")}.000Z`);
}

/** Insert an echo row the way the new version does (the S4a keyed INSERT, here as raw SQL). */
export function insertEchoRow(conn: Database.Database, messageId: string, opts: { session?: string; schemaV?: number; serverBytes?: number } = {}): void {
  const blocks = JSON.stringify([{ type: "thinking", thinking: "t", signature: "s" }]);
  conn
    .prepare(
      "INSERT INTO message_provider_echo (message_id, session_id, provider, model, schema_v, blocks, bytes, server_bytes, created_at) VALUES (?, ?, 'anthropic', 'claude-haiku-5-5', ?, ?, ?, ?, ?)",
    )
    .run(messageId, opts.session ?? SESSION, opts.schemaV ?? 1, blocks, blocks.length, opts.serverBytes ?? 0, "2026-10-12T00:00:00.000Z");
}

export const messageIds = (conn: Database.Database): string[] =>
  (conn.prepare("SELECT id FROM messages ORDER BY created_at, id").all() as Array<{ id: string }>).map((r) => r.id);

export const echoIds = (conn: Database.Database): string[] =>
  (conn.prepare("SELECT message_id FROM message_provider_echo ORDER BY message_id").all() as Array<{ message_id: string }>).map((r) => r.message_id);
