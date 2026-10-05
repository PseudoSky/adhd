/**
 * Two-connection concurrency proof for the parallel-process locking contract
 * from `@adhd/agent-core-env`'s `applyLockingPragmas` (backlog 331508ac;
 * ADR-0012).
 *
 * HONEST SCOPE: better-sqlite3 already installs a 5000ms busy handler by
 * default, so the original "immediate SQLITE_BUSY" symptom does NOT reproduce
 * against a bare connection. What these tests prove is that the contract is
 * now EXPLICIT, TYPED and HONOURED end-to-end: `openRegistryDb()` applies the
 * caller's `busyTimeoutMs`, a contending writer waits then succeeds, and a
 * zero budget surfaces SQLITE_BUSY immediately (the negative control — it goes
 * RED if the configured budget is ever ignored).
 *
 * Determinism: the lock holder is a worker thread with its own event loop (a
 * `setTimeout`), so it can COMMIT while this thread's `busy_timeout` busy-waits
 * inside the native write. No wall-clock `sleep` in the assertions.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRegistryDb } from '@adhd/agent-core-env';

const HOLDER = fileURLToPath(
  new URL('./fixtures/sqlite-lock-holder.cjs', import.meta.url)
);

interface IHolder {
  waitFor(type: string): Promise<void>;
  stop(): Promise<void>;
}

function startHolder(dbPath: string, holdMs: number): IHolder {
  const worker = new Worker(HOLDER, { workerData: { path: dbPath, holdMs } });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmcp-lock-'));
  tmpDirs.push(dir);
  return path.join(dir, 'registry.db');
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('SQLite parallel-process locking (331508ac)', () => {
  it('a bounded busy_timeout lets the second writer WAIT for the holder', async () => {
    const dbPath = makeDbPath();
    const holdMs = 200;
    const holder = startHolder(dbPath, holdMs);
    await holder.waitFor('locked');

    const { sqlite } = openRegistryDb({
      registryDbPath: dbPath,
      busyTimeoutMs: 3_000,
    });
    try {
      const started = Date.now();
      // Blocks in the native busy handler until the worker COMMITs, then succeeds.
      sqlite.prepare('INSERT INTO t (x) VALUES (?)').run(2);
      const waitedMs = Date.now() - started;

      expect(waitedMs).toBeGreaterThanOrEqual(holdMs - 50);
      const count = sqlite.prepare('SELECT COUNT(*) AS n FROM t').get() as {
        n: number;
      };
      expect(count.n).toBe(2);
    } finally {
      sqlite.close();
      await holder.stop();
    }
  });

  it('negative control: a configured zero budget surfaces SQLITE_BUSY immediately', async () => {
    const dbPath = makeDbPath();
    const holder = startHolder(dbPath, 400);
    await holder.waitFor('locked');

    const { sqlite } = openRegistryDb({ registryDbPath: dbPath, busyTimeoutMs: 0 });
    try {
      let thrown: { code?: string } | undefined;
      try {
        sqlite.prepare('INSERT INTO t (x) VALUES (?)').run(3);
      } catch (err) {
        thrown = err as { code?: string };
      }
      expect(thrown?.code).toBe('SQLITE_BUSY');
    } finally {
      sqlite.close();
      await holder.stop();
    }
  });
});
