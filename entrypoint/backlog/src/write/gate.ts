/**
 * gate.ts — the C5 closure gate (DESIGN §2 Primitive 3, §5 AC4, §7 cond. 3).
 *
 * A terminal transition is **fail-closed**: before any write commits,
 * `evaluateTransitionGateTx` evaluates the item's transition-scoped
 * obligations against C4's predicate core and reports a typed reason set. It
 * is a **read-modify-write and runs INSIDE the caller's open `BEGIN IMMEDIATE`
 * transaction** (`transition.ts`'s `executeWriteTransaction` callback) — so
 * two concurrent terminal transitions serialize through the RESERVED lock
 * (adhd ADR-0001 + ADR-0012) and the gate's read is atomic with the write it
 * guards. **No temp-file+rename, no flock, no file-atomic pattern** is
 * introduced; the store's transaction IS the concurrency mechanism.
 *
 * **It never writes and never decides a throw for an unsatisfied predicate.**
 * The caller (`transition`) throws {@link ObligationUnsatisfiedError} on
 * `!satisfied` and writes the `satisfies` edges on success. The gate throws
 * only for one decided, terminal `BacklogWriteError`: a claimed override the
 * caller is not permitted to make ({@link OverrideNotPermittedError}), which is
 * a caller-input failure rather than an unsatisfied obligation.
 *
 * **`satisfies` edges** — on success, for each `{obligationUid, attestationUid}`
 * in `satisfiedBy`, `transition` writes `satisfies` edges (obligation →
 * attestation) and stamps `transition.meta.satisfied_by`.
 *
 * **Resolvers.** This module implements C4's `IPredicateResolver` against the
 * SAME `tx` the write uses (`tx.executeGet`/`executeAll`, hand-composed SQL —
 * never the bare adapter, whose reads would see committed-only state outside
 * this transaction; see `tx.ts`'s header). The grammar's semantics stay in
 * C4's {@link evaluatePredicate}; this file supplies only the leaf lookups and
 * the reason derivation.
 */
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import {
  evaluatePredicate,
  type IPredicate,
  type IPredicateResolver,
  type IRelationDirection,
} from './obligation.js';
import { OverrideNotPermittedError } from './errors.js';
import { DEFAULT_BRANCH_ANCESTOR_CHECK, isShaOnDefaultBranch } from './anchor-check.js';
import { computeActionable, orderConditions } from '../query/verdict-core.js';
import type { ICondition, IConditionType, IVerdict } from '../query/types.js';
import { extractClaimMeta, isClaimStale } from './claim-lease.js';
import { readRevision } from './revision.js';
import type { ITxNodeRow } from './tx.js';

/** The closed refusal-reason vocabulary (DESIGN §2 Primitive 4's governed core, scoped to the write gate). */
export type IGateReasonCode =
  | 'EvidenceUnverified'
  | 'EvidenceStale'
  | 'BlockedBy'
  | 'MissingObligation'
  | 'ClaimStale'
  | 'ReferenceUnresolved'
  | 'Unknown';

/**
 * The object-shaped refusal payload (adhd ADR-0004 — carried in
 * `error.details.refusal`, never as a `{result}` envelope).
 */
export interface IGateRefusal {
  code: IGateReasonCode;
  message: string;
  /** The obligation that refused, when the refusal is obligation-scoped. */
  obligationUid?: string;
  /** The thing to fix — blocker uid / attestation uid. */
  subject?: string;
  /** For EvidenceUnverified: the `claim.kind` the obligation required. */
  required_kind?: string;
  /** The mechanical check that produced the refusal (e.g. 'default_branch_ancestor'). */
  performed_check?: string;
}

export interface IGateEvaluation {
  satisfied: boolean;
  refusals: IGateRefusal[];
  /** Pairs recorded as `satisfies` edges on success. */
  satisfiedBy: Array<{ obligationUid: string; attestationUid: string }>;
  /** Obligations whose on_fail is 'warn' and predicate false — recorded, never refusing. */
  warnings: IGateRefusal[];
}

/** The gated transition's inputs, threaded from `transition.ts`'s open `tx`. */
export interface IGateInput {
  issueRowid: number;
  fromStatus: string;
  toStatus: string;
  effectiveActor: string;
  at: string;
  /** A caller-supplied override attempt; honoured only for a listed actor + a non-blank reason. */
  override?: { reason: string };
}

/** One live `obligation` node, normalised off its stored `meta`. */
interface IObligationRow {
  rowid: number;
  uid: string;
  appliesTo: { to: string; from?: string };
  requirement: IPredicate;
  onFail: 'block' | 'warn';
  override?: { actors: string[] };
}

/** One live `attestation` node attached to the subject, projected to the fields the gate reads. */
interface IAttestationFact {
  uid: string;
  claimKind: string;
  anchorLocator?: string;
  checkState?: string;
}

function parseMeta(raw: string | null): Record<string, unknown> | undefined {
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
 * The tx-backed {@link IPredicateResolver} — the leaf lookups of the closed
 * core, issued against the caller's own open `tx` (never the bare adapter).
 */
function makeTxResolver(tx: AdapterTransaction, issueRowid: number): IPredicateResolver {
  return {
    async countVerifiedAttestations(kind: string): Promise<number> {
      const row = await tx.executeGet<{ n: number }>(
        `SELECT COUNT(DISTINCT n.uid) AS n
           FROM edge e JOIN node n ON n.rowid = e.dst
          WHERE e.src = ? AND e.rel = 'attests' AND e.t_invalid IS NULL
            AND n.kind = 'attestation' AND n.t_invalid IS NULL
            AND json_extract(n.meta,'$.claim.kind') = ?
            AND json_extract(n.meta,'$.check.state') = 'verified'`,
        [issueRowid, kind]
      );
      return row?.n ?? 0;
    },
    async blockersAllTerminal(): Promise<boolean> {
      // Incoming live `blocks` edges: the SOURCE is the blocker, this issue the
      // dependent. A blocker with no live `has_status` target is NON-terminal
      // (fail-closed), distinct from "determined terminal".
      const incoming = await tx.executeAll<{ src: number }>(
        "SELECT src FROM edge WHERE dst = ? AND rel = 'blocks' AND t_invalid IS NULL",
        [issueRowid]
      );
      for (const { src } of incoming.rows) {
        const status = await tx.executeGet<{ meta: string | null }>(
          `SELECT s.meta AS meta FROM edge se JOIN node s ON s.rowid = se.dst
            WHERE se.src = ? AND se.rel = 'has_status' AND se.t_invalid IS NULL
            ORDER BY se.rowid LIMIT 1`,
          [src]
        );
        if (!status) return false; // missing status ⇒ non-terminal
        const meta = parseMeta(status.meta) ?? {};
        if (meta['terminal'] !== true) return false;
      }
      return true;
    },
    async relationExists(type: string, direction: IRelationDirection): Promise<boolean> {
      const sql =
        direction === 'in'
          ? "SELECT 1 AS x FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL LIMIT 1"
          : "SELECT 1 AS x FROM edge WHERE src = ? AND rel = ? AND t_invalid IS NULL LIMIT 1";
      const row = await tx.executeGet<{ x: number }>(sql, [issueRowid, type]);
      return row !== null && row !== undefined;
    },
  };
}

/** Read the issue's live obligations off `has_obligation`. Malformed rows are returned with `requirement:undefined` so the caller can refuse `MissingObligation`. */
async function readObligations(
  tx: AdapterTransaction,
  issueRowid: number
): Promise<Array<IObligationRow & { malformed?: boolean }>> {
  const rows = await tx.executeAll<{ rowid: number; uid: string; meta: string | null }>(
    `SELECT o.rowid AS rowid, o.uid AS uid, o.meta AS meta
       FROM edge e JOIN node o ON o.rowid = e.dst
      WHERE e.src = ? AND e.rel = 'has_obligation' AND e.t_invalid IS NULL
        AND o.kind = 'obligation' AND o.t_invalid IS NULL
      ORDER BY o.rowid`,
    [issueRowid]
  );
  const out: Array<IObligationRow & { malformed?: boolean }> = [];
  for (const row of rows.rows) {
    const meta = parseMeta(row.meta);
    const appliesToRaw = meta?.['applies_to'];
    const requirement = meta?.['requirement'] as IPredicate | undefined;
    const onFail = meta?.['on_fail'];
    const overrideRaw = meta?.['override'];
    const appliesTo =
      appliesToRaw !== null && typeof appliesToRaw === 'object'
        ? (appliesToRaw as Record<string, unknown>)
        : undefined;
    const to = appliesTo?.['to'];
    const from = appliesTo?.['from'];
    if (
      requirement === undefined ||
      typeof to !== 'string' ||
      to.trim().length === 0 ||
      (onFail !== 'block' && onFail !== 'warn')
    ) {
      out.push({
        rowid: row.rowid,
        uid: row.uid,
        appliesTo: { to: typeof to === 'string' ? to : '' },
        requirement: requirement as IPredicate,
        onFail: onFail === 'warn' ? 'warn' : 'block',
        malformed: true,
      });
      continue;
    }
    const override =
      overrideRaw !== null &&
      typeof overrideRaw === 'object' &&
      Array.isArray((overrideRaw as Record<string, unknown>)['actors'])
        ? {
            actors: ((overrideRaw as Record<string, unknown>)['actors'] as unknown[]).filter(
              (a): a is string => typeof a === 'string'
            ),
          }
        : undefined;
    out.push({
      rowid: row.rowid,
      uid: row.uid,
      appliesTo:
        typeof from === 'string' && from.trim().length > 0 ? { to, from } : { to },
      requirement: requirement as IPredicate,
      onFail,
      ...(override !== undefined ? { override } : {}),
    });
  }
  return out;
}

/** Every `evidence` leaf `kind` in a predicate (deduped, order-stable). */
function collectEvidenceKinds(pred: IPredicate, out: string[] = []): string[] {
  switch (pred.op) {
    case 'evidence':
      if (!out.includes(pred.kind)) out.push(pred.kind);
      return out;
    case 'all_of':
    case 'any_of':
      for (const child of pred.of) collectEvidenceKinds(child, out);
      return out;
    case 'not':
      collectEvidenceKinds(pred.of, out);
      return out;
    default:
      return out;
  }
}

/** One verified attestation uid of `kind` on the issue, or `undefined`. */
async function pickVerifiedAttestationUid(
  tx: AdapterTransaction,
  issueRowid: number,
  kind: string
): Promise<string | undefined> {
  const row = await tx.executeGet<{ uid: string }>(
    `SELECT n.uid AS uid
       FROM edge e JOIN node n ON n.rowid = e.dst
      WHERE e.src = ? AND e.rel = 'attests' AND e.t_invalid IS NULL
        AND n.kind = 'attestation' AND n.t_invalid IS NULL
        AND json_extract(n.meta,'$.claim.kind') = ?
        AND json_extract(n.meta,'$.check.state') = 'verified'
      ORDER BY n.rowid LIMIT 1`,
    [issueRowid, kind]
  );
  return row?.uid;
}

/** All live attestations attached to the issue, projected to the fields reason-derivation reads. */
async function readAttestationFacts(
  tx: AdapterTransaction,
  issueRowid: number
): Promise<IAttestationFact[]> {
  const rows = await tx.executeAll<{ uid: string; meta: string | null }>(
    `SELECT n.uid AS uid, n.meta AS meta
       FROM edge e JOIN node n ON n.rowid = e.dst
      WHERE e.src = ? AND e.rel = 'attests' AND e.t_invalid IS NULL
        AND n.kind = 'attestation' AND n.t_invalid IS NULL
      ORDER BY n.rowid`,
    [issueRowid]
  );
  return rows.rows.map((row) => {
    const meta = parseMeta(row.meta);
    const claim = meta?.['claim'];
    const anchor = meta?.['anchor'];
    const check = meta?.['check'];
    const claimKind =
      claim !== null && typeof claim === 'object'
        ? ((claim as Record<string, unknown>)['kind'] as string | undefined)
        : undefined;
    const anchorLocator =
      anchor !== null && typeof anchor === 'object'
        ? ((anchor as Record<string, unknown>)['locator'] as string | undefined)
        : undefined;
    const checkState =
      check !== null && typeof check === 'object'
        ? ((check as Record<string, unknown>)['state'] as string | undefined)
        : undefined;
    return {
      uid: row.uid,
      claimKind: typeof claimKind === 'string' ? claimKind : 'attestation',
      ...(typeof anchorLocator === 'string' ? { anchorLocator } : {}),
      ...(typeof checkState === 'string' ? { checkState } : {}),
    };
  });
}

/**
 * Two-hop `owns_component`/`owns_project` walk to the subject issue's project
 * root — the SAME graph-invariant pattern `attestation.ts`/`transition.ts`
 * carry locally (this package's established per-file convention for these
 * small tx-scoped helpers). Returns the project's `metadata.path`, or
 * `undefined` for a path-less project.
 */
async function resolveIssueProjectPathTx(
  tx: AdapterTransaction,
  issueRowid: number
): Promise<string | undefined> {
  const componentEdge = await tx.executeGet<{ src: number }>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [issueRowid, 'owns_component']
  );
  if (!componentEdge) return undefined;
  const projectEdge = await tx.executeGet<{ src: number }>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [componentEdge.src, 'owns_project']
  );
  if (!projectEdge) return undefined;
  const project = await tx.executeGet<{ kind: string; t_invalid: string | null; meta: string | null }>(
    'SELECT kind, t_invalid, meta FROM node WHERE rowid = ?',
    [projectEdge.src]
  );
  if (project?.kind !== 'project' || project.t_invalid !== null) return undefined;
  const path = parseMeta(project.meta)?.['path'];
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

/**
 * The first failing leaf of an UNSATISFIED predicate — a diagnostic walk run
 * ONLY after C4's {@link evaluatePredicate} has decided the predicate false.
 * It locates WHICH leaf to name; the boolean decision stays C4's alone.
 */
async function firstFailingLeaf(
  pred: IPredicate,
  resolver: IPredicateResolver
): Promise<IPredicate | undefined> {
  switch (pred.op) {
    case 'evidence':
    case 'blockers_terminal':
    case 'relation':
      return pred;
    case 'all_of': {
      for (const child of pred.of) {
        if (!(await evaluatePredicate(child, resolver))) {
          return firstFailingLeaf(child, resolver);
        }
      }
      return pred;
    }
    case 'any_of': {
      // Unsatisfied any_of ⇒ every child failed; descend into the first.
      for (const child of pred.of) {
        if (!(await evaluatePredicate(child, resolver))) {
          return firstFailingLeaf(child, resolver);
        }
      }
      return pred;
    }
    case 'not':
      // Unsatisfied `not` ⇒ its child HOLDS; there is no failing leaf to name.
      return pred;
    default:
      return pred;
  }
}

/** Derive a typed refusal from the failing leaf + the issue's attestations. Never throws. */
async function deriveRefusal(
  tx: AdapterTransaction,
  issueRowid: number,
  obligationUid: string,
  requirement: IPredicate,
  resolver: IPredicateResolver
): Promise<IGateRefusal> {
  let leaf: IPredicate | undefined;
  try {
    leaf = await firstFailingLeaf(requirement, resolver);
  } catch {
    return {
      code: 'Unknown',
      message: 'the obligation predicate could not be evaluated',
      obligationUid,
    };
  }

  if (leaf?.op === 'evidence') {
    const kind = leaf.kind;
    const facts = await readAttestationFacts(tx, issueRowid);
    const ofKind = facts.filter((f) => f.claimKind === kind);
    const commitLocator = facts.find((f) => f.anchorLocator?.startsWith('commit:'))
      ?.anchorLocator;
    const commitAttestationUid = facts.find((f) =>
      f.anchorLocator?.startsWith('commit:')
    )?.uid;
    const base: IGateRefusal = {
      code: 'EvidenceUnverified',
      obligationUid,
      required_kind: kind,
      message: `no verified attestation of kind "${kind}" satisfies this obligation`,
    };
    if (commitLocator !== undefined) {
      base.performed_check = DEFAULT_BRANCH_ANCESTOR_CHECK;
      const repoRoot = await resolveIssueProjectPathTx(tx, issueRowid);
      const sha = commitLocator.slice('commit:'.length);
      if (commitAttestationUid !== undefined) base.subject = commitAttestationUid;
      const state = facts.find((f) => f.uid === commitAttestationUid)?.checkState;
      if (state === 'stale') base.code = 'EvidenceStale';
      if (repoRoot !== undefined && sha.length > 0) {
        const check = await isShaOnDefaultBranch(repoRoot, sha);
        if (!check.onDefaultBranch) {
          base.message =
            `commit "${sha}" is asserted as evidence of kind "${kind}" but is not an ancestor of the ` +
            `default branch (${DEFAULT_BRANCH_ANCESTOR_CHECK}); a bare commit ref never satisfies a ` +
            `published-artifact obligation`;
        }
      }
    } else if (ofKind.length > 0) {
      const first = ofKind[0];
      if (first !== undefined) base.subject = first.uid;
      if (ofKind.some((f) => f.checkState === 'stale')) {
        base.code = 'EvidenceStale';
        base.message = `the attestation of kind "${kind}" is stale`;
      }
    }
    return base;
  }

  if (leaf?.op === 'blockers_terminal') {
    return {
      code: 'BlockedBy',
      obligationUid,
      message: 'a blocker is not terminal',
    };
  }

  if (leaf?.op === 'relation') {
    return {
      code: 'ReferenceUnresolved',
      obligationUid,
      message: `the required relation "${leaf.type}" (${leaf.direction}) is absent`,
    };
  }

  return {
    code: 'Unknown',
    obligationUid,
    message: 'the obligation is unsatisfied for a reason this gate does not name',
  };
}

/** `applies_to` scope: `to` matches `'*'` or the resolved target status; `from` absent or the current status. */
function scopeMatches(
  appliesTo: { to: string; from?: string },
  fromStatus: string,
  toStatus: string
): boolean {
  const toOk = appliesTo.to === '*' || appliesTo.to === toStatus;
  const fromOk = appliesTo.from === undefined || appliesTo.from === fromStatus;
  return toOk && fromOk;
}

/**
 * Evaluate the transition-scoped obligations of `issueRowid` for `from → to`
 * INSIDE the caller's open `tx`. Never writes. `effectiveActor` enables the
 * listed-actor override.
 *
 * Returns a typed {@link IGateEvaluation}; the caller decides whether to throw
 * ({@link ObligationUnsatisfiedError}) and writes the `satisfies` edges on
 * success. Throws {@link OverrideNotPermittedError} when an override is
 * claimed by an actor not listed on the refusing obligation, or carries a
 * blank reason.
 */
export async function evaluateTransitionGateTx(
  tx: AdapterTransaction,
  input: IGateInput
): Promise<IGateEvaluation> {
  const resolver = makeTxResolver(tx, input.issueRowid);

  const refusals: IGateRefusal[] = [];
  const warnings: IGateRefusal[] = [];
  const satisfiedBy: Array<{ obligationUid: string; attestationUid: string }> = [];

  const obligations = await readObligations(tx, input.issueRowid);

  for (const obligation of obligations) {
    if (obligation.malformed) {
      // A malformed obligation cannot be scoped, so it cannot be proven
      // out-of-scope: fail-closed by refusing regardless of applies_to.
      const refusal: IGateRefusal = {
        code: 'MissingObligation',
        obligationUid: obligation.uid,
        message: 'the obligation is malformed and cannot be evaluated',
      };
      if (obligation.onFail === 'warn') warnings.push(refusal);
      else refusals.push(refusal);
      continue;
    }

    if (!scopeMatches(obligation.appliesTo, input.fromStatus, input.toStatus)) continue;

    let satisfied: boolean;
    try {
      satisfied = await evaluatePredicate(obligation.requirement, resolver);
    } catch {
      // A resolver failure is fail-closed: the gate cannot determine a leaf, so
      // it must refuse, never pass.
      const refusal: IGateRefusal = {
        code: 'Unknown',
        obligationUid: obligation.uid,
        message: 'the obligation predicate could not be evaluated',
      };
      if (obligation.onFail === 'warn') warnings.push(refusal);
      else refusals.push(refusal);
      continue;
    }

    if (satisfied) {
      for (const kind of collectEvidenceKinds(obligation.requirement)) {
        const attestationUid = await pickVerifiedAttestationUid(tx, input.issueRowid, kind);
        if (attestationUid !== undefined) {
          satisfiedBy.push({ obligationUid: obligation.uid, attestationUid });
        }
      }
      continue;
    }

    // Unsatisfied.
    if (obligation.onFail === 'warn') {
      warnings.push(
        await deriveRefusal(tx, input.issueRowid, obligation.uid, obligation.requirement, resolver)
      );
      continue;
    }

    const isListedActor =
      obligation.override?.actors.includes(input.effectiveActor) ?? false;
    if (isListedActor) {
      // An override was actually claimed: a non-blank reason is ALWAYS
      // required (never a configurable boolean), else it is refused.
      if (input.override === undefined) {
        refusals.push(
          await deriveRefusal(tx, input.issueRowid, obligation.uid, obligation.requirement, resolver)
        );
        continue;
      }
      const reason = input.override.reason;
      if (typeof reason === 'string' && reason.trim().length > 0) {
        // Honoured: skipped, recorded by the caller as satisfied-by-override.
        continue;
      }
      throw new OverrideNotPermittedError(obligation.uid, input.effectiveActor);
    }
    if (input.override !== undefined) {
      // A claimed override by an actor not listed on this obligation.
      throw new OverrideNotPermittedError(obligation.uid, input.effectiveActor);
    }

    refusals.push(
      await deriveRefusal(tx, input.issueRowid, obligation.uid, obligation.requirement, resolver)
    );
  }

  return {
    satisfied: refusals.length === 0,
    refusals,
    satisfiedBy,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// C6 — the tx-scoped verdict (rungs 1–2 only), for `claim`'s entry precondition
// ---------------------------------------------------------------------------

/** One live incoming blocker with its resolved terminal flag (rung 1). */
async function readIncomingBlockersTx(
  tx: AdapterTransaction,
  issueRowid: number
): Promise<Array<{ uid: string; terminal: boolean }>> {
  const rows = await tx.executeAll<{
    uid: string;
    status_meta: string | null;
  }>(
    `SELECT n.uid AS uid, s.meta AS status_meta
       FROM edge e
       JOIN node n ON n.rowid = e.src
       LEFT JOIN edge se
         ON se.src = n.rowid AND se.rel = 'has_status' AND se.t_invalid IS NULL
       LEFT JOIN node s ON s.rowid = se.dst
      WHERE e.dst = ? AND e.rel = 'blocks' AND e.t_invalid IS NULL
        AND n.t_invalid IS NULL`,
    [issueRowid]
  );
  return rows.rows.map((r) => {
    const meta = parseMeta(r.status_meta) ?? {};
    // A missing status is NON-terminal (fail-closed), exactly as
    // `blockersAllTerminal` reads it.
    const terminal =
      r.status_meta !== null ? meta['terminal'] === true : false;
    return { uid: r.uid, terminal };
  });
}

/** Every live `status` row's name, split into all-names and terminal-names (rung-2 transition scoping). */
async function readStatusScopesTx(
  tx: AdapterTransaction
): Promise<{ all: Set<string>; terminal: Set<string> }> {
  const rows = await tx.executeAll<{ name: string | null; meta: string | null }>(
    "SELECT name, meta FROM node WHERE kind = 'status' AND t_invalid IS NULL"
  );
  const all = new Set<string>();
  const terminal = new Set<string>();
  for (const r of rows.rows) {
    if (typeof r.name !== 'string') continue;
    all.add(r.name);
    const meta = parseMeta(r.meta) ?? {};
    if (meta['terminal'] === true) terminal.add(r.name);
  }
  return { all, terminal };
}

function conditionTypeForCode(code: IGateReasonCode): IConditionType {
  switch (code) {
    case 'BlockedBy':
      return 'Blocked';
    case 'EvidenceUnverified':
    case 'EvidenceStale':
      return 'Evidence';
    case 'ReferenceUnresolved':
      return 'Reference';
    case 'ClaimStale':
      return 'Claim';
    default:
      return 'Obligation';
  }
}

/**
 * Derive the verdict INSIDE the caller's open tx, through rungs 1–2 only
 * (claim is a precondition, never a full anchor re-resolve). Never writes;
 * reuses C4's {@link evaluatePredicate} with the tx-scoped {@link
 * makeTxResolver} and C6's own `orderConditions`/`computeActionable`.
 */
export async function evaluateVerdictTx(
  tx: AdapterTransaction,
  issueRow: ITxNodeRow,
  input: { at: string; claimStaleAfterMin: number }
): Promise<IVerdict> {
  const conditions: ICondition[] = [];

  // Rung 1 — relation state.
  const blockers = await readIncomingBlockersTx(tx, issueRow.rowid);
  for (const b of blockers) {
    if (b.terminal) continue;
    conditions.push({
      type: 'Blocked',
      status: 'True',
      severity: 'block',
      code: 'BlockedBy',
      subject: b.uid,
      message: `blocked by ${b.uid}`,
    });
  }

  // Rung 2 — obligations (terminal-scoped) + claim staleness.
  const resolver = makeTxResolver(tx, issueRow.rowid);
  const scopes = await readStatusScopesTx(tx);
  const obligations = await readObligations(tx, issueRow.rowid);

  if (obligations.length === 0) {
    conditions.push({
      type: 'Obligation',
      status: 'True',
      severity: 'warn',
      code: 'MissingObligation',
      message: 'no obligations are declared on this item',
    });
  }

  for (const obligation of obligations) {
    const to = obligation.appliesTo.to;
    const terminalScoped =
      to === '*' || scopes.terminal.has(to) || !scopes.all.has(to);
    if (!terminalScoped) continue;

    if (obligation.malformed) {
      conditions.push({
        type: 'Obligation',
        status: 'True',
        severity: obligation.onFail,
        code: 'MissingObligation',
        subject: obligation.uid,
        message: 'the obligation is malformed and cannot be evaluated',
      });
      continue;
    }

    let satisfied: boolean;
    try {
      satisfied = await evaluatePredicate(obligation.requirement, resolver);
    } catch {
      conditions.push({
        type: 'Obligation',
        status: 'Unknown',
        severity: obligation.onFail,
        code: 'Unknown',
        subject: obligation.uid,
        message: 'the obligation predicate could not be evaluated',
      });
      continue;
    }
    if (satisfied) continue;

    const refusal = await deriveRefusal(
      tx,
      issueRow.rowid,
      obligation.uid,
      obligation.requirement,
      resolver
    );
    conditions.push({
      type: conditionTypeForCode(refusal.code),
      status: 'True',
      severity: obligation.onFail,
      code: refusal.code,
      subject: refusal.subject ?? obligation.uid,
      message: refusal.message,
    });
  }

  const { claimedBy, claimedAt } = extractClaimMeta(issueRow.metadata);
  if (
    claimedBy !== undefined &&
    isClaimStale(claimedAt, input.at, input.claimStaleAfterMin)
  ) {
    conditions.push({
      type: 'Claim',
      status: 'True',
      severity: 'warn',
      code: 'ClaimStale',
      subject: claimedBy,
      message: `claim by "${claimedBy}" is stale (threshold ${input.claimStaleAfterMin}min)`,
    });
  }

  const ordered = orderConditions(conditions);
  return {
    actionable: computeActionable(ordered),
    evaluated_at: input.at,
    revision: readRevision(issueRow.metadata),
    conditions: ordered,
  };
}
