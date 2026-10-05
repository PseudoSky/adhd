/**
 * legacy-migration-skip.e2e.test.ts — backlog af567fb8.
 *
 * DEFAULT-RUNNING, hermetic, REAL-entrypoint proof: agent-mcp's
 * `ADHD_AGENT_SKIP_LEGACY_MIGRATION` flag stops the flat→namespaced legacy-DB
 * migration from reading (and seeding a fresh scratch DB from) the developer's
 * real `$HOME/.adhd/agent-mcp/agents.db`.
 *
 * Spawns the BUILT agent-mcp entry over stdio JSON-RPC (a real child process)
 * with an isolated `cwd` and a FAKE `$HOME` that contains a seeded legacy flat
 * store. Two runs:
 *   - flag ON  → the scratch operational DB is never seeded (unseeded).
 *   - flag OFF → the same legacy store DOES seed it (the negative control that
 *     proves the flag — not some other isolation — is what suppresses the read).
 *
 * No model call is made (only `guide`), so this is NOT env-gated.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertAgentMcpBuilt,
  cleanupScratch,
  makeRunner,
  mkFakeHome,
  mkScratch,
} from './helpers/agent-mcp-registry.js';

beforeAll(() => assertAgentMcpBuilt());
afterAll(() => cleanupScratch());

const SEED_AGENT = 'legacy-seed-agent';

/** Seed a FLAT legacy store at `<home>/.adhd/agent-mcp/agents.db`. */
function seedLegacyFlatStore(home: string): void {
  const dir = join(home, '.adhd', 'agent-mcp');
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'agents.db'));
  try {
    db.exec(
      'CREATE TABLE agents (name TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, ' +
        'data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)'
    );
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO agents (name, version, data, created_at, updated_at) VALUES (?, 1, ?, ?, ?)'
    ).run(SEED_AGENT, JSON.stringify({ name: SEED_AGENT }), now, now);
  } finally {
    db.close();
  }
}

/** Read the agent names from the child's OWN scratch operational DB. */
function scratchAgentNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT name FROM agents').all() as Array<{ name: string }>).map(
      (r) => r.name
    );
  } finally {
    db.close();
  }
}

describe('af567fb8 — ADHD_AGENT_SKIP_LEGACY_MIGRATION keeps a fresh scratch DB unseeded', () => {
  it('flag ON: boot never reads/seeds the fake legacy store', async () => {
    const scratch = mkScratch('skip-legacy-on');
    const home = mkFakeHome(scratch);
    seedLegacyFlatStore(home);
    const dbPath = join(scratch, 'agents.db');

    const runner = makeRunner({
      dbPath,
      home,
      cwd: scratch,
      extraEnv: { ADHD_AGENT_SKIP_LEGACY_MIGRATION: 'true' },
    });
    try {
      await runner.callTool('guide', {}); // force child boot + migrations
      const names = scratchAgentNames(dbPath);
      expect(names).not.toContain(SEED_AGENT);
      expect(names).toHaveLength(0);
    } finally {
      await runner.close().catch(() => undefined);
    }
  }, 60_000);

  it('NEGATIVE CONTROL: without the flag the same legacy store DOES seed the scratch DB', async () => {
    const scratch = mkScratch('skip-legacy-off');
    const home = mkFakeHome(scratch);
    seedLegacyFlatStore(home);
    const dbPath = join(scratch, 'agents.db');

    const runner = makeRunner({ dbPath, home, cwd: scratch });
    try {
      await runner.callTool('guide', {}); // force child boot + migrations
      expect(scratchAgentNames(dbPath)).toContain(SEED_AGENT);
    } finally {
      await runner.close().catch(() => undefined);
    }
  }, 60_000);
});
