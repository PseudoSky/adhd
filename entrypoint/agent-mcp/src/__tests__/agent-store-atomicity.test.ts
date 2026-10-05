/**
 * AC4 + AC5 of backlog 331508ac — the read-modify-write half of the
 * parallel-process locking contract for the agent-* stores.
 *
 * AC4: the read-modify-write paths (`AgentStore.create` / `update` / `delete`)
 *      run inside `BEGIN IMMEDIATE`, so the lock is taken at BEGIN and a
 *      concurrent writer cannot commit between the SELECT and the write.
 * AC5: a lost lock race is retried a BOUNDED number of times, and ONLY for
 *      SQLite lock-contention errors.
 *
 * These are real two-connection (worker-thread) tests, not mocks. AC4's
 * negative control runs the IDENTICAL check-then-insert with a DEFERRED
 * transaction and shows it races to a raw UNIQUE error — proving the
 * `AGENT_ALREADY_EXISTS` assertion has teeth. AC5's negative control runs with
 * `maxAttempts: 1` and shows the busy error then propagates unretried.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';

import {
  openRegistryDb,
  applyLockingPragmas,
  withBusyRetry,
  isSqliteBusyError,
} from '@adhd/agent-core-env';
import {
  ToolError,
  agentCreateInputSchema,
} from '@adhd/agent-engine-orchestrator';

import { agentsTable } from '../db/schema.js';
import { AgentStore } from '../store/agent-store.js';

const HOLDER = fileURLToPath(
  new URL('./fixtures/agents-lock-holder.cjs', import.meta.url)
);

interface IHolder {
  waitFor(type: string): Promise<void>;
  stop(): Promise<void>;
}

function startHolder(
  dbPath: string,
  holdMs: number,
  extra: { seedName?: string | null; seedData?: string } = {}
): IHolder {
  const worker = new Worker(HOLDER, {
    workerData: { path: dbPath, holdMs, ...extra },
  });
  const seen = new Set<string>();
  const waiters: Array<() => void> = [];
  worker.on('message', (m: { type: string }) => {
    seen.add(m.type);
    waiters.splice(0).forEach((w) => w());
  });
  return {
    async waitFor(type: string) {
      while (!seen.has(type)) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    stop() {
      return worker.terminate().then(() => undefined);
    },
  };
}

const tmpDirs: string[] = [];
function makeDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmcp-atomicity-'));
  tmpDirs.push(dir);
  return path.join(dir, 'agents.db');
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const baseInput = agentCreateInputSchema.parse({
  name: 'race',
  provider: { type: 'claudecli' },
  systemPrompt: 'hello',
});

function seedDefinition(name: string) {
  const at = new Date().toISOString();
  const input = agentCreateInputSchema.parse({
    name,
    provider: { type: 'claudecli' },
    systemPrompt: 'seed',
  });
  return { ...input, version: 1, createdAt: at, updatedAt: at };
}

function openStore(dbPath: string, busyTimeoutMs: number) {
  const sqlite = new Database(dbPath);
  applyLockingPragmas(sqlite, { busyTimeoutMs });
  const db = drizzle(sqlite);
  const store = new AgentStore(db);
  return { sqlite, db, store };
}

describe('AgentStore atomicity — BEGIN IMMEDIATE + bounded BUSY retry (331508ac)', () => {
  it('AC4: create() takes the write lock at BEGIN — a row committed by a concurrent writer is observed as AGENT_ALREADY_EXISTS', async () => {
    const dbPath = makeDbPath();
    // The holder seeds `race` INSIDE its uncommitted immediate transaction and
    // holds it for 200ms. A BEGIN-IMMEDIATE create() blocks at BEGIN until the
    // holder commits, then its SELECT observes the row.
    const holder = startHolder(dbPath, 200, {
      seedName: 'race',
      seedData: JSON.stringify(seedDefinition('race')),
    });
    await holder.waitFor('locked');

    const { sqlite, store } = openStore(dbPath, 5_000);
    try {
      let thrown: unknown;
      try {
        store.create(baseInput);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(ToolError);
      expect((thrown as ToolError).code).toBe('AGENT_ALREADY_EXISTS');

      const row = sqlite
        .prepare('SELECT COUNT(*) AS n FROM agents WHERE name = ?')
        .get('race') as { n: number };
      expect(row.n).toBe(1);
    } finally {
      sqlite.close();
      await holder.stop();
    }
  });

  it('AC4 negative control: the identical check-then-insert WITHOUT BEGIN IMMEDIATE races to a raw UNIQUE error, never the clean AGENT_ALREADY_EXISTS', async () => {
    const dbPath = makeDbPath();
    const holder = startHolder(dbPath, 200, {
      seedName: 'race',
      seedData: JSON.stringify(seedDefinition('race')),
    });
    await holder.waitFor('locked');

    const { sqlite, db } = openStore(dbPath, 5_000);
    const at = new Date().toISOString();
    try {
      let thrown: unknown;
      try {
        db.transaction(
          (tx) => {
            const existing = tx
              .select()
              .from(agentsTable)
              .where(eq(agentsTable.name, 'race'))
              .get();
            if (existing) {
              throw new ToolError('AGENT_ALREADY_EXISTS', 'exists');
            }
            tx.insert(agentsTable)
              .values({
                name: 'race',
                version: 1,
                data: JSON.stringify(seedDefinition('race')),
                createdAt: at,
                updatedAt: at,
              })
              .run();
          },
          { behavior: 'deferred' }
        );
      } catch (err) {
        thrown = err;
      }

      // The whole point: a DEFERRED read-modify-write does NOT yield the clean
      // domain error. It fails at the write (busy) or at the unique constraint.
      expect(thrown).toBeDefined();
      expect((thrown as { code?: string }).code).not.toBe('AGENT_ALREADY_EXISTS');
    } finally {
      sqlite.close();
      await holder.stop();
    }
  });

  it('AC5: withBusyRetry recovers from SQLITE_BUSY once the holder releases (real two-connection retry)', async () => {
    const dbPath = makeDbPath();
    const holder = startHolder(dbPath, 150, { seedName: null });
    await holder.waitFor('locked');

    // Zero budget: BEGIN IMMEDIATE fails immediately with SQLITE_BUSY, so the
    // ONLY thing that can make this succeed is the retry wrapper.
    const { sqlite } = openRegistryDb({ registryDbPath: dbPath, busyTimeoutMs: 0 });
    const at = new Date().toISOString();
    try {
      let attempts = 0;
      withBusyRetry(
        () => {
          attempts++;
          return sqlite
            .transaction(() => {
              sqlite
                .prepare(
                  'INSERT INTO agents (name, version, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
                )
                .run('retried', 1, '{}', at, at);
            })
            .immediate();
        },
        { maxAttempts: 12, baseDelayMs: 25, maxDelayMs: 60 }
      );

      expect(attempts).toBeGreaterThan(1);
      const row = sqlite
        .prepare('SELECT COUNT(*) AS n FROM agents WHERE name = ?')
        .get('retried') as { n: number };
      expect(row.n).toBe(1);
    } finally {
      sqlite.close();
      await holder.stop();
    }
  });

  it('AC5 negative control: maxAttempts:1 does not retry — the SQLITE_BUSY propagates', async () => {
    const dbPath = makeDbPath();
    const holder = startHolder(dbPath, 300, { seedName: null });
    await holder.waitFor('locked');

    const { sqlite } = openRegistryDb({ registryDbPath: dbPath, busyTimeoutMs: 0 });
    const at = new Date().toISOString();
    try {
      let attempts = 0;
      let thrown: unknown;
      try {
        withBusyRetry(
          () => {
            attempts++;
            return sqlite
              .transaction(() => {
                sqlite
                  .prepare(
                    'INSERT INTO agents (name, version, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
                  )
                  .run('never', 1, '{}', at, at);
              })
              .immediate();
          },
          { maxAttempts: 1 }
        );
      } catch (err) {
        thrown = err;
      }

      expect(attempts).toBe(1);
      expect(isSqliteBusyError(thrown)).toBe(true);
    } finally {
      sqlite.close();
      await holder.stop();
    }
  });

  it('AC5: a non-busy error propagates immediately, unretried (bounded to BUSY only)', () => {
    let attempts = 0;
    let thrown: unknown;
    try {
      withBusyRetry(
        () => {
          attempts++;
          throw new Error('boom');
        },
        { maxAttempts: 5 }
      );
    } catch (err) {
      thrown = err;
    }

    expect(attempts).toBe(1);
    expect((thrown as Error).message).toBe('boom');
    expect(isSqliteBusyError(thrown)).toBe(false);
  });
});
