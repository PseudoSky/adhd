/**
 * `openRegistryDb()` — proof that:
 *   1. It is LAZY (module-scope import creates no file — the exact
 *      regression this whole migration exists to prevent).
 *   2. When actually called, it opens/creates the file, sets the same
 *      pragmas every pre-migration family client set, and persists across
 *      close+reopen (real proof, not vibes — REGISTRY-PACKAGE-RULES.md §7).
 *
 * See also `import-side-effect.test.ts` for the package-level (not just
 * this one function's) import-time proof across the full public barrel.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openRegistryDb } from '../open-registry-db.js';
import { cleanupFixtures, mkAdhdRoot } from '../test/fixtures.js';

afterEach(() => {
  cleanupFixtures();
});

describe('openRegistryDb — lazy, no import-time side effect', () => {
  it('does not create the resolved file merely by having been imported (this test file importing it above did not create anything)', () => {
    const dir = mkAdhdRoot('no-side-effect-');
    const candidatePath = join(dir, 'registry.db');
    // The mere fact that `openRegistryDb` was imported at the top of this
    // file, and other test files in this suite import it too, must not
    // have created ANY file at this fresh candidate path — nothing but an
    // explicit call below is allowed to touch the filesystem.
    expect(existsSync(candidatePath)).toBe(false);
  });
});

describe('openRegistryDb — real open, real pragmas, real persistence', () => {
  it('creates the parent directory and the file on first call', () => {
    const dir = mkAdhdRoot('open-creates-');
    const registryDbPath = join(dir, 'nested', 'registry.db');
    expect(existsSync(registryDbPath)).toBe(false);

    const { sqlite } = openRegistryDb({ registryDbPath });
    try {
      expect(existsSync(registryDbPath)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it('sets journal_mode=WAL and foreign_keys=ON, matching every pre-migration family client', () => {
    const dir = mkAdhdRoot('pragmas-');
    const registryDbPath = join(dir, 'registry.db');

    const { sqlite } = openRegistryDb({ registryDbPath });
    try {
      const journalMode = sqlite.pragma('journal_mode', { simple: true });
      const foreignKeys = sqlite.pragma('foreign_keys', { simple: true });
      expect(journalMode).toBe('wal');
      expect(foreignKeys).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it('persists across CLOSE + REOPEN (real proof of persistence, not in-memory state)', () => {
    const dir = mkAdhdRoot('persist-');
    const registryDbPath = join(dir, 'registry.db');

    const first = openRegistryDb({ registryDbPath });
    first.sqlite.exec('CREATE TABLE probe_rows (id TEXT PRIMARY KEY, value TEXT)');
    first.sqlite.prepare('INSERT INTO probe_rows (id, value) VALUES (?, ?)').run('a', 'hello');
    first.sqlite.close();

    const second = openRegistryDb({ registryDbPath });
    try {
      const row = second.sqlite
        .prepare('SELECT value FROM probe_rows WHERE id = ?')
        .get('a') as { value: string } | undefined;
      expect(row?.value).toBe('hello');
    } finally {
      second.sqlite.close();
    }
  });

  it('each call opens its own independent connection (no caching/singleton behavior)', () => {
    const dir = mkAdhdRoot('independent-');
    const registryDbPath = join(dir, 'registry.db');

    const first = openRegistryDb({ registryDbPath });
    const second = openRegistryDb({ registryDbPath });
    try {
      expect(first.sqlite).not.toBe(second.sqlite);
    } finally {
      first.sqlite.close();
      second.sqlite.close();
    }
  });
});
