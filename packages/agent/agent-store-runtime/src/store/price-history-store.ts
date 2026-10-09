/**
 * 37f6c511 / 1f1c8598 — append-only model price history, as-of lookup and the pull ledger.
 *
 * Tables: `model_price_history` (BEFORE UPDATE/DELETE triggers make it append-only; corrections are
 * new rows, newest `observed_at` wins) and `price_pull_ledger` (one row per pull attempt).
 *
 * Concurrency: every store is parallel-process enabled. All multi-statement writes run in a
 * `BEGIN IMMEDIATE` transaction so two processes sharing one DB file serialise on the write lock
 * (the connection's busy timeout governs waiting; there are no retry loops here), and every insert
 * is also guarded by the unique `(model_id, observed_at, source)` index.
 *
 * This module is structurally typed against core-provider's `IPriceSource` / `IPriceRecord`
 * (it does NOT import that package): {@link createPriceSource} is assignable to `IPriceSource`.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { modelPriceHistoryTable, pricePullLedgerTable } from '../db/schema.js';
import { generateId } from '../utils/ids.js';
import { nowIso } from '../utils/timestamps.js';

/** A move of at least this factor (either direction, input or output) is HELD, not applied. */
export const ANOMALY_HOLD_FACTOR = 20;
/** A move of at least this factor (below the hold factor) is applied with a warning anomaly. */
export const ANOMALY_WARN_FACTOR = 10;
/** An input rate above this ($/M tokens) is held. */
export const ANOMALY_MAX_INPUT_PER_M = 1000;
/** A `running` ledger row older than the claim TTL is treated as a crashed run and superseded. */
export const SUPERSEDED_RUN_ERROR = 'superseded: running row exceeded runningTtlMs (crashed run)';

/** Row to append (rates are $ per MILLION tokens; null = absent/router, 0 = real free price). */
export interface INewPriceRow {
  modelId: string;
  kind: 'model' | 'router';
  inputPerM: number | null;
  cacheReadPerM: number | null;
  cacheWritePerM: number | null;
  outputPerM: number | null;
  rawJson: string;
  overridesJson: string | null;
}

/** Structurally identical to core-provider's `IPriceRecord`, plus store provenance. */
export interface IPriceRecordLike {
  id: string;
  modelId: string;
  observedAt: string;
  kind: 'model' | 'router';
  inputPerM: number | null;
  cacheReadPerM: number | null;
  cacheWritePerM: number | null;
  /** 1-hour cache-write tier ($/M) read from the verbatim `raw_json` (`input_cache_write_1h`); null when unpublished. */
  cacheWrite1hPerM: number | null;
  outputPerM: number | null;
  source: 'bundled' | 'openrouter-live';
  beforeFirstObservation?: boolean;
  /** Pull that produced the row; null for the bundled seed. */
  ledgerId: string | null;
  /** Verbatim `pricing.overrides` JSON (stored, never applied). */
  overridesJson: string | null;
}

/** One anomaly noticed while applying an observation. */
export interface IPriceAnomaly {
  modelId: string;
  /** `hold`: not applied (needs `accept`). `warn`: applied. `same_instant`: a different price at an already-used instant was skipped. */
  severity: 'hold' | 'warn' | 'same_instant';
  reason: string;
  field?: 'inputPerM' | 'outputPerM';
  previous?: number;
  observed?: number;
}

export interface IApplyResult {
  /** History row ids appended for models never seen before. */
  newIds: string[];
  /** History row ids appended for models whose price/kind/overrides changed. */
  changedIds: string[];
  unchangedCount: number;
  anomalies: IPriceAnomaly[];
}

export type PullStatus = 'running' | 'ok' | 'failed' | 'rejected_shrink' | 'rejected_invalid';

export interface IPullFinish {
  status: Exclude<PullStatus, 'running'>;
  finishedAt: string;
  httpStatus?: number | null;
  modelsSeen?: number | null;
  newCount?: number | null;
  changedCount?: number | null;
  unchangedCount?: number | null;
  anomalies?: IPriceAnomaly[];
  error?: string | null;
  durationMs?: number | null;
}

export interface ILedgerRow {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: PullStatus;
  httpStatus: number | null;
  modelsSeen: number | null;
  newCount: number | null;
  changedCount: number | null;
  unchangedCount: number | null;
  anomaliesJson: string | null;
  error: string | null;
  durationMs: number | null;
  sourceUrl: string;
}

export interface IClaimOptions {
  /** Minimum gap since the last `ok` pull started (ignored when `force`). */
  minIntervalMs: number;
  /** A `running` row younger than this blocks a new claim; older ones are superseded. */
  runningTtlMs: number;
  force: boolean;
  /**
   * With `force`, the minimum gap since the last pull attempt of ANY status started. Enforced inside
   * the claim transaction, so concurrent processes cannot bypass it. Omitted = no forced floor.
   */
  forcedMinIntervalMs?: number;
  sourceUrl: string;
}

export type ClaimResult =
  | { claimed: true; ledgerId: string }
  | { claimed: false; reason: 'fresh' | 'running' | 'forced_too_soon' };

export interface ILedgerSummary {
  lastOk?: ILedgerRow;
  lastFailed?: ILedgerRow;
  /** Hours since the last successful pull finished (null if none). Not reset by failures. */
  priceAgeHours: number | null;
}

type Db = BetterSQLite3Database<Record<string, never>>;
type HistoryRow = typeof modelPriceHistoryTable.$inferSelect;
type LedgerRow = typeof pricePullLedgerTable.$inferSelect;

const lc = (id: string): string => id.toLowerCase();

/**
 * `input_cache_write_1h` ($/token in the verbatim feed JSON) -> $/million, or null when the row
 * carries no (valid, non-negative) 1h tier. Read from `raw_json`, the stored source of truth, so
 * no schema column is needed; same conversion as core-provider's `perMillion`.
 */
function cacheWrite1hFromRaw(rawJson: string): number | null {
  try {
    const v = (JSON.parse(rawJson) as Record<string, unknown> | null)?.['input_cache_write_1h'];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Number((n * 1_000_000).toPrecision(12)) : null;
  } catch {
    return null;
  }
}

function toRecord(r: HistoryRow, beforeFirst?: boolean): IPriceRecordLike {
  const rec: IPriceRecordLike = {
    id: r.id,
    modelId: r.modelId,
    observedAt: r.observedAt,
    kind: r.kind === 'router' ? 'router' : 'model',
    inputPerM: r.inputPerM,
    cacheReadPerM: r.cacheReadPerM,
    cacheWritePerM: r.cacheWritePerM,
    cacheWrite1hPerM: cacheWrite1hFromRaw(r.rawJson),
    outputPerM: r.outputPerM,
    source: r.source === 'bundled' ? 'bundled' : 'openrouter-live',
    ledgerId: r.ledgerId,
    overridesJson: r.overridesJson,
  };
  if (beforeFirst) rec.beforeFirstObservation = true;
  return rec;
}

function toLedger(r: LedgerRow): ILedgerRow {
  return { ...r, status: r.status as PullStatus };
}

function sameValue(a: IPriceRecordLike, b: INewPriceRow): boolean {
  return (
    a.kind === b.kind &&
    a.inputPerM === b.inputPerM &&
    a.cacheReadPerM === b.cacheReadPerM &&
    a.cacheWritePerM === b.cacheWritePerM &&
    a.cacheWrite1hPerM === cacheWrite1hFromRaw(b.rawJson) &&
    a.outputPerM === b.outputPerM &&
    a.overridesJson === b.overridesJson
  );
}

/**
 * Ratio of the larger to the smaller rate, or undefined when it is not defined: either side absent
 * (null) or non-positive. A move across zero (0 -> >0 or >0 -> 0, e.g. a free tier appearing or a
 * price disappearing) has no finite ratio; it is NOT silently ignored but reported by
 * {@link zeroBoundaryMove} as a WARN (applied, never held), because a hold on every free-tier flip
 * would stall legitimate feed updates while ignoring it would hide a real change.
 */
function moveFactor(prev: number | null, next: number | null): number | undefined {
  if (prev === null || next === null || prev <= 0 || next <= 0) return undefined;
  return Math.max(next / prev, prev / next);
}

/** True when the rate moved between exactly 0 and a positive value (either direction). */
function zeroBoundaryMove(prev: number | null, next: number | null): boolean {
  if (prev === null || next === null) return false;
  return (prev === 0 && next > 0) || (prev > 0 && next === 0);
}

export class PriceHistoryStore {
  constructor(private readonly db: Db) {}

  /**
   * Price record in force for `modelId` at `instantIso`: greatest `observed_at <= instant`
   * (ties: newest rowid). If every row postdates the instant, the earliest row with
   * `beforeFirstObservation: true`. Undefined when the model has no rows.
   */
  priceAt(modelId: string, instantIso: string): IPriceRecordLike | undefined {
    return this.priceAtIn(this.db, modelId, instantIso);
  }

  /** Newest row for a model (undefined if never observed). */
  latest(modelId: string): IPriceRecordLike | undefined {
    return this.latestIn(this.db, modelId);
  }

  /**
   * Append the bundled snapshot as `source='bundled'` rows observed at `fetchedAt`.
   * Idempotent: the unique `(model_id, observed_at, source)` index makes a repeat a no-op.
   * @returns number of rows actually inserted.
   */
  seedBundled(rows: INewPriceRow[], fetchedAt: string): number {
    return this.db.transaction(
      (tx) => {
        let inserted = 0;
        for (const row of rows) {
          const res = tx
            .insert(modelPriceHistoryTable)
            .values({
              id: generateId(),
              modelId: lc(row.modelId),
              observedAt: fetchedAt,
              source: 'bundled',
              kind: row.kind,
              inputPerM: row.inputPerM,
              cacheReadPerM: row.cacheReadPerM,
              cacheWritePerM: row.cacheWritePerM,
              outputPerM: row.outputPerM,
              rawJson: row.rawJson,
              overridesJson: row.overridesJson,
              ledgerId: null,
            })
            .onConflictDoNothing()
            .run();
          inserted += res.changes;
        }
        return inserted;
      },
      { behavior: 'immediate' }
    );
  }

  /**
   * Atomically claim the right to run a pull (BEGIN IMMEDIATE). Not claimed when a `running`
   * row is younger than `runningTtlMs`, or (unless `force`) the last `ok` pull started less than
   * `minIntervalMs` ago. A forced claim is refused (`forced_too_soon`) when any pull attempt started
   * less than `forcedMinIntervalMs` ago. Crashed `running` rows past the TTL are marked failed and superseded.
   */
  claimPull(now: string, opts: IClaimOptions): ClaimResult {
    return this.db.transaction(
      (tx) => {
        const nowMs = Date.parse(now);
        const running = tx
          .select()
          .from(pricePullLedgerTable)
          .where(eq(pricePullLedgerTable.status, 'running'))
          .orderBy(desc(pricePullLedgerTable.startedAt))
          .all();
        for (const r of running) {
          if (nowMs - Date.parse(r.startedAt) < opts.runningTtlMs) {
            return { claimed: false, reason: 'running' } as const;
          }
        }
        if (opts.force && opts.forcedMinIntervalMs !== undefined) {
          const lastAny = tx
            .select()
            .from(pricePullLedgerTable)
            .orderBy(desc(pricePullLedgerTable.startedAt))
            .limit(1)
            .get();
          if (lastAny && nowMs - Date.parse(lastAny.startedAt) < opts.forcedMinIntervalMs) {
            return { claimed: false, reason: 'forced_too_soon' } as const;
          }
        }
        if (!opts.force) {
          const lastOk = tx
            .select()
            .from(pricePullLedgerTable)
            .where(eq(pricePullLedgerTable.status, 'ok'))
            .orderBy(desc(pricePullLedgerTable.startedAt))
            .limit(1)
            .get();
          if (lastOk && nowMs - Date.parse(lastOk.startedAt) < opts.minIntervalMs) {
            return { claimed: false, reason: 'fresh' } as const;
          }
        }
        if (running.length > 0) {
          tx.update(pricePullLedgerTable)
            .set({ status: 'failed', finishedAt: now, error: SUPERSEDED_RUN_ERROR })
            .where(
              inArray(
                pricePullLedgerTable.id,
                running.map((r) => r.id)
              )
            )
            .run();
        }
        const ledgerId = generateId();
        tx.insert(pricePullLedgerTable)
          .values({ id: ledgerId, startedAt: now, status: 'running', sourceUrl: opts.sourceUrl })
          .run();
        return { claimed: true, ledgerId } as const;
      },
      { behavior: 'immediate' }
    );
  }

  /**
   * Compare `rows` to each model's latest record and append only what changed, in ONE
   * transaction, observed at `now`. A model with no prior row is `new`; any difference in
   * kind/rates/overrides is `changed`; equal is `unchanged`. A move of {@link ANOMALY_HOLD_FACTOR}x or
   * more (input or output) or an input rate above {@link ANOMALY_MAX_INPUT_PER_M} is HELD
   * (not applied) unless its model id is in `accept`; a {@link ANOMALY_WARN_FACTOR}x move is applied
   * with a `warn` anomaly. A move between exactly 0 and a positive rate has no finite factor: it is
   * applied with a `warn` anomaly and is never held.
   */
  applyObservation(
    ledgerId: string,
    rows: INewPriceRow[],
    now: string,
    accept: ReadonlySet<string>
  ): IApplyResult {
    const accepted = new Set([...accept].map(lc));
    return this.db.transaction(
      (tx) => {
        const result: IApplyResult = { newIds: [], changedIds: [], unchangedCount: 0, anomalies: [] };
        for (const row of rows) {
          const modelId = lc(row.modelId);
          const prev = this.latestIn(tx, modelId);
          if (prev && sameValue(prev, row)) {
            result.unchangedCount += 1;
            continue;
          }
          const anomalies: IPriceAnomaly[] = [];
          let hold = false;
          if (row.inputPerM !== null && row.inputPerM > ANOMALY_MAX_INPUT_PER_M) {
            hold = true;
            anomalies.push({
              modelId,
              severity: 'hold',
              reason: `inputPerM ${row.inputPerM} exceeds ${ANOMALY_MAX_INPUT_PER_M} $/M`,
              field: 'inputPerM',
              observed: row.inputPerM,
            });
          }
          if (prev) {
            for (const field of ['inputPerM', 'outputPerM'] as const) {
              const base = {
                modelId,
                field,
                previous: prev[field] as number,
                observed: row[field] as number,
              };
              if (zeroBoundaryMove(prev[field], row[field])) {
                anomalies.push({
                  ...base,
                  severity: 'warn',
                  reason: `${field} moved from ${base.previous} to ${base.observed} (across zero; applied)`,
                });
                continue;
              }
              const factor = moveFactor(prev[field], row[field]);
              if (factor === undefined) continue;
              if (factor >= ANOMALY_HOLD_FACTOR) {
                hold = true;
                anomalies.push({ ...base, severity: 'hold', reason: `${field} moved ${factor.toFixed(1)}x` });
              } else if (factor >= ANOMALY_WARN_FACTOR) {
                anomalies.push({ ...base, severity: 'warn', reason: `${field} moved ${factor.toFixed(1)}x` });
              }
            }
          }
          if (hold && !accepted.has(modelId)) {
            result.anomalies.push(...anomalies);
            continue;
          }
          const id = generateId();
          const res = tx
            .insert(modelPriceHistoryTable)
            .values({
              id,
              modelId,
              observedAt: now,
              source: 'openrouter-live',
              kind: row.kind,
              inputPerM: row.inputPerM,
              cacheReadPerM: row.cacheReadPerM,
              cacheWritePerM: row.cacheWritePerM,
              outputPerM: row.outputPerM,
              rawJson: row.rawJson,
              overridesJson: row.overridesJson,
              ledgerId,
            })
            .onConflictDoNothing()
            .run();
          if (res.changes === 0) {
            result.anomalies.push({
              modelId,
              severity: 'same_instant',
              reason: `a live row already exists at observed_at ${now}; differing price skipped`,
            });
            continue;
          }
          result.anomalies.push(...anomalies);
          (prev ? result.changedIds : result.newIds).push(id);
        }
        return result;
      },
      { behavior: 'immediate' }
    );
  }

  /**
   * Close a pull's ledger row with its outcome. Guarded by `status = 'running'`, so a late finisher
   * can never overwrite a row that was superseded (marked `failed` by a newer claim) or already closed.
   * @returns true when the row was closed; false when 0 rows changed (superseded / already closed).
   */
  finishPull(ledgerId: string, f: IPullFinish): boolean {
    const res = this.db
      .update(pricePullLedgerTable)
      .set({
        status: f.status,
        finishedAt: f.finishedAt,
        httpStatus: f.httpStatus ?? null,
        modelsSeen: f.modelsSeen ?? null,
        newCount: f.newCount ?? null,
        changedCount: f.changedCount ?? null,
        unchangedCount: f.unchangedCount ?? null,
        anomaliesJson: f.anomalies ? JSON.stringify(f.anomalies) : null,
        error: f.error ?? null,
        durationMs: f.durationMs ?? null,
      })
      .where(and(eq(pricePullLedgerTable.id, ledgerId), eq(pricePullLedgerTable.status, 'running')))
      .run();
    return res.changes > 0;
  }

  /**
   * Latest successful and latest failed (`failed` / `rejected_*`) pulls, and the age in hours of
   * the last success at `now` (default: the current instant). A later failure never resets the age.
   */
  lastLedger(now: string = nowIso()): ILedgerSummary {
    const lastOk = this.db
      .select()
      .from(pricePullLedgerTable)
      .where(eq(pricePullLedgerTable.status, 'ok'))
      .orderBy(desc(pricePullLedgerTable.startedAt))
      .limit(1)
      .get();
    const lastFailed = this.db
      .select()
      .from(pricePullLedgerTable)
      .where(inArray(pricePullLedgerTable.status, ['failed', 'rejected_shrink', 'rejected_invalid']))
      .orderBy(desc(pricePullLedgerTable.startedAt))
      .limit(1)
      .get();
    const out: ILedgerSummary = { priceAgeHours: null };
    if (lastOk) {
      out.lastOk = toLedger(lastOk);
      const since = Date.parse(lastOk.finishedAt ?? lastOk.startedAt);
      out.priceAgeHours = Math.max(0, (Date.parse(now) - since) / 3_600_000);
    }
    if (lastFailed) out.lastFailed = toLedger(lastFailed);
    return out;
  }

  /** All rows for a model in `observed_at` order (inclusive `from`/`to` bounds optional). */
  history(modelId: string, from?: string, to?: string): IPriceRecordLike[] {
    const conds = [eq(modelPriceHistoryTable.modelId, lc(modelId))];
    if (from !== undefined) conds.push(gte(modelPriceHistoryTable.observedAt, from));
    if (to !== undefined) conds.push(lte(modelPriceHistoryTable.observedAt, to));
    return this.db
      .select()
      .from(modelPriceHistoryTable)
      .where(and(...conds))
      .orderBy(asc(modelPriceHistoryTable.observedAt), sql`rowid asc`)
      .all()
      .map((r) => toRecord(r));
  }

  private latestIn(db: Db, modelId: string): IPriceRecordLike | undefined {
    const r = db
      .select()
      .from(modelPriceHistoryTable)
      .where(eq(modelPriceHistoryTable.modelId, lc(modelId)))
      .orderBy(desc(modelPriceHistoryTable.observedAt), sql`rowid desc`)
      .limit(1)
      .get();
    return r ? toRecord(r) : undefined;
  }

  private priceAtIn(db: Db, modelId: string, instantIso: string): IPriceRecordLike | undefined {
    const id = lc(modelId);
    const hit = db
      .select()
      .from(modelPriceHistoryTable)
      .where(and(eq(modelPriceHistoryTable.modelId, id), lte(modelPriceHistoryTable.observedAt, instantIso)))
      .orderBy(desc(modelPriceHistoryTable.observedAt), sql`rowid desc`)
      .limit(1)
      .get();
    if (hit) return toRecord(hit);
    const first = db
      .select()
      .from(modelPriceHistoryTable)
      .where(eq(modelPriceHistoryTable.modelId, id))
      .orderBy(asc(modelPriceHistoryTable.observedAt), sql`rowid asc`)
      .limit(1)
      .get();
    return first ? toRecord(first, true) : undefined;
  }
}

/**
 * As-of price source over the runtime DB. Structurally an `IPriceSource` (core-provider) and
 * safe to construct per call: it holds only the store, no cache.
 */
export function createPriceSource(db: Db): {
  priceAt(modelId: string, instantIso: string): IPriceRecordLike | undefined;
} {
  const store = new PriceHistoryStore(db);
  return { priceAt: (modelId, instantIso) => store.priceAt(modelId, instantIso) };
}
