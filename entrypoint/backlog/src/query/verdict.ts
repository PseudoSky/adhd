/**
 * verdict.ts — C6's graph-backed verdict adapter (DESIGN §2 Primitive 4).
 *
 * `deriveVerdict` is DERIVED ON READ and NEVER writes: a pure function of
 * store state + time. It runs the mandatory cheap-first ladder with an explicit
 * per-read budget (`maxRung`):
 *
 * | Rung | What runs | Produces |
 * |---|---|---|
 * | 1 | incoming live `blocks` (indexed in-degree) | `Blocked`/`BlockedBy` for each non-terminal blocker |
 * | 2 | obligation presence & shape + predicate evaluation + claim staleness | `Obligation`/`Evidence`/`Claim` conditions |
 * | 3 | anchor existence at HEAD | `EvidenceStale` when absent |
 * | 4 | changed-since-filing | `EvidenceStale` when moved since filing |
 * | 5 | full anchor re-resolve (digest match) | `EvidenceStale` on digest mismatch |
 *
 * Rungs 3–5 run ONLY when `maxRung ≥ n`. **The list path derives at rungs 1–2
 * only** (bounded derivation): where it cannot afford a rung a condition is
 * `Unknown`, which `computeActionable` renders as `actionable:'unknown'` —
 * neither a green light nor a block, so the list and `get` paths can never
 * disagree `true` vs `false` for the same item.
 */
import type { GraphBackend, NodeRecord } from '@adhd/sox-graph-store';
import { isStatusTerminal, resolveBlockers, resolveObligations } from './card.js';
import { resolveIssuePlacement } from './resolve.js';
import {
  evaluatePredicate,
  type IPredicate,
  type IPredicateResolver,
  type IRelationDirection,
} from '../write/obligation.js';
import {
  checkAnchor,
  parseAnchor,
  type IAttestationAnchor,
  type IParsedAnchor,
} from '../write/anchor-check.js';
import { extractClaimMeta, isClaimStale } from '../write/claim-lease.js';
import { readRevision } from '../write/revision.js';
import { nowISO } from '../write/tx.js';
import { computeActionable, orderConditions } from './verdict-core.js';
import type { ICondition, IObligationView, IVerdict } from './types.js';

/** Highest ladder rung `deriveVerdict` may run. */
export type IVerdictRung = 1 | 2 | 3 | 4 | 5;

export interface IDeriveVerdictOptions {
  /**
   * Highest ladder rung this call is allowed to run. Default 2 (the list
   * bound). 5 = full re-resolve. A budget stop yields an `Unknown` condition.
   */
  maxRung?: IVerdictRung;
  /** The instant used for staleness maths; defaults to nowISO(). */
  at?: string;
  /** Staleness threshold (minutes); defaults to 30 (project_policy default). */
  claimStaleAfterMin?: number;
  /** Test instrumentation: invoked with each rung actually evaluated. */
  onRung?: (rung: number) => void;
}

const DEFAULT_CLAIM_STALE_AFTER_MIN = 30;

function condition(
  partial: Pick<ICondition, 'type' | 'status' | 'severity' | 'code'> &
    Partial<Pick<ICondition, 'message' | 'subject'>>
): ICondition {
  return partial;
}

/** A `block`-severity `Unknown` — the honest "the check was not run/decided". */
function unknownBlock(subject: string | undefined, message: string): ICondition {
  return condition({
    type: 'Budget',
    status: 'Unknown',
    severity: 'block',
    code: 'Unknown',
    message,
    ...(subject !== undefined ? { subject } : {}),
  });
}

/** Every `evidence` leaf kind in a predicate (deduped, order-stable). */
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

/** The op of the first failing leaf of an UNSATISFIED predicate — the WHOLE of reason-code derivation. */
async function firstFailingOp(
  pred: IPredicate,
  resolver: IPredicateResolver
): Promise<string> {
  switch (pred.op) {
    case 'evidence':
    case 'blockers_terminal':
    case 'relation':
      return pred.op;
    case 'all_of':
    case 'any_of': {
      for (const child of pred.of) {
        if (!(await evaluatePredicate(child, resolver)))
          return firstFailingOp(child, resolver);
      }
      return pred.op;
    }
    case 'not':
      return pred.op;
  }
}

/** Map a failing predicate op onto the governed reason-code core. */
function codeForFailingOp(op: string): {
  code: ICondition['code'];
  type: ICondition['type'];
} {
  switch (op) {
    case 'evidence':
      return { code: 'EvidenceUnverified', type: 'Evidence' };
    case 'blockers_terminal':
      return { code: 'BlockedBy', type: 'Blocked' };
    case 'relation':
      return { code: 'ReferenceUnresolved', type: 'Reference' };
    default:
      return { code: 'Unknown', type: 'Obligation' };
  }
}

/** The graph-backed {@link IPredicateResolver} for the on-read verdict. */
function makeGraphResolver(
  graph: GraphBackend,
  issue: NodeRecord,
  nonTerminalBlockers: readonly { uid: string }[]
): IPredicateResolver {
  return {
    async countVerifiedAttestations(kind: string): Promise<number> {
      const edges = await graph.getEdges({ src: issue.id, rel: 'attests' });
      if (edges.length === 0) return 0;
      const nodes = await graph.getNodesByIds(edges.map((e) => e.dst));
      let n = 0;
      for (const node of nodes) {
        const meta = node.metadata;
        const claim = meta?.['claim'];
        const check = meta?.['check'];
        const claimKind =
          claim !== null && typeof claim === 'object'
            ? (claim as Record<string, unknown>)['kind']
            : undefined;
        const state =
          check !== null && typeof check === 'object'
            ? (check as Record<string, unknown>)['state']
            : undefined;
        if (claimKind === kind && state === 'verified') n += 1;
      }
      return n;
    },
    async blockersAllTerminal(): Promise<boolean> {
      // `nonTerminalBlockers` is exactly the live incoming `blocks` set minus
      // the terminal ones (rung 1) — non-empty ⇒ not all terminal.
      return nonTerminalBlockers.length === 0;
    },
    async relationExists(
      type: string,
      direction: IRelationDirection
    ): Promise<boolean> {
      const edges =
        direction === 'in'
          ? await graph.getEdges({ dst: issue.id, rel: type })
          : await graph.getEdges({ src: issue.id, rel: type });
      return edges.length > 0;
    },
  };
}

/**
 * Whether an obligation predicts a terminal transition — `applies_to.to` is
 * `'*'`, an unknown status name (fail-open toward including it), or a known
 * TERMINAL status. A `to` naming a known non-terminal status is excluded.
 */
async function isTerminallyScoped(
  graph: GraphBackend,
  obligation: IObligationView
): Promise<boolean> {
  const to = obligation.applies_to?.to;
  if (to === '*') return true;
  const statuses = await graph.queryNodes({ kind: 'status', liveOnly: true });
  const match = statuses.find((s) => s.name === to);
  if (match === undefined) return true; // unknown status name — do not silently exclude
  return isStatusTerminal(match);
}

/** The subject project's filesystem root, or `undefined` (path-less project). */
async function resolveProjectRoot(
  graph: GraphBackend,
  issueId: number
): Promise<string | undefined> {
  const { project } = await resolveIssuePlacement(graph, issueId);
  const path = project?.metadata?.['path'];
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

/** A stored-verified attestation of `kind` on the issue, projected for the anchor ladder. */
interface IEvidenceFact {
  uid: string;
  anchor?: IAttestationAnchor;
  assertedAt?: string;
}

async function findVerifiedAttestation(
  graph: GraphBackend,
  issueId: number,
  kind: string
): Promise<IEvidenceFact | undefined> {
  const edges = await graph.getEdges({ src: issueId, rel: 'attests' });
  if (edges.length === 0) return undefined;
  const nodes = await graph.getNodesByIds(edges.map((e) => e.dst));
  for (const node of nodes) {
    const meta = node.metadata;
    const claim = meta?.['claim'];
    const check = meta?.['check'];
    const anchorRaw = meta?.['anchor'];
    const claimKind =
      claim !== null && typeof claim === 'object'
        ? (claim as Record<string, unknown>)['kind']
        : undefined;
    const state =
      check !== null && typeof check === 'object'
        ? (check as Record<string, unknown>)['state']
        : undefined;
    if (claimKind !== kind || state !== 'verified') continue;
    const fact: IEvidenceFact = { uid: node.uid };
    if (anchorRaw !== null && typeof anchorRaw === 'object') {
      const locator = (anchorRaw as Record<string, unknown>)['locator'];
      const digest = (anchorRaw as Record<string, unknown>)['digest'];
      if (typeof locator === 'string' && typeof digest === 'string') {
        fact.anchor = { locator, digest };
      }
    }
    const assertedAt =
      claim !== null && typeof claim === 'object'
        ? (claim as Record<string, unknown>)['asserted_at']
        : undefined;
    if (typeof assertedAt === 'string') fact.assertedAt = assertedAt;
    return fact;
  }
  return undefined;
}

function parseAnchorSafe(locator: string): IParsedAnchor | undefined {
  try {
    return parseAnchor(locator);
  } catch {
    return undefined;
  }
}

/**
 * Rungs 3–5 — refine a currently-satisfied evidence obligation by resolving its
 * anchor against HEAD. Only called when `maxRung ≥ 3`. Never writes.
 */
async function refineEvidence(
  graph: GraphBackend,
  issueId: number,
  obligation: IObligationView,
  kinds: readonly string[],
  opts: Required<Pick<IDeriveVerdictOptions, 'maxRung' | 'at'>> &
    Pick<IDeriveVerdictOptions, 'onRung'>
): Promise<ICondition[]> {
  const out: ICondition[] = [];
  for (const kind of kinds) {
    const fact = await findVerifiedAttestation(graph, issueId, kind);
    if (fact?.anchor === undefined) {
      out.push(
        condition({
          type: 'Evidence',
          status: 'Unknown',
          severity: obligation.on_fail,
          code: 'Unknown',
          subject: obligation.uid,
          message: `no stored-verified "${kind}" attestation with a readable anchor`,
        })
      );
      continue;
    }
    const parsed = parseAnchorSafe(fact.anchor.locator);
    if (parsed?.scheme !== 'path' && parsed?.scheme !== 'commit') {
      // url:/query:/registry: anchors have no mechanical checker wired yet.
      out.push(
        condition({
          type: 'Evidence',
          status: 'Unknown',
          severity: obligation.on_fail,
          code: 'Unknown',
          subject: obligation.uid,
          message: `no mechanical checker is wired for "${parsed?.scheme ?? 'unknown'}:" anchors yet`,
        })
      );
      continue;
    }
    const root = await resolveProjectRoot(graph, issueId);
    if (root === undefined) {
      out.push(
        condition({
          type: 'Evidence',
          status: 'Unknown',
          severity: obligation.on_fail,
          code: 'Unknown',
          subject: obligation.uid,
          message: 'no project root could be resolved for the subject',
        })
      );
      continue;
    }
    // Rungs actually attempted, in order.
    opts.onRung?.(3);
    if (opts.maxRung >= 4 && parsed.scheme === 'path') opts.onRung?.(4);
    if (opts.maxRung >= 5) opts.onRung?.(5);

    const check = checkAnchor(fact.anchor, {
      root,
      ...(opts.maxRung >= 4 && fact.assertedAt !== undefined
        ? { sinceISO: fact.assertedAt }
        : {}),
      ...(opts.maxRung >= 5 ? { full: true } : {}),
      now: opts.at,
      by: 'verdict',
    });

    if (check.state === 'stale') {
      out.push(
        condition({
          type: 'Evidence',
          status: 'True',
          severity: obligation.on_fail,
          code: 'EvidenceStale',
          subject: fact.uid,
          message: `the "${kind}" anchor is stale (${check.reason ?? check.method})`,
        })
      );
      continue;
    }
    if (check.state === 'verified' && opts.maxRung >= 4) {
      // Freshness was actually checked and the anchor still matches.
      continue;
    }
    // `unverified`/`unknown`, or a rung-3-only presence check that cannot prove
    // freshness — an honest Unknown, never a green light.
    out.push(
      condition({
        type: 'Evidence',
        status: 'Unknown',
        severity: obligation.on_fail,
        code: 'Unknown',
        subject: obligation.uid,
        message:
          check.state === 'unknown' || check.state === 'unverified'
            ? `the "${kind}" anchor could not be mechanically resolved (${check.reason ?? check.method})`
            : `the "${kind}" anchor presence was confirmed but freshness was not re-resolved at this rung`,
      })
    );
  }
  return out;
}

/** Evaluate ONE obligation that predicts a terminal transition. */
async function evaluateObligation(
  graph: GraphBackend,
  issue: NodeRecord,
  obligation: IObligationView,
  resolver: IPredicateResolver,
  opts: Required<Pick<IDeriveVerdictOptions, 'maxRung' | 'at'>> &
    Pick<IDeriveVerdictOptions, 'onRung'>
): Promise<ICondition[]> {
  let satisfied: boolean;
  try {
    satisfied = await evaluatePredicate(obligation.requirement, resolver);
  } catch {
    return [
      condition({
        type: 'Obligation',
        status: 'Unknown',
        severity: obligation.on_fail,
        code: 'Unknown',
        subject: obligation.uid,
        message: 'the obligation predicate could not be evaluated',
      }),
    ];
  }

  if (!satisfied) {
    const failing = codeForFailingOp(
      await firstFailingOp(obligation.requirement, resolver)
    );
    return [
      condition({
        type: failing.type,
        status: 'True',
        severity: obligation.on_fail,
        code: failing.code,
        subject: obligation.uid,
        message: `obligation unsatisfied: ${failing.code}`,
      }),
    ];
  }

  // Satisfied. A predicate that references evidence cannot be CERTIFIED below
  // the rung that re-resolves its anchor (rungs 3–5): below rung 3 it is an
  // honest Unknown (the list path's budget stop), never `true`.
  const kinds = collectEvidenceKinds(obligation.requirement);
  if (kinds.length === 0) return [];
  if (opts.maxRung < 3) {
    return [
      condition({
        type: 'Evidence',
        status: 'Unknown',
        severity: obligation.on_fail,
        code: 'Unknown',
        subject: obligation.uid,
        message:
          'evidence anchor not re-resolved at this rung — actionability is genuinely unknown',
      }),
    ];
  }
  return refineEvidence(graph, issue.id, obligation, kinds, opts);
}

/**
 * Derive the verdict for a live issue (DESIGN §2 Primitive 4). NEVER writes.
 */
export async function deriveVerdict(
  graph: GraphBackend,
  issue: NodeRecord,
  opts: IDeriveVerdictOptions = {}
): Promise<IVerdict> {
  const maxRung: IVerdictRung = opts.maxRung ?? 2;
  const at = opts.at ?? nowISO();
  const claimStaleAfterMin =
    opts.claimStaleAfterMin ?? DEFAULT_CLAIM_STALE_AFTER_MIN;
  const conditions: ICondition[] = [];

  // Rung 1 — relation state (always).
  opts.onRung?.(1);
  const blockers = await resolveBlockers(graph, issue.id);
  for (const b of blockers) {
    conditions.push(
      condition({
        type: 'Blocked',
        status: 'True',
        severity: 'block',
        code: 'BlockedBy',
        subject: b.uid,
        message: `blocked by ${b.uid}`,
      })
    );
  }

  if (maxRung < 2) {
    // Rung 2 was not run: obligations are unassessed, so actionability is
    // genuinely unknown — never a green light.
    conditions.push(
      unknownBlock(undefined, 'obligations were not evaluated at this rung')
    );
  } else {
    opts.onRung?.(2);
    const obligations = await resolveObligations(graph, issue.id);

    if (obligations.length === 0) {
      // C6: an obligation-free item is reported, never blocked (the honest floor).
      conditions.push(
        condition({
          type: 'Obligation',
          status: 'True',
          severity: 'warn',
          code: 'MissingObligation',
          message: 'no obligations are declared on this item',
        })
      );
    }

    const resolver = makeGraphResolver(graph, issue, blockers);
    const rungOpts = { maxRung, at, ...(opts.onRung ? { onRung: opts.onRung } : {}) };
    for (const obligation of obligations) {
      if (!(await isTerminallyScoped(graph, obligation))) continue;
      conditions.push(
        ...(await evaluateObligation(graph, issue, obligation, resolver, rungOpts))
      );
    }

    // Claim staleness (rung 2) — a warning, so IN_PROGRESS stops conflating
    // "work is live" with "nobody touched it".
    const { claimedBy, claimedAt } = extractClaimMeta(issue.metadata);
    if (
      claimedBy !== undefined &&
      isClaimStale(claimedAt, at, claimStaleAfterMin)
    ) {
      conditions.push(
        condition({
          type: 'Claim',
          status: 'True',
          severity: 'warn',
          code: 'ClaimStale',
          subject: claimedBy,
          message: `claim by "${claimedBy}" is stale (threshold ${claimStaleAfterMin}min)`,
        })
      );
    }
  }

  const ordered = orderConditions(conditions);
  return {
    actionable: computeActionable(ordered),
    evaluated_at: at,
    revision: readRevision(issue.metadata),
    conditions: ordered,
  };
}
