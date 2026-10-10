/**
 * Provider fault handling shared by the `anthropic` and `claudecli` adapters (9ed453c1 FLT /
 * de6bee5d FLT-1..FLT-6; SPEC `docs/plan/provider-failure/SPEC.md` PF-2/PF-4 subset).
 *
 * Classification is NOT done here: raw SDK / CLI errors are normalised into the PF-1
 * {@link RawProviderError} and handed to `classifyProviderError` (`@adhd/agent-core-provider`).
 * This module adds only what a single provider adapter needs:
 *
 *  - {@link ProviderCallError}: a `ToolError` whose `data` is the typed {@link ProviderFailure}.
 *  - {@link callWithRetry}: the ONE retry owner for an adapter. Capped exponential full-jitter backoff
 *    honouring `Retry-After`/reset, at most `maxRetries` (default 2) retries of a TRANSIENT class
 *    (rate_limited / overloaded / unavailable), ZERO retries of a quota / usage-window / billing
 *    limit (fails fast with the reset time), total waiting bounded by the retry window, and no retry
 *    once the caller's signal aborted.
 *  - {@link TripRegistry}: PROCESS-LOCAL memory of a failing credential so that concurrent tasks in
 *    ONE process do not each rediscover it. This is NOT the cross-process tripwire: other agent-mcp
 *    processes on the same credential do not see it. The cross-process store is PF-3
 *    (`provider_trips` in `agent-store-runtime`), not yet built; keys are laid out per SPEC §9.2 so
 *    the registry can later be backed by it.
 */
import { createHash } from 'node:crypto';

import type {
  ProviderFailure,
  ProviderFailureClass,
  ProviderFailureProviderType,
} from '@adhd/agent-base-types';
import { errorCodeForFailureClass } from '@adhd/agent-base-types';
import {
  classifyProviderError,
  cooldownBaseMs,
  exceedsRetryWaitCap,
  fullJitterBackoffMs,
  type RawProviderError,
  type Rng,
} from '@adhd/agent-core-provider';

import { ToolError } from '../validation/errors.js';

// ─── typed error ─────────────────────────────────────────────────────────────

/** A provider failure carrying the classified {@link ProviderFailure} on `data`. */
export class ProviderCallError extends ToolError {
  declare readonly data: ProviderFailure;
  /** ISO time the provider says the limit lifts (usage window / `Retry-After`), when known. */
  readonly resetAt?: string;

  constructor(failure: ProviderFailure, message: string, resetAtMs?: number, options?: { cause?: unknown }) {
    super(errorCodeForFailureClass(failure.class) ?? 'PROVIDER_ERROR', message, failure);
    this.name = 'ProviderCallError';
    if (resetAtMs !== undefined) this.resetAt = new Date(resetAtMs).toISOString();
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export function isProviderCallError(e: unknown): e is ProviderCallError {
  return e instanceof ProviderCallError;
}

/** Whether a failure is a hard limit (quota / billing / usage window / auth): never retried, never waited out. */
export function isHardLimit(f: ProviderFailure): boolean {
  if (f.class === 'billing' || f.class === 'auth' || f.class === 'permission') return true;
  return f.class === 'rate_limited' && f.retryable === false;
}

const TRANSIENT: ReadonlySet<ProviderFailureClass> = new Set(['rate_limited', 'overloaded', 'unavailable']);

/** Human message that always carries class, retryability and (when known) the reset time. */
export function describeFailure(f: ProviderFailure, resetAtMs?: number): string {
  const parts = [`${f.class}${f.status !== undefined ? ` (HTTP ${f.status})` : ''}`, f.retryable ? 'retryable' : 'not retryable'];
  if (resetAtMs !== undefined) parts.push(`resets at ${new Date(resetAtMs).toISOString()}`);
  // `unknown` keeps the historical `PROVIDER_ERROR: <text>` shape callers already match on.
  if (f.class === 'unknown') return `PROVIDER_ERROR: ${f.message}`;
  return `Provider ${f.class === 'rate_limited' ? 'limit' : 'failure'} [${parts.join('; ')}]: ${f.message}`;
}

// ─── identity ────────────────────────────────────────────────────────────────

/** `sha256(providerType|baseURL|secretEnvName)` truncated; never a secret (SPEC §1). */
export function credentialKeyOf(parts: { providerType: ProviderFailureProviderType; baseURL?: string; secretEnvName?: string }): string {
  return createHash('sha256')
    .update(`${parts.providerType}|${parts.baseURL ?? ''}|${parts.secretEnvName ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

// ─── clock ───────────────────────────────────────────────────────────────────

/** Injectable time so every retry/backoff/pause is deterministic in tests. */
export interface RetryClock {
  now(): number;
  /** Resolves after `ms`; MUST reject with an AbortError when `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export function abortError(signal?: AbortSignal): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  if (signal?.reason !== undefined) (e as { cause?: unknown }).cause = signal.reason;
  return e;
}

export const systemClock: RetryClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal));
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(t);
        reject(abortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

// ─── process-local trip registry ─────────────────────────────────────────────

interface TripEntry {
  until: number;
  failure: ProviderFailure;
  hard: boolean;
}

/** Retry runtime an adapter is constructed with (all injectable; defaults are the real thing). */
export interface RetryRuntime {
  clock: RetryClock;
  rng: Rng;
  registry: TripRegistry;
}

/**
 * PROCESS-LOCAL map of tripped targets (see the module doc: not cross-process).
 * Keys follow SPEC §9.2: `trip:<providerType>:<credentialScope>` for credential-scoped limits and
 * `...:<wireModel>` for model-scoped ones.
 */
export class TripRegistry {
  private readonly entries = new Map<string, TripEntry>();

  static keyFor(f: Pick<ProviderFailure, 'providerType' | 'credentialScope' | 'wireModel' | 'scope'>): string {
    const base = `trip:${f.providerType}:${f.credentialScope}`;
    return f.scope === 'credential' ? base : `${base}:${f.wireModel}`;
  }

  /** Record a trip until `untilMs`; later trips for a key only ever extend it. */
  trip(failure: ProviderFailure, untilMs: number, hard: boolean): void {
    const key = TripRegistry.keyFor(failure);
    const prev = this.entries.get(key);
    if (prev && prev.until >= untilMs && (prev.hard || !hard)) return;
    this.entries.set(key, { until: untilMs, failure, hard: hard || (prev?.hard ?? false) });
  }

  /** The live trip covering a target, credential-scoped first. */
  active(target: { providerType: ProviderFailureProviderType; credentialScope: string; wireModel: string }, nowMs: number): TripEntry | undefined {
    for (const key of [
      `trip:${target.providerType}:${target.credentialScope}`,
      `trip:${target.providerType}:${target.credentialScope}:${target.wireModel}`,
    ]) {
      const e = this.entries.get(key);
      if (!e) continue;
      if (e.until <= nowMs) {
        this.entries.delete(key);
        continue;
      }
      return e;
    }
    return undefined;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** The registry every adapter in this process shares by default. */
export const processTripRegistry = new TripRegistry();

export function defaultRetryRuntime(): RetryRuntime {
  return { clock: systemClock, rng: Math.random, registry: processTripRegistry };
}

// ─── retry owner ─────────────────────────────────────────────────────────────

export interface RetryPolicy {
  /** Max retries after the first attempt. Default 2 (so attempts <= 3). */
  retries: number;
  minTimeout: number;
  maxTimeout: number;
  factor: number;
  /** Bounds only STARTING a new attempt and backoff sleeps; an in-flight attempt is never aborted by it. */
  windowMs: number;
}

export const DEFAULT_RETRY_POLICY: Omit<RetryPolicy, 'windowMs'> = {
  retries: 2,
  minTimeout: 500,
  maxTimeout: 8_000,
  factor: 2,
};

export interface CallWithRetryOptions {
  runtime: RetryRuntime;
  policy: RetryPolicy;
  target: { providerType: ProviderFailureProviderType; credentialScope: string; wireModel: string };
  signal?: AbortSignal;
  /** Turn a thrown error into a typed failure; `undefined` means "not a provider fault, rethrow as-is". */
  classify: (err: unknown) => ProviderFailure | undefined;
  /** Called once per failed attempt that will be retried (observability seam). */
  onRetry?: (info: { attempt: number; failure: ProviderFailure; waitMs: number }) => void;
}

function resetMs(f: ProviderFailure, now: number): number | undefined {
  return f.retryAfterMs !== undefined ? now + f.retryAfterMs : undefined;
}

/**
 * Run `run` under the shared fault policy. Throws {@link ProviderCallError} for any classified
 * provider fault; rethrows non-provider errors and aborts unchanged.
 */
export async function callWithRetry<T>(run: (attempt: number) => Promise<T>, opts: CallWithRetryOptions): Promise<T> {
  const { runtime, policy, target, signal } = opts;
  const { clock, registry } = runtime;
  const windowEnd = clock.now() + policy.windowMs;

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw abortError(signal);

    // A trip opened by ANY task on this credential (this process) is honoured before spending a request.
    const trip = registry.active(target, clock.now());
    if (trip) {
      const remaining = trip.until - clock.now();
      if (trip.hard || remaining >= windowEnd - clock.now()) {
        const f: ProviderFailure = { ...trip.failure, source: 'trip' };
        throw new ProviderCallError(f, describeFailure(f, trip.until), trip.until);
      }
      await clock.sleep(remaining, signal);
      continue; // re-check: the pause may have been extended meanwhile
    }

    try {
      return await run(attempt);
    } catch (err) {
      if (signal?.aborted) throw err; // never retry (or reclassify) after abort
      const failure = opts.classify(err);
      if (!failure || failure.class === 'cancelled') throw err;
      const now = clock.now();
      const reset = resetMs(failure, now);

      if (isHardLimit(failure) || failure.toolUseEmitted === true || !TRANSIENT.has(failure.class)) {
        if (isHardLimit(failure)) {
          const cool = cooldownBaseMs(failure.class, failure.retryAfterMs) ?? 60_000;
          registry.trip(failure, reset ?? now + cool, true);
        }
        throw new ProviderCallError(failure, describeFailure(failure, reset), reset, { cause: err });
      }

      // Transient.
      const hinted = failure.retryAfterMs;
      const tooLong = exceedsRetryWaitCap(hinted);
      const backoff = fullJitterBackoffMs(attempt - 1, policy, runtime.rng);
      const waitMs = Math.max(hinted ?? 0, backoff);
      const exhausted = attempt > policy.retries || tooLong || now + waitMs >= windowEnd;
      // Pause every other task on this target for the stated delay (the shared limiter).
      registry.trip(failure, now + (hinted ?? waitMs), tooLong);
      if (exhausted) throw new ProviderCallError(failure, describeFailure(failure, reset), reset, { cause: err });

      opts.onRetry?.({ attempt, failure, waitMs });
      await clock.sleep(waitMs, signal);
    }
  }
}

// ─── raw extraction ──────────────────────────────────────────────────────────

function headerBag(h: unknown): RawProviderError['headers'] {
  if (!h || typeof h !== 'object') return undefined;
  const maybe = h as { forEach?: (cb: (v: string, k: string) => void) => void };
  if (typeof maybe.forEach === 'function') {
    const out: Record<string, string> = {};
    maybe.forEach.call(h, (v: string, k: string) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  return h as RawProviderError['headers'];
}

/** Normalise an Anthropic/OpenAI SDK error (`APIError`) into the classifier input. Reads no secret. */
export function rawFromSdkError(
  err: unknown,
  ctx: Pick<RawProviderError, 'providerType' | 'modelRef' | 'wireModel' | 'credentialKey' | 'credentialScope'> & { host?: string },
  aborted: boolean
): RawProviderError {
  const e = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
  const raw: RawProviderError = {
    ...ctx,
    source: typeof e['status'] === 'number' ? 'http' : 'transport',
    aborted,
    message: err instanceof Error ? err.message : String(err),
  };
  if (typeof e['status'] === 'number') raw.status = e['status'];
  const headers = headerBag(e['headers']);
  if (headers) raw.headers = headers;
  if (e['error'] !== undefined) raw.body = e['error'];
  if (err instanceof Error) raw.errorName = err.name;
  if (typeof e['code'] === 'string') raw.errorCode = e['code'];
  const rid = e['requestID'] ?? e['request_id'];
  if (typeof rid === 'string') raw.requestId = rid;
  return raw;
}

/** Classify an SDK error; `undefined` for errors that are not provider faults (plain programmer errors). */
export function classifySdkError(
  err: unknown,
  ctx: Parameters<typeof rawFromSdkError>[1],
  aborted: boolean
): ProviderFailure | undefined {
  if (isProviderCallError(err)) return err.data;
  if (!(err instanceof Error)) return undefined;
  return classifyProviderError(rawFromSdkError(err, ctx, aborted));
}

// ─── claude CLI faults ───────────────────────────────────────────────────────

/**
 * The `rate_limit_info` of a stream-json `rate_limit_event`. Shape verified against the zod schema
 * shipped inside the `claude` 2.1.296 binary and against recorded `allowed`/`allowed_warning` events in
 * `~/.adhd/agent-mcp/*\/logs/api`: `status` is `allowed | allowed_warning | rejected`, `resetsAt` is
 * epoch SECONDS, `rateLimitType` is `five_hour | seven_day | seven_day_opus | seven_day_sonnet |
 * seven_day_overage_included | overage`. A `rejected` event has not been captured live (never triggered).
 */
export interface CliRateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  overageStatus?: string;
}

/** A limit/window warning surfaced to the caller instead of being swallowed (FLT-4). */
export interface ProviderLimitWarning {
  kind: 'usage_window';
  status: CliRateLimitInfo['status'];
  rateLimitType?: string;
  utilization?: number;
  /** ISO reset time. */
  resetsAt?: string;
  overageStatus?: string;
}

/** Parse a `rate_limit_event` stream line; `undefined` when it is not a well-formed one. */
export function parseCliRateLimitEvent(event: unknown): CliRateLimitInfo | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const info = (event as { rate_limit_info?: unknown }).rate_limit_info;
  if (typeof info !== 'object' || info === null) return undefined;
  const i = info as Record<string, unknown>;
  const status = i['status'];
  if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') return undefined;
  return {
    status,
    ...(typeof i['resetsAt'] === 'number' ? { resetsAt: i['resetsAt'] } : {}),
    ...(typeof i['rateLimitType'] === 'string' ? { rateLimitType: i['rateLimitType'] } : {}),
    ...(typeof i['utilization'] === 'number' ? { utilization: i['utilization'] } : {}),
    ...(typeof i['overageStatus'] === 'string' ? { overageStatus: i['overageStatus'] } : {}),
  };
}

export function toLimitWarning(info: CliRateLimitInfo): ProviderLimitWarning {
  return {
    kind: 'usage_window',
    status: info.status,
    ...(info.rateLimitType !== undefined ? { rateLimitType: info.rateLimitType } : {}),
    ...(info.utilization !== undefined ? { utilization: info.utilization } : {}),
    ...(info.resetsAt !== undefined ? { resetsAt: new Date(info.resetsAt * 1000).toISOString() } : {}),
    ...(info.overageStatus !== undefined ? { overageStatus: info.overageStatus } : {}),
  };
}

/**
 * UNVERIFIED text fallbacks, used only when neither a structured `rejected` event nor an
 * `api_error_status` is present. Anchored; never widen without a captured fixture. The strings come
 * from the CLI binary's UI copy ("You've hit your monthly spend limit", "...weekly usage limit"), not
 * from a captured error result.
 */
export const CLI_WINDOW_TEXT = /^(?:you['’]ve hit your\b.*\blimit|claude (?:ai )?usage limit reached|(?:5-hour|weekly|session) limit reached)/i;
export const CLI_API_ERROR_TEXT = /^API Error:?\s*(\d{3})\b/;

export interface CliFaultEvidence {
  /** The terminal `result` event when it had `is_error: true`. */
  errorResult?: { text?: string; apiErrorStatus?: number | null };
  /** A `rate_limit_event` whose status was `rejected`. */
  rejected?: CliRateLimitInfo;
  /** Present only when the process ended without a `result`. */
  exitCode?: number | null;
  signal?: string | null;
  stderrTail?: string;
  toolUseEmitted: boolean;
}

type CliCtx = Pick<RawProviderError, 'providerType' | 'modelRef' | 'wireModel' | 'credentialKey' | 'credentialScope'>;

/**
 * Turn what the CLI showed into a typed failure. Order (first match wins): structured `rejected`
 * event -> `result.api_error_status` -> anchored text fallbacks -> non-zero exit with stderr tail.
 * Returns `undefined` when there is no evidence of a fault (the caller keeps its empty-result error).
 * A usage-window limit is `rate_limited`, credential-scoped, NOT retryable, resumable, with the reset
 * time in `retryAfterMs`; a transient 429/529 stays retryable.
 */
export function classifyCliFault(
  ev: CliFaultEvidence,
  ctx: CliCtx,
  nowMs: number
): { failure: ProviderFailure; resetAtMs?: number } | undefined {
  const text = ev.errorResult?.text?.trim() || undefined;
  // The CLI relays Anthropic API errors, so HTTP-status rules (529 = overloaded) are the `anthropic`
  // rules; the adapter identity is restored on the result below.
  const base = { ...ctx, providerType: 'anthropic' as const, toolUseEmitted: ev.toolUseEmitted, nowMs };
  const asCli = (f: ProviderFailure): ProviderFailure => ({ ...f, providerType: ctx.providerType });
  const windowByText = text !== undefined && CLI_WINDOW_TEXT.test(text);

  if (ev.rejected || windowByText) {
    const resetAtMs = ev.rejected?.resetsAt !== undefined ? ev.rejected.resetsAt * 1000 : undefined;
    const label = ev.rejected?.rateLimitType ? ` (${ev.rejected.rateLimitType})` : '';
    const f = classifyProviderError({
      ...base,
      source: 'stream-event',
      status: 429,
      message: text ?? `Claude usage window limit reached${label}`,
    });
    const failure: ProviderFailure = {
      ...asCli(f),
      class: 'rate_limited',
      scope: 'credential',
      retryable: false,
      resumable: true,
      ...(resetAtMs !== undefined ? { retryAfterMs: Math.max(0, resetAtMs - nowMs) } : {}),
    };
    return { failure, ...(resetAtMs !== undefined ? { resetAtMs } : {}) };
  }

  const status =
    ev.errorResult?.apiErrorStatus ?? (text !== undefined ? Number(CLI_API_ERROR_TEXT.exec(text)?.[1]) || undefined : undefined);
  if (ev.errorResult) {
    const failure = asCli(
      classifyProviderError({
        ...base,
        source: status !== undefined ? 'http' : 'cli-text',
        ...(status !== undefined ? { status } : {}),
        message: `claude CLI returned error: ${text ?? '(no message)'}`,
      })
    );
    return { failure };
  }

  if (ev.exitCode !== undefined && ev.exitCode !== null && ev.exitCode !== 0) {
    const tail = ev.stderrTail?.trim();
    const failure = asCli(classifyProviderError({
      ...base,
      source: 'cli-text',
      message: `claude CLI exited with code ${ev.exitCode}${tail ? `: ${tail}` : ' with no stderr'}`,
    }));
    return { failure };
  }
  if (ev.signal) {
    const failure = asCli(classifyProviderError({
      ...base,
      source: 'cli-text',
      message: `claude CLI was killed by ${ev.signal}${ev.stderrTail?.trim() ? `: ${ev.stderrTail.trim()}` : ''}`,
    }));
    return { failure };
  }
  return undefined;
}
