/**
 * The planner — a rule-based (heuristic) access-path chooser. There are no
 * statistics/cardinality in this engine, so a cost model would be unjustified; the
 * only decision is index-scan vs scan, resolved from the PRE (raw-row) predicate.
 *
 * `planQuery` walks the self-similar query tree (root + `select`-nested + `_in`/
 * `_nin` subqueries), splits each node's `where` with the phase rule, and assigns an
 * access path from the PRE half only — a post-group output name can never pick an
 * index. `executePlanned` (in `./execute`) consumes the plan.
 */
import { computeKey, planKey, type CanonMemo } from './canonical';
import { fieldLeaves, postNames, splitWhere } from './phase';
import type { PlannerIndex } from './indexing';
import type { Predicate, QueryExpression } from './types';

export type AccessPath =
  | { readonly kind: 'scan' }
  | { readonly kind: 'index'; readonly ids: ReadonlySet<number> };

export interface PlanNode {
  /** Plan identity (`planKey`) — includes `name`. */
  readonly key: string;
  /** CSE identity (`computeKey`) — `name` normalized away. */
  readonly computeKey: string;
  /** The query this node plans. */
  readonly query: QueryExpression;
  readonly access: AccessPath;
  /** The pre-group half of `where` (feeds the access path + the scan filter). */
  readonly pre?: Predicate;
  /** The post-group half of `where`. */
  readonly post?: Predicate;
  /** True iff this node reads its source directly (root / `_in` operand), vs a
   *  `select`-nested node, which operates on its parent's scoped rows. */
  readonly readsSource: boolean;
  /** The `computeKey`s of this node's children, in discovery order. */
  readonly childKeys: readonly string[];
}

export interface PhysicalPlan {
  readonly root: PlanNode;
  /** Every planned node keyed by `computeKey` — the CSE lookup. */
  readonly nodes: ReadonlyMap<string, PlanNode>;
}

export interface PlannerOptions {
  indexFor(source: string): PlannerIndex | undefined;
  /** The source name an un-named top query reads (the DataView resolves it). */
  defaultSource: string;
}

function isScalarOperatorShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => k.startsWith('_'));
}

function isSubqueryExpression(value: unknown): value is QueryExpression {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isScalarOperatorShape(value);
}

/** Every `_in`/`_nin` operand that is itself a QueryExpression, at any depth. */
function subqueryOperands(root: Predicate): QueryExpression[] {
  const out: QueryExpression[] = [];
  const visit = (node: Predicate): void => {
    for (const [, operator] of fieldLeaves(node)) {
      for (const [op, operand] of Object.entries(operator)) {
        if ((op === '_in' || op === '_nin') && isSubqueryExpression(operand)) out.push(operand);
      }
    }
    for (const c of node._and ?? []) visit(c);
    for (const c of node._or ?? []) visit(c);
    if (node._not !== undefined) visit(node._not);
  };
  visit(root);
  return out;
}

/** The access path for a node's source read — from the PRE predicate only. */
export function computeAccessPath(pre: Predicate | undefined, index: PlannerIndex | undefined): AccessPath {
  if (pre === undefined || index === undefined) return { kind: 'scan' };
  const ids = index.candidates(pre);
  return ids === undefined ? { kind: 'scan' } : { kind: 'index', ids };
}

/** Plan a query tree: root + `select`-nested + `_in`/`_nin` subqueries. */
export function planQuery(query: QueryExpression, opts: PlannerOptions): PhysicalPlan {
  const nodes = new Map<string, PlanNode>();
  // One identity memo shared by EVERY key computed in this pass, so a shared
  // subexpression is canonicalized once, not ~2^depth times.
  const canonMemo: CanonMemo = new Map();
  // Visit memo: a shared reference (same object, same read context) is planned
  // ONCE and reused, so planning is O(query nodes) even on a DAG.
  const visited = new Map<string, PlanNode>();

  const visit = (q: QueryExpression, readsSource: boolean, source: string | undefined): PlanNode => {
    const ck = computeKey(q, canonMemo);
    const visitKey = `${ck}\u0000${readsSource ? 'S' : 'N'}\u0000${source ?? ''}`;
    const done = visited.get(visitKey);
    if (done !== undefined) return done;

    const post = postNames(q);
    const { pre, post: postFilter } = splitWhere(q.where, post);
    const index = readsSource && source !== undefined ? opts.indexFor(source) : undefined;
    const access = computeAccessPath(pre, index);

    const children: PlanNode[] = [];
    for (const item of q.select ?? []) {
      if (typeof item !== 'string') children.push(visit(item, false, undefined));
    }
    if (q.where !== undefined) {
      for (const operand of subqueryOperands(q.where)) {
        children.push(visit(operand, true, operand.source ?? (readsSource ? source : undefined)));
      }
    }

    const node: PlanNode = {
      key: planKey(q, canonMemo),
      computeKey: ck,
      query: q,
      access,
      pre,
      post: postFilter,
      readsSource,
      childKeys: children.map((c) => c.computeKey),
    };
    nodes.set(node.computeKey, node);
    visited.set(visitKey, node);
    return node;
  };

  const root = visit(query, true, query.source ?? opts.defaultSource);
  return { root, nodes };
}
