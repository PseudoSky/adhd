/**
 * DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-001 — legacy flat-path migration test
 * (design decision 3).
 *
 * The real machine's history: 48 agents live in the FLAT legacy
 * `~/.adhd/agent-mcp/agents.db` (pre-namespacing layout), while the canonical
 * namespaced store (`<HOME>/.adhd/agent-mcp/production/data/agents.db`) is
 * empty — so every future zero-config server would boot against an empty
 * store, and the global server only worked because the user-scope Claude Code
 * registration pins `ADHD_AGENT_DATABASE_PATH` to the flat path.
 *
 * `migrateLegacyOperationalDb()` is the one-time, idempotent, first-boot
 * copy: when the canonical store has ZERO agent rows AND the flat legacy DB
 * exists with rows, it copies the agents (and every same-shaped operational
 * table present in the flat DB) into the canonical store, then records a
 * marker row so it never re-runs.
 *
 * These tests build a REAL flat legacy DB (same drizzle migrations as
 * production) with N agents + operational rows, run the migration against an
 * empty canonical store, and prove: N rows land; a second run is a no-op
 * (still N, no duplicates); the flat file is never modified (opened
 * read-only); and a canonical store that already has agents is left alone.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { migrateLegacyOperationalDb, resolveFlatLegacyDbPath } from '../db/migrate-legacy.js';
import { runMigrationsOn } from '../db/migrate-runner.js';

const cleanupDirs: string[] = [];

function mkTmpDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `adhd-agent-mcp-${label}-`));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Opens (or creates) a SQLite DB at `filePath` and applies the REAL
 *  agent-mcp drizzle migrations — the exact schema production runs. */
function openMigratedDb(filePath: string): Database.Database {
  mkdirSync(dirname(filePath), { recursive: true });
  const sqlite = new Database(filePath);
  runMigrationsOn(sqlite, drizzle(sqlite));
  return sqlite;
}

const AGENT_INSERT = `
  INSERT INTO agents (name, version, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
`;

function seedAgents(conn: Database.Database, names: string[]): void {
  const insert = conn.prepare(AGENT_INSERT);
  const now = new Date().toISOString();
  conn.transaction(() => {
    for (const name of names) {
      insert.run(name, 1, JSON.stringify({ name }), now, now);
    }
  })();
}

const SESSION_INSERT = `
  INSERT INTO sessions (id, agent_name, agent_version, agent_data, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'active', ?, ?)
`;

function seedSessions(conn: Database.Database, rows: Array<{ id: string; agentName: string }>): void {
  const insert = conn.prepare(SESSION_INSERT);
  const now = new Date().toISOString();
  conn.transaction(() => {
    for (const row of rows) {
      insert.run(row.id, row.agentName, 1, JSON.stringify({ name: row.agentName }), now, now);
    }
  })();
}

function countRows(conn: Database.Database, table: string): number {
  return (conn.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

describe('DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-001 — legacy flat-path migration', () => {
  it('copies agents + same-shaped operational tables from the flat legacy DB into an empty canonical store, and is idempotent on re-run (marker + zero-agent guard)', () => {
    const flatDir = mkTmpDir('legacy-migration');
    const flatPath = join(flatDir, '.adhd', 'agent-mcp', 'agents.db'); // FLAT legacy layout
    const flat = openMigratedDb(flatPath);
    seedAgents(flat, ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5']); // N = 5
    seedSessions(flat, [
      { id: 'sess-1', agentName: 'agent-1' },
      { id: 'sess-2', agentName: 'agent-2' },
    ]);
    flat.close();

    const canonicalPath = join(mkTmpDir('legacy-migration-canon'), 'canonical', 'agents.db');
    const canonical = openMigratedDb(canonicalPath); // empty, fully migrated
    expect(countRows(canonical, 'agents')).toBe(0);

    // First run: migrates.
    const outcome = migrateLegacyOperationalDb(canonical, { flatDbPath: flatPath });
    expect(outcome.copied).toBe(true);
    expect(outcome.agentsCopied).toBe(5);
    expect(countRows(canonical, 'agents')).toBe(5);
    // Same-shaped operational tables land too.
    expect(countRows(canonical, 'sessions')).toBe(2);

    // Second run: idempotent — still 5, no duplicates, no re-copy.
    const again = migrateLegacyOperationalDb(canonical, { flatDbPath: flatPath });
    expect(again.copied).toBe(false);
    expect(countRows(canonical, 'agents')).toBe(5);
    expect(countRows(canonical, 'sessions')).toBe(2);

    // The flat legacy DB is untouched (opened read-only during migration).
    const flatCheck = openMigratedDb(flatPath);
    expect(countRows(flatCheck, 'agents')).toBe(5);
    flatCheck.close();

    canonical.close();
  });

  it('leaves a canonical store that already has agents alone (zero-agent guard) — never merges or duplicates', () => {
    const flatDir = mkTmpDir('legacy-migration-guard');
    const flatPath = join(flatDir, '.adhd', 'agent-mcp', 'agents.db');
    const flat = openMigratedDb(flatPath);
    seedAgents(flat, ['legacy-agent']);
    flat.close();

    const canonicalPath = join(mkTmpDir('legacy-migration-guard-canon'), 'canonical', 'agents.db');
    const canonical = openMigratedDb(canonicalPath);
    seedAgents(canonical, ['already-there']);

    const outcome = migrateLegacyOperationalDb(canonical, { flatDbPath: flatPath });

    expect(outcome.copied).toBe(false);
    expect(countRows(canonical, 'agents')).toBe(1);
    expect(countRows(canonical, 'agents')).not.toBe(2);

    // Marker recorded so the guard is stable across boots.
    const again = migrateLegacyOperationalDb(canonical, { flatDbPath: flatPath });
    expect(again.copied).toBe(false);

    canonical.close();
  });

  it('is a no-op when the flat legacy DB does not exist (fresh machines, or HOME isolated)', () => {
    const canonicalPath = join(mkTmpDir('legacy-migration-noflat'), 'canonical', 'agents.db');
    const canonical = openMigratedDb(canonicalPath);
    const missingFlat = join(mkTmpDir('legacy-migration-noflat-src'), 'does-not-exist', 'agents.db');

    const outcome = migrateLegacyOperationalDb(canonical, { flatDbPath: missingFlat });

    expect(outcome.copied).toBe(false);
    expect(countRows(canonical, 'agents')).toBe(0);

    canonical.close();
  });

  it('resolveFlatLegacyDbPath() derives the flat path from $HOME (testable override of os.homedir())', () => {
    const tmpHome = mkTmpDir('legacy-migration-home');
    const previous = process.env['HOME'];
    process.env['HOME'] = tmpHome;
    try {
      expect(resolveFlatLegacyDbPath()).toBe(join(tmpHome, '.adhd', 'agent-mcp', 'agents.db'));
    } finally {
      if (previous === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previous;
    }
  });

  it('flat DB with zero agents is a no-op, not an error', () => {
    const flatDir = mkTmpDir('legacy-migration-empty');
    const flatPath = join(flatDir, '.adhd', 'agent-mcp', 'agents.db');
    const flat = openMigratedDb(flatPath); // migrated but empty
    flat.close();

    const canonicalPath = join(mkTmpDir('legacy-migration-empty-canon'), 'canonical', 'agents.db');
    const canonical = openMigratedDb(canonicalPath);

    const outcome = migrateLegacyOperationalDb(canonical, { flatDbPath: flatPath });

    expect(outcome.copied).toBe(false);
    expect(countRows(canonical, 'agents')).toBe(0);

    canonical.close();
  });
});
