/**
 * `migrate-legacy.ts` — one-time, idempotent, first-boot migration of the
 * FLAT legacy operational DB into the canonical namespaced store
 * (DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-001, design decision 3).
 *
 * History: before the namespacing redesign, agent-mcp's operational store
 * lived at the FLAT `~/.adhd/agent-mcp/agents.db`. The redesign moved the
 * zero-config location to the namespaced, user-global
 * `~/.adhd/agent-mcp/production/data/agents.db`, but existing installs keep
 * their real agents (and sessions/messages/tasks/…) in the flat file — a
 * zero-config server would boot against an EMPTY namespaced store and the 48
 * real agents would be invisible (the global server only worked because the
 * user-scope Claude Code registration pins `ADHD_AGENT_DATABASE_PATH` to the
 * flat path).
 *
 * This module copies the flat legacy DB's operational rows into the canonical
 * store exactly once, on first boot, then records a marker row so it never
 * re-runs. The copy is a row-level INSERT (never a file move/copy): the
 * canonical store's schema is the CURRENT migration state, which may be newer
 * than the flat file's, and the flat file must remain untouched (it may still
 * be open read-write by a resident server pinned via
 * `ADHD_AGENT_DATABASE_PATH`).
 *
 * Safety guarantees:
 *  - Read-only over the flat file (a separate `{ readonly: true }`
 *    better-sqlite3 connection) — the legacy file is never modified.
 *  - Zero-agent guard: if the canonical store ALREADY has agent rows, nothing
 *    is copied (canonical is authoritative; no merging, no duplication) and
 *    the marker is still recorded so the guard is stable across boots.
 *  - Marker: a `__legacy_db_migration` row (written in the SAME transaction
 *    as the copy) makes the whole migration run-once; deleting all canonical
 *    agents later can never resurrect legacy rows.
 *  - Same-shaped tables only: each operational table's copied column list is
 *    the INTERSECTION of the flat and canonical column sets, so a schema
 *    drift (newer/older migrations on either side) degrades gracefully.
 *  - Best-effort per table: a failure on one table (e.g. an orphaned FK
 *    reference) skips that table and logs, never aborting the boot.
 *
 * Ordering (see `db/migrate.ts`): this runs AFTER the drizzle migrations, so
 * the canonical tables always exist with the full current schema. (Running it
 * before migrations would be unsafe: drizzle migration 0000 uses a bare
 * `CREATE TABLE` and later migrations `ALTER TABLE`, so a pre-created or
 * old-shape table would break them.)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

/** The operational tables whose rows are migrated flat → namespaced.
 *  `agents` first: sessions/tasks reference it (FK). */
export const LEGACY_OPERATIONAL_TABLES: readonly string[] = [
  "agents",
  "sessions",
  "messages",
  "tasks",
  "task_events",
  "task_usage",
  "composed_prompts",
  "experiment_assignments",
];

/** Marker table + single row recording that the migration already ran. */
export const LEGACY_MIGRATION_MARKER_TABLE = "__legacy_db_migration";

export interface LegacyMigrationOutcome {
  /** `true` when rows were actually copied this run. */
  copied: boolean;
  /** Number of agent rows copied (when `copied`). */
  agentsCopied: number;
  /** Why the migration did (or didn't) do work. */
  reason:
    | "copied"
    | "no-flat-db"
    | "already-migrated"
    | "canonical-populated"
    | "canonical-not-migrated"
    | "flat-empty";
}

/** The flat legacy path: `~/.adhd/agent-mcp/agents.db`. `$HOME` wins over
 *  `os.homedir()` so tests (and containers) can isolate it deterministically. */
export function resolveFlatLegacyDbPath(home?: string): string {
  const effectiveHome = home ?? process.env['HOME'] ?? os.homedir();
  return path.join(effectiveHome, ".adhd", "agent-mcp", "agents.db");
}

function tableExists(conn: Database.Database, name: string): boolean {
  return (
    conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function columnNames(conn: Database.Database, table: string): string[] {
  return (conn.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function countRows(conn: Database.Database, table: string): number {
  if (!tableExists(conn, table)) return 0;
  return (conn.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

function markerRecorded(conn: Database.Database): boolean {
  if (!tableExists(conn, LEGACY_MIGRATION_MARKER_TABLE)) return false;
  return conn.prepare(`SELECT 1 FROM "${LEGACY_MIGRATION_MARKER_TABLE}" LIMIT 1`).get() !== undefined;
}

function recordMarker(conn: Database.Database, sourcePath: string, agentsCopied: number): void {
  conn
    .prepare(
      `CREATE TABLE IF NOT EXISTS "${LEGACY_MIGRATION_MARKER_TABLE}" (
         id INTEGER PRIMARY KEY,
         source_path TEXT NOT NULL,
         migrated_at TEXT NOT NULL,
         agents_copied INTEGER NOT NULL
       )`,
    )
    .run();
  conn
    .prepare(
      `INSERT OR IGNORE INTO "${LEGACY_MIGRATION_MARKER_TABLE}" (id, source_path, migrated_at, agents_copied)
       VALUES (1, ?, ?, ?)`,
    )
    .run(sourcePath, new Date().toISOString(), agentsCopied);
}

export interface MigrateLegacyOptions {
  /** Override for the flat legacy DB path (test isolation). Defaults to
   *  `resolveFlatLegacyDbPath()`. */
  flatDbPath?: string;
  /** Best-effort log sink; defaults to `console`. */
  log?: (level: "info" | "warn", message: string) => void;
}

/**
 * Runs the one-time flat → namespaced migration on the OPEN canonical
 * connection (`sqlite` from `db/client.ts`, after the drizzle migrations have
 * run — see `db/migrate.ts`).
 *
 * @returns the outcome describing what happened.
 */
export function migrateLegacyOperationalDb(
  canonical: Database.Database,
  opts: MigrateLegacyOptions = {},
): LegacyMigrationOutcome {
  const flatDbPath = opts.flatDbPath ?? resolveFlatLegacyDbPath();
  const log = opts.log ?? ((level, message) => console[level](message));

  if (!fs.existsSync(flatDbPath)) {
    return { copied: false, agentsCopied: 0, reason: "no-flat-db" };
  }
  if (markerRecorded(canonical)) {
    return { copied: false, agentsCopied: 0, reason: "already-migrated" };
  }

  // Zero-agent guard: canonical is authoritative. Record the marker so this
  // guard is stable (deleting all agents later must not resurrect legacy rows).
  if (countRows(canonical, "agents") > 0) {
    recordMarker(canonical, flatDbPath, 0);
    return { copied: false, agentsCopied: 0, reason: "canonical-populated" };
  }

  // Production always runs this AFTER the drizzle migrations (see
  // `db/migrate.ts`), so the canonical schema exists. Defend the direct-call
  // API against a schema-less canonical: copying would be a silent no-op
  // dressed up as success, so refuse and leave the marker unset (a later boot
  // after migrations can still perform the real copy).
  if (!tableExists(canonical, "agents")) {
    log("warn", "migrate-legacy: canonical DB has no agents table — run the drizzle migrations first; skipping");
    return { copied: false, agentsCopied: 0, reason: "canonical-not-migrated" };
  }

  // Read-only over the flat file — never modify the legacy store (a resident
  // server pinned via ADHD_AGENT_DATABASE_PATH may still be writing it).
  const flat = new Database(flatDbPath, { readonly: true });
  try {
    const flatAgentCount = countRows(flat, "agents");
    if (flatAgentCount === 0) {
      recordMarker(canonical, flatDbPath, 0);
      return { copied: false, agentsCopied: 0, reason: "flat-empty" };
    }

    const doCopy = canonical.transaction(() => {
      let copiedTables = 0;
      for (const table of LEGACY_OPERATIONAL_TABLES) {
        if (!tableExists(flat, table)) continue;
        const flatCols = columnNames(flat, table);
        const canonicalCols = columnNames(canonical, table);
        if (flatCols.length === 0) continue;
        // Same-shaped only: copy the INTERSECTING columns, in flat's order.
        const cols = flatCols.filter((c) => canonicalCols.includes(c));
        if (cols.length === 0) continue; // no shared shape — skip, never guess
        try {
          const rows = flat
            .prepare(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${table}"`)
            .all() as Array<Record<string, unknown>>;
          const insert = canonical.prepare(
            `INSERT OR IGNORE INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")})
             VALUES (${cols.map(() => "?").join(", ")})`,
          );
          // Best-effort PER ROW: a single orphaned row (e.g. a session whose
          // agent was deleted from the legacy store — real flat DBs carry
          // these) must not drop the whole table. An error aborts only the
          // current statement; the enclosing transaction stays open.
          let skipped = 0;
          for (const row of rows) {
            try {
              insert.run(...cols.map((c) => row[c]));
            } catch {
              skipped++;
            }
          }
          copiedTables++;
          if (skipped > 0) {
            log("warn", `migrate-legacy: skipped ${skipped} orphaned/invalid row(s) in "${table}"`);
          }
        } catch (err) {
          // Table-level failure (e.g. the read itself) — never abort the boot.
          log("warn", `migrate-legacy: skipping "${table}" (${(err as Error).message})`);
        }
      }
      recordMarker(canonical, flatDbPath, flatAgentCount);
      return copiedTables;
    });
    doCopy();

    return { copied: true, agentsCopied: flatAgentCount, reason: "copied" };
  } finally {
    flat.close();
  }
}
