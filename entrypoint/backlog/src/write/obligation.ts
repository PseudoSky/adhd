/**
 * obligation.ts — `obligate` / `unobligate` and the CLOSED predicate core
 * (C4, DESIGN §2 Primitive 3).
 *
 * An **Obligation** is a declared, typed requirement attached to an issue — a
 * separate `obligation` node keyed to the issue by a `has_obligation` edge,
 * NEVER a status stored on the item. The requirement's vocabulary is a
 * **closed core** in code:
 *
 *   evidence{kind,min?} | blockers_terminal() | relation{type,direction}
 *   | all_of | any_of | not
 *
 * `assertValidPredicate` validates the grammar recursively at WRITE time (an
 * unknown `op`, a missing/ill-typed leaf, an unexpected extra key, or
 * `evidence.min < 1` throws {@link InvalidPredicateError} before any
 * transaction opens — so an invalid predicate never holds the write lock).
 * `evaluatePredicate` is the ONE implementation of the grammar's semantics,
 * a pure recursive walk over an injected {@link IPredicateResolver}: the C5
 * write gate supplies a tx-backed resolver, the C6 verdict a graph-backed one,
 * and neither re-implements the grammar (adhd ADR-0002). C4 deliberately does
 * NOT ship a resolver and does NOT implement the closure gate (that is C5) —
 * only declaration, removal, validation, and the read projection.
 *
 * **`applies_to.to` is REQUIRED.** An earlier draft left it optional, a silent
 * dual with no error and no wrong answer surfaced (DESIGN §2 Primitive 3, after
 * the red-team fix). Omitting it is a validation error, not a silent default.
 * There is no separate "actionability-only" (`to`-absent) obligation class.
 *
 * **Node storage** — `kind:'obligation'`, `name: <requirement.op>`,
 * `content: canonicalJSONStringify(requirement)`, `metadata`:
 * `{ applies_to: { to, from? }, requirement, on_fail, override? }`.
 *
 * Both verbs run in ONE `executeWriteTransaction` (ADR-0001/ADR-0012 — the
 * store's own `BEGIN IMMEDIATE` is the atomicity primitive; no temp file, no
 * rename, no flock). `obligate` writes only the obligation node + its
 * `has_obligation` edge + an audit row — the subject issue is never mutated.
 * `unobligate` soft-invalidates (bi-temporal), never hard-deletes.
 */

import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import { resolveEdgeKindTx } from './catalog.js';
import { writeAudit } from './audit.js';
import {
  CatalogNotFoundError,
  InvalidArgumentError,
  InvalidPredicateError,
  ObligationNotFoundError,
  assertNotBareRoleLiteral,
} from './errors.js';
import {
  type IWriteStoreHandle,
  canonicalJSONStringify,
  executeWriteTransaction,
  invalidateEdgeTx,
  nowISO,
  resolveLiveIssueTx,
  resolveUidPrefixTx,
  writeEdgeTx,
  writeNodeTx,
} from './tx.js';

/** `block` refuses the transition; `warn` records the shortfall but allows it (the C5 gate reads this). */
export type IObligationSeverity = 'block' | 'warn';

/** Which side of an edge the subject sits on: `in` = subject is `dst`, `out` = subject is `src`. */
export type IRelationDirection = 'in' | 'out';

/**
 * The CLOSED predicate core (DESIGN §2 Primitive 3). No CEL, no dynamic leaf,
 * no timeout — the grammar is exactly these six productions. Validated
 * recursively by {@link assertValidPredicate}.
 *
 * - `evidence{kind,min?}` → distinct verified attestations of `kind` ≥ `min ?? 1`.
 * - `blockers_terminal()` → every incoming live `blocks` source is terminal.
 * - `relation{type,direction}` → a live edge of `type` touches the subject.
 * - `all_of` / `any_of` / `not` → boolean composition. Empty `all_of` ⇒ `true`,
 *   empty `any_of` ⇒ `false` (documented, asserted).
 */
export type IPredicate =
  | { op: 'evidence'; kind: string; min?: number }
  | { op: 'blockers_terminal' }
  | { op: 'relation'; type: string; direction: IRelationDirection }
  | { op: 'all_of'; of: IPredicate[] }
  | { op: 'any_of'; of: IPredicate[] }
  | { op: 'not'; of: IPredicate };

export interface IObligationAppliesTo {
  /** Absent ⇒ applies to any from-status. */
  from?: string;
  /**
   * REQUIRED. Scopes a TRANSITION into that status: a concrete status name, or
   * `'*'` for "any terminal transition". Evaluated by the C5 gate at the
   * transition, and surfaced by the C6 verdict as a *prediction* of that gate.
   */
  to: string;
}

export interface IObligationOverride {
  /** Non-empty actor identities permitted to override this obligation — an override always requires a recorded reason at the C5 layer. */
  actors: string[];
}

export interface IObligateInput {
  uid: string;
  applies_to: IObligationAppliesTo;
  requirement: IPredicate;
  on_fail: IObligationSeverity;
  override?: IObligationOverride;
  by: string;
}

export interface IObligateOutcome {
  uid: string;
  obligationUid: string;
}

export interface IUnobligateInput {
  obligationUid: string;
  by: string;
}

export interface IUnobligateOutcome {
  obligationUid: string;
  invalidated: true;
}

/**
 * The three leaf questions the grammar can ask. Implemented by each caller's
 * own resolver — C5's tx-backed `evaluateTransitionGateTx` and C6's verdict
 * resolver — because the leaf lookups are the ONLY part that touches storage;
 * the composition is {@link evaluatePredicate}'s job alone.
 */
export interface IPredicateResolver {
  /** Distinct attestations of `claim.kind === kind` whose `check.state === 'verified'`. */
  countVerifiedAttestations(kind: string): Promise<number>;
  /** `true` iff every incoming live `blocks` edge's source issue is terminal; a missing status is non-terminal (fail-closed). */
  blockersAllTerminal(): Promise<boolean>;
  /** `true` iff a live edge of `type` exists with the subject as `dst` (`in`) or `src` (`out`). */
  relationExists(type: string, direction: IRelationDirection): Promise<boolean>;
}

const PREDICATE_OPS = [
  'evidence',
  'blockers_terminal',
  'relation',
  'all_of',
  'any_of',
  'not',
] as const;

/** Reject any key outside the production's closed field set — the grammar is closed, so a typo'd field is a validation error, never a silently-ignored extra. */
function assertNoExtraKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  op: string
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new InvalidPredicateError(
        `${op} predicate has unexpected key "${key}" (allowed: ${allowed.join(', ')})`
      );
    }
  }
}

function assertNonBlankLeaf(
  value: unknown,
  field: string
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidPredicateError(`${field} must be a non-empty string`);
  }
}

/**
 * Recursive validator over the closed core — throws {@link InvalidPredicateError}
 * on an unknown `op`, a missing/ill-typed leaf, an unexpected extra key, a
 * non-array `all_of`/`any_of` `of`, or `evidence.min < 1`. Runs BEFORE any
 * transaction opens.
 */
export function assertValidPredicate(pred: unknown): asserts pred is IPredicate {
  if (pred === null || typeof pred !== 'object' || Array.isArray(pred)) {
    throw new InvalidPredicateError(
      'a predicate must be an object with an "op" discriminator'
    );
  }
  const record = pred as Record<string, unknown>;
  const op = record['op'];
  if (typeof op !== 'string') {
    throw new InvalidPredicateError('a predicate is missing its "op" discriminator');
  }
  if (!(PREDICATE_OPS as readonly string[]).includes(op)) {
    throw new InvalidPredicateError(
      `unknown op "${op}" — the core is closed to ${PREDICATE_OPS.map((o) => `"${o}"`).join(', ')}`
    );
  }

  switch (op) {
    case 'evidence': {
      assertNoExtraKeys(record, ['op', 'kind', 'min'], op);
      assertNonBlankLeaf(record['kind'], 'evidence.kind');
      const min = record['min'];
      if (min !== undefined) {
        if (typeof min !== 'number' || !Number.isInteger(min) || min < 1) {
          throw new InvalidPredicateError(
            'evidence.min must be an integer >= 1 when present'
          );
        }
      }
      return;
    }
    case 'blockers_terminal': {
      assertNoExtraKeys(record, ['op'], op);
      return;
    }
    case 'relation': {
      assertNoExtraKeys(record, ['op', 'type', 'direction'], op);
      assertNonBlankLeaf(record['type'], 'relation.type');
      const direction = record['direction'];
      if (direction !== 'in' && direction !== 'out') {
        throw new InvalidPredicateError(
          'relation.direction must be "in" or "out"'
        );
      }
      return;
    }
    case 'all_of':
    case 'any_of': {
      assertNoExtraKeys(record, ['op', 'of'], op);
      const of = record['of'];
      if (!Array.isArray(of)) {
        throw new InvalidPredicateError(`${op}.of must be an array of predicates`);
      }
      for (const child of of) assertValidPredicate(child);
      return;
    }
    case 'not': {
      assertNoExtraKeys(record, ['op', 'of'], op);
      // `not.of` is a SINGLE predicate (unlike all_of/any_of's array). An array
      // here is rejected by the object check at the top of the recursion.
      assertValidPredicate(record['of']);
      return;
    }
  }
}

/**
 * Pure evaluator — the ONE implementation of the grammar's semantics, shared
 * by the C5 write gate (tx-backed resolver) and the C6 verdict (graph-backed
 * resolver). NOT re-implemented per caller (adhd ADR-0002).
 *
 * **Documented short-circuits:** an empty `all_of` is `true`, an empty `any_of`
 * is `false`, and `not` of an empty `any_of` is therefore `true`.
 *
 * **Fail-closed:** a resolver rejection propagates — it is never coerced to
 * `true`. A gate that cannot determine a leaf must refuse, not pass.
 */
export async function evaluatePredicate(
  pred: IPredicate,
  resolver: IPredicateResolver
): Promise<boolean> {
  switch (pred.op) {
    case 'evidence': {
      const count = await resolver.countVerifiedAttestations(pred.kind);
      return count >= (pred.min ?? 1);
    }
    case 'blockers_terminal':
      return resolver.blockersAllTerminal();
    case 'relation':
      return resolver.relationExists(pred.type, pred.direction);
    case 'all_of': {
      if (pred.of.length === 0) return true;
      for (const child of pred.of) {
        if (!(await evaluatePredicate(child, resolver))) return false;
      }
      return true;
    }
    case 'any_of': {
      if (pred.of.length === 0) return false;
      for (const child of pred.of) {
        if (await evaluatePredicate(child, resolver)) return true;
      }
      return false;
    }
    case 'not':
      return !(await evaluatePredicate(pred.of, resolver));
  }
}

function assertNonBlank(
  field: string,
  value: string | undefined
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidArgumentError(field, 'is required');
  }
}

/**
 * Validate `input.applies_to`, returning its normalised `{ to, from? }`.
 * `to` is REQUIRED (a non-blank string; `'*'` is the explicit "any terminal
 * transition" wildcard) — omitting it is {@link InvalidArgumentError}, never a
 * silent default. A present-but-blank `from` is refused too.
 */
function normaliseAppliesTo(raw: unknown): { to: string; from?: string } {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidArgumentError('applies_to', 'is required');
  }
  const record = raw as Record<string, unknown>;
  const to = record['to'];
  if (typeof to !== 'string' || to.trim().length === 0) {
    throw new InvalidArgumentError(
      'applies_to.to',
      'is required — a concrete status name or "*" for any terminal transition; omitting it is a validation error, not a silent default'
    );
  }
  const from = record['from'];
  if (from !== undefined && (typeof from !== 'string' || from.trim().length === 0)) {
    throw new InvalidArgumentError(
      'applies_to.from',
      'must be a non-empty string when present'
    );
  }
  return from === undefined ? { to } : { to, from: from as string };
}

function normaliseOverride(raw: unknown): IObligationOverride | undefined {
  if (raw === undefined) return undefined;
  const actors = (raw as Record<string, unknown> | null)?.['actors'];
  if (
    !Array.isArray(actors) ||
    actors.length === 0 ||
    !actors.every((a) => typeof a === 'string' && a.trim().length > 0)
  ) {
    throw new InvalidArgumentError(
      'override.actors',
      'must be a non-empty array of non-blank identities when an override is present'
    );
  }
  return { actors: [...(actors as string[])] };
}

/** Resolve an obligation uid (exact or unique prefix) to its live node, mapping the write layer's not-found shape to {@link ObligationNotFoundError}. */
async function resolveObligationNode(
  exec: AdapterTransaction,
  uid: string
): Promise<{ rowid: number; uid: string; metadata: Record<string, unknown> | undefined }> {
  try {
    const row = await resolveUidPrefixTx(exec, uid, { expectedKind: 'obligation' });
    return { rowid: row.rowid, uid: row.uid, metadata: row.metadata };
  } catch (err) {
    if (err instanceof CatalogNotFoundError) throw new ObligationNotFoundError(uid);
    throw err;
  }
}

/**
 * Declare an obligation on a live issue. One `immediate` transaction: resolve
 * the issue (`resolveLiveIssueTx`), write the `obligation` node, resolve
 * `has_obligation`, write the edge, and audit `'obligated'`. The subject issue
 * is NEVER mutated — no column, no `meta` touch, no stored status.
 *
 * Validation (`assertValidPredicate`, `applies_to.to` required, `on_fail` ∈
 * `{block,warn}`, override shape) runs BEFORE `executeWriteTransaction`, so a
 * malformed predicate never holds the write lock.
 *
 * Errors: `InvalidArgumentError` (blank `uid`/`by`, omitted/blank
 * `applies_to.to`, bad `on_fail`, malformed override),
 * `InvalidPredicateError` (the closed-core grammar), `IssueNotFoundError`,
 * `StaleSupersedeError`, `WriteContentionError`/`WriteIOError` (§4c).
 */
export async function obligate(
  handle: IWriteStoreHandle,
  input: IObligateInput
): Promise<IObligateOutcome> {
  assertNonBlank('uid', input.uid);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);

  const appliesTo = normaliseAppliesTo(input.applies_to);

  if (input.on_fail !== 'block' && input.on_fail !== 'warn') {
    throw new InvalidArgumentError('on_fail', 'must be "block" or "warn"');
  }
  const override = normaliseOverride(input.override);
  // Grammar validation BEFORE any transaction opens (a validation failure must
  // never hold the write lock).
  assertValidPredicate(input.requirement);

  const now = nowISO();
  const requirement = input.requirement as unknown as Record<string, unknown>;

  return executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const issue = await resolveLiveIssueTx(tx, input.uid);

    const metadata: Record<string, unknown> = {
      applies_to: appliesTo,
      requirement,
      on_fail: input.on_fail,
      ...(override !== undefined ? { override } : {}),
    };

    const obligation = await writeNodeTx(tx, {
      at: now,
      kind: 'obligation',
      name: input.requirement.op,
      content: canonicalJSONStringify(requirement),
      metadata,
    });

    const rule = await resolveEdgeKindTx(tx, 'has_obligation');
    await writeEdgeTx(tx, {
      at: now,
      srcRowid: issue.rowid,
      srcUid: issue.uid,
      srcKind: 'issue',
      dstRowid: obligation.rowid,
      dstUid: obligation.uid,
      dstKind: 'obligation',
      rel: 'has_obligation',
      rule,
      typePolicy: handle.typePolicy,
    });

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: issue.rowid,
      subjectUid: issue.uid,
      subjectKind: 'issue',
      actor: input.by,
      action: 'obligated',
      to: obligation.uid,
      note: input.requirement.op,
      at: now,
    });

    return { uid: issue.uid, obligationUid: obligation.uid };
  });
}

/**
 * Retire an obligation. One `immediate` transaction: resolve `obligationUid` to
 * a live `obligation` node (else {@link ObligationNotFoundError}),
 * soft-invalidate it (`UPDATE node SET t_invalid = ?, meta = <merged
 * invalidatedAt/invalidatedReason> WHERE rowid = ?` — the `delete.ts` /
 * `rmLocation` bi-temporal shape), invalidate the owning `has_obligation` edge,
 * and audit `'unobligated'`. Never a hard delete — the row and its trail stay
 * readable; it simply stops appearing on the card.
 *
 * Errors: `InvalidArgumentError` (blank `obligationUid`/`by`),
 * `ObligationNotFoundError`, `WriteContentionError`/`WriteIOError` (§4c).
 */
export async function unobligate(
  handle: IWriteStoreHandle,
  input: IUnobligateInput
): Promise<IUnobligateOutcome> {
  assertNonBlank('obligationUid', input.obligationUid);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);

  return executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const row = await resolveObligationNode(tx, input.obligationUid);
    const now = nowISO();

    // The owning `has_obligation` edge (issue → obligation). Found before the
    // node is invalidated so the edge can be invalidated in the SAME tx.
    const edge = await tx.executeGet<{ src: number }>(
      "SELECT src FROM edge WHERE dst = ? AND rel = 'has_obligation' AND t_invalid IS NULL",
      [row.rowid]
    );

    const mergedMeta = {
      ...(row.metadata ?? {}),
      invalidatedReason: 'unobligated',
      invalidatedAt: now,
    };
    const result = await tx.executeRun(
      'UPDATE node SET t_invalid = ?, meta = ? WHERE rowid = ?',
      [now, JSON.stringify(mergedMeta), row.rowid]
    );
    if (result.rowsAffected !== 1) {
      throw new Error(
        `unobligate: invalidate UPDATE affected ${result.rowsAffected} rows for uid="${input.obligationUid}", expected exactly 1.`
      );
    }

    if (edge) {
      await invalidateEdgeTx(tx, {
        srcRowid: edge.src,
        dstRowid: row.rowid,
        rel: 'has_obligation',
        reason: 'unobligated',
        at: now,
      });
    }

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: row.rowid,
      subjectUid: row.uid,
      subjectKind: 'obligation',
      actor: input.by,
      action: 'unobligated',
      at: now,
    });

    return { obligationUid: row.uid, invalidated: true as const };
  });
}
