/**
 * session-selection.test.ts — 5ad2cf37 (D-G(2)) session-held binding.
 *
 *   5ad2cf37 AC3 — reopen-persistence: a binding set via updateSelection survives
 *                  closing and reopening the SQLite file (a host restart).
 *   5ad2cf37 AC1 — (store half) create({binding}) / updateSelection write only the
 *                  supplied fields; getSelection returns what the chain's `session`
 *                  tier reads.
 *
 * Real on-disk better-sqlite3 file, the real agent-mcp migration SQL for the
 * `sessions` table columns (0011), reopened after writing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionStore } from '../store/session-store.js';
import type { AgentDefinition } from '../validation/schemas.js';

const SESSIONS_DDL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL, agent_name TEXT NOT NULL, agent_version INTEGER NOT NULL,
  agent_data TEXT NOT NULL, status TEXT DEFAULT 'active' NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, composed_prompt_id TEXT
);`;
const MIGRATION_0011 = fs
  .readFileSync(
    path.resolve(__dirname, '../../../../../entrypoint/agent-mcp/drizzle/0011_session_provider_binding.sql'),
    'utf8'
  )
  .replace(/-->\s*statement-breakpoint/g, '');

const agent = {
  name: 'a',
  version: 1,
  provider: undefined,
  mcpServers: {},
  permissions: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as unknown as AgentDefinition;

let dir: string;
let file: string;

function open(ddl: string[]): { sqlite: Database.Database; store: SessionStore } {
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  for (const stmt of ddl) sqlite.exec(stmt);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { sqlite, store: new SessionStore(drizzle(sqlite) as any) };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-selection-'));
  file = path.join(dir, 'runtime.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('SessionStore session-held binding', () => {
  it('a new session holds no binding; updateSelection writes only supplied fields', () => {
    const { sqlite, store } = open([SESSIONS_DDL, MIGRATION_0011]);
    const s = store.create({ agentName: 'a', agentDefinition: agent });
    expect(store.getSelection(s.id)).toBeNull();

    store.updateSelection(s.id, { providerType: 'anthropic', modelRef: 'claude_sonnet_4_6' });
    expect(store.getSelection(s.id)).toEqual({ providerType: 'anthropic', modelRef: 'claude_sonnet_4_6' });

    // model-only swap keeps the provider
    store.updateSelection(s.id, { modelRef: 'claude_opus_4_8', models: ['claude_opus_4_8', 'claude_sonnet_4_6'] });
    expect(store.getSelection(s.id)).toEqual({
      providerType: 'anthropic',
      modelRef: 'claude_opus_4_8',
      models: ['claude_opus_4_8', 'claude_sonnet_4_6'],
    });
    sqlite.close();
  });

  it('5ad2cf37 AC3 — the binding survives closing and reopening the file', () => {
    const first = open([SESSIONS_DDL, MIGRATION_0011]);
    const s = first.store.create({
      agentName: 'a',
      agentDefinition: agent,
      binding: { providerType: 'anthropic', modelRef: 'claude_sonnet_4_6' },
    });
    first.sqlite.close();

    const second = open([]); // reopen: no DDL, the file is the only state
    expect(second.store.getSelection(s.id)).toEqual({
      providerType: 'anthropic',
      modelRef: 'claude_sonnet_4_6',
    });
    second.sqlite.close();
  });

  it('refuses a closed session and an unknown providerType; unknown session is SESSION_NOT_FOUND', () => {
    const { sqlite, store } = open([SESSIONS_DDL, MIGRATION_0011]);
    const s = store.create({ agentName: 'a', agentDefinition: agent });
    expect(() => store.updateSelection(s.id, { providerType: 'bogus' as never })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' })
    );
    store.close(s.id);
    expect(() => store.updateSelection(s.id, { modelRef: 'x' })).toThrowError(
      expect.objectContaining({ code: 'SESSION_CLOSED' })
    );
    expect(() => store.getSelection('missing')).toThrowError(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND' })
    );
    sqlite.close();
  });

  it('aafd6561 AC-e — a sessions table that predates migration 0011 throws (never a silent null)', () => {
    const { sqlite, store } = open([SESSIONS_DDL]);
    const s = store.create({ agentName: 'a', agentDefinition: agent });
    expect(() => store.getSelection(s.id)).toThrowError(/no such column/i);
    sqlite.close();
  });
});
