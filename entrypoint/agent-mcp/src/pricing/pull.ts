/**
 * 37f6c511 (FS2 / G3) — the live OpenRouter price pull.
 *
 * `runPricePull` claims the pull in the ledger (multi-process safe, `BEGIN IMMEDIATE`), GETs the
 * public `https://openrouter.ai/api/v1/models` feed WITHOUT any credential, parses it with
 * core-provider's `parseOpenRouterFeed`, applies it through `PriceHistoryStore.applyObservation`
 * (one transaction; the store owns the anomaly hold/warn rules) and closes the ledger row.
 *
 * It NEVER throws. Every failure closes the ledger row (`failed` / `rejected_*`), logs an ERROR
 * naming the cause, writes zero price rows, and so leaves the last good prices serving.
 *
 * Network, clock and sleep are injected, so unit tests use a fake `fetch` (ADR-0009: no sockets in
 * the unit lane).
 */
import { PRICING_SNAPSHOT_META, parseOpenRouterFeed, type IParsedModel } from '@adhd/agent-core-provider';
import {
  ANOMALY_HOLD_FACTOR,
  ANOMALY_MAX_INPUT_PER_M,
  ANOMALY_WARN_FACTOR,
  type INewPriceRow,
  type IPriceAnomaly,
  type PriceHistoryStore,
} from '@adhd/agent-store-runtime';

import { pricingOps, type OpsSource } from './ops.js';

/** Public OpenRouter model feed (no API key required). */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
/** Minimum gap between successful pulls. Pulled slightly under 24h so timer drift never trips the `fresh` gate. */
export const PULL_MIN_INTERVAL_MS = 24 * 3_600_000 - 5 * 60_000;
/** Cadence of the in-server scheduler. */
export const PULL_INTERVAL_MS = 24 * 3_600_000;
/**
 * A `running` ledger row older than this is a crashed run and is superseded by the next claim.
 * Worst case of one live pull: 2 x {@link FETCH_TIMEOUT_MS} + {@link MAX_RETRY_WAIT_MS} stays well under it.
 */
export const RUNNING_TTL_MS = 10 * 60_000;
/** Per-attempt timeout (request + body read). */
export const FETCH_TIMEOUT_MS = 30_000;
/** Retry delay when the server sends no usable `Retry-After`. */
export const DEFAULT_RETRY_WAIT_MS = 60_000;
/** Upper bound on a server-requested `Retry-After`. */
export const MAX_RETRY_WAIT_MS = 120_000;
/** Cap on the response body read from the feed; a larger body fails the pull. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Minimum gap between FORCED pulls, measured from the last pull attempt of any status. */
export const FORCED_MIN_INTERVAL_MS = 10 * 60_000;
/** A feed with fewer than this fraction of the previous model count is rejected as a shrink. */
export const SHRINK_MIN_RATIO = 0.5;

/**
 * The anomaly rules the store applies, re-exported (imported, not redefined) so the tools can
 * state them to the operator.
 */
export const PRICE_ANOMALY_THRESHOLDS = {
  holdFactor: ANOMALY_HOLD_FACTOR,
  warnFactor: ANOMALY_WARN_FACTOR,
  maxInputPerM: ANOMALY_MAX_INPUT_PER_M,
} as const;

/** Minimal logger surface (pino and `EngineLogger` both satisfy it). */
export interface IPullLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface IPullDeps {
  store: PriceHistoryStore;
  /** Injected HTTP boundary (defaults to `globalThis.fetch` at the call site that builds the deps). */
  fetchImpl: typeof fetch;
  /** ISO-8601 UTC "now" (injected clock). */
  now: () => string;
  /** Wait `ms`; must resolve early (not reject) when `signal` aborts. Default: unref'd, abortable timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  logger: IPullLogger;
  /** Package version for the `User-Agent`. */
  version: string;
  url?: string;
  /** Aborts an in-flight pull (server shutdown). */
  signal?: AbortSignal;
  /** Previous-model-count fallback for the shrink gate when no `ok` ledger row exists. Default: bundled snapshot count. */
  baselineModelCount?: number;
  /** c536ce29 TRC-AC7: ops channel for `pricing.*` records. Default: the process-wide ops channel. */
  ops?: OpsSource;
}

export interface IPullResult {
  /** `skipped` = not claimed (see `reason`); the rest mirror the ledger status. */
  status: 'ok' | 'skipped' | 'failed' | 'rejected_shrink' | 'rejected_invalid';
  /** Why a pull was skipped: a fresh `ok` pull exists, another process holds a live claim, or a forced pull came within {@link FORCED_MIN_INTERVAL_MS} of the last attempt. */
  reason?: 'fresh' | 'running' | 'forced_too_soon';
  ledgerId?: string;
  /** Observation instant stamped on every row this pull appended. */
  fetchedAt?: string;
  models: number;
  new: number;
  changed: number;
  unchanged: number;
  anomalies: IPriceAnomaly[];
  durationMs: number;
  httpStatus?: number;
  error?: string;
}

export interface IPullOptions {
  /** Bypass the 24h gate (manual refresh). A live `running` claim by another process still blocks. */
  force?: boolean;
  /**
   * Model ids whose HELD anomaly is released by this pull (their new price is applied).
   *
   * A NON-EMPTY list also exempts the pull from the {@link FORCED_MIN_INTERVAL_MS} forced-pull floor:
   * it is the operator's review-and-release step right after a refresh reported a HELD anomaly, and
   * the floor exists to stop sub-agent refresh loops. Sub-agents cannot supply `accept` (the
   * in-process `pricing_refresh` rejects it and never forwards it), so they stay floored. The
   * exemption does NOT bypass the `running` claim gate. An empty list is not an exemption.
   */
  accept?: string[];
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** `Retry-After` is delta-seconds or an HTTP-date. Returns ms, or undefined when absent/unparseable. */
export function parseRetryAfterMs(header: string | null, nowIso: string): number | undefined {
  if (header === null) return undefined;
  const v = header.trim();
  if (v === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.parse(nowIso));
}

type Attempt =
  | { ok: true; body: string; httpStatus: number }
  | { ok: false; retryable: boolean; error: string; httpStatus?: number; retryAfterMs?: number };

/**
 * Read the body with a byte counter, aborting the request (and cancelling the stream) the moment
 * more than {@link MAX_BODY_BYTES} have arrived, so an oversized or hostile body is never buffered whole.
 */
async function readCappedBody(
  res: Response,
  controller: AbortController
): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  const tooBig = (): { ok: false; error: string } => ({
    ok: false,
    error: `response body exceeds ${MAX_BODY_BYTES} bytes`,
  });
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    controller.abort();
    await res.body?.cancel().catch(() => undefined);
    return tooBig();
  }
  if (!res.body) {
    const text = await res.text();
    return Buffer.byteLength(text) > MAX_BODY_BYTES ? tooBig() : { ok: true, body: text };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      return tooBig();
    }
    chunks.push(value);
  }
  return { ok: true, body: Buffer.concat(chunks).toString('utf8') };
}

async function attemptFetch(deps: IPullDeps, url: string): Promise<Attempt> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  const signal = AbortSignal.any(deps.signal ? [timeout, deps.signal, controller.signal] : [timeout, controller.signal]);
  try {
    // No Authorization / Cookie header: the feed is public and must never see a credential.
    const res = await deps.fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': `agent-mcp/${deps.version} (price-sync)`,
      },
      signal,
    });
    if (res.status === 429 || res.status >= 500) {
      return {
        ok: false,
        retryable: true,
        error: `HTTP ${res.status}`,
        httpStatus: res.status,
        retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after'), deps.now()),
      };
    }
    if (!res.ok) {
      return { ok: false, retryable: false, error: `HTTP ${res.status}`, httpStatus: res.status };
    }
    const read = await readCappedBody(res, controller);
    if (!read.ok) return { ok: false, retryable: false, error: read.error, httpStatus: res.status };
    return { ok: true, body: read.body, httpStatus: res.status };
  } catch (err) {
    if (deps.signal?.aborted) return { ok: false, retryable: false, error: 'aborted: shutdown' };
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, retryable: true, error: `network error: ${msg}` };
  }
}

/** Parsed feed model -> insertable history row. */
export function toPriceRow(m: IParsedModel): INewPriceRow {
  return {
    modelId: m.modelId,
    kind: m.kind,
    inputPerM: m.inputPerM,
    cacheReadPerM: m.cacheReadPerM,
    cacheWritePerM: m.cacheWritePerM,
    outputPerM: m.outputPerM,
    rawJson: m.rawJson,
    overridesJson: m.overridesJson,
  };
}

/**
 * Run one price pull. Never throws.
 *
 * Gates, in order: claim (24h / live-claim) -> fetch (one retry on network error, 5xx, 429) ->
 * JSON parse (`failed`) -> feed validation (`rejected_invalid`, whole pull) -> shrink
 * (`rejected_shrink`: empty, or under {@link SHRINK_MIN_RATIO} of the previous model count) ->
 * `applyObservation` (store-owned anomaly hold/warn; `accept` releases held models).
 */
export async function runPricePull(deps: IPullDeps, opts: IPullOptions = {}): Promise<IPullResult> {
  const url = deps.url ?? OPENROUTER_MODELS_URL;
  const sleep = deps.sleep ?? defaultSleep;
  const startedAt = deps.now();
  const ops = (event: string, fields: Record<string, unknown>, level?: 'info' | 'warn' | 'error'): void =>
    pricingOps(deps.ops, event, fields, level);
  const accepted = opts.accept ?? [];
  const base = (extra: Partial<IPullResult>): IPullResult => ({
    status: 'failed',
    models: 0,
    new: 0,
    changed: 0,
    unchanged: 0,
    anomalies: [],
    durationMs: Math.max(0, Date.parse(deps.now()) - Date.parse(startedAt)),
    ...extra,
  });

  let ledgerId: string;
  try {
    const claim = deps.store.claimPull(startedAt, {
      minIntervalMs: PULL_MIN_INTERVAL_MS,
      runningTtlMs: RUNNING_TTL_MS,
      force: opts.force === true,
      // An accepting (operator release) pull skips the forced floor; see IPullOptions.accept.
      forcedMinIntervalMs: (opts.accept?.length ?? 0) > 0 ? undefined : FORCED_MIN_INTERVAL_MS,
      sourceUrl: url,
    });
    if (!claim.claimed) {
      deps.logger.info({ reason: claim.reason }, 'pricing: pull skipped (not claimed)');
      ops('pricing.pull.skipped', { reason: claim.reason, forced: opts.force === true, accept: accepted, url });
      return base({ status: 'skipped', reason: claim.reason });
    }
    ledgerId = claim.ledgerId;
    ops('pricing.pull.start', { ledger_id: ledgerId, url, forced: opts.force === true, accept: accepted });
  } catch (err) {
    const error = `claim failed: ${err instanceof Error ? err.message : String(err)}`;
    deps.logger.error({ err }, 'pricing: could not claim the price pull; last good prices keep serving');
    ops('pricing.pull.end', { status: 'failed', phase: 'claim', error, forced: opts.force === true, url }, 'error');
    return base({ error });
  }

  const finish = (
    status: Exclude<IPullResult['status'], 'skipped'>,
    extra: Partial<IPullResult> & { error?: string }
  ): IPullResult => {
    const result = base({ status, ledgerId, ...extra });
    try {
      const closed = deps.store.finishPull(ledgerId, {
        status,
        finishedAt: deps.now(),
        httpStatus: result.httpStatus ?? null,
        modelsSeen: result.models || null,
        newCount: result.new,
        changedCount: result.changed,
        unchangedCount: result.unchanged,
        anomalies: result.anomalies,
        error: result.error ?? null,
        durationMs: result.durationMs,
      });
      if (!closed) {
        deps.logger.warn(
          { ledgerId, status },
          'pricing: ledger row was no longer running (superseded or already closed); outcome not recorded'
        );
      }
    } catch (err) {
      deps.logger.error({ err, ledgerId }, 'pricing: could not close the pull ledger row');
    }
    if (status !== 'ok') {
      deps.logger.error(
        { status, ledgerId, httpStatus: result.httpStatus, cause: result.error },
        'pricing: live price pull did not update prices; last good prices keep serving'
      );
    }
    ops(
      'pricing.pull.end',
      {
        ledger_id: ledgerId,
        status,
        http_status: result.httpStatus ?? null,
        models: result.models,
        new: result.new,
        changed: result.changed,
        unchanged: result.unchanged,
        anomalies: result.anomalies.length,
        held: result.anomalies.filter((a) => a.severity === 'hold').length,
        warned: result.anomalies.filter((a) => a.severity === 'warn').length,
        accepted,
        duration_ms: result.durationMs,
        ...(result.error ? { error: result.error } : {}),
      },
      status === 'ok' ? 'info' : 'warn'
    );
    return result;
  };

  try {
    let attempt = await attemptFetch(deps, url);
    if (!attempt.ok && attempt.retryable) {
      const wait = Math.min(attempt.retryAfterMs ?? DEFAULT_RETRY_WAIT_MS, MAX_RETRY_WAIT_MS);
      deps.logger.warn(
        { cause: attempt.error, waitMs: wait },
        'pricing: price feed request failed; retrying once'
      );
      ops('pricing.pull.retry', { ledger_id: ledgerId, cause: attempt.error, wait_ms: wait }, 'warn');
      await sleep(wait, deps.signal);
      attempt = deps.signal?.aborted
        ? { ok: false, retryable: false, error: 'aborted: shutdown' }
        : await attemptFetch(deps, url);
    }
    if (!attempt.ok) return finish('failed', { error: attempt.error, httpStatus: attempt.httpStatus });

    let json: unknown;
    try {
      json = JSON.parse(attempt.body);
    } catch {
      return finish('failed', {
        error: `response is not valid JSON (starts: ${JSON.stringify(attempt.body.slice(0, 120))})`,
        httpStatus: attempt.httpStatus,
      });
    }

    const parsed = parseOpenRouterFeed(json);
    if (parsed.invalid.length > 0) {
      return finish('rejected_invalid', {
        error: `${parsed.invalid.length} invalid entr${parsed.invalid.length === 1 ? 'y' : 'ies'}: ${parsed.invalid.slice(0, 5).join('; ')}`,
        httpStatus: attempt.httpStatus,
        models: parsed.models.length,
      });
    }

    const previous =
      deps.store.lastLedger(deps.now()).lastOk?.modelsSeen ??
      deps.baselineModelCount ??
      PRICING_SNAPSHOT_META.modelCount;
    if (parsed.models.length === 0 || parsed.models.length < previous * SHRINK_MIN_RATIO) {
      return finish('rejected_shrink', {
        error: `feed has ${parsed.models.length} models, previous ${previous} (minimum ${Math.ceil(previous * SHRINK_MIN_RATIO)})`,
        httpStatus: attempt.httpStatus,
        models: parsed.models.length,
      });
    }

    const fetchedAt = deps.now();
    const applied = deps.store.applyObservation(
      ledgerId,
      parsed.models.map(toPriceRow),
      fetchedAt,
      new Set(opts.accept ?? [])
    );
    for (const a of applied.anomalies) {
      ops(
        'pricing.anomaly',
        {
          ledger_id: ledgerId,
          model_id: a.modelId,
          severity: a.severity,
          reason: a.reason,
          field: a.field,
          previous: a.previous,
          observed: a.observed,
          accepted: accepted.some((m) => m.toLowerCase() === a.modelId.toLowerCase()),
        },
        a.severity === 'hold' ? 'error' : 'warn'
      );
      const log = a.severity === 'hold' ? deps.logger.error : deps.logger.warn;
      log.call(
        deps.logger,
        { anomaly: a },
        a.severity === 'hold'
          ? `pricing: price HELD, not applied (re-run pricing_refresh with accept:["${a.modelId}"] to apply): ${a.reason}`
          : `pricing: price anomaly: ${a.reason}`
      );
    }
    const result = finish('ok', {
      fetchedAt,
      httpStatus: attempt.httpStatus,
      models: parsed.models.length,
      new: applied.newIds.length,
      changed: applied.changedIds.length,
      unchanged: applied.unchangedCount,
      anomalies: applied.anomalies,
    });
    deps.logger.info(
      { ledgerId, models: result.models, new: result.new, changed: result.changed, unchanged: result.unchanged, anomalies: result.anomalies.length },
      'pricing: live price pull complete'
    );
    return result;
  } catch (err) {
    return finish('failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
