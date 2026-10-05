/**
 * `migrate-legacy.ts` — idempotent, first-boot migration of the
 * FLAT legacy operational DB into the canonical namespaced store, plus a
 * marker-aware CATCH-UP for a store that kept growing after it was seeded
 * (DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-001, design decision 3; backlog
 * 7acc68c1; delta-scope fix 80b61a7d).
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
 *  - Catch-up is DELTA-SCOPED and can never revert a canonical write. When the
 *    marker shows a prior seed from the SAME flat file and the flat source has
 *    CHANGED since the last reconciliation, the delta is reconciled in: a row
 *    absent from canonical is INSERTed, and a row whose flat copy is strictly
 *    NEWER than canonical's is UPDATEd. A canonical row that is as-new-or-newer
 *    is never touched — an unconditional upsert that DO-UPDATEs every
 *    overlapping row of every table would revert canonical rows written after
 *    the seed (bug 80b61a7d: canonical agent-1 @v99 / agent-2 @v42 reverted to
 *    flat's v1 the moment the flat agent count grew 3→5). Per-row recency is
 *    the explicit monotonic `version` where a table has one (agents), else
 *    `updated_at`, else the numeric `model_calls` counter (task_usage), else
 *    `created_at`; a table with none is insert-only. The UPDATE carries the
 *    recency comparison in its own `WHERE`, so it is atomic under concurrent
 *    writers (ADR-0012 — the store is parallel-process enabled; there is no
 *    single-writer assumption here).
 *  - Catch-up trigger is flat CONTENT change, not agent-count growth alone.
 *    Each reconciliation records a per-table watermark (row count, max rowid,
 *    recency aggregate) in the marker; a later boot reconciles when any of
 *    those moved. This is what makes a constant-agent-count but edited flat
 *    store reconcile (an agent revised in place bumps `SUM(version)`) — the
 *    old `flatAgentCount > marker.agents_copied` trigger missed it entirely.
 *    `agents_copied === 0` (the zero-agent guard) never triggers a catch-up, so
 *    a canonical store that was authoritative from the start is never
 *    overwritten from legacy. This is what makes removing the flat pin safe:
 *    without it, a store seeded once and then kept live by the pin would
 *    silently strand every agent added afterwards (backlog 7acc68c1).
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
    | "deferred-pinned-flat"
    /** `opts.skipLegacyMigration` was set (backlog af567fb8): the flat legacy
     *  store is never opened or read — used by hermetic test harnesses so a
     *  fresh scratch DB is not seeded from the developer's real store. */
    | "skipped"
    /** A seed that did not land every offered agent row — rolled back, marker
     *  unwritten, retried on the next boot (bug 0ea16bf1). */
    | "seed-incomplete";
}

/** What a single column is for recency purposes: `version` is the explicit
 *  monotonic agent counter; the text columns are ISO-8601 timestamps, which
 *  order lexicographically. */
interface RecencyColumn {
  col: string;
  /** `true` for the numeric `version` counter (aggregate with SUM so an
   *  in-place edit anywhere in the table is visible), `false` for a timestamp
   *  (aggregate with MAX, since a write sets it to "now"). */
  numeric: boolean;
}

/** Per-table fingerprint of the flat source as of the last reconciliation.
 *  Used purely as the catch-up TRIGGER; the per-row recency guard is what
 *  makes reconciliation safe. */
interface TableWatermark {
  rows: number;
  maxRowid: number;
  /** `SUM(version)` for version-bearing tables, else `MAX(updated_at)` /
   *  `MAX(created_at)`, else `null` when the table carries no recency column. */
  recency: string | number | null;
}
type FlatWatermarks = Record<string, TableWatermark>;

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

/**
 * Chooses the per-table recency column used for BOTH the catch-up trigger's
 * watermark and the per-row UPDATE guard. Preference: the explicit monotonic
 * `version` (agents), then `updated_at` (sessions, tasks), then the numeric
 * `model_calls` counter (task_usage), then `created_at` (append-only tables).
 * A table with none is insert-only.
 */
function recencyColumn(cols: readonly string[]): RecencyColumn | undefined {
  if (cols.includes("version")) return { col: "version", numeric: true };
  if (cols.includes("updated_at")) return { col: "updated_at", numeric: false };
  // task_usage carries NEITHER a version NOR an updated_at: its rows are
  // upserted IN PLACE after insert (usage-plugin accumulates `model_calls` /
  // token counters and flips `is_complete`), so `created_at` never moves and a
  // continued task's flat row is invisible to a timestamp-only guard (backlog
  // b530f68f). `model_calls` is the monotonic signal that DOES move: the
  // upsert adds 1 on every model response, `task_id` is a UUID so both stores'
  // rows are the SAME task, and the larger counter is strictly further along.
  // Aggregate with SUM (like `version`) so any row's increment moves the
  // watermark; the per-row guard then reconciles flat only when its counter is
  // strictly greater. Residual safe gap (documented, asserted by test): a
  // completion-only edit (`is_complete` 0→1, `latency_ms`) that adds no further
  // model call is declined — it never reverts a canonical write.
  if (cols.includes("model_calls")) return { col: "model_calls", numeric: true };
  if (cols.includes("created_at")) return { col: "created_at", numeric: false };
  return undefined;
}

/** Fingerprints every operational table present in the flat source. */
function computeFlatWatermarks(flat: Database.Database): FlatWatermarks {
  const out: FlatWatermarks = {};
  for (const table of LEGACY_OPERATIONAL_TABLES) {
    if (!tableExists(flat, table)) continue;
    const cols = columnNames(flat, table);
    if (cols.length === 0) continue;
    const rec = recencyColumn(cols);
    let recencyExpr = "NULL";
    if (rec) recencyExpr = rec.numeric ? `SUM("${rec.col}")` : `MAX("${rec.col}")`;
    const row = flat
      .prepare(
        `SELECT COUNT(*) AS rows, COALESCE(MAX(rowid), 0) AS maxRowid, ` +
          `${recencyExpr} AS recency FROM "${table}"`,
      )
      .get() as { rows: number; maxRowid: number; recency: string | number | null };
    out[table] = { rows: row.rows, maxRowid: row.maxRowid, recency: row.recency };
  }
  return out;
}

/** `true` when the flat source differs from the watermark of the last
 *  reconciliation in any table's row count, max rowid, or recency aggregate.
 *  A missing (legacy) watermark is treated as changed so an install that
 *  predates watermarks reconciles once; the per-row guard keeps that safe. */
function flatChangedSince(stored: FlatWatermarks | undefined, current: FlatWatermarks): boolean {
  if (!stored) return true;
  for (const [table, cur] of Object.entries(current)) {
    const prev = stored[table];
    if (!prev) return true;
    if (
      prev.rows !== cur.rows ||
      prev.maxRowid !== cur.maxRowid ||
      String(prev.recency) !== String(cur.recency)
    ) {
      return true;
    }
  }
  return false;
}

interface LegacyMigrationMarker {
  source_path: string;
  agents_copied: number;
  /** Absent on markers written before 80b61a7d (or on the zero-agent guard). */
  flatWatermarks?: FlatWatermarks;
}

/** Reads the run-once marker row, if the marker table exists and carries one.
 *  Tolerates the pre-80b61a7d marker shape (no `flat_watermarks` column). */
function readMarker(conn: Database.Database): LegacyMigrationMarker | undefined {
  if (!tableExists(conn, LEGACY_MIGRATION_MARKER_TABLE)) return undefined;
  const hasWatermarks = columnNames(conn, LEGACY_MIGRATION_MARKER_TABLE).includes("flat_watermarks");
  const row = conn
    .prepare(
      `SELECT source_path, agents_copied${hasWatermarks ? ", flat_watermarks" : ""} ` +
        `FROM "${LEGACY_MIGRATION_MARKER_TABLE}" WHERE id = 1`,
    )
    .get() as
    | { source_path: string; agents_copied: number; flat_watermarks?: string | null }
    | undefined;
  if (!row) return undefined;

  let flatWatermarks: FlatWatermarks | undefined;
  if (row.flat_watermarks) {
    try {
      flatWatermarks = JSON.parse(row.flat_watermarks) as FlatWatermarks;
    } catch {
      // A corrupt watermark is treated as "no watermark" — reconcile once,
      // safely, via the per-row guard.
      flatWatermarks = undefined;
    }
  }
  return { source_path: row.source_path, agents_copied: row.agents_copied, flatWatermarks };
}

/** Writes (or REFRESHES) the single marker row, upgrading a legacy 4-column
 *  marker table in place by adding the `flat_watermarks` column. The upsert is
 *  load-bearing: the catch-up path re-records its watermark on the same row so
 *  a later boot sees flat == marker and stops. */
function writeMarker(
  conn: Database.Database,
  sourcePath: string,
  agentsCopied: number,
  watermarks: FlatWatermarks | undefined,
): void {
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
  if (!columnNames(conn, LEGACY_MIGRATION_MARKER_TABLE).includes("flat_watermarks")) {
    conn
      .prepare(`ALTER TABLE "${LEGACY_MIGRATION_MARKER_TABLE}" ADD COLUMN flat_watermarks TEXT`)
      .run();
  }
  conn
    .prepare(
      `INSERT INTO "${LEGACY_MIGRATION_MARKER_TABLE}" (id, source_path, migrated_at, agents_copied, flat_watermarks)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source_path = excluded.source_path,
         migrated_at = excluded.migrated_at,
         agents_copied = excluded.agents_copied,
         flat_watermarks = excluded.flat_watermarks`,
    )
    .run(
      sourcePath,
      new Date().toISOString(),
      agentsCopied,
      watermarks ? JSON.stringify(watermarks) : null,
    );
}

export interface MigrateLegacyOptions {
  /** Override for the flat legacy DB path (test isolation). Defaults to
   *  `resolveFlatLegacyDbPath()`. */
  flatDbPath?: string;
  /** Best-effort log sink; defaults to `console`. */
  log?: (level: "info" | "warn", message: string) => void;
  /** Backlog af567fb8 — when `true`, skip the migration entirely: the flat
   *  legacy store is never opened. `runMigrations()` sets this from the
   *  `ADHD_AGENT_SKIP_LEGACY_MIGRATION` config flag, which hermetic test
   *  harnesses set so a fresh scratch DB is not seeded from the developer's
   *  real `~/.adhd/agent-mcp/agents.db`. Returns `reason: "skipped"`. */
  skipLegacyMigration?: boolean;
}

interface CopyFlatOptions {
  /** `seed` ⇒ INSERT OR IGNORE into the empty canonical store (first boot).
   *  `reconcile` ⇒ INSERT OR IGNORE plus a delta UPDATE of a row only when the
   *  flat copy is strictly NEWER than canonical's (catch-up; never reverts a
   *  canonical write). */
  mode: "seed" | "reconcile";
  flatDbPath: string;
  flatAgentCount: number;
  log: (level: "info" | "warn", message: string) => void;
}

/** Sentinel thrown inside the seed transaction when the `agents` copy did not
 *  land every offered row. The enclosing IMMEDIATE transaction rolls back —
 *  no partial seed and no marker — so a later boot retries cleanly instead of
 *  short-circuiting on a false success (bug 0ea16bf1). */
class IncompleteSeedError extends Error {}

/**
 * Copies every same-shaped operational table from the read-only `flat`
 * connection into `canonical`, then writes the marker — all in ONE IMMEDIATE
 * transaction (concurrent writers are serialized through it; ADR-0012), so the
 * rows and the run-once marker commit or roll back together.
 *
 * Returns `{ applied, tables, agentsComplete }`: `applied` is the number of
 * rows actually inserted or updated (0 ⇒ a reconcile was a no-op), `tables`
 * the number of flat tables from which rows were offered, and `agentsComplete`
 * whether every offered `agents` row landed (always `true` in `reconcile`
 * mode — completeness is a SEED gate; the delta path is allowed to be a no-op).
 *
 * In `seed` mode, if the `agents` copy did not land every offered row (e.g. a
 * canonical NOT NULL column absent from the flat file makes every agent insert
 * throw), the transaction ROLLS BACK and the run-once marker is NOT written: a
 * zero-row apply must never be recorded as a success, or the next boot
 * short-circuits `already-migrated` and strands the legacy agents forever
 * (bug 0ea16bf1). `applied`/`tables` are then 0 and `agentsComplete` is false.
 *
 * Keeps the original per-row best-effort semantics (a single orphaned row must
 * not drop its whole table).
 */
function copyFlatIntoCanonical(
  canonical: Database.Database,
  flat: Database.Database,
  opts: CopyFlatOptions,
): { applied: number; tables: number; agentsComplete: boolean } {
  // The authoritative offered-agent count is the caller's `countRows` result,
  // NOT the per-table read's length: if the agents read itself were to throw
  // (table-level catch below), a length-derived offer of 0 would falsely mark
  // the seed complete.
  const agentsOffered = opts.flatAgentCount;
  let applied = 0;
  let copiedTables = 0;
  let agentsApplied = 0;
  try {
    canonical
      .transaction(() => {
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
          const rec = recencyColumn(cols);
          const recCol = rec?.col;

          // A new flat row always lands (INSERT OR IGNORE never clobbers a
          // concurrently-written canonical row). An existing canonical row is
          // overwritten ONLY when the flat copy is strictly newer — the recency
          // comparison lives in the UPDATE's WHERE, so it is atomic.
          const insertSql = `INSERT OR IGNORE INTO "${table}" (${quoted}) VALUES (${placeholders})`;
          const canUpdate =
            opts.mode === "reconcile" &&
            recCol !== undefined &&
            pkCols.length > 0 &&
            updatable.length > 0;
          const updateSql = canUpdate
            ? `UPDATE "${table}" SET ${updatable.map((c) => `"${c}" = ?`).join(", ")} ` +
              `WHERE ${pkCols.map((c) => `"${c}" = ?`).join(" AND ")} AND "${recCol}" < ?`
            : undefined;

          try {
            const rows = flat
              .prepare(`SELECT ${quoted} FROM "${table}"`)
              .all() as Array<Record<string, unknown>>;
            const insert = canonical.prepare(insertSql);
            const update = updateSql ? canonical.prepare(updateSql) : undefined;
            const isAgents = table === "agents";
            let tableApplied = 0;
            // Best-effort PER ROW: a single orphaned row (e.g. a session whose
            // agent was deleted from the legacy store — real flat DBs carry
            // these) must not drop the whole table. An error aborts only the
            // current statement; the enclosing transaction stays open.
            let skipped = 0;
            for (const row of rows) {
              try {
                tableApplied += insert.run(...cols.map((c) => row[c])).changes;
                if (update && recCol !== undefined) {
                  tableApplied += update.run(
                    ...updatable.map((c) => row[c]),
                    ...pkCols.map((c) => row[c]),
                    row[recCol],
                  ).changes;
                }
              } catch {
                skipped++;
              }
            }
            applied += tableApplied;
            if (isAgents) agentsApplied = tableApplied;
            copiedTables++;
            if (skipped > 0) {
              opts.log(
                "warn",
                `migrate-legacy: skipped ${skipped} orphaned/invalid row(s) in "${table}"`,
              );
            }
          } catch (err) {
            // Table-level failure (e.g. the read itself) — never abort the boot.
            opts.log("warn", `migrate-legacy: skipping "${table}" (${(err as Error).message})`);
          }
        }

        // SEED COMPLETENESS GATE (bug 0ea16bf1): a seed that did not land every
        // offered agent is not a success. Throw so the IMMEDIATE transaction
        // rolls back — NOTHING is committed (no partial rows, no marker) and
        // the next boot retries, rather than recording a false success that
        // short-circuits `already-migrated` and strands the agents.
        if (opts.mode === "seed" && agentsOffered > 0 && agentsApplied < agentsOffered) {
          throw new IncompleteSeedError(
            `migrate-legacy: seed copied only ${agentsApplied}/${agentsOffered} agent row(s) ` +
              `(canonical schema drift?) — rolling back without recording the marker; the ` +
              `migration will retry on the next boot (bug 0ea16bf1)`,
          );
        }

        writeMarker(canonical, opts.flatDbPath, opts.flatAgentCount, computeFlatWatermarks(flat));
      })
      .immediate();
  } catch (err) {
    if (err instanceof IncompleteSeedError) {
      opts.log("warn", err.message);
      return { applied: 0, tables: 0, agentsComplete: false };
    }
    throw err;
  }
  return { applied, tables: copiedTables, agentsComplete: true };
}

/**
 * Runs the flat → namespaced migration on the OPEN canonical connection
 * (`sqlite` from `db/client.ts`, after the drizzle migrations have run — see
 * `db/migrate.ts`).
 *
 * Two modes, both idempotent:
 *  - FIRST BOOT (no marker): seed an empty canonical store from the flat legacy
 *    DB, then record the run-once marker.
 *  - CATCH-UP (marker present + the flat source has CHANGED since the last
 *    reconciliation): the pin kept the flat store live after the seed, so
 *    reconcile the DELTA — rows missing from canonical are inserted, and a row
 *    is updated only when flat's copy is strictly newer (flat wins for the
 *    delta only; canonical post-seed writes are never reverted) — and refresh
 *    the marker. Without this, a store seeded early and then kept growing would
 *    silently strand every later agent once the pin is removed (backlog
 *    7acc68c1).
 *
 * @returns the outcome describing what happened.
 */
export function migrateLegacyOperationalDb(
  canonical: Database.Database,
  opts: MigrateLegacyOptions = {},
): LegacyMigrationOutcome {
  const flatDbPath = opts.flatDbPath ?? resolveFlatLegacyDbPath();
  const log = opts.log ?? ((level, message) => console[level](message));

  // Backlog af567fb8: opt-out for hermetic boots. Return BEFORE touching the
  // filesystem so a test harness's fresh scratch DB can never be seeded from
  // the developer's real flat legacy store (and no marker is written).
  if (opts.skipLegacyMigration) {
    log(
      "info",
      "migrate-legacy: skipped (ADHD_AGENT_SKIP_LEGACY_MIGRATION) — the flat legacy store is never read",
    );
    return { copied: false, agentsCopied: 0, reason: "skipped" };
  }

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
      // CATCH-UP (backlog 7acc68c1, delta-scope fix 80b61a7d): the marker
      // proves a prior run seeded the canonical store from THIS flat file.
      // Reconcile only when the flat CONTENT has changed since the last
      // reconciliation — broader than "the agent count grew", so a
      // constant-count edit (an agent revised in place) is not missed.
      // `agents_copied === 0` is the zero-agent-guard case (canonical was
      // authoritative, nothing seeded), so it is deliberately NOT a catch-up
      // trigger.
      const sameSource = path.resolve(marker.source_path) === path.resolve(flatDbPath);
      const hasSeed = marker.agents_copied > 0;
      const current = computeFlatWatermarks(flat);
      if (!(sameSource && hasSeed && flatChangedSince(marker.flatWatermarks, current))) {
        return { copied: false, agentsCopied: 0, reason: "already-migrated" };
      }
      const { applied } = copyFlatIntoCanonical(canonical, flat, {
        mode: "reconcile",
        flatDbPath,
        flatAgentCount,
        log,
      });
      if (applied === 0) {
        // The trigger fired (e.g. a legacy marker) but the per-row guard found
        // nothing newer to apply — record the fresh watermark and stop.
        return { copied: false, agentsCopied: 0, reason: "already-migrated" };
      }
      return { copied: true, agentsCopied: flatAgentCount, reason: "copied" };
    }

    // Zero-agent guard: canonical is authoritative. Record the marker so this
    // guard is stable (deleting all agents later must not resurrect legacy rows).
    if (countRows(canonical, "agents") > 0) {
      writeMarker(canonical, flatDbPath, 0, undefined);
      return { copied: false, agentsCopied: 0, reason: "canonical-populated" };
    }
    if (flatAgentCount === 0) {
      writeMarker(canonical, flatDbPath, 0, undefined);
      return { copied: false, agentsCopied: 0, reason: "flat-empty" };
    }

    // Seed an empty canonical store. `agentsComplete` is false when the agents
    // copy did not land every offered row — copyFlatIntoCanonical has already
    // rolled the seed back and left the marker unwritten, so a later boot
    // retries; this must NOT be reported as a successful copy (bug 0ea16bf1).
    const { agentsComplete } = copyFlatIntoCanonical(canonical, flat, {
      mode: "seed",
      flatDbPath,
      flatAgentCount,
      log,
    });
    if (!agentsComplete) {
      return { copied: false, agentsCopied: 0, reason: "seed-incomplete" };
    }
    return { copied: true, agentsCopied: flatAgentCount, reason: "copied" };
  } finally {
    flat.close();
  }
}
