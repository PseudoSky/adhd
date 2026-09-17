/**
 * envelope.ts — the transport-facing response envelope: its closed error-code
 * union, the exit codes a CLI host keys off, and the constructors/guards every
 * surface (CLI, MCP, HTTP) branches on.
 *
 * **Why this is its own module.** This machinery previously lived in a
 * 2,936-line god-module alongside the entire superseded application layer. It
 * is the one piece of that module the replacement layer genuinely needs, so
 * keeping it there meant the god-module could never be deleted. Nothing here
 * depends on any item/store type — the envelope is deliberately about SHAPE,
 * not about what is being carried — so it has zero internal imports and sits
 * at the bottom of the dependency graph.
 *
 * **The error-code union is DERIVED, not curated.** The set below is exactly
 * the image of {@link toEnvelopeCode}'s class→code mapping. That rule matters:
 * an earlier attempt to prune the union by grepping for literal code strings
 * found four codes "unused" and would have deleted two that are load-bearing,
 * because codes are never written as literals at the throw site — they are
 * produced by mapping a thrown error class. A code belongs here if and only if
 * some error class maps to it. Add a class, add its code; delete the last
 * class that maps to a code, delete the code.
 */

/**
 * The closed union of envelope error codes.
 *
 * Each member names the error class(es) that produce it, so the derivation
 * rule in this file's header can be checked by reading rather than inferred.
 */
export const BACKLOG_ERROR_CODES = [
  /** A referenced catalog entry (project/component/kind/status/priority) does not exist — `CatalogNotFoundError`. Exit 4. */
  'not_found',
  /**
   * The addressed ISSUE does not exist — `IssueNotFoundError`. Deliberately
   * distinct from `not_found` (a bad catalog reference) and from `internal`
   * (the server failed): a caller that asked for a uid which is simply not
   * there has made neither a malformed request nor triggered a crash, and
   * must be able to tell those three apart by `code` alone. Exit 1.
   */
  'item_not_found',
  /** Malformed flag or parameter shape — `InvalidArgumentError`. Exit 2. */
  'invalid_argument',
  /** Schema rejection: unknown filter key, unknown projection field, over-limit — `BacklogValidationError`. Exit 2. */
  'validation',
  /** Store contention (busy/lease). `details.retryable === true` + `retryAfterMs` — `WriteContentionError`. Exit 1. */
  'store_busy',
  /** A semantic/anchor/similarity read with no embedding backend, or an empty vector space — `RagNotConfiguredError`. Exit 1. */
  'rag_not_configured',
  /** Someone else holds the claim, a single-valued relation is taken, or a supersede raced — `ClaimHeldError`, `SingleValuedRelationConflictError`, `StaleSupersedeError`. Exit 1. */
  'conflict',
  /** A gate refused the write: a terminal transition missing its citation or note, or an unverifiable citation — `CitationRequiredError`, `NoteRequiredError`, `CitationUnverifiableError`. Exit 1. */
  'precondition_failed',
  /** Unclassified server-side failure — `WriteIOError`, or any non-`BacklogWriteError` throw. Exit 1. NEVER the same code as `item_not_found`. */
  'internal',
] as const;

/** The closed union of envelope error codes. See {@link BACKLOG_ERROR_CODES}. */
export type BacklogErrorCode = (typeof BACKLOG_ERROR_CODES)[number];

const BACKLOG_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(
  BACKLOG_ERROR_CODES
);

/**
 * Runtime membership test for the closed union. The union is only genuinely
 * "closed" if something checks it at runtime — a transport that hand-built an
 * envelope with a typo'd code would otherwise ship an error no agent can
 * switch on, and TypeScript cannot see across a JSON boundary.
 */
export function isBacklogErrorCode(value: unknown): value is BacklogErrorCode {
  return typeof value === 'string' && BACKLOG_ERROR_CODE_SET.has(value);
}

/**
 * Error code → CLI process exit code.
 *
 * Verified against `@adhd/apigen-base-errors`' `CLI_EXIT_CODE`
 * (`invalid_argument: 2, not_found: 4, internal: 1`); these codes extend that
 * table without remapping any of it.
 *
 * The load-bearing property is that a caller can distinguish outcomes the
 * exit code alone collapses: `item_not_found` and `internal` both exit 1, so
 * they MUST remain distinct `code` values.
 */
export const BACKLOG_EXIT_CODE: Readonly<Record<BacklogErrorCode, number>> = {
  not_found: 4,
  item_not_found: 1,
  invalid_argument: 2,
  validation: 2,
  store_busy: 1,
  rag_not_configured: 1,
  conflict: 1,
  precondition_failed: 1,
  internal: 1,
} as const;

/**
 * `error.details`. `retryable`/`retryAfterMs` exist so an agent knows whether
 * to retry a `store_busy` and with what backoff instead of hot-looping.
 * Open-ended beyond those: individual codes attach their own evidence.
 */
export interface IOutcomeErrorDetails {
  /** True only for transient codes (today: `store_busy`). */
  retryable?: boolean;
  /** Suggested backoff in milliseconds; only meaningful when `retryable`. */
  retryAfterMs?: number;
  /**
   * Internal doc/plan reference for an `invalid_argument` whose underlying
   * reason cites internal terminology (a plan id, a spec section) that does
   * not belong in the user-facing `message`.
   */
  internalRef?: string;
  [key: string]: unknown;
}

/** The error arm's payload. */
export interface IOutcomeError {
  code: BacklogErrorCode;
  message: string;
  details?: IOutcomeErrorDetails;
}

/**
 * Pagination truth carried beside the data. `total` is the count BEFORE
 * `limit`/`offset`; `returned` is `data.length`. A silently-truncated list is
 * indistinguishable from a complete one unless the envelope says how many
 * there really were.
 */
export interface IQueryEnvelopeMeta {
  /** Matching rows before limit/offset — the TRUE count. */
  total: number;
  /** Rows actually in `data`. */
  returned: number;
  limit?: number;
  offset?: number;
  /**
   * Set when the result set was cut short by anything other than the caller's
   * own `limit`. A silent cap is forbidden — if it happens, it is stated here.
   */
  truncated?: boolean;
}

/** The success arm. `data` is always present (never `null` as a stand-in for "missing"). */
export interface IOutcomeSuccess<T> {
  ok: true;
  data: T;
  /** Non-fatal ambiguity surfaced at resolution time. A read NEVER silently narrows. */
  warnings?: string[];
  /** Present on list-shaped reads. */
  meta?: IQueryEnvelopeMeta;
}

/** The failure arm. There is no `data` on this arm at all. */
export interface IOutcomeFailure {
  ok: false;
  error: IOutcomeError;
  warnings?: string[];
}

/**
 * THE response envelope for every mounted verb.
 *
 * A `void`/`null` return is rendered by apigen as `{"result": null}` for BOTH
 * success and failure, which makes a write unverifiable. This union has no arm
 * that can express that: success carries `data`, failure carries `error`, and
 * `ok` discriminates them.
 *
 * It is a discriminated union rather than `{ ok, data?, error? }` on purpose —
 * `{ ok: true, data: null }` for a missing item is not assignable when `T` is
 * a real item type.
 */
export type IOutcomeEnvelope<T> = IOutcomeSuccess<T> | IOutcomeFailure;

/** Narrow an envelope to its success arm. */
export function isOutcomeOk<T>(
  env: IOutcomeEnvelope<T>
): env is IOutcomeSuccess<T> {
  return env.ok === true;
}

/**
 * Narrow an envelope to its failure arm.
 *
 * Deliberately structural (`ok === false` AND a well-formed `error`) — a
 * malformed half-envelope is neither ok nor a usable error, and callers must
 * not treat it as success by accident.
 */
export function isOutcomeError<T>(
  env: IOutcomeEnvelope<T>
): env is IOutcomeFailure {
  return (
    env.ok === false &&
    typeof env.error === 'object' &&
    env.error !== null &&
    isBacklogErrorCode(env.error.code)
  );
}

/** Build a success envelope. */
export function okEnvelope<T>(
  data: T,
  extra?: { warnings?: string[]; meta?: IQueryEnvelopeMeta }
): IOutcomeSuccess<T> {
  const env: IOutcomeSuccess<T> = { ok: true, data };
  if (extra?.warnings && extra.warnings.length > 0)
    env.warnings = extra.warnings;
  if (extra?.meta) env.meta = extra.meta;
  return env;
}

/** Build a failure envelope. `store_busy` is stamped retryable by default. */
export function errorEnvelope(
  code: BacklogErrorCode,
  message: string,
  details?: IOutcomeErrorDetails
): IOutcomeFailure {
  const error: IOutcomeError = { code, message };
  const merged: IOutcomeErrorDetails = { ...(details ?? {}) };
  if (code === 'store_busy' && merged.retryable === undefined)
    merged.retryable = true;
  if (Object.keys(merged).length > 0) error.details = merged;
  return { ok: false, error };
}

/** The process exit code a CLI host must use for an envelope. Success is always 0. */
export function exitCodeForEnvelope<T>(env: IOutcomeEnvelope<T>): number {
  return env.ok ? 0 : BACKLOG_EXIT_CODE[env.error.code];
}

/**
 * Structural guard for a value that came back from a transport, where the
 * static type is erased. Recognises BOTH arms.
 *
 * Used by the CLI's `options.exitCode` hook — a non-envelope result (a `--use`
 * mount, a plugin's own synthetic op) must fall through to apigen's default
 * exit-0-on-return, never be mapped by this table.
 */
export function isOutcomeEnvelope(
  value: unknown
): value is IOutcomeEnvelope<unknown> {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v['ok'] !== 'boolean') return false;
  if (v['ok']) return true;
  const err = v['error'];
  if (err === null || typeof err !== 'object') return false;
  const code = (err as Record<string, unknown>)['code'];
  return typeof code === 'string' && code in BACKLOG_EXIT_CODE;
}

/** Why a similarity-ranked read cannot be served. */
export type RagUnavailableReason = 'not_configured' | 'empty_vector_space';

/**
 * A similarity-ranked read was requested but cannot be served.
 *
 * Distinguishes "no backend at all" from "a backend exists but nothing has
 * been embedded yet" — an unbackfilled space would otherwise return an empty
 * result set, which reads as "no matches" when the truth is "this ranking is
 * not available." Reporting it as disabled is the honest answer.
 */
export class RagNotConfiguredError extends Error {
  constructor(
    feature: string,
    readonly reason: RagUnavailableReason = 'not_configured'
  ) {
    super(
      (reason === 'empty_vector_space'
        ? `backlog: "${feature}" needs an embedded vector space and this store has none — a backend is configured, but zero items have been embedded, ` +
          `so nearest-neighbour ranking has nothing to rank. Run an embedding backfill to populate it. `
        : `backlog: "${feature}" needs a configured embedding backend and none is available. `) +
        `Keyword and dimensional queries still work.`
    );
    this.name = 'RagNotConfiguredError';
  }
}
