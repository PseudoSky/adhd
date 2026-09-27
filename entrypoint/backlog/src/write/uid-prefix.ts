/**
 * uid-prefix.ts — the ONE place a uid REFERENCE is resolved by exact match or
 * by a UNIQUE prefix, shared by the read path (`GraphBackend`) and the write
 * path (an `AdapterTransaction` / `StoreAdapter` executor).
 *
 * **The contract, in one paragraph.** A reference a consumer holds is either
 * an exact 36-character uid, a short PREFIX of one (the first 8 hex characters
 * are the natural unit a person copies out of a list), or not uid-shaped at
 * all. Exact wins and is the fast path. A prefix resolves only when it matches
 * EXACTLY ONE live node; matching two or more is REFUSED with
 * {@link AmbiguousReferenceError}, naming every candidate — silently returning
 * the wrong item is strictly worse than refusing. A prefix shorter than
 * {@link MIN_UID_PREFIX_LENGTH} is refused as too short rather than allowed to
 * match broadly.
 *
 * **Why the floor is 8 hex characters.** Eight hex characters are the first
 * UUID block — what a caller actually copies from a card/list — and 32 bits of
 * address space, so in even a very large store the chance any two uids share
 * an 8-character prefix is well under a percent; when it does happen the
 * resolver refuses loudly rather than guessing, so the floor is safe by
 * construction, not by probability. It matches the abbreviation length
 * version-control tools settled on for the same reason.
 *
 * **Why the shape walk, not a plain regex.** A prefix of the canonical
 * `8-4-4-4-12` string form may carry a hyphen at a canonical boundary once the
 * caller copies past the first block (`8c62416b-94`). The walk accepts exactly
 * those hyphens and rejects any at a non-boundary position, so a stray
 * punctuation string is never mistaken for a uid prefix.
 *
 * **All SQL is parameterized.** The only dynamic part of the candidate read is
 * the prefix bound as a `?` parameter; nothing is interpolated into the
 * statement text.
 */

import {
  AmbiguousReferenceError,
  CatalogNotFoundError,
  InvalidArgumentError,
  IssueNotFoundError,
} from './errors.js';

/** The canonical string form a minted uid always takes (`write/tx.ts`'s `writeNodeTx` uses `crypto.randomUUID()`). */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Whether `ref` is an exact, full uid (resolve-or-throw), never a business `name` and never a prefix. */
export function isUidShaped(ref: string): boolean {
  return UUID_V4_RE.test(ref);
}

/**
 * The shortest uid prefix this resolver will accept. Eight hex characters —
 * the first UUID block, the human-copyable unit, and 32 bits of address space;
 * see this file's header for the full justification.
 */
export const MIN_UID_PREFIX_LENGTH = 8;

const HEX_OR_HYPHEN_RE = /^[0-9a-f-]+$/i;

/** The positions a hyphen occupies in the canonical `8-4-4-4-12` string form. */
const CANONICAL_HYPHEN_POSITIONS: ReadonlySet<number> = new Set([8, 13, 18, 23]);

/**
 * Whether `ref` is a proper prefix (length `>=` {@link MIN_UID_PREFIX_LENGTH},
 * `< 36`) of some canonical uid string — hex characters with hyphens only at
 * the canonical boundary positions.
 */
export function isUidPrefixShaped(ref: string): boolean {
  if (ref.length < MIN_UID_PREFIX_LENGTH || ref.length >= 36) return false;
  if (!HEX_OR_HYPHEN_RE.test(ref)) return false;
  for (let i = 0; i < ref.length; i += 1) {
    const ch = ref[i];
    if (CANONICAL_HYPHEN_POSITIONS.has(i)) {
      if (ch !== '-') return false;
    } else if (ch === '-') {
      return false;
    }
  }
  return true;
}

/** How a caller-supplied reference reads: an exact uid, a uid prefix, a too-short uid attempt, or not uid-shaped at all. */
export type UidRefKind = 'exact' | 'prefix' | 'too-short' | 'not-uid';

/**
 * Classify `ref` for uid resolution. `too-short` is a uid ATTEMPT (hex/hyphen
 * only) below {@link MIN_UID_PREFIX_LENGTH} — a strict uid context rejects it
 * as too short, while a uid-or-name context falls back to a name lookup, so a
 * genuine 6-character value that is itself a valid name is never swallowed.
 */
export function classifyUidRef(ref: string): UidRefKind {
  if (isUidShaped(ref)) return 'exact';
  if (isUidPrefixShaped(ref)) return 'prefix';
  if (
    ref.length > 0 &&
    ref.length < MIN_UID_PREFIX_LENGTH &&
    HEX_OR_HYPHEN_RE.test(ref)
  ) {
    return 'too-short';
  }
  return 'not-uid';
}

/** One live node matching a uid PREFIX, projected to the fields the ambiguity decision and its error need. */
export interface IUidCandidate {
  uid: string;
  kind: string;
  name: string | null;
  isSuperseded: boolean;
}

/**
 * The minimal executor a prefix candidate read needs. Structural, so it is
 * satisfied by `AdapterTransaction`, graph-store's `GraphTransaction`, and a
 * bare `StoreAdapter` alike — nothing here depends on which one it is.
 */
export interface IUidPrefixQueryExecutor {
  executeAll<T = Record<string, unknown>>(
    sql: string,
    args?: unknown[]
  ): Promise<{ rows: T[] }>;
}

/**
 * The executor a uid resolution needs: the prefix candidate read plus the
 * exact single-row read. Structural, so `AdapterTransaction`,
 * graph-store's `GraphTransaction`, and a bare `StoreAdapter` all satisfy it.
 */
export interface INodeReadExecutor extends IUidPrefixQueryExecutor {
  executeGet<T = Record<string, unknown>>(
    sql: string,
    args?: unknown[]
  ): Promise<T | null>;
}

/** The raw candidate row the prefix SELECT returns. */
interface IRawUidCandidateRow {
  uid: string;
  kind: string;
  name: string | null;
  is_superseded: number | null;
}

/**
 * Every LIVE node whose uid starts with `prefix`.
 *
 * The range predicate `uid >= ? AND uid < ?` is an indexed prefix scan (the
 * store keeps a unique index on `uid`) and, unlike a `LIKE` pattern, is
 * case-exact against the lowercase uids the store mints — so the input is
 * lower-cased once here and the caller never has to reason about collation.
 * Soft-deleted rows are excluded in SQL (`t_invalid IS NULL`); a superseded
 * row is returned (its `is_superseded` flag carried) so a caller that resolves
 * to it can raise the same stale-reference error the exact path does.
 */
export async function queryLiveUidPrefixCandidates(
  exec: IUidPrefixQueryExecutor,
  prefix: string
): Promise<IUidCandidate[]> {
  const lower = prefix.toLowerCase();
  const { rows } = await exec.executeAll<IRawUidCandidateRow>(
    'SELECT uid, kind, name, is_superseded FROM node WHERE uid >= ? AND uid < ? AND t_invalid IS NULL',
    [lower, `${lower}\uffff`]
  );
  return rows.map((row) => ({
    uid: row.uid,
    kind: row.kind,
    name: row.name,
    isSuperseded: row.is_superseded === 1,
  }));
}

/**
 * The ambiguity decision, shared by both paths. Returns the sole candidate, or
 * `null` when there are none (the caller owns the not-found error, which
 * differs by kind). Two or more candidates throw {@link AmbiguousReferenceError}
 * — the resolver never auto-selects.
 */
export function selectUniqueUidCandidate(
  ref: string,
  candidates: readonly IUidCandidate[]
): IUidCandidate | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  throw new AmbiguousReferenceError(
    ref,
    candidates.map((c) => ({ uid: c.uid, kind: c.kind, name: c.name ?? '' }))
  );
}

/**
 * The not-found error for a uid reference, keyed by the kind the caller asked
 * for. `asPrefix` selects the prefix-specific wording ("no item matches")
 * versus the exact-uid wording, so a caller can tell "this short reference
 * matched nothing" from "this full uid is not here."
 */
export function missingUidError(
  expectedKind: string | undefined,
  ref: string,
  asPrefix: boolean
): Error {
  if (expectedKind === 'issue') return new IssueNotFoundError(ref, asPrefix);
  return new CatalogNotFoundError(expectedKind ?? 'uid', ref);
}

/** The too-short refusal — a uid attempt below {@link MIN_UID_PREFIX_LENGTH}. */
export function tooShortUidError(ref: string): InvalidArgumentError {
  return new InvalidArgumentError(
    'uid',
    `uid prefix "${ref}" is too short — a uid prefix must be at least ${MIN_UID_PREFIX_LENGTH} characters (or pass the full uid)`
  );
}
