/**
 * Behavioral proof for 1b947d91 AC1/AC2/AC3: AGENT_NOT_FOUND must be
 * actionable — it lists registered agent names (sorted, capped, names only).
 *
 * Teeth: against the pre-fix message (`Agent 'x' not found`) every assertion
 * on the roster text goes RED; the system-prompt assertion guards the
 * names-only contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { runMigrationsOn } from '../db/migrate-runner.js';
import {
  AgentStore,
  AGENT_NOT_FOUND_NAME_CAP,
} from '../store/agent-store.js';
import { agentCreateInputSchema } from '@adhd/agent-engine-orchestrator';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('1b947d91 AC1/AC3: AGENT_NOT_FOUND lists registered names', () => {
  let sqlite: Database.Database;
  let store: AgentStore;

  const seed = (name: string, systemPrompt = `${name} prompt`) =>
    store.create(
      agentCreateInputSchema.parse({
        name,
        provider: { type: 'claudecli' },
        systemPrompt,
      })
    );

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store = new AgentStore(db as any);
    runMigrationsOn(sqlite, db);
  });
  afterEach(() => sqlite.close());

  const msgOf = (name: string): string => {
    try {
      store.read(name);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error('expected AGENT_NOT_FOUND');
  };

  it('lists registered names sorted, without leaking system prompts', () => {
    seed('zeta');
    seed('alpha', 'TOP-SECRET-PROMPT');
    seed('mid');
    const m = msgOf('nope');
    expect(m).toContain("Agent 'nope' not found");
    expect(m).toContain('Registered agents: alpha, mid, zeta.');
    expect(m).not.toContain('TOP-SECRET-PROMPT');
  });

  it('caps the roster and reports "+N more"', () => {
    const total = AGENT_NOT_FOUND_NAME_CAP + 5;
    const pad = (i: number) => `agent-${String(i).padStart(3, '0')}`;
    for (let i = 0; i < total; i++) seed(pad(i));
    const m = msgOf('nope');
    expect(m).toContain(pad(0));
    expect(m).toContain(pad(AGENT_NOT_FOUND_NAME_CAP - 1));
    expect(m).not.toContain(pad(AGENT_NOT_FOUND_NAME_CAP));
    expect(m).toContain('(+5 more');
  });

  it('says so when no agents exist', () => {
    expect(msgOf('nope')).toContain('No agents are registered');
  });
});

describe('1b947d91 AC2: agent tool description', () => {
  it('tells callers how to find valid names (both tool descriptors)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../server.ts', import.meta.url)),
      'utf8'
    );
    const matches = src.match(
      /session for a named agent\. If the name is unknown, the AGENT_NOT_FOUND error lists[^']*`agent_list`/g
    );
    expect(matches?.length).toBe(2);
  });
});
