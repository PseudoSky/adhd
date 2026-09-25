/**
 * seed.spec.ts
 *
 * Proves the prompts seeder writes each component's head + version pair
 * atomically (BUG c757dd2e): a failure on the version insert must roll the head
 * back with it.
 *
 * Negative-control tooth: the rollback assertion (`headCount === 0`,
 * `versionCount === 0`). On the pre-fix code the head insert autocommits before
 * the version insert aborts, leaving a head row with no version — `headCount ===
 * 1` — so this assertion is RED pre-fix.
 *
 * Forward guard (NOT a red→green tooth): the recovery assertion at the end
 * (drop the trigger, re-seed → head 1 / version 1). It also PASSES on the pre-fix
 * code, because the version insert is keyed on the version's own absence and is
 * independent of the head check, so a later seed() heals a partial row on its
 * own. It guards the invariant that a failed seed does not wedge future seeds —
 * it does not show that the transaction is what makes recovery possible.
 *
 * Real on-disk temp DB + real migrations; no mocks. Gate on the vitest EXIT
 * code, not stdout.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from '../db/schema.js';
import { seed } from '../seed/index.js';
import { SEED_COMPONENTS } from '../seed/components.js';

const MIGRATIONS_FOLDER = path.resolve(
  new URL('../../drizzle', import.meta.url).pathname
);

describe('seed() — head+version atomicity', () => {
  let dbPath: string;
  let conn: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;

  // Seed the FIRST component so ordering cannot muddy the assertion: on a clean
  // DB it is the very first head+version pair written.
  const targetSlug = SEED_COMPONENTS[0].slug;

  beforeAll(() => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agent-registry-seed-test-')
    );
    dbPath = path.join(tmpDir, 'test-seed.db');

    conn = new Database(dbPath);
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = OFF'); // FK-safe migration runner pattern
    db = drizzle(conn, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    conn.pragma('foreign_keys = ON');
  });

  afterAll(() => {
    // Close before unlinking — avoids WAL teardown race
    conn.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        /* ignore */
      }
    }
  });

  function headCount(slug: string): number {
    const row = conn
      .prepare('SELECT count(*) AS n FROM registry_components WHERE slug = ?')
      .get(slug) as { n: number };
    return row.n;
  }

  function versionCount(slug: string): number {
    const row = conn
      .prepare(
        'SELECT count(*) AS n FROM registry_component_versions WHERE slug = ?'
      )
      .get(slug) as { n: number };
    return row.n;
  }

  it('rolls the component head back when the version insert fails, then re-seeds cleanly', () => {
    // ── Induce a failure scoped to exactly the target slug's version insert ──
    conn.exec(
      "CREATE TRIGGER seed_boom AFTER INSERT ON registry_component_versions " +
        `WHEN NEW.slug = '${targetSlug}' ` +
        "BEGIN SELECT RAISE(ABORT, 'boom'); END;"
    );

    expect(() => seed(db)).toThrow();

    // TOOTH (negative control): the head must NOT survive the failed version
    // insert. Pre-fix this is 1 (committed head, aborted version) → test is RED.
    expect(headCount(targetSlug)).toBe(0);
    expect(versionCount(targetSlug)).toBe(0);

    // ── Forward guard: drop the trigger and re-seed — the pair must land ─────
    // This also passes on the pre-fix code (the version insert is keyed on the
    // version's own absence, independent of the head check); only the rollback
    // assertions above are the red→green tooth.
    conn.exec('DROP TRIGGER seed_boom');
    expect(() => seed(db)).not.toThrow();

    expect(headCount(targetSlug)).toBe(1);
    expect(versionCount(targetSlug)).toBe(1);
  });
});
