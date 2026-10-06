/**
 * The phase rule — how ONE `where` tree carries both WHERE (pre-group) and
 * HAVING (post-group).
 *
 * A predicate leaf has a PHASE decided by reference: POST if it references an
 * aggregate output (a `group_by` item's `name`), else PRE. The tree decomposes as
 * `P = P_where AND P_having` **iff every `_or`/`_not` subtree is phase-pure**:
 *  - `_and` across phases is fine (conjunctive pushdown);
 *  - a mixed-phase `_or`/`_not` has NO WHERE-then-HAVING form → a compile error.
 *
 * This module is the ONLY place that rule lives.
 */
import { QueryModelError } from './errors';
import type { ScalarOperator, Predicate, QueryExpression } from './types';

/** Thrown when a `where` tree violates the phase rule (a mixed-phase disjunction). */
export class PhaseRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhaseRuleError';
  }
}

const BOOL_KEYS: ReadonlySet<string> = new Set(['_and', '_or', '_not']);

/**
 * A leaf value is a scalar operator iff it is a non-array object none of whose
 * keys are boolean-structure keys. A field key holding a scalar operator passes;
 * a nested predicate, a subquery, or an array does not.
 */
export function isScalarOperator(value: unknown): value is ScalarOperator {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => k.startsWith('_') && !BOOL_KEYS.has(k));
}

/** The `(field, operator)` leaves of a predicate node, in key order. */
export function fieldLeaves(node: Predicate): Array<[string, ScalarOperator]> {
  const out: Array<[string, ScalarOperator]> = [];
  for (const key of Object.keys(node)) {
    if (BOOL_KEYS.has(key)) continue;
    const value = node[key];
    if (isScalarOperator(value)) out.push([key, value]);
  }
  return out;
}

/** The set of post-group names a query produces (its aggregate items' `name`s). */
export function postNames(query: QueryExpression): Set<string> {
  const names = new Set<string>();
  for (const item of query.group_by ?? []) {
    if (typeof item === 'object' && item !== null && 'name' in item && typeof item.name === 'string') {
      names.add(item.name);
    }
  }
  return names;
}

export type Phase = 'pre' | 'post' | 'mixed';

/** The phase of a subtree: `pre` (all leaves pre), `post` (all post), else `mixed`. */
export function phaseOf(node: Predicate, post: ReadonlySet<string>): Phase {
  const children: Phase[] = [];
  for (const c of node._and ?? []) children.push(phaseOf(c, post));
  for (const c of node._or ?? []) children.push(phaseOf(c, post));
  if (node._not !== undefined) children.push(phaseOf(node._not, post));
  for (const [key] of fieldLeaves(node)) children.push(post.has(key) ? 'post' : 'pre');
  if (children.every((c) => c === 'pre')) return 'pre';
  if (children.every((c) => c === 'post')) return 'post';
  return 'mixed';
}

/** Recursively assert every `_or`/`_not` subtree is phase-pure, and every leaf is well-formed. */
function assertPurity(node: Predicate, post: ReadonlySet<string>, path: string): void {
  if (node._or?.length === 0) throw new PhaseRuleError(`empty \`_or\` at ${path} is malformed`);
  if (node._and?.length === 0) throw new PhaseRuleError(`empty \`_and\` at ${path} is malformed`);
  const checkSubtree = (sub: Predicate, label: string): void => {
    if (phaseOf(sub, post) === 'mixed') {
      throw new PhaseRuleError(
        `mixed-phase '${label}' at ${path}: a disjunction/negation cannot combine a ` +
          `raw-row and a group-output predicate (no WHERE-then-HAVING form)`
      );
    }
    assertPurity(sub, post, path);
  };
  for (const c of node._or ?? []) checkSubtree(c, '_or');
  if (node._not !== undefined) checkSubtree(node._not, '_not');
  for (const c of node._and ?? []) assertPurity(c, post, path);
  // Every non-boolean key must hold a scalar operator — a nested predicate or an
  // empty object under a field key is malformed, not a silently-ignored leaf.
  for (const key of Object.keys(node)) {
    if (BOOL_KEYS.has(key)) continue;
    if (!isScalarOperator(node[key])) {
      throw new PhaseRuleError(
        `malformed predicate at ${path}: '${key}' is neither a reserved boolean key nor a scalar operator`
      );
    }
  }
}

/**
 * Decompose a predicate node into its top-level CONJUNCTS. A predicate object is an
 * implicit AND of its keys: `_and` flattens recursively, a field leaf becomes its own
 * conjunct, and an `_or`/`_not` node is ONE conjunct (a disjunction / negation). This
 * is what lets `{ dept: …, _or: [ … ] }` split into a pre conjunct and a post conjunct
 * instead of being lumped into one mixed node.
 */
function topLevelConjuncts(node: Predicate): Predicate[] {
  const out: Predicate[] = [];
  for (const c of node._and ?? []) out.push(...topLevelConjuncts(c));
  if (node._or !== undefined) out.push({ _or: node._or });
  if (node._not !== undefined) out.push({ _not: node._not });
  for (const [key, value] of fieldLeaves(node)) out.push({ [key]: value });
  return out;
}

const andOf = (list: Predicate[]): Predicate | undefined => {
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return { _and: list };
};

/**
 * Split a `where` tree into its pre-group and post-group halves, per the phase
 * rule. Throws `PhaseRuleError` on a mixed-phase `_or`/`_not`.
 */
export function splitWhere(
  where: Predicate | undefined,
  post: ReadonlySet<string>
): { pre?: Predicate; post?: Predicate } {
  if (where === undefined) return {};
  assertPurity(where, post, 'where');
  const pre: Predicate[] = [];
  const postList: Predicate[] = [];
  for (const conjunct of topLevelConjuncts(where)) {
    const phase = phaseOf(conjunct, post);
    if (phase === 'mixed') {
      throw new PhaseRuleError('mixed-phase top-level conjunct in `where`');
    }
    (phase === 'post' ? postList : pre).push(conjunct);
  }
  return { pre: andOf(pre), post: andOf(postList) };
}

/**
 * Validate the group-item names of a query (§2.3's name/field collision rule).
 * A group item's `name` must be unique, and must not equal a group KEY path — in
 * either case a reference to that spelling would be ambiguous (key or output).
 * A collision with an *unreferenced* raw field is undetectable without a schema
 * and is not a collision *within the query*.
 */
export function validateQuery(query: QueryExpression): void {
  const names = new Set<string>();
  const keys = new Set<string>();
  for (const item of query.group_by ?? []) {
    if (typeof item === 'string') {
      keys.add(item);
      continue;
    }
    if ('_bucket' in item) {
      keys.add(item._bucket.field);
      continue;
    }
    const name = item.name;
    if (name === undefined) throw new QueryModelError('a group_by aggregate item needs a `name`');
    if (names.has(name)) throw new QueryModelError(`duplicate group item name '${name}'`);
    names.add(name);
  }
  for (const name of names) {
    if (keys.has(name)) {
      throw new QueryModelError(`name/field collision: '${name}' is both a group key and an output name`);
    }
  }
}
