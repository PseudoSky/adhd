/**
 * open-registry-store.test.ts — the adapter-backed registry open
 * (ADR-0001 D4 step 1; backlog 331508ac).
 *
 * Asserts the two contract properties a consumer depends on:
 *   - the typed `busy_timeout` is applied (read back from the connection);
 *   - the store opens multiprocess-enabled (ADR-0001 D7 — `multiprocess-wal`,
 *     never the single-writer fallback, never an env toggle).
 * And that it is idempotent across independent opens of the same file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openRegistryStore } from '../index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../../');
const TMP_ROOT = path.join(REPO_ROOT, 'tmp', 'agent-core-env');

let tmpDir: string;

beforeAll(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  tmpDir = fs.mkdtempSync(path.join(TMP_ROOT, 'open-registry-store-'));
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('openRegistryStore (ADR-0001 D4 step 1)', () => {
  /** `pragmaGet` returns the PRAGMA's result rows; normalize to the scalar. */
  async function readBusyTimeout(
    adapter: Awaited<ReturnType<typeof openRegistryStore>>
  ): Promise<number> {
    const rows = (await adapter.pragmaGet('busy_timeout')) as Array<{
      busy_timeout: number;
    }>;
    return rows[0].busy_timeout;
  }

  it('applies the typed busy_timeout (read back from the connection)', async () => {
    const adapter = await openRegistryStore({
      registryDbPath: path.join(tmpDir, 'busy.db'),
      busyTimeoutMs: 1234,
    });
    try {
      expect(await readBusyTimeout(adapter)).toBe(1234);
    } finally {
      await adapter.close();
    }
  });

  it('defaults busy_timeout to 5000 when unset', async () => {
    const adapter = await openRegistryStore({
      registryDbPath: path.join(tmpDir, 'default.db'),
    });
    try {
      expect(await readBusyTimeout(adapter)).toBe(5000);
    } finally {
      await adapter.close();
    }
  });

  it('opens multiprocess-enabled (multiprocess-wal), never the single-writer fallback (D7)', async () => {
    const adapter = await openRegistryStore({
      registryDbPath: path.join(tmpDir, 'mode.db'),
    });
    try {
      expect(adapter.capabilities.walMode).toBe('multiprocess-wal');
      expect(adapter.capabilities.multiprocessWrite).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it('creates the store on a fresh path and can be reopened independently', async () => {
    const dbPath = path.join(tmpDir, 'reopen.db');
    const a1 = await openRegistryStore({ registryDbPath: dbPath });
    await a1.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)');
    await a1.transaction(
      async (tx) => {
        await tx.executeRun('INSERT INTO t DEFAULT VALUES');
      },
      { mode: 'immediate' }
    );
    await a1.close();

    const a2 = await openRegistryStore({ registryDbPath: dbPath });
    try {
      const row = (await a2.executeGet('SELECT COUNT(*) AS n FROM t')) as {
        n: number;
      };
      expect(row.n).toBe(1);
    } finally {
      await a2.close();
    }
  });
});
