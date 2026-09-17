/**
 * errors.ts — the write layer error taxonomy (SPEC.md §4c).
 *
 * Every write-layer write ultimately fails in exactly one of two ways, never a raw
 * driver exception and never a bare string:
 *
 * 1. A **named, typed, transport-facing class** thrown before any driver call
 *    ever runs (an app-level validation failure — a missing `by`, an
 *    unresolved catalog reference, a CAS conflict this spec itself detects),
 *    or thrown by {@link executeWriteTransaction} (tx.ts) after it has
 *    decided a driver-level failure is terminal.
 * 2. The internal {@link IWriteError} envelope — `tx.ts`'s OWN pattern-matched
 *    shape for a caught driver-level failure, used only to decide
 *    retry-vs-rethrow. A caller of the write layer (createIssue, and every
 *    other §6.3 verb) never sees this shape directly; they only ever catch
 *    one of the named classes below.
 *
 * All named classes here are `E_VALIDATION`- or `E_CONSTRAINT`-class
 * members of the same union (SPEC.md §4c, "Two failure-signaling shapes,
 * reconciled into one contract") — `IssueNotFoundError`, `InvalidArgumentError`,
 * `CatalogNotFoundError`, `ClaimHeldError`, `SingleValuedRelationConflictError`,
 * `NoteRequiredError`, `CitationRequiredError`, `CitationUnverifiableError` are
 * `E_VALIDATION` (never retryable — thrown before any driver call runs);
 * `StaleSupersedeError` is the one deliberate `E_CONSTRAINT` this spec's own
 * `supersede` CAS raises (§4c, "updateIssue's body path"). `WriteContentionError`
 * / `WriteIOError` are the two driver-level classes tx.ts's retry loop
 * produces on exhaustion (`E_CONTENTION` / `E_IO`).
 */

import {
  isBusyError,
  isConcurrentConflict,
  isDatabaseError,
  isForeignKeyError,
  isUniqueConstraintError,
} from '@adhd/sox-store-adapter';

/** The closed code union every {@link IWriteError} carries (SPEC.md §4c). */
export type WriteErrorCode =
  | 'E_CONTENTION'
  | 'E_CONSTRAINT'
  | 'E_VALIDATION'
  | 'E_IO';

/**
 * The write layer's internal envelope for a caught driver-level failure
 * (SPEC.md §4c). This is NEVER the shape a caller of `createIssue` (or any
 * other write-layer verb) receives directly — it is what `tx.ts`'s retry loop pattern-
 * matches on internally before re-throwing one of the named classes below.
 * `retryable` is the ONLY field a caller should ever branch on, and only on
 * the named classes that carry it forward — never a message-text match.
 */
export interface IWriteError {
  code: WriteErrorCode;
  retryable: boolean;
  retry_after_ms?: number;
  message: string;
  /** The original driver-native error — never swallowed. */
  cause: unknown;
}

/**
 * Common base for every transport-facing error the write layer throws.
 * `tx.ts`'s retry loop uses `instanceof BacklogWriteError` to recognize an
 * already-decided, terminal failure (thrown from inside a verb's own
 * transaction callback) and rethrow it untouched — never reclassify or retry
 * a failure this layer has already named.
 */
export abstract class BacklogWriteError extends Error implements IWriteError {
  abstract readonly code: WriteErrorCode;
  abstract readonly retryable: boolean;
  readonly retry_after_ms?: number;
  readonly cause: unknown;

  protected constructor(
    message: string,
    cause: unknown = undefined,
    retryAfterMs?: number
  ) {
    super(message);
    this.name = new.target.name;
    this.cause = cause;
    this.retry_after_ms = retryAfterMs;
  }
}

/**
 * `E_CONTENTION`, exhausted. Thrown by {@link executeWriteTransaction}
 * (tx.ts) after 3 total attempts (1 initial + 2 retries, 250ms/500ms linear
 * backoff — SPEC.md §4c "Retry semantics") all failed on lock/commit
 * contention (`isBusyError`/`isConcurrentConflict`). `retryable` stays `true`
 * even on exhaustion (ADR-0012 §4's own contract) — the caller, not the write
 * layer, owns any retry beyond this bound.
 */
export class WriteContentionError extends BacklogWriteError {
  readonly code = 'E_CONTENTION' as const;
  readonly retryable = true;

  constructor(retryAfterMs: number, cause: unknown) {
    super(
      `Write contention: exhausted the retry budget (last backoff ${retryAfterMs}ms)`,
      cause,
      retryAfterMs
    );
  }
}

/**
 * `E_IO`, the first (and, by design, only) occurrence — SPEC.md §4c never
 * auto-retries `E_IO` on any write-layer verb, because `writeAudit` (§4a)
 * rides inside literally every write transaction as an unguarded, keyless
 * INSERT. `retryable` stays `true` (ADR-0012 §4) — the caller, who alone has
 * the business context to check whether the write actually landed (e.g. a
 * `query` before resubmitting), owns the decision to retry.
 *
 * Constructed by {@link executeWriteTransaction} (tx.ts) ONLY for
 * {@link classifyDriverError}'s recognized-but-unclassified-database-error
 * branch (`isDatabaseError(err)` true). A genuinely unrecognized,
 * non-database-shaped failure (`isDatabaseError(err)` false — a deterministic
 * bug in this module's own code) is never wrapped in this class — it would
 * assert `retryable: true` on a failure that can never succeed on retry — and
 * is instead rethrown untouched by the caller.
 */
export class WriteIOError extends BacklogWriteError {
  readonly code = 'E_IO' as const;
  readonly retryable = true;

  constructor(cause: unknown) {
    super(
      'Write I/O failure: an unclassified driver/connection error surfaced from the underlying transaction',
      cause
    );
  }
}

/**
 * The one deliberate `E_CONSTRAINT` this spec's own CAS raises (SPEC.md
 * §4c, "updateIssue's body path: supersede needs a CAS the library doesn't
 * give it") — the `UPDATE node SET is_superseded = 1 WHERE rowid = ? AND
 * is_superseded = 0` guard affected zero rows, meaning a concurrent writer
 * already superseded the same target first. Never retryable — retrying a
 * terminal CAS loss cannot change its outcome.
 */
export class StaleSupersedeError extends BacklogWriteError {
  readonly code = 'E_CONSTRAINT' as const;
  readonly retryable = false;

  /**
   * @param uid The stale uid the caller passed in.
   * @param successorUid The uid this issue lives under NOW, when it is known —
   *   the head of the `SUPERSEDES` chain starting at `uid`. Supplied by the
   *   READ path (`resolveIssueByUid`), which can walk the chain against
   *   committed state. The WRITE-path CAS deliberately omits it: it loses the
   *   race *inside* its own transaction, so any successor it read would be a
   *   uid another in-flight writer may still supersede before this caller
   *   acts on it. Absent means "not known here", never "none exists".
   */
  constructor(
    public readonly uid: string,
    public readonly successorUid?: string
  ) {
    super(
      successorUid === undefined
        ? `Issue "${uid}" was already superseded by a concurrent write; re-get and retry`
        : `Issue "${uid}" was superseded by a body edit and is no longer the live issue; it now lives under "${successorUid}"`
    );
  }
}

/**
 * A `project`/`component`/`kind`/`status`/`priority`/`agent`/`edge_kind`
 * reference did not resolve. Thrown for a UUID-shaped `ref` that has no live
 * row (uids are never auto-vivified, SPEC.md §6.1), and for `project`/
 * `component` NAMEs, which `createIssue` never mints (§1, §6.1 — component
 * and project are resolved-only by every issue verb).
 */
export class CatalogNotFoundError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;

  constructor(
    public readonly catalogKind: string,
    public readonly ref: string
  ) {
    super(`${catalogKind} "${ref}" was not found`);
  }
}

/** A caller-supplied argument is missing, blank, or fails a project-declared invariant. */
export class InvalidArgumentError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;

  constructor(public readonly field: string, detail?: string) {
    super(
      detail
        ? `Invalid argument "${field}": ${detail}`
        : `Invalid argument "${field}"`
    );
  }
}

/** No live `issue` node carries the given `uid` (SPEC.md §6.1). */
export class IssueNotFoundError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;

  constructor(public readonly uid: string) {
    super(`No live issue found for uid "${uid}"`);
  }
}

/**
 * `claim` (§6.3.5): the lease is held by someone else, not yet stale, and the
 * caller did not pass `force:true`.
 */
export class ClaimHeldError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;

  constructor(
    public readonly heldBy: string,
    public readonly heldSince: string
  ) {
    super(`Claim already held by "${heldBy}" since ${heldSince}`);
  }
}

/**
 * `relate` (§6.3.6): a single-valued rel already has a value on the CAPPED
 * side, and it is not the one being added. This is the SAME
 * `edge_kind.multiplicity` gate every edge write runs (§2, `checkMultiplicityTx`
 * in tx.ts) — `relate`'s `n:1` rels (`supersedes`, `duplicate_of`, `part_of`)
 * are its most visible caller, but the gate is generic over BOTH capped
 * multiplicities `edge_kind` declares (§2):
 *
 * - `n:1` — the SOURCE's out-degree is capped at one (`side: 'source'`): the
 *   source already points at a different target.
 * - `1:n` — the TARGET's in-degree is capped at one (`side: 'target'`): the
 *   target is already pointed at by a different source.
 *
 * Deliberately a single named-options constructor, not positional
 * `(a, b, c)` args — `checkMultiplicityTx`'s two branches resolve the capped
 * uid and the conflicting uid via DIFFERENT SQL joins (one via `e.dst`, one
 * via `e.src`), and two same-shaped `string` positional args are trivially
 * swappable by a future edit without a type error to catch it (exactly what
 * happened to the 1:n branch before this fix — the message string still read
 * as plausible English with the values swapped, which is how it went
 * unnoticed). Named fields make the mistake a call site can no longer make
 * silently.
 */
export class SingleValuedRelationConflictError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;

  /** Which side of `rel` this multiplicity rule caps at one value. */
  public readonly side: 'source' | 'target';
  /** The uid of the node whose `side` is capped (already at its one allowed value). */
  public readonly cappedUid: string;
  public readonly rel: string;
  /** The uid of the pre-existing OTHER endpoint already occupying the capped side's one slot. */
  public readonly conflictingUid: string;

  constructor(input: {
    side: 'source' | 'target';
    cappedUid: string;
    rel: string;
    conflictingUid: string;
  }) {
    const message =
      input.side === 'source'
        ? `"${input.rel}" already has a single target (${input.conflictingUid}) for source "${input.cappedUid}"`
        : `"${input.rel}" already has a single source (${input.conflictingUid}) for target "${input.cappedUid}"`;
    super(message);
    this.side = input.side;
    this.cappedUid = input.cappedUid;
    this.rel = input.rel;
    this.conflictingUid = input.conflictingUid;
  }
}

/**
 * A citation's `sha` resolved to the `"unverified"` sentinel (§8.5's
 * two-branch rule: file not found, or the issue's project has no known
 * filesystem `path`) and `project_policy.citation_requires_sha` (default
 * `true`) rejects that.
 */
export class CitationUnverifiableError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;

  constructor(public readonly target: string) {
    super(
      `Citation target "${target}" could not be verified and this project requires a real sha`
    );
  }
}

/** `transition` (§6.3.4): `project_policy.transition_requires_note` (default `true`) and no `note` was given. */
export class NoteRequiredError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;

  constructor(public readonly uid: string) {
    super(
      `A note is required to transition issue "${uid}" (project_policy.transition_requires_note)`
    );
  }
}

/** `transition` (§6.3.4): `project_policy.citation_required` (default `false`) is set, the target status is terminal, and no citation was given. */
export class CitationRequiredError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;

  constructor(public readonly uid: string) {
    super(
      `At least one citation is required to close issue "${uid}" (project_policy.citation_required)`
    );
  }
}

/**
 * The read layer's own validation class (SPEC.md §6.5) — an unknown `fields`
 * entry (`assertKnownFields`) or an out-of-range/non-integral `limit`
 * (`assertQueryLimit`, "a cap that isn't an error is indistinguishable from a
 * complete result"). Declared here, not in `src/query/`, per this file's own
 * "do not invent parallel ones" rule: it is the SAME `E_VALIDATION`-class
 * member of the write layer's error union (§4c), just raised by the read
 * surface — a `query`/`get` caller catches it identically to any other named
 * class in this module. `field` names the offending input key
 * (`'fields'`/`'limit'`); `detail` carries the specific reason (which unknown
 * name, or which bound was violated).
 */
export class BacklogValidationError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;

  constructor(public readonly field: string, detail?: string) {
    super(detail ? `Invalid "${field}": ${detail}` : `Invalid "${field}"`);
  }
}

/**
 * Classify a caught, RAW driver-level error (never one of our own
 * {@link BacklogWriteError} subclasses — those are already decided and must
 * never reach this function) into the internal {@link IWriteError} envelope,
 * using `@adhd/sox-store-adapter`'s portable, driver-shaped detection
 * predicates (SPEC.md §4c) — never a raw `err.code`/message match of our
 * own, since Turso's `err.code` carries no discriminating information
 * (ADR-0012 §3).
 *
 * `isDatabaseError` (`@adhd/sox-store-adapter`'s "is this err shaped like a
 * recognized database error AT ALL" predicate) is what actually distinguishes
 * the two `E_IO` sub-cases the SPEC.md §4c table collapses into one row
 * ("Unclassified driver/connection failure | `E_IO` | `isDatabaseError`
 * catch-all | `true`"):
 *
 * - A RECOGNIZED-but-otherwise-unclassified database error (`isDatabaseError`
 *   true — e.g. a driver/connection fault that isn't busy/contention/unique/FK)
 *   is the case that table row actually describes: `E_IO`, `retryable: true`,
 *   surfaced once by {@link executeWriteTransaction} (tx.ts) as
 *   {@link WriteIOError} and never auto-retried (§4c "Retry semantics" — the
 *   audit-atomicity hazard applies uniformly).
 * - A GENUINELY UNRECOGNIZED failure — `isDatabaseError` false, meaning it
 *   never even reached the driver (a `TypeError`/`SyntaxError`/other
 *   deterministic bug in this module's own code, e.g. a `JSON.parse` thrown
 *   from inside a verb's transaction callback) — is NOT a database fault at
 *   all and must never be reported `retryable: true`: a caller honouring
 *   `retryable` would retry a failure that can never succeed. This still
 *   returns `code: 'E_IO'` (the closed `WriteErrorCode` union, SPEC.md §4c,
 *   has no fifth bucket for "not a driver error at all" and this failure did
 *   reach the transaction boundary same as the recognized case) but with
 *   `retryable: false` — the discriminator {@link executeWriteTransaction}
 *   uses to skip {@link WriteIOError} (which hardcodes `retryable: true`,
 *   ADR-0012 §4) for this branch and instead rethrow the original error
 *   UNTOUCHED, exactly like the unclassified-`E_CONSTRAINT` catch-all below
 *   it: a raw `TypeError`/`SyntaxError` is *more* diagnostic than a generic
 *   `WriteIOError`, not less.
 */
export function classifyDriverError(err: unknown): IWriteError {
  const message = err instanceof Error ? err.message : String(err);
  if (isBusyError(err) || isConcurrentConflict(err)) {
    return { code: 'E_CONTENTION', retryable: true, message, cause: err };
  }
  if (isUniqueConstraintError(err) || isForeignKeyError(err)) {
    return { code: 'E_CONSTRAINT', retryable: false, message, cause: err };
  }
  if (isDatabaseError(err)) {
    // Recognized-but-otherwise-unclassified database error — the SPEC.md
    // §4c table's actual `E_IO` case.
    return { code: 'E_IO', retryable: true, message, cause: err };
  }
  // Genuinely unrecognized, non-database-shaped failure (never reached the
  // driver at all) — deliberately NOT retryable. See doc comment above.
  return { code: 'E_IO', retryable: false, message, cause: err };
}

/**
 * BUG-BACKLOG-BY-BARE-ROLE-001: SPEC.md/SKILL.md have always documented that
 * `by` "must always be `${agentName}:${instanceId}`, never a bare role
 * literal like `"agent"`", and that this is rejected before any write runs —
 * but no code ever enforced the second half. Every mutating verb's own
 * `assertNonBlank('by', ...)` only checked for missing/whitespace-only, so
 * `by:"agent"` (the doc's own forbidden example) was accepted everywhere:
 * `claim`, `update`, `upsert-project`, `create`, all landed it verbatim into
 * `claimedBy`/`author`/audit rows, defeating the guard's stated purpose of
 * keeping every write attributable to a real identity under concurrent
 * multi-agent use.
 *
 * A small, closed list — not a shape regex — because the doc's own examples
 * are specific bare nouns, not "anything without a colon" (a human's plain
 * name like `"dana"` is a legitimate identity and must keep working).
 */
const BARE_ROLE_LITERALS = new Set([
  'agent',
  'user',
  'system',
  'human',
  'unknown',
  'anonymous',
  'admin',
  'bot',
  'claude',
  'assistant',
]);

/**
 * Rejects the specific bare-role literals SPEC.md calls out by name, on top
 * of whatever blank/missing check the call site already runs. Call this
 * immediately after `assertNonBlank('by', input.by)` at every mutating verb.
 */
export function assertNotBareRoleLiteral(field: string, value: string): void {
  if (BARE_ROLE_LITERALS.has(value.trim().toLowerCase())) {
    throw new InvalidArgumentError(
      field,
      `"${value}" is a bare role literal, not a real identity — use ` +
        '"${agentName}:${instanceId}" (e.g. "claude:1"), never a bare role word'
    );
  }
}
