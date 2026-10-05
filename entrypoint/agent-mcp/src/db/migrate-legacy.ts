/**
 * `migrate-legacy.ts` — idempotent, first-boot migration of the
 * FLAT legacy operational DB into the canonical namespaced store, plus a
 * marker-aware CATCH-UP for a store that kept growing after it was seeded
 * (DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-001, design decision 3; backlog
 * 7acc68c1).
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
 *  - Pinned-path exception (DEBT-AGENTMCP-MIGRATION-PINNED-MARKER-001): when
 *    the operational DB is itself pinned to the flat legacy path
 *    (`ADHD_AGENT_DATABASE_PATH` → the flat file, the exact configuration the
 *    global server runs under), `canonical` IS the flat file. In that case
 *    the migration is DEFERRED without writing anything — not even the
 *    marker, whose `CREATE TABLE`/`INSERT` would modify the very store this
 *    module promises to leave untouched. The deferral is logged explicitly;
 *    the namespaced store stays empty only until a zero-config boot resolves
 *    a distinct canonical path and performs the real copy.
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
 *  - Catch-up: when the marker shows a prior seed from the SAME flat file and
 *    the flat store has since GROWN, the new/updated rows are reconciled in
 *    (flat wins). This is what makes removing the flat pin safe — without it, a
 *    store seeded once and then kept live by the pin would silently strand
 *    every agent added afterwards (backlog 7acc68c1). `agents_copied === 0`
 *    (the zero-agent guard) never triggers a catch-up, so a canonical store
 *    that was authoritative from the start is never overwritten from legacy.
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
    | "flat-empty"
    | "deferred-pinned-flat";
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

/** The table's PRIMARY KEY columns in key order — the conflict target for the
 *  catch-up upsert (all eight operational tables have a single-column PK). */
function primaryKeyColumns(conn: Database.Database, table: string): string[] {
  return (
    conn.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; pk: number }>
  )
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

function countRows(conn: Database.Database, table: string): number {
  if (!tableExists(conn, table)) return 0;
  return (conn.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

interface LegacyMigrationMarker {
  source_path: string;
  agents_copied: number;
}

/** Reads the run-once marker row, if the marker table exists and carries one. */
function readMarker(conn: Database.Database): LegacyMigrationMarker | undefined {
  if (!tableExists(conn, LEGACY_MIGRATION_MARKER_TABLE)) return undefined;
  const row = conn
    .prepare(`SELECT source_path, agents_copied FROM "${LEGACY_MIGRATION_MARKER_TABLE}" WHERE id = 1`)
    .get() as LegacyMigrationMarker | undefined;
  return row;
}

/** Writes (or REFRESHES) the single marker row. The upsert is load-bearing: the
 *  catch-up path re-records its `agents_copied` watermark on the same row so a
 *  later boot sees flat == marker and stops. */
function writeMarker(conn: Database.Database, sourcePath: string, agentsCopied: number): void {
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
      `INSERT INTO "${LEGACY_MIGRATION_MARKER_TABLE}" (id, source_path, migrated_at, agents_copied)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source_path = excluded.source_path,
         migrated_at = excluded.migrated_at,
         agents_copied = excluded.agents_copied`,
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

interface CopyFlatOptions {
  /** `true` ⇒ an existing canonical row whose PK collides with a flat row is
   *  UPDATED from the flat row (flat wins) — the catch-up path, where the flat
   *  store is still the live source. `false` ⇒ INSERT OR IGNORE (first-boot
   *  seed into an empty canonical store). */
  overwriteExisting: boolean;
  flatDbPath: string;
  flatAgentCount: number;
  log: (level: "info" | "warn", message: string) => void;
}

/**
 * Copies every same-shaped operational table from the read-only `flat`
 * connection into `canonical`, then writes the marker — all in ONE
 * transaction, so the rows and the run-once marker commit or roll back
 * together. Returns the number of tables from which at least one row was
 * offered. Keeps the original inline copy's per-row best-effort semantics (a
 * single orphaned row must not drop its whole table).
 */
function copyFlatIntoCanonical(
  canonical: Database.Database,
  flat: Database.Database,
  opts: CopyFlatOptions,
): number {
  let copiedTables = 0;
  canonical.transaction(() => {
    for (const table of LEGACY_OPERATIONAL_TABLES) {
      if (!tableExists(flat, table)) continue;
      const flatCols = columnNames(flat, table);
      const canonicalCols = columnNames(canonical, table);
      if (flatCols.length === 0) continue;
      // Same-shaped only: copy the INTERSECTING columns, in flat's order.
      const cols = flatCols.filter((c) => canonicalCols.includes(c));
      if (cols.length === 0) continue; // no shared shape — skip, never guess

      const quoted = cols.map((c) => `"${c}"`).join(", ");
      const placeholders = cols.map(() => "?").join(", ");
      const pkCols = primaryKeyColumns(canonical, table).filter((c) => cols.includes(c));
      const updatable = cols.filter((c) => !pkCols.includes(c));
      const canUpsert = opts.overwriteExisting && pkCols.length > 0 && updatable.length > 0;
      const sql = canUpsert
        ? `INSERT INTO "${table}" (${quoted}) VALUES (${placeholders}) ` +
          `ON CONFLICT(${pkCols.map((c) => `"${c}"`).join(", ")}) ` +
          `DO UPDATE SET ${updatable.map((c) => `"${c}" = excluded."${c}"`).join(", ")}`
        : `INSERT OR IGNORE INTO "${table}" (${quoted}) VALUES (${placeholders})`;

      try {
        const rows = flat
          .prepare(`SELECT ${quoted} FROM "${table}"`)
          .all() as Array<Record<string, unknown>>;
        const insert = canonical.prepare(sql);
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
          opts.log("warn", `migrate-legacy: skipped ${skipped} orphaned/invalid row(s) in "${table}"`);
        }
      } catch (err) {
        // Table-level failure (e.g. the read itself) — never abort the boot.
        opts.log("warn", `migrate-legacy: skipping "${table}" (${(err as Error).message})`);
      }
    }
    writeMarker(canonical, opts.flatDbPath, opts.flatAgentCount);
  })();
  return copiedTables;
}

/**
 * Runs the flat → namespaced migration on the OPEN canonical connection
 * (`sqlite` from `db/client.ts`, after the drizzle migrations have run — see
 * `db/migrate.ts`).
 *
 * Two modes, both idempotent:
 *  - FIRST BOOT (no marker): seed an empty canonical store from the flat legacy
 *    DB, then record the run-once marker.
 *  - CATCH-UP (marker present + the flat store has GROWN since it was seeded):
 *    the pin kept the flat store live after the seed, so reconcile the delta
 *    (flat wins) and refresh the marker — without this, a store seeded early
 *    and then kept growing would silently strand every later agent once the
 *    pin is removed (backlog 7acc68c1).
 *
 * @returns the outcome describing what happened.
 */
export function migrateLegacyOperationalDb(
  canonical: Database.Database,
  opts: MigrateLegacyOptions = {},
): LegacyMigrationOutcome {
  const flatDbPath = opts.flatDbPath ?? resolveFlatLegacyDbPath();
  const log = opts.log ?? ((level, message) => console[level](message));

  // DEBT-AGENTMCP-MIGRATION-PINNED-MARKER-001: when the operational DB is
  // pinned (`ADHD_AGENT_DATABASE_PATH` → the flat legacy path — the exact
  // configuration the global server runs under), `canonical` IS the flat
  // file. Recording the marker here would `CREATE TABLE`/`INSERT` on the
  // very store this module promises never to modify, and the "copy" would be
  // flat→same-file. Detect the pin via the canonical connection's own file
  // path (better-sqlite3 `db.name`), compared with the SAME `path.resolve`
  // lexical normalization `db/client.ts` applies to the canonical path. On a
  // pin, defer WITHOUT writing anything and log it explicitly — the
  // namespaced store stays empty only until a zero-config boot.
  const canonicalDbPath = path.resolve(canonical.name);
  if (canonicalDbPath === path.resolve(flatDbPath)) {
    log(
      "info",
      `migrate-legacy: deferred — operational DB is pinned to the flat legacy path "${canonicalDbPath}"; ` +
        "not modifying the flat store; the namespaced migration runs at a zero-config boot " +
        "(DEBT-AGENTMCP-MIGRATION-PINNED-MARKER-001)",
    );
    return { copied: false, agentsCopied: 0, reason: "deferred-pinned-flat" };
  }

  if (!fs.existsSync(flatDbPath)) {
    return { copied: false, agentsCopied: 0, reason: "no-flat-db" };
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

  const marker = readMarker(canonical);

  // Read-only over the flat file — never modify the legacy store (a resident
  // server pinned via ADHD_AGENT_DATABASE_PATH may still be writing it).
  const flat = new Database(flatDbPath, { readonly: true });
  try {
    const flatAgentCount = countRows(flat, "agents");

    if (marker) {
      // CATCH-UP (backlog 7acc68c1): the marker proves a prior run seeded the
      // canonical store from THIS flat file. Only reconcile when the flat store
      // has GROWN since then — the pin kept it live after the seed, so its
      // newer rows must not be stranded. `agents_copied === 0` is the
      // zero-agent-guard case (canonical was authoritative, nothing seeded), so
      // it is deliberately NOT a catch-up trigger.
      const sameSource = path.resolve(marker.source_path) === path.resolve(flatDbPath);
      const grew = marker.agents_copied > 0 && flatAgentCount > marker.agents_copied;
      if (!(sameSource && grew)) {
        return { copied: false, agentsCopied: 0, reason: "already-migrated" };
      }
      copyFlatIntoCanonical(canonical, flat, {
        overwriteExisting: true,
        flatDbPath,
        flatAgentCount,
        log,
      });
      return { copied: true, agentsCopied: flatAgentCount, reason: "copied" };
    }

    // Zero-agent guard: canonical is authoritative. Record the marker so this
    // guard is stable (deleting all agents later must not resurrect legacy rows).
    if (countRows(canonical, "agents") > 0) {
      writeMarker(canonical, flatDbPath, 0);
      return { copied: false, agentsCopied: 0, reason: "canonical-populated" };
    }
    if (flatAgentCount === 0) {
      writeMarker(canonical, flatDbPath, 0);
      return { copied: false, agentsCopied: 0, reason: "flat-empty" };
    }

    copyFlatIntoCanonical(canonical, flat, {
      overwriteExisting: false,
      flatDbPath,
      flatAgentCount,
      log,
    });
    return { copied: true, agentsCopied: flatAgentCount, reason: "copied" };
  } finally {
    flat.close();
  }
}
