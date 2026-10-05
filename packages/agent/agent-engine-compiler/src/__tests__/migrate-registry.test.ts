/**
 * migrate-registry.test.ts — the centralized registry migration call
 * (backlog 1ef6134d).
 *
 * `migrateRegistry(sqlite)` runs ALL FIVE registry-family migration sets on ONE
 * shared SQLite connection, in canonical ascending-timestamp order. This test
 * proves the consumer-visible outcome: a fresh, empty database gains every
 * family's canonical tables in one call — the "no such table" class the backlog
 * item is about — and that the call is idempotent.
 *
 * Teeth: a negative control shows an un-migrated connection on the same fresh
 * file has NONE of those tables, so the assertion is genuinely driven by
 * `migrateRegistry` and not by an import-time side effect.
 *
 * Real on-disk file, never `:memory:`. Gate on the vitest EXIT CODE.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateRegistry } from '../index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../../');
const TMP_ROOT = path.join(REPO_ROOT, 'tmp', 'agent-engine-compiler');

/** The four canonical family tables (the compiler set currently owns no
 *  domain table of its own, only its own migration journal entries). */
const REQUIRED_TABLES = [
  'provider_providers', // agent-core-provider
  'registry_agents', // agent-store-prompts
  'tool_types', // agent-store-tools
  'policy_policy_types', // agent-core-policy
];

function tableNames(conn: Database.Database): Set<string> {
  return new Set(
    (
      conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
  );
}

describe('migrateRegistry — one call runs all five registry-family migration sets (1ef6134d)', () => {
  let tmpDir: string;

  beforeAll(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(TMP_ROOT, 'migrate-registry-'));
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('teeth: a fresh, un-migrated registry DB has NONE of the family tables', () => {
    const dbPath = path.join(tmpDir, 'bare.db');
    const conn = new Database(dbPath);
    try {
      const names = tableNames(conn);
      for (const t of REQUIRED_TABLES) {
        expect(names.has(t)).toBe(false);
      }
      // The canonical tables genuinely do not exist until migrateRegistry runs.
      expect(() =>
        conn.prepare('SELECT * FROM registry_agents').all()
      ).toThrow(/no such table/i);
    } finally {
      conn.close();
    }
  });

  it('creates every registry-family table on a fresh DB in one call', () => {
    const dbPath = path.join(tmpDir, 'migrated.db');
    const conn = new Database(dbPath);
    conn.pragma('journal_mode = WAL');
    try {
      migrateRegistry(conn);

      const names = tableNames(conn);
      for (const t of REQUIRED_TABLES) {
        expect(names.has(t)).toBe(true);
      }

      // All five sets contribute journal rows (each package ships ≥1 migration
      // file), so the shared journal holds at least five entries. This is what
      // distinguishes "all five ran" from "only the first four".
      const journal = conn
        .prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations')
        .get() as { n: number };
      expect(journal.n).toBeGreaterThanOrEqual(5);

      // And the tables are actually queryable (not merely present in the DDL).
      expect(conn.prepare('SELECT COUNT(*) AS n FROM registry_agents').get()).toEqual({
        n: 0,
      });
    } finally {
      conn.close();
    }
  });

  it('is idempotent — a second call on the same connection is a no-op', () => {
    const dbPath = path.join(tmpDir, 'idempotent.db');
    const conn = new Database(dbPath);
    conn.pragma('journal_mode = WAL');
    try {
      migrateRegistry(conn);
      const afterFirst = tableNames(conn);
      const journalAfterFirst = (
        conn.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as {
          n: number;
        }
      ).n;

      expect(() => migrateRegistry(conn)).not.toThrow();

      const journalAfterSecond = (
        conn.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as {
          n: number;
        }
      ).n;
      expect(journalAfterSecond).toBe(journalAfterFirst);
      expect(tableNames(conn)).toEqual(afterFirst);
    } finally {
      conn.close();
    }
  });

  it('persists across close + reopen (real on-disk file)', () => {
    const dbPath = path.join(tmpDir, 'reopen.db');
    const conn = new Database(dbPath);
    conn.pragma('journal_mode = WAL');
    migrateRegistry(conn);
    conn.close();

    const reopened = new Database(dbPath);
    try {
      const names = tableNames(reopened);
      for (const t of REQUIRED_TABLES) {
        expect(names.has(t)).toBe(true);
      }
    } finally {
      reopened.close();
    }
  });
});
