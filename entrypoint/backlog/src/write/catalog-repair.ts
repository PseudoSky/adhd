/**
 * catalog-repair.ts — one-shot, REVERSIBLE repair of the `status` catalog's
 * `terminal` flag (`query/card.ts`'s `isStatusTerminal`, SPEC.md §2).
 *
 * ## The drift this repairs
 *
 * `isStatusTerminal(statusRecord)` is `status.metadata.terminal === true`,
 * defaulting FALSE when the key is absent. A `status` row whose NAME is one
 * of the reserved terminal vocabulary but which was minted WITHOUT that flag
 * — `create-issue.ts`'s `mintMetadata: async () => ({ terminal: false })`, and
 * `tools/etl`'s own bootstrap mints — is therefore read as NON-terminal, and
 * `queryIssues({filter:{status:'open'}})` returns items that are closed by
 * name. The flag, not the name, is the single source of truth for closedness
 * (ADR-0002 D5: an unfixed-source gap is repaired at the SOURCE, never papered
 * over with a read-time name fallback — a fallback would be a second, drifting
 * source of truth).
 *
 * ## What this module does — and deliberately does NOT
 *
 * It sets `meta.terminal = true` on exactly those LIVE `status` rows whose
 * folded name is in {@link RESERVED_TERMINAL_STATUS_NAMES} and whose flag is
 * not already `true`. It never touches `name`, `kind`, `rank`, or any other
 * `meta` key — only the one flag. It is IDEMPOTENT (a row already
 * `terminal:true` is skipped; a re-run plans nothing and writes nothing) and
 * REVERSIBLE (the apply journal records the prior flag; the reverse restores
 * exactly that).
 *
 * It does NOT read the query layer and does NOT change it: `isStatusTerminal`
 * stays name-blind (ADR-0002 D5).
 */

import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import {
  type IWriteStoreHandle,
  executeWriteTransaction,
  nowISO,
} from './tx.js';

/**
 * The reserved terminal vocabulary — SINGLE SOURCE. Imported by the repair
 * (here) AND the (later) guard; a drift test asserts they agree. Case-sensitive
 * canonical spellings.
 */
export const RESERVED_TERMINAL_STATUS_NAMES: ReadonlySet<string> = new Set([
  'closed',
  'DONE',
  'FIXED',
  'RESOLVED',
  'INVALID',
  'SUPERSEDED',
]);

/**
 * Unicode fold used by BOTH duplicate detection and JS-side grouping — never
 * `SQL lower()`/`NOCASE` (ASCII-only, so it folds `A`–`Z` and nothing else).
 * `NFKC` first so compatibility forms collapse, then `toLowerCase()` (the JS
 * Unicode-aware case fold, mirroring PostgreSQL `citext`'s documented Unicode
 * behavior) so `RESOLVED`, `resolved` and `Resolved` group together.
 */
export function catalogNameFold(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

/** {@link RESERVED_TERMINAL_STATUS_NAMES}, folded once at module load — the grouping key set the planner matches a folded row name against. */
const FOLDED_RESERVED_TERMINAL_STATUS_NAMES: ReadonlySet<string> = new Set(
  [...RESERVED_TERMINAL_STATUS_NAMES].map((name) => catalogNameFold(name))
);

/**
 * Guarded `JSON.parse` for a `node.meta` column value — the SAME
 * degrade-on-corruption discipline as `write/catalog.ts`'s (unexported)
 * `parseMetaObject`: a non-JSON or non-object `meta` degrades to `undefined`
 * rather than throwing a raw `SyntaxError` out of a transaction callback.
 */
function parseMetaObject(
  raw: string | null
): Record<string, unknown> | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The set of LIVE `status` rowids the backfill should set `terminal:true` on,
 * plus the plan timestamp. Rows already `terminal:true` are EXCLUDED here (the
 * idempotency guarantee: a fully-repaired store plans nothing).
 */
export interface ITerminalBackfillPlan {
  setTerminalRowids: number[];
  at: string;
}

/**
 * The apply journal — enough to restore EXACTLY the prior state. `hadTerminal`
 * is the row's `meta.terminal === true` at apply time; because a row already
 * `true` is never changed (and never journaled), every real entry's
 * `hadTerminal` is `false`.
 */
export interface ITerminalBackfillJournal {
  entries: Array<{ rowid: number; uid: string; hadTerminal: boolean }>;
  at: string;
}

interface IRawStatusRow {
  rowid: number;
  uid: string;
  kind: string;
  name: string | null;
  meta: string | null;
}

/**
 * Build the backfill plan: every LIVE `status` row whose FOLDED name is a
 * reserved terminal name and whose `terminal` flag is not already `true`.
 *
 * Reads are plain SELECTs against the bare adapter — this is a repair planner,
 * not a write verb, and it holds no lock across the (separately transactional)
 * apply. A row created or renamed between plan and apply is tolerantly skipped
 * by {@link applyTerminalBackfill}, which re-guards each row inside its own
 * transaction.
 */
export async function planTerminalBackfill(
  handle: IWriteStoreHandle,
  at: string = nowISO()
): Promise<ITerminalBackfillPlan> {
  const { rows } = await handle.adapter.executeAll<IRawStatusRow>(
    "SELECT rowid, uid, kind, name, meta FROM node WHERE kind = 'status' AND t_invalid IS NULL ORDER BY rowid ASC"
  );

  const setTerminalRowids: number[] = [];
  for (const row of rows) {
    const folded = catalogNameFold(row.name ?? '');
    if (!FOLDED_RESERVED_TERMINAL_STATUS_NAMES.has(folded)) continue;
    const meta = parseMetaObject(row.meta);
    if (meta?.terminal === true) continue; // already correct — idempotent
    setTerminalRowids.push(row.rowid);
  }

  return { setTerminalRowids, at };
}

/**
 * Apply the plan in ONE `executeWriteTransaction` (`BEGIN IMMEDIATE` +
 * busy-only bounded retry, §4c): read each target status row, guarded-parse
 * its `meta`, set `terminal:true`, guarded
 * `UPDATE node SET meta = ? WHERE rowid = ? AND t_invalid IS NULL`. Only the
 * `terminal` flag is touched — every other `meta` key is carried through
 * verbatim.
 *
 * A rowid that is no longer a LIVE `status` row between plan and apply is
 * skipped (nothing to repair, nothing journaled); a planned rowid that IS a
 * live non-`status` row is a plan/DB mismatch and throws loudly (ADR-0002 D5's
 * error-loudly posture) rather than silently rewriting an unrelated node.
 */
export async function applyTerminalBackfill(
  handle: IWriteStoreHandle,
  plan: ITerminalBackfillPlan
): Promise<ITerminalBackfillJournal> {
  return executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const entries: ITerminalBackfillJournal['entries'] = [];
    for (const rowid of plan.setTerminalRowids) {
      const row = await tx.executeGet<IRawStatusRow>(
        'SELECT rowid, uid, kind, name, meta FROM node WHERE rowid = ? AND t_invalid IS NULL',
        [rowid]
      );
      if (!row) continue; // vanished / invalidated concurrently — nothing to do

      if (row.kind !== 'status') {
        throw new Error(
          `applyTerminalBackfill: planned rowid ${rowid} is not a status row (kind="${row.kind}") — plan/DB mismatch, refusing to rewrite it.`
        );
      }

      const meta = parseMetaObject(row.meta) ?? {};
      const hadTerminal = meta.terminal === true;
      if (hadTerminal) continue; // already correct — never journal a no-op

      const next = { ...meta, terminal: true };
      const result = await tx.executeRun(
        'UPDATE node SET meta = ? WHERE rowid = ? AND t_invalid IS NULL',
        [JSON.stringify(next), rowid]
      );
      if (result.rowsAffected !== 1) {
        throw new Error(
          `applyTerminalBackfill: UPDATE affected ${result.rowsAffected} rows for rowid=${rowid}, expected exactly 1.`
        );
      }
      entries.push({ rowid: row.rowid, uid: row.uid, hadTerminal });
    }
    return { entries, at: nowISO() };
  });
}

/**
 * Reverse an applied journal in ONE `executeWriteTransaction`: restore
 * `meta.terminal` to its recorded `hadTerminal` for each entry — and NOTHING
 * else. A rowid that is no longer a LIVE `status` row is skipped.
 */
export async function reverseTerminalBackfill(
  handle: IWriteStoreHandle,
  journal: ITerminalBackfillJournal
): Promise<void> {
  await executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    for (const entry of journal.entries) {
      const row = await tx.executeGet<IRawStatusRow>(
        'SELECT rowid, uid, kind, name, meta FROM node WHERE rowid = ? AND t_invalid IS NULL',
        [entry.rowid]
      );
      if (!row) continue; // vanished / invalidated concurrently — nothing to restore

      if (row.kind !== 'status') {
        throw new Error(
          `reverseTerminalBackfill: journal rowid ${entry.rowid} is not a status row (kind="${row.kind}") — refusing to rewrite it.`
        );
      }

      const meta = parseMetaObject(row.meta) ?? {};
      const next = { ...meta, terminal: entry.hadTerminal };
      const result = await tx.executeRun(
        'UPDATE node SET meta = ? WHERE rowid = ? AND t_invalid IS NULL',
        [JSON.stringify(next), entry.rowid]
      );
      if (result.rowsAffected !== 1) {
        throw new Error(
          `reverseTerminalBackfill: UPDATE affected ${result.rowsAffected} rows for rowid=${entry.rowid}, expected exactly 1.`
        );
      }
    }
  });
}
