/**
 * agent-update-open-sessions.test.ts — backlog 301f040a.
 *
 * `agent_update` never reaches already-open sessions (their agent definition is
 * snapshotted at session creation). Before this change that was silent: an
 * operator only discovered it by retrying on the old session_id and hitting the
 * exact failure they had just fixed. `agentUpdate` now returns
 * `openSessionsNotUpdated` — the ids of the active sessions still on the old
 * snapshot.
 *
 * Real components: a real on-disk SQLite file migrated with the operational
 * schema, the real `AgentStore` + `SessionStore`, and the real `agentUpdate`
 * tool with the same session-store adapter `server.ts` wires. No mocks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyLockingPragmas } from '@adhd/agent-core-env';
import { SessionStore } from '@adhd/agent-store-runtime';
import {
  agentUpdate,
  agentCreateInputSchema,
  type AgentCrudDeps,
} from '@adhd/agent-engine-orchestrator';

import { runMigrationsOn } from '../db/migrate-runner.js';
import { AgentStore } from '../store/agent-store.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../');
const TMP_ROOT = path.join(REPO_ROOT, 'tmp', 'agent-mcp');

let tmpDir: string;
let sqlite: Database.Database;
let agentStore: AgentStore;
let sessionStore: SessionStore;
let deps: AgentCrudDeps;

function openDb(file: string): void {
  sqlite = new Database(file);
  applyLockingPragmas(sqlite, { busyTimeoutMs: 5_000 });
  const db = drizzle(sqlite);
  runMigrationsOn(sqlite, db);
  agentStore = new AgentStore(db);
  sessionStore = new SessionStore(db);
  deps = {
    agentStore,
    sessionStore: {
      list: (filter) =>
        sessionStore
          .list({ agentName: filter.agentName, status: filter.status as never })
          .map((s) => ({ id: s.id })),
      close: (sessionId) => {
        sessionStore.close(sessionId);
      },
    },
  };
}

function createAgent(name: string): void {
  agentStore.create(
    agentCreateInputSchema.parse({
      name,
      provider: { type: 'claudecli' },
      systemPrompt: 'v1 prompt',
    })
  );
}

describe('agent_update surfaces open sessions it does not affect (301f040a)', () => {
  beforeAll(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(TMP_ROOT, 'agent-update-open-sessions-'));
    openDb(path.join(tmpDir, 'agents.db'));
  });

  afterAll(() => {
    try {
      sqlite.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('reports the active session id AND the session keeps its pre-update snapshot', () => {
    createAgent('with-open-session');
    const before = agentStore.read('with-open-session');
    const session = sessionStore.create({
      agentName: 'with-open-session',
      agentDefinition: before,
    });

    const result = agentUpdate(
      { name: 'with-open-session', patch: { systemPrompt: 'v2 prompt' } },
      deps
    );

    // The signal is present and names the open session.
    expect(result.openSessionsNotUpdated).toContain(session.id);
    // The update itself still applied (version bumped).
    expect(result.version).toBe(before.version + 1);

    // ...and the open session is genuinely unaffected: it still holds v1.
    const sessionDef = sessionStore.getAgentDefinition(session.id);
    expect(sessionDef.version).toBe(before.version);
    expect(sessionDef.systemPrompt).toBe('v1 prompt');
  });

  it('does not list closed sessions', () => {
    createAgent('with-closed-session');
    const def = agentStore.read('with-closed-session');
    const session = sessionStore.create({
      agentName: 'with-closed-session',
      agentDefinition: def,
    });
    sessionStore.close(session.id);

    const result = agentUpdate(
      { name: 'with-closed-session', patch: { description: 'updated' } },
      deps
    );

    expect(result.openSessionsNotUpdated).toEqual([]);
  });

  it('returns an empty list when no session is open', () => {
    createAgent('no-sessions');

    const result = agentUpdate(
      { name: 'no-sessions', patch: { description: 'updated' } },
      deps
    );

    expect(result.openSessionsNotUpdated).toEqual([]);
  });
});
