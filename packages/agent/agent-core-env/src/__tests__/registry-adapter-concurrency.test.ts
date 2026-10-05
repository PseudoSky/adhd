/**
 * registry-adapter-concurrency.test.ts — the ADR-0001 D5 acceptance gate for
 * backlog 331508ac: a REAL two-OS-process concurrency proof against the sox
 * store adapter (Turso), with a negative control that must go RED on the
 * pre-migration better-sqlite3 build.
 *
 * GREEN: two real processes (the holder is `fork`ed; the parent is its own OS
 * process) each open their OWN adapter connection to ONE on-disk store. The
 * holder takes a `BEGIN IMMEDIATE` lock; the parent's contending
 * read-modify-write runs through `withImmediateRetry` and RECOVERS — both rows
 * land and no raw driver/busy error reaches the caller.
 *
 * RED (negative control): the IDENTICAL contention against a pre-migration
 * better-sqlite3 holder makes a bare `busy_timeout = 0` contender throw a raw
 * `SQLITE_BUSY`. That is the red baseline — if the store were reverted to
 * better-sqlite3, the GREEN assertion's whole point is lost, and this control
 * documents exactly what the caller would see instead.
 *
 * Trust the runner EXIT CODE; better-sqlite3 can segfault at teardown.
 */
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openRegistryStore, withImmediateRetry } from '../index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../../');
const TMP_ROOT = path.join(REPO_ROOT, 'tmp', 'agent-core-env');

const TURSO_HOLDER = fileURLToPath(
  new URL('./fixtures/turso-lock-holder.mjs', import.meta.url)
);
const SQLITE_HOLDER = fileURLToPath(
  new URL('./fixtures/sqlite-lock-holder.cjs', import.meta.url)
);

interface IHolder {
  waitFor(type: string): Promise<void>;
  stop(): Promise<void>;
}

const children: ChildProcess[] = [];

function startHolder(fixture: string, dbPath: string, holdMs: number): IHolder {
  const child = fork(fixture, [dbPath, String(holdMs)], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  children.push(child);
  const seen = new Set<string>();
  const waiters: Array<() => void> = [];
  child.on('message', (m: { type?: string }) => {
    if (m?.type) seen.add(m.type);
    waiters.splice(0).forEach((w) => w());
  });
  return {
    async waitFor(type: string) {
      while (!seen.has(type)) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    },
  };
}

let seq = 0;
function makeDbPath(name: string): string {
  return path.join(TMP_ROOT, `${name}-${process.pid}-${seq++}.db`);
}

beforeAll(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
});

afterAll(() => {
  children.splice(0).forEach((c) => {
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  });
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** A minimal `{ transaction }` double — `withImmediateRetry` only calls that. */
type FakeAdapter = Parameters<typeof withImmediateRetry>[0];

function busyError(): Error & { code: string } {
  const err = new Error('database is locked') as Error & { code: string };
  err.code = 'SQLITE_BUSY';
  return err;
}

describe('withImmediateRetry — AC4 (BEGIN IMMEDIATE) + AC5 (bounded busy-only retry)', () => {
  it('AC4: runs the body inside adapter.transaction(fn, { mode: "immediate" })', async () => {
    let seenOpts: unknown;
    const adapter: FakeAdapter = {
      transaction: async (fn, opts) => {
        seenOpts = opts;
        return fn({} as never);
      },
    };
    const out = await withImmediateRetry(adapter, () => 'ok');
    expect(out).toBe('ok');
    expect(seenOpts).toEqual({ mode: 'immediate' });
  });

  it('AC5: retries a busy-shaped error then succeeds', async () => {
    let calls = 0;
    const adapter: FakeAdapter = {
      transaction: async (fn) => {
        calls++;
        if (calls <= 2) throw busyError();
        return fn({} as never);
      },
    };
    const out = await withImmediateRetry(adapter, () => 'ok', {
      baseDelayMs: 1,
      maxDelayMs: 2,
    });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('AC5: a non-busy error propagates unretried', async () => {
    let calls = 0;
    const adapter: FakeAdapter = {
      transaction: async () => {
        calls++;
        throw new Error('boom');
      },
    };
    await expect(
      withImmediateRetry(adapter, () => 'ok', { baseDelayMs: 1 })
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  it('AC5: a bounded busy pileup rethrows after maxAttempts', async () => {
    let calls = 0;
    const adapter: FakeAdapter = {
      transaction: async () => {
        calls++;
        throw busyError();
      },
    };
    await expect(
      withImmediateRetry(adapter, () => 'ok', {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
      })
    ).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    expect(calls).toBe(3);
  });
});

describe('D5: real two-process contention on the sox store adapter', () => {
  it('GREEN: a contended read-modify-write recovers — no raw busy error, both writes land', async () => {
    const dbPath = makeDbPath('adapter-green');
    const holder = startHolder(TURSO_HOLDER, dbPath, 400);
    await holder.waitFor('locked');

    // busy_timeout: 0 → the very first BEGIN IMMEDIATE throws busy immediately,
    // so ONLY the bounded retry can make this succeed.
    const adapter = await openRegistryStore({
      registryDbPath: dbPath,
      busyTimeoutMs: 0,
    });
    try {
      await withImmediateRetry(
        adapter,
        async (tx) => {
          await tx.executeRun("INSERT INTO t (who) VALUES ('main')");
        },
        { maxAttempts: 40, baseDelayMs: 20, maxDelayMs: 100 }
      );

      await holder.waitFor('committed');

      const row = (await adapter.executeGet(
        'SELECT COUNT(*) AS n FROM t'
      )) as { n: number };
      expect(row.n).toBe(2);
    } finally {
      await adapter.close();
      await holder.stop();
    }
  }, 60_000);

  it('RED (negative control): the IDENTICAL contention on the pre-migration better-sqlite3 build throws a raw SQLITE_BUSY', async () => {
    const dbPath = makeDbPath('sqlite-red');
    const holder = startHolder(SQLITE_HOLDER, dbPath, 400);
    await holder.waitFor('locked');

    const db = new Database(dbPath);
    db.pragma('busy_timeout = 0');
    try {
      let thrown: unknown;
      try {
        db.prepare("INSERT INTO t (who) VALUES ('main')").run();
      } catch (err) {
        thrown = err;
      }
      // The pre-migration substrate surfaces lock contention as a raw driver
      // error — exactly what the adapter path above does NOT.
      expect((thrown as { code?: string } | undefined)?.code).toBe('SQLITE_BUSY');
    } finally {
      db.close();
      await holder.stop();
    }
  }, 60_000);
});
