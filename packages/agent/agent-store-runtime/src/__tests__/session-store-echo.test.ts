/**
 * guards: the persisted provider echo stops surviving a reopen of the on-disk file, session-idle TTL expiry or sweeping
 *   serves or strips the wrong rows, a failure of the echo path throws instead of degrading once, or the echo DDL
 *   drifts from migration 0017 and the drizzle table definition.
 * tier: S (real on-disk better-sqlite3 files in a temporary directory, injected clock; no provider, no subprocess)
 * cites: R9-hist S4a AC10, R9-hist AC11, R9-hist AC14, R9-hist S0
 */
/**
 * R9-hist S4a -- persisted provider echo in the runtime store (spec-v2 section 1, AC10 / AC11 / AC14).
 *
 * Real on-disk better-sqlite3 files (no mocks of the store), every persistence claim proven by REOPENING the
 * file on a new connection, expiry driven by an injected clock (`NOW0 + minutes`, no sleeps, no wall clock),
 * and no provider call anywhere. The echo DDL below is copied verbatim from agent-mcp migration 0017; the
 * parity suite at the bottom proves it equals both that migration (applied through the real migration folder)
 * and the drizzle table definition.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { IProviderEcho, TaskEventType } from '@adhd/agent-base-types';

import { messageProviderEchoTable, taskEventsTable } from '../db/schema.js';
import { logger } from '../logger.js';
import {
  ECHO_SCHEMA_VERSION,
  SessionStore,
  isEchoSessionExpired,
  resetEchoFailureWarningForTests,
  stripEchoServerBlocks,
} from '../store/session-store.js';
import { TaskStore } from '../store/task-store.js';
import type { AgentDefinition, Message } from '../validation/schemas.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');
const REAL_MIGRATIONS = join(REPO_ROOT, 'entrypoint/agent-mcp/drizzle');
const SCRATCH_ROOT = join(REPO_ROOT, 'tmp/agent-store-runtime');

// ── The fake clock: every timestamp in these tests is NOW0 + n minutes, ISO like nowIso() ─────────────────────
const NOW0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const MIN = 60_000;
const TTL = 10 * MIN;
const at = (ms: number): string => new Date(NOW0 + ms).toISOString();

const BASE_DDL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL, agent_name TEXT NOT NULL, agent_version INTEGER NOT NULL,
  agent_data TEXT NOT NULL, status TEXT DEFAULT 'active' NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, composed_prompt_id TEXT,
  provider_type TEXT, model_ref TEXT, models TEXT
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT, tool_calls TEXT, tool_results TEXT, created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL, session_id TEXT, parent_task_id TEXT, is_ephemeral INTEGER DEFAULT 0 NOT NULL,
  recursion_depth INTEGER DEFAULT 0 NOT NULL, status TEXT DEFAULT 'pending' NOT NULL, prompt TEXT NOT NULL,
  result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
  cancelled_at TEXT, depends_on TEXT, on_upstream_failure TEXT, inputs TEXT, resume_token TEXT, cwd TEXT
);
CREATE TABLE task_events (
  id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL
);`;

/** Copied verbatim from entrypoint/agent-mcp/drizzle/0017_message_provider_echo.sql (comments dropped). */
const ECHO_DDL = `
CREATE TABLE IF NOT EXISTS \`message_provider_echo\` (
	\`message_id\` text PRIMARY KEY NOT NULL REFERENCES \`messages\`(\`id\`) ON DELETE CASCADE,
	\`session_id\` text NOT NULL,
	\`provider\` text NOT NULL,
	\`model\` text NOT NULL,
	\`schema_v\` integer NOT NULL DEFAULT 1,
	\`blocks\` text NOT NULL,
	\`bytes\` integer NOT NULL,
	\`server_bytes\` integer NOT NULL DEFAULT 0,
	\`created_at\` text NOT NULL
);
CREATE INDEX IF NOT EXISTS \`idx_message_provider_echo_session\` ON \`message_provider_echo\` (\`session_id\`);`;

const agentDefinition = (): AgentDefinition =>
  ({
    name: 'a',
    version: 1,
    provider: { type: 'openai', model: 'gpt-4o-mini' },
    systemPrompt: 'p',
    mcpServers: {},
    permissions: {},
    createdAt: at(0),
    updatedAt: at(0),
  }) as AgentDefinition;

// ── Echo fixtures ──────────────────────────────────────────────────────────────────────────────────────────────
const THINKING = { type: 'thinking', thinking: 'weigh the page', signature: 'SIG-1' };
const TEXT = { type: 'text', text: 'fetching' };
const CLIENT_TOOL = { type: 'tool_use', id: 'toolu_1', name: 'shell__run', input: { cmd: 'ls' } };
const SERVER_USE = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_fetch', input: { url: 'https://example.test' } };
const SERVER_RESULT = {
  type: 'web_fetch_tool_result',
  tool_use_id: 'srvtoolu_1',
  content: { type: 'web_fetch_result', url: 'https://example.test', text: 'THIRD-PARTY-PAGE-BODY' },
};
const TIER_T = [THINKING, TEXT, CLIENT_TOOL];
const echoOf = (blocks: Array<Record<string, unknown>>): IProviderEcho => ({
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  blocks,
});
const MIXED = echoOf([THINKING, SERVER_USE, SERVER_RESULT, TEXT, CLIENT_TOOL]);
const sizeOf = (blocks: ReadonlyArray<unknown>): number => Buffer.byteLength(JSON.stringify(blocks));
const SERVER_ONLY_BYTES = sizeOf([SERVER_USE, SERVER_RESULT]);
const MIXED_BYTES = sizeOf(MIXED.blocks);
// Only the tier S blocks' own bytes count toward `server_bytes` (the JSON array commas are not attributed).
const MIXED_SERVER_BYTES = sizeOf([SERVER_USE]) - 2 + sizeOf([SERVER_RESULT]) - 2;

interface IFixture {
  file: string;
  conn: Database.Database;
  store: SessionStore;
}

describe('R9-hist S4a: persisted provider echo (SessionStore)', () => {
  let scratch: string;
  const open: Database.Database[] = [];

  /** Open (or REopen) the on-disk database on a brand-new connection. */
  function openFixture(file: string, opts: { foreignKeys?: boolean } = {}): IFixture {
    const conn = new Database(file);
    open.push(conn);
    conn.pragma(`foreign_keys = ${opts.foreignKeys === false ? 'OFF' : 'ON'}`);
    return { file, conn, store: new SessionStore(drizzle(conn)) };
  }

  function createFixture(opts: { foreignKeys?: boolean; echoTable?: boolean } = {}): IFixture {
    const file = join(scratch, `store-${open.length}.db`);
    const fx = openFixture(file, opts);
    fx.conn.exec(BASE_DDL);
    if (opts.echoTable !== false) fx.conn.exec(ECHO_DDL);
    return fx;
  }

  /** A session with one assistant message at `atMs` carrying `echo` (persisted with its true byte sizes). */
  function seedAssistant(
    fx: IFixture,
    sessionId: string,
    messageId: string,
    atMs: number,
    echo: IProviderEcho | null
  ): void {
    const msg: Message = { id: messageId, sessionId, role: 'assistant', content: 'reply', createdAt: at(atMs) };
    fx.store.appendMessage(sessionId, msg);
    if (echo !== null) {
      const serverBlocks = echo.blocks.filter(
        (b) => b['type'] === 'server_tool_use' || String(b['type']).endsWith('_tool_result')
      );
      const serverBytes = serverBlocks.reduce((sum, b) => sum + sizeOf([b]) - 2, 0);
      fx.store.appendMessageEcho(messageId, sessionId, echo, sizeOf(echo.blocks), serverBytes);
    }
  }

  const newSession = (fx: IFixture): string =>
    fx.store.create({ agentName: 'a', agentDefinition: agentDefinition() }).id;

  const rowOf = (conn: Database.Database, messageId: string) =>
    conn.prepare('SELECT * FROM message_provider_echo WHERE message_id = ?').get(messageId) as
      | { blocks: string; bytes: number; server_bytes: number; session_id: string; schema_v: number }
      | undefined;
  const countRows = (conn: Database.Database): number =>
    (conn.prepare('SELECT count(*) AS n FROM message_provider_echo').get() as { n: number }).n;

  /** What task.ts will compute: idle = now - latest created_at of the messages loaded BEFORE the new prompt. */
  const idleAt = (store: SessionStore, sessionId: string, nowMs: number): number =>
    nowMs - Math.max(...store.getMessages(sessionId).map((m) => Date.parse(m.createdAt)));

  beforeEach(() => {
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    scratch = mkdtempSync(join(SCRATCH_ROOT, 'echo-'));
    resetEchoFailureWarningForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const c of open.splice(0)) if (c.open) c.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('R9-hist AC10: persistence and reopen', () => {
    it('R9-hist AC10: an appended echo survives a reopen of the file (new connection) with blocks verbatim', () => {
      const a = createFixture();
      const sid = newSession(a);
      seedAssistant(a, sid, 'm1', 0, MIXED);
      a.conn.close();

      const b = openFixture(a.file);
      const got = b.store.getMessageEchoes(sid, ['m1'], 1 * MIN, TTL);
      expect([...got.keys()]).toEqual(['m1']);
      expect(got.get('m1')).toEqual(MIXED);
      expect(b.store.getEchoSessionServerBytes(sid)).toBe(MIXED_SERVER_BYTES);
      expect(rowOf(b.conn, 'm1')).toMatchObject({ bytes: MIXED_BYTES, server_bytes: MIXED_SERVER_BYTES, schema_v: 1 });
    });

    it('R9-hist AC10: a second append for the same message id is a no-op (keyed INSERT, first writer wins)', () => {
      const fx = createFixture();
      const sid = newSession(fx);
      seedAssistant(fx, sid, 'm1', 0, MIXED);
      const other = echoOf([{ type: 'text', text: 'DIFFERENT' }]);
      fx.store.appendMessageEcho('m1', sid, other, sizeOf(other.blocks), 0);
      expect(countRows(fx.conn)).toBe(1);
      expect(fx.store.getMessageEchoes(sid, ['m1'], 0, TTL).get('m1')).toEqual(MIXED);
    });

    it('R9-hist AC10: append rejects impossible sizes before touching storage', () => {
      const fx = createFixture();
      const sid = newSession(fx);
      fx.store.appendMessage(sid, { id: 'm1', sessionId: sid, role: 'assistant', content: 'x', createdAt: at(0) });
      for (const [bytes, server] of [[-1, 0], [10, 11], [1.5, 0], [10, -1]] as const) {
        expect(() => fx.store.appendMessageEcho('m1', sid, MIXED, bytes, server)).toThrowError(/Invalid echo sizes/);
      }
      expect(countRows(fx.conn)).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('R9-hist AC10: session-idle TTL expiry at read (injected clock, no sweeper needed)', () => {
    it('R9-hist AC10: idle within the TTL replays tier T and tier S; idle past the TTL replays tier T only', () => {
      const fx = createFixture();
      const sid = newSession(fx);
      seedAssistant(fx, sid, 'm1', 0, MIXED);

      const warm = fx.store.getMessageEchoes(sid, ['m1'], idleAt(fx.store, sid, NOW0 + 9 * MIN), TTL);
      expect(warm.get('m1')?.blocks).toEqual([THINKING, SERVER_USE, SERVER_RESULT, TEXT, CLIENT_TOOL]);

      const before = fx.conn.prepare('SELECT * FROM message_provider_echo').all();
      const cold = fx.store.getMessageEchoes(sid, ['m1'], idleAt(fx.store, sid, NOW0 + 11 * MIN), TTL);
      expect(cold.get('m1')?.blocks).toEqual(TIER_T);
      // The read path performs no writes: the stored row still holds tier S (expiry did not depend on a sweeper).
      expect(fx.conn.prepare('SELECT * FROM message_provider_echo').all()).toEqual(before);
    });

    it('R9-hist AC10: the boundary is strict -- idle == TTL keeps tier S, TTL + 1 ms strips it', () => {
      const fx = createFixture();
      const sid = newSession(fx);
      seedAssistant(fx, sid, 'm1', 0, MIXED);
      expect(fx.store.getMessageEchoes(sid, ['m1'], TTL, TTL).get('m1')?.blocks).toHaveLength(5);
      expect(fx.store.getMessageEchoes(sid, ['m1'], TTL + 1, TTL).get('m1')?.blocks).toHaveLength(3);
      expect(isEchoSessionExpired(TTL, TTL)).toBe(false);
      expect(isEchoSessionExpired(TTL + 1, TTL)).toBe(true);
    });

    it('R9-hist AC10: expiry is all-or-nothing per session -- every echo of an expired session is stripped together', () => {
      const fx = createFixture();
      const sid = newSession(fx);
      seedAssistant(fx, sid, 'old', 0, MIXED);
      seedAssistant(fx, sid, 'new', 8 * MIN, MIXED);
      // Per-row age would keep 'new' (age 3 min) and strip 'old' (age 11 min); session idle (3 min) keeps both.
      const now = NOW0 + 11 * MIN;
      const idle = idleAt(fx.store, sid, now);
      expect(idle).toBe(3 * MIN);
      const warm = fx.store.getMessageEchoes(sid, ['old', 'new'], idle, TTL);
      expect(warm.get('old')?.blocks).toHaveLength(5);
      expect(warm.get('new')?.blocks).toHaveLength(5);
      const cold = fx.store.getMessageEchoes(sid, ['old', 'new'], 20 * MIN, TTL);
      expect(cold.get('old')?.blocks).toEqual(TIER_T);
      expect(cold.get('new')?.blocks).toEqual(TIER_T);
    });

    it('R9-hist AC10: TTL 0 never serves tier S, and a non-finite idle fails safe (stripped)', () => {
      const fx = createFixture();
      const sid = newSession(fx);
      seedAssistant(fx, sid, 'm1', 0, MIXED);
      expect(fx.store.getMessageEchoes(sid, ['m1'], 0, 0).get('m1')?.blocks).toEqual(TIER_T);
      expect(fx.store.getMessageEchoes(sid, ['m1'], Number.NaN, TTL).get('m1')?.blocks).toEqual(TIER_T);
      expect(isEchoSessionExpired(0, 0)).toBe(true);
      expect(isEchoSessionExpired(Number.NaN, TTL)).toBe(true);
    });

    it('R9-hist AC10: a row that is only tier S yields no echo once expired (that message replays as legacy)', () => {
      const fx = createFixture();
      const sid = newSession(fx);
      seedAssistant(fx, sid, 'm1', 0, echoOf([SERVER_USE, SERVER_RESULT]));
      expect(fx.store.getMessageEchoes(sid, ['m1'], 1 * MIN, TTL).get('m1')?.blocks).toHaveLength(2);
      expect(fx.store.getMessageEchoes(sid, ['m1'], 11 * MIN, TTL).size).toBe(0);
    });

    it('R9-hist AC10: stripEchoServerBlocks removes both halves of every server pair and nothing else', () => {
      const SECOND_USE = { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'q' } };
      const SECOND_RES = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', content: [] };
      const input = [THINKING, SERVER_USE, SERVER_RESULT, { type: 'redacted_thinking', data: 'x' }, SECOND_USE, SECOND_RES, CLIENT_TOOL];
      expect(stripEchoServerBlocks(input)).toEqual([THINKING, { type: 'redacted_thinking', data: 'x' }, CLIENT_TOOL]);
      expect(input).toHaveLength(7);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('R9-hist AC10: loads only the requested ids, never the whole session', () => {
    it('R9-hist AC10: 5000 persisted echoes, 3 ids requested -> exactly those 3 come back', () => {
      const fx = createFixture();
      const sid = newSession(fx);
      const tx = fx.conn.transaction(() => {
        const m = fx.conn.prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?,?,?,?,?)');
        const e = fx.conn.prepare(
          "INSERT INTO message_provider_echo (message_id, session_id, provider, model, schema_v, blocks, bytes, server_bytes, created_at) VALUES (?,?, 'anthropic','claude-haiku-5-5',1,?,?,0,?)"
        );
        const blocks = JSON.stringify(TIER_T);
        for (let i = 0; i < 5000; i++) {
          m.run(`m${i}`, sid, 'assistant', 'x', at(0));
          e.run(`m${i}`, sid, blocks, blocks.length, at(0));
        }
      });
      tx();
      const got = fx.store.getMessageEchoes(sid, ['m7', 'm2500', 'm4999', 'does-not-exist'], 0, TTL);
      expect([...got.keys()].sort()).toEqual(['m2500', 'm4999', 'm7']);
      expect(fx.store.getMessageEchoes(sid, [], 0, TTL).size).toBe(0);
    });

    it('R9-hist AC10: a request larger than the 500-id IN chunk still returns every row (chunk boundary)', () => {
      const fx = createFixture();
      const sid = newSession(fx);
      const ids: string[] = [];
      fx.conn.transaction(() => {
        const m = fx.conn.prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?,?,?,?,?)');
        const e = fx.conn.prepare(
          "INSERT INTO message_provider_echo (message_id, session_id, provider, model, schema_v, blocks, bytes, server_bytes, created_at) VALUES (?,?, 'anthropic','claude-haiku-5-5',1,?,2,0,?)"
        );
        for (let i = 0; i < 1203; i++) {
          ids.push(`c${i}`);
          m.run(`c${i}`, sid, 'assistant', 'x', at(0));
          e.run(`c${i}`, sid, JSON.stringify([TEXT]), at(0));
        }
      })();
      expect(fx.store.getMessageEchoes(sid, ids, 0, TTL).size).toBe(1203);
      // Duplicated ids are looked up once.
      expect(fx.store.getMessageEchoes(sid, [...ids, ...ids], 0, TTL).size).toBe(1203);
    });

    it("R9-hist AC10: another session's message id is never served", () => {
      const fx = createFixture();
      const s1 = newSession(fx);
      const s2 = newSession(fx);
      seedAssistant(fx, s1, 'm1', 0, MIXED);
      expect(fx.store.getMessageEchoes(s2, ['m1'], 0, TTL).size).toBe(0);
      expect(fx.store.getMessageEchoes(s1, ['m1'], 0, TTL).size).toBe(1);
    });

    it('R9-hist AC10: a schema_v above the supported version, or a non-anthropic row, is ignored', () => {
      const fx = createFixture();
      const sid = newSession(fx);
      seedAssistant(fx, sid, 'v1', 0, MIXED);
      seedAssistant(fx, sid, 'v2', 0, MIXED);
      seedAssistant(fx, sid, 'oa', 0, MIXED);
      fx.conn.prepare('UPDATE message_provider_echo SET schema_v = ? WHERE message_id = ?').run(ECHO_SCHEMA_VERSION + 1, 'v2');
      fx.conn.prepare("UPDATE message_provider_echo SET provider = 'openai' WHERE message_id = 'oa'").run();
      expect([...fx.store.getMessageEchoes(sid, ['v1', 'v2', 'oa'], 0, TTL).keys()]).toEqual(['v1']);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('R9-hist AC10: sweepEchoes', () => {
    it('R9-hist AC10: a session with an old row but recent activity (task at minute 0, 9, 15) keeps its tier S; the sweeper leaves it alone', () => {
      const fx = createFixture();
      const sid = newSession(fx);
      seedAssistant(fx, sid, 'm0', 0, MIXED); // task at minute 0
      seedAssistant(fx, sid, 'm9', 9 * MIN, echoOf([TEXT])); // task at minute 9 (no S of its own)
      // Minute 15: the session was last active at minute 9, so it has been idle 6 minutes: not expired.
      const now15 = NOW0 + 15 * MIN;
      expect(idleAt(fx.store, sid, now15)).toBe(6 * MIN);
      expect(fx.store.getMessageEchoes(sid, ['m0'], idleAt(fx.store, sid, now15), TTL).get('m0')?.blocks).toHaveLength(5);
      const swept = fx.store.sweepEchoes(now15, TTL);
      expect(swept).toEqual({ stripped: 0, orphansDeleted: 0, corruptDeleted: 0 });
      expect(rowOf(fx.conn, 'm0')?.server_bytes).toBe(MIXED_SERVER_BYTES);
      seedAssistant(fx, sid, 'm15', 15 * MIN, echoOf([TEXT]));
      // Minute 20 is only 5 min after the minute-15 activity: still untouched.
      expect(fx.store.sweepEchoes(NOW0 + 20 * MIN, TTL).stripped).toBe(0);
      // Minute 26: idle 11 min past the TTL: now the sweeper strips.
      expect(fx.store.sweepEchoes(NOW0 + 26 * MIN, TTL).stripped).toBe(1);
      const row = rowOf(fx.conn, 'm0');
      expect(row?.server_bytes).toBe(0);
      expect(JSON.parse(row?.blocks ?? '[]')).toEqual(TIER_T);
      expect(row?.bytes).toBe(sizeOf(TIER_T));
    });

    it('R9-hist AC10: the reader and the sweeper apply ONE rule at ttl-1ms, ttl and ttl+1ms', () => {
      for (const offset of [TTL - 1, TTL, TTL + 1]) {
        const fx = createFixture();
        const sid = newSession(fx);
        seedAssistant(fx, sid, 'm1', 0, MIXED);
        const readerStrips = fx.store.getMessageEchoes(sid, ['m1'], idleAt(fx.store, sid, NOW0 + offset), TTL).get('m1')?.blocks.length === 3;
        const sweeperStrips = fx.store.sweepEchoes(NOW0 + offset, TTL).stripped === 1;
        expect({ offset, sweeperStrips }).toEqual({ offset, sweeperStrips: readerStrips });
        expect(readerStrips).toBe(offset > TTL);
      }
    });

    it('R9-hist AC10: sweeping is idempotent and strips ttl 0 sessions regardless of activity', () => {
      const fx = createFixture();
      const sid = newSession(fx);
      seedAssistant(fx, sid, 'm1', 0, MIXED);
      expect(fx.store.sweepEchoes(NOW0, 0).stripped).toBe(1);
      expect(fx.store.sweepEchoes(NOW0, 0)).toEqual({ stripped: 0, orphansDeleted: 0, corruptDeleted: 0 });
      expect(fx.store.getEchoSessionServerBytes(sid)).toBe(0);
      expect(fx.store.getMessageEchoes(sid, ['m1'], 0, TTL).get('m1')?.blocks).toEqual(TIER_T);
    });

    it('R9-hist AC10: a row left with no tier T is deleted by the sweep', () => {
      const fx = createFixture();
      const sid = newSession(fx);
      seedAssistant(fx, sid, 'only-s', 0, echoOf([SERVER_USE, SERVER_RESULT]));
      expect(SERVER_ONLY_BYTES).toBeGreaterThan(0);
      expect(fx.store.sweepEchoes(NOW0 + 30 * MIN, TTL).stripped).toBe(1);
      expect(countRows(fx.conn)).toBe(0);
    });

    it('R9-hist AC10: two sweepers on separate connections converge -- the union strips each row exactly once', () => {
      const a = createFixture();
      const b = openFixture(a.file);
      const sid = newSession(a);
      for (let i = 0; i < 450; i++) seedAssistant(a, sid, `m${i}`, 0, MIXED); // crosses the 200-row batch size
      const now = NOW0 + 30 * MIN;
      const first = a.store.sweepEchoes(now, TTL);
      const second = b.store.sweepEchoes(now, TTL);
      const third = a.store.sweepEchoes(now, TTL);
      expect(first.stripped).toBe(450);
      expect(second).toEqual({ stripped: 0, orphansDeleted: 0, corruptDeleted: 0 });
      expect(third.stripped).toBe(0);
      expect(b.conn.prepare('SELECT count(*) AS n FROM message_provider_echo WHERE server_bytes > 0').get()).toEqual({ n: 0 });
      // New activity on the session after the strip must not resurrect or re-strip anything.
      seedAssistant(a, sid, 'fresh', 31 * MIN, MIXED);
      expect(b.store.sweepEchoes(NOW0 + 32 * MIN, TTL).stripped).toBe(0);
      expect(rowOf(b.conn, 'fresh')?.server_bytes).toBe(MIXED_SERVER_BYTES);
    });

    it('R9-hist AC10: orphans (message gone, foreign_keys=OFF) are deleted; live rows are kept', () => {
      const fx = createFixture({ foreignKeys: false });
      const sid = newSession(fx);
      seedAssistant(fx, sid, 'keep', 0, echoOf([TEXT]));
      seedAssistant(fx, sid, 'gone', 0, echoOf([TEXT]));
      fx.conn.prepare("DELETE FROM messages WHERE id = 'gone'").run(); // an old binary's clearMessages with FK off
      expect(countRows(fx.conn)).toBe(2);
      expect(fx.store.sweepEchoes(NOW0, TTL)).toEqual({ stripped: 0, orphansDeleted: 1, corruptDeleted: 0 });
      expect(rowOf(fx.conn, 'keep')).toBeDefined();
      expect(rowOf(fx.conn, 'gone')).toBeUndefined();
    });

    it('R9-hist AC10: a corrupt row is removed by the sweep instead of wedging it', () => {
      const fx = createFixture();
      const sid = newSession(fx);
      seedAssistant(fx, sid, 'good', 0, MIXED);
      seedAssistant(fx, sid, 'bad', 0, MIXED);
      fx.conn.prepare("UPDATE message_provider_echo SET blocks = '{not json' WHERE message_id = 'bad'").run();
      const res = fx.store.sweepEchoes(NOW0 + 30 * MIN, TTL);
      expect(res).toEqual({ stripped: 1, orphansDeleted: 0, corruptDeleted: 1 });
      expect(rowOf(fx.conn, 'bad')).toBeUndefined();
      expect(JSON.parse(rowOf(fx.conn, 'good')?.blocks ?? '[]')).toEqual(TIER_T);
    });

    it('R9-hist AC10: getEchoSessionServerBytes sums tier S per session and drops to 0 after the strip', () => {
      const fx = createFixture();
      const s1 = newSession(fx);
      const s2 = newSession(fx);
      seedAssistant(fx, s1, 'a', 0, MIXED);
      seedAssistant(fx, s1, 'b', 0, MIXED);
      seedAssistant(fx, s2, 'c', 0, MIXED);
      expect(fx.store.getEchoSessionServerBytes(s1)).toBe(2 * MIXED_SERVER_BYTES);
      expect(fx.store.getEchoSessionServerBytes(s2)).toBe(MIXED_SERVER_BYTES);
      expect(fx.store.getEchoSessionServerBytes('no-such-session')).toBe(0);
      fx.store.sweepEchoes(NOW0 + 30 * MIN, TTL);
      expect(fx.store.getEchoSessionServerBytes(s1)).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('R9-hist AC10: explicit deletion (clearMessages / deleteMessageEchoes)', () => {
    for (const foreignKeys of [false, true]) {
      it(`R9-hist AC10: clearMessages removes the session's echo rows in the same transaction (foreign_keys=${foreignKeys ? 'ON' : 'OFF'})`, () => {
        const fx = createFixture({ foreignKeys });
        const keepSession = newSession(fx);
        const sid = newSession(fx);
        seedAssistant(fx, sid, 'm1', 0, MIXED);
        seedAssistant(fx, sid, 'm2', 1 * MIN, MIXED);
        seedAssistant(fx, keepSession, 'other', 0, MIXED);
        expect(fx.conn.pragma('foreign_keys', { simple: true })).toBe(foreignKeys ? 1 : 0);

        expect(fx.store.clearMessages(sid)).toBe(2);

        expect(rowOf(fx.conn, 'm1')).toBeUndefined();
        expect(rowOf(fx.conn, 'm2')).toBeUndefined();
        expect(rowOf(fx.conn, 'other')).toBeDefined(); // another session's echo is untouched
        // Reopened: the purge is durable and no orphan is left for the sweeper.
        const re = openFixture(fx.file, { foreignKeys });
        expect(re.store.sweepEchoes(NOW0, TTL).orphansDeleted).toBe(0);
        expect(re.store.getMessageEchoes(sid, ['m1', 'm2'], 0, TTL).size).toBe(0);
      });
    }

    it('R9-hist AC10: a closed session cannot be cleared and its echo rows are NOT purged by the failed attempt', () => {
      const fx = createFixture();
      const sid = newSession(fx);
      seedAssistant(fx, sid, 'm1', 0, MIXED);
      fx.store.close(sid);
      expect(() => fx.store.clearMessages(sid)).toThrowError(/closed/);
      expect(rowOf(fx.conn, 'm1')).toBeDefined();
    });

    it('R9-hist AC10: with foreign_keys=ON deleting a message cascades its echo; with OFF the orphan sweep is the backstop', () => {
      const on = createFixture({ foreignKeys: true });
      const sOn = newSession(on);
      seedAssistant(on, sOn, 'm1', 0, MIXED);
      on.conn.prepare("DELETE FROM messages WHERE id = 'm1'").run();
      expect(rowOf(on.conn, 'm1')).toBeUndefined();

      const off = createFixture({ foreignKeys: false });
      const sOff = newSession(off);
      seedAssistant(off, sOff, 'm1', 0, MIXED);
      off.conn.prepare("DELETE FROM messages WHERE id = 'm1'").run();
      expect(rowOf(off.conn, 'm1')).toBeDefined();
      expect(off.store.sweepEchoes(NOW0, TTL).orphansDeleted).toBe(1);
      expect(rowOf(off.conn, 'm1')).toBeUndefined();
    });

    it('R9-hist AC10: deleteMessageEchoes (the self-heal) removes only that session\'s rows and reports the count', () => {
      const fx = createFixture();
      const s1 = newSession(fx);
      const s2 = newSession(fx);
      seedAssistant(fx, s1, 'a', 0, MIXED);
      seedAssistant(fx, s1, 'b', 0, MIXED);
      seedAssistant(fx, s2, 'c', 0, MIXED);
      expect(fx.store.deleteMessageEchoes(s1)).toBe(2);
      expect(fx.store.deleteMessageEchoes(s1)).toBe(0);
      expect(rowOf(fx.conn, 'c')).toBeDefined();
      // The messages themselves are untouched: only the echo side record is dropped.
      expect(fx.store.getMessages(s1)).toHaveLength(2);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('R9-hist AC14: failure isolation (best effort, one WARN per process, never throws)', () => {
    it('R9-hist AC14: a database without the echo table (new binary, unmigrated DB) degrades to legacy history', () => {
      const fx = createFixture({ echoTable: false });
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const sid = newSession(fx);
      fx.store.appendMessage(sid, { id: 'm1', sessionId: sid, role: 'assistant', content: 'x', createdAt: at(0) });

      expect(() => fx.store.appendMessageEcho('m1', sid, MIXED, MIXED_BYTES, MIXED_SERVER_BYTES)).not.toThrow();
      expect(fx.store.getMessageEchoes(sid, ['m1'], 0, TTL).size).toBe(0);
      expect(fx.store.getEchoSessionServerBytes(sid)).toBe(0);
      expect(fx.store.sweepEchoes(NOW0, TTL)).toEqual({ stripped: 0, orphansDeleted: 0, corruptDeleted: 0 });
      expect(fx.store.deleteMessageEchoes(sid)).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1); // one WARN per process, not one per failing call
      expect(JSON.stringify(warn.mock.calls[0])).not.toContain('THIRD-PARTY-PAGE-BODY');
      // The user purge still works on an unmigrated database.
      expect(fx.store.clearMessages(sid)).toBe(1);
    });

    it('R9-hist AC14: a locked database makes append/get/sweep return quietly without failing the caller', () => {
      const a = createFixture();
      const sid = newSession(a);
      seedAssistant(a, sid, 'm1', 0, MIXED);
      const b = openFixture(a.file);
      b.conn.pragma('busy_timeout = 0');
      a.conn.exec('BEGIN IMMEDIATE'); // another process holds the write lock
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      try {
        expect(() => b.store.appendMessageEcho('m1', sid, echoOf([TEXT]), 10, 0)).not.toThrow();
        expect(b.store.sweepEchoes(NOW0 + 30 * MIN, TTL)).toEqual({ stripped: 0, orphansDeleted: 0, corruptDeleted: 0 });
        expect(b.store.deleteMessageEchoes(sid)).toBe(0);
        expect(warn).toHaveBeenCalledTimes(1);
        // Whether or not the engine lets a reader through a held write lock, a read must never throw.
        expect(() => b.store.getMessageEchoes(sid, ['m1'], 0, TTL)).not.toThrow();
      } finally {
        a.conn.exec('ROLLBACK');
      }
      // After the lock clears, nothing was lost or half-written.
      expect(rowOf(a.conn, 'm1')?.server_bytes).toBe(MIXED_SERVER_BYTES);
    });

    it('R9-hist AC14: a corrupt blocks column is skipped on read (that message replays as legacy), with one WARN and no content', () => {
      const fx = createFixture();
      const sid = newSession(fx);
      seedAssistant(fx, sid, 'good', 0, MIXED);
      seedAssistant(fx, sid, 'bad1', 0, MIXED);
      seedAssistant(fx, sid, 'bad2', 0, MIXED);
      fx.conn.prepare("UPDATE message_provider_echo SET blocks = 'oops THIRD-PARTY-PAGE-BODY' WHERE message_id = 'bad1'").run();
      fx.conn.prepare("UPDATE message_provider_echo SET blocks = '{\"not\":\"an array\"}' WHERE message_id = 'bad2'").run();
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      const got = fx.store.getMessageEchoes(sid, ['good', 'bad1', 'bad2'], 0, TTL);
      expect([...got.keys()]).toEqual(['good']);
      fx.store.getMessageEchoes(sid, ['bad1'], 0, TTL);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('THIRD-PARTY-PAGE-BODY');
    });

    it('R9-hist AC14: appending an echo for a message that does not exist is swallowed (FK) and stores nothing', () => {
      const fx = createFixture({ foreignKeys: true });
      const sid = newSession(fx);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      expect(() => fx.store.appendMessageEcho('ghost', sid, MIXED, MIXED_BYTES, MIXED_SERVER_BYTES)).not.toThrow();
      expect(countRows(fx.conn)).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('R9-hist AC11: the table definition equals migration 0017 and the drizzle schema', () => {
    interface IColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
    const describeTable = (conn: Database.Database) => ({
      columns: (conn.prepare('PRAGMA table_info(message_provider_echo)').all() as IColumnInfo[]).map(
        ({ name, type, notnull, dflt_value, pk }) => ({ name, type: type.toLowerCase(), notnull, dflt: dflt_value, pk })
      ),
      foreignKeys: (conn.prepare('PRAGMA foreign_key_list(message_provider_echo)').all() as Array<{ table: string; from: string; to: string; on_delete: string }>).map(
        ({ table, from, to, on_delete }) => ({ table, from, to, onDelete: on_delete })
      ),
      indexes: (conn.prepare('PRAGMA index_list(message_provider_echo)').all() as Array<{ name: string; origin: string }>)
        .filter((i) => i.origin === 'c')
        .map((i) => ({
          name: i.name,
          columns: (conn.prepare(`PRAGMA index_info(${i.name})`).all() as Array<{ name: string }>).map((c) => c.name),
        })),
    });

    it('R9-hist AC11: the verbatim DDL used by these tests equals the table the REAL migration folder creates', () => {
      const real = new Database(':memory:');
      open.push(real);
      migrate(drizzle(real), { migrationsFolder: REAL_MIGRATIONS });
      const mine = createFixture();
      expect(describeTable(mine.conn)).toEqual(describeTable(real));
      expect(describeTable(real).columns.map((c) => c.name)).toEqual([
        'message_id', 'session_id', 'provider', 'model', 'schema_v', 'blocks', 'bytes', 'server_bytes', 'created_at',
      ]);
    });

    it('R9-hist AC11: the drizzle table definition agrees with the migrated table (columns, nullability, defaults, PK, FK, index)', () => {
      const real = new Database(':memory:');
      open.push(real);
      migrate(drizzle(real), { migrationsFolder: REAL_MIGRATIONS });
      const live = describeTable(real);
      const cfg = getTableConfig(messageProviderEchoTable);
      expect(cfg.name).toBe('message_provider_echo');
      expect(cfg.columns.map((c) => c.name)).toEqual(live.columns.map((c) => c.name));
      for (const col of cfg.columns) {
        const l = live.columns.find((c) => c.name === col.name);
        expect({ col: col.name, notNull: col.notNull }).toEqual({ col: col.name, notNull: l?.notnull === 1 });
        expect({ col: col.name, primary: col.primary }).toEqual({ col: col.name, primary: l?.pk === 1 });
        expect({ col: col.name, type: col.getSQLType() }).toEqual({ col: col.name, type: l?.type });
      }
      expect(cfg.columns.find((c) => c.name === 'schema_v')?.default).toBe(1);
      expect(live.columns.find((c) => c.name === 'schema_v')?.dflt).toBe('1');
      expect(cfg.columns.find((c) => c.name === 'server_bytes')?.default).toBe(0);
      expect(live.columns.find((c) => c.name === 'server_bytes')?.dflt).toBe('0');
      expect(cfg.foreignKeys).toHaveLength(1);
      const fk = cfg.foreignKeys[0].reference();
      expect({ from: fk.columns.map((c) => c.name), to: fk.foreignColumns.map((c) => c.name), onDelete: cfg.foreignKeys[0].onDelete }).toEqual({
        from: ['message_id'],
        to: ['id'],
        onDelete: 'cascade',
      });
      expect(live.foreignKeys).toEqual([{ table: 'messages', from: 'message_id', to: 'id', onDelete: 'CASCADE' }]);
      expect(cfg.indexes.map((i) => ({ name: i.config.name, columns: i.config.columns.map((c) => ('name' in c ? c.name : '')) }))).toEqual(live.indexes);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('R9-hist S0 task events: provider:history_degraded and provider:pause_continued reach task_events', () => {
    it('R9-hist AC17 AC18: the drizzle enum accepts both names and TaskStore.appendEvent persists them', () => {
      expectTypeOf<'provider:history_degraded'>().toMatchTypeOf<TaskEventType>();
      expectTypeOf<'provider:pause_continued'>().toMatchTypeOf<TaskEventType>();
      expect(taskEventsTable.type.enumValues).toEqual(
        expect.arrayContaining(['provider:history_degraded', 'provider:pause_continued'])
      );

      const fx = createFixture();
      const tasks = new TaskStore(drizzle(fx.conn));
      fx.conn
        .prepare("INSERT INTO tasks (id, prompt, created_at, updated_at) VALUES ('t1','p',?,?)")
        .run(at(0), at(0));
      tasks.appendEvent({ taskId: 't1', type: 'provider:history_degraded', payload: { apiMessage: 'm', echoedMessages: 2, healed: true } });
      tasks.appendEvent({ taskId: 't1', type: 'provider:pause_continued', payload: { n: 1 } });
      const rows = fx.conn.prepare('SELECT type, payload FROM task_events ORDER BY created_at, rowid').all() as Array<{ type: string; payload: string }>;
      expect(rows.map((r) => r.type)).toEqual(['provider:history_degraded', 'provider:pause_continued']);
      expect(JSON.parse(rows[1].payload)).toEqual({ n: 1 });
    });
  });
});
