// Child process for migrate-runner-concurrency.e2e.test.ts (R9-hist AC11): a long-lived PREVIOUS-VERSION agent-mcp process.
// It knows nothing about `message_provider_echo`: it opens the database the way the host does (WAL, busy timeout,
// foreign_keys=ON), prepares its message statements ONCE (as a running server would) and then executes JSON commands
// read line by line from stdin, replying with one JSON line each:
//   {"op":"begin"}            BEGIN IMMEDIATE  (holds the database write lock)
//   {"op":"commit"}           COMMIT
//   {"op":"insert","id":..,"n":..}   old-shape INSERT INTO messages (no echo column, no echo row)
//   {"op":"delete","id":..}   DELETE FROM messages (relies on the FK cascade for anything hanging off a message)
//   {"op":"count"}            number of messages in the session
//   {"op":"quit"}             exit 0
// argv: <dbFile> <sessionId>.
import Database from 'better-sqlite3';
import { createInterface } from 'node:readline';

const [, , dbFile, sessionId] = process.argv;
const conn = new Database(dbFile);
conn.pragma('journal_mode = WAL');
conn.pragma('busy_timeout = 30000');
conn.pragma('foreign_keys = ON');
const insert = conn.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)");
const del = conn.prepare('DELETE FROM messages WHERE session_id = ? AND id = ?');
const count = conn.prepare('SELECT count(*) AS n FROM messages WHERE session_id = ?');

const reply = (o) => process.stdout.write(JSON.stringify(o) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const cmd = JSON.parse(line);
  try {
    if (cmd.op === 'begin') conn.exec('BEGIN IMMEDIATE');
    else if (cmd.op === 'commit') conn.exec('COMMIT');
    else if (cmd.op === 'insert') insert.run(cmd.id, sessionId, `content of ${cmd.id}`, `2026-10-12T00:00:${String(cmd.n).padStart(2, '0')}.000Z`);
    else if (cmd.op === 'delete') reply({ ok: true, changes: del.run(sessionId, cmd.id).changes });
    else if (cmd.op === 'count') reply({ ok: true, n: count.get(sessionId).n });
    else if (cmd.op === 'quit') { reply({ ok: true }); conn.close(); process.exit(0); }
    else throw new Error('unknown op ' + cmd.op);
    if (cmd.op !== 'delete' && cmd.op !== 'count') reply({ ok: true });
  } catch (e) {
    reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
conn.close();
