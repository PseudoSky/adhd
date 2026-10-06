/**
 * Canonicalization — a stable, order-independent identity for a `QueryExpression`
 * and a `Predicate`, used for plan identity and the CSE/cache key.
 *
 * STRUCTURAL object keys are sorted everywhere. The COMMUTATIVE OPERAND arrays are
 * sorted too: `_and`/`_or` (idempotent, commutative), `_in`/`_nin` (set-valued), and
 * `group_by` (a set of grouping keys). Order-SENSITIVE slots are NOT reordered —
 * `order_by`, `distinct_on`, `select`, and the arithmetic operand arrays
 * (`_add`/`_sub`/`_mul`/`_div`/`_coalesce`/`_round`) keep their order, because
 * evaluation depends on it (notably float summation order).
 *
 * Two queries that differ only in the order of a commutative slot share a key; two
 * that differ anywhere meaningful do not.
 */
import type { Predicate, QueryExpression } from './types';

/** Arrays whose element order is irrelevant — sorted, duplicates dropped. */
const SORT_DEDUP: ReadonlySet<string> = new Set(['_and', '_or', '_in', '_nin']);
/** Arrays whose element order is irrelevant — sorted, duplicates KEPT (a repeated
 *  `group_by` key is a query-shape fact, not something to hide by dedupe). */
const SORT_KEEP: ReadonlySet<string> = new Set(['group_by']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An identity-keyed memo for a single canonicalization pass. A shared-reference
 * (DAG) query would otherwise re-canonicalize a reused subexpression once per
 * reference — ~2^depth — so the planner threads ONE memo through every key it
 * computes, making the whole pass O(nodes). Query objects are treated as
 * immutable for the duration of a pass (they are).
 */
export type CanonMemo = Map<unknown, string>;

/** One in-flight container on `canon`'s explicit work stack. */
interface ArrFrame {
  readonly kind: 'arr';
  readonly value: readonly unknown[];
  readonly key: string | undefined;
  readonly out: string[];
  i: number;
}
interface RecFrame {
  readonly kind: 'rec';
  readonly value: Record<string, unknown>;
  readonly keys: string[];
  readonly out: string[];
  i: number;
}
type Frame = ArrFrame | RecFrame;

/**
 * A canonical JSON string: object keys sorted; commutative arrays normalized.
 *
 * ITERATIVE (explicit work stack), never native recursion: query nesting depth is
 * caller-controlled, and a recursive walk costs several V8 frames per level, so a
 * ~1k-deep `_and` chain sat within ~15% of the default stack limit and overflowed
 * nondeterministically (JIT tier / worker load). Stack use here is O(1); the heap
 * work stack is O(depth). Evaluation order, memoization and output are identical
 * to the recursive formulation. A cyclic query throws `TypeError`.
 */
function canon(root: unknown, rootKey: string | undefined, memo: CanonMemo): string {
  const stack: Frame[] = [];
  /** Records currently being canonicalized — a re-entry is a cycle. */
  const active = new Set<object>();

  /** A leaf / memo hit resolves to its string now; a container pushes a frame (returns undefined). */
  const enter = (value: unknown, key: string | undefined): string | undefined => {
    if (Array.isArray(value)) {
      if (active.has(value)) throw new TypeError('canon: cyclic query structure');
      active.add(value);
      stack.push({ kind: 'arr', value, key, out: [], i: 0 });
      return undefined;
    }
    if (isRecord(value)) {
      const hit = memo.get(value);
      if (hit !== undefined) return hit;
      if (active.has(value)) throw new TypeError('canon: cyclic query structure');
      active.add(value);
      stack.push({ kind: 'rec', value, keys: Object.keys(value).sort(), out: [], i: 0 });
      return undefined;
    }
    const out = JSON.stringify(value);
    return out === undefined ? 'null' : out;
  };

  const first = enter(root, rootKey);
  if (first !== undefined) return first;

  let result = '';
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const n = top.kind === 'arr' ? top.value.length : top.keys.length;
    if (top.i < n) {
      const idx = top.i++;
      const child = top.kind === 'arr' ? top.value[idx] : top.value[top.keys[idx]];
      const childKey = top.kind === 'arr' ? undefined : top.keys[idx];
      const s = enter(child, childKey);
      if (s !== undefined) top.out.push(top.kind === 'arr' ? s : `${JSON.stringify(childKey)}:${s}`);
      continue;
    }
    // All children resolved — fold this container and hand it to its parent.
    stack.pop();
    active.delete(top.value);
    let folded: string;
    if (top.kind === 'arr') {
      const items = top.out;
      if (top.key !== undefined && SORT_DEDUP.has(top.key)) folded = `[${[...new Set(items)].sort().join(',')}]`;
      else if (top.key !== undefined && SORT_KEEP.has(top.key)) folded = `[${[...items].sort().join(',')}]`;
      else folded = `[${items.join(',')}]`;
    } else {
      folded = `{${top.out.join(',')}}`;
      memo.set(top.value, folded);
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      result = folded;
    } else if (parent.kind === 'arr') {
      parent.out.push(folded);
    } else {
      parent.out.push(`${JSON.stringify(parent.keys[parent.i - 1])}:${folded}`);
    }
  }
  return result;
}

/** The structural canonical string of a predicate. */
export function canonicalizePredicate(pred: Predicate, memo: CanonMemo = new Map()): string {
  return canon(pred, undefined, memo);
}

/**
 * The full plan key — includes `name` and `source`. Stable across object-key order
 * and `_and`/`_or`/`_in`/`_nin`/`group_by` operand order.
 */
export function planKey(query: QueryExpression, memo: CanonMemo = new Map()): string {
  return canon(query, undefined, memo);
}

/**
 * The CSE/compute key — `planKey` with `name` removed. `execute` never reads a
 * node's `name` (only its parent labels the output), so two items that are identical
 * but for `name` compute identically and may share one evaluation.
 */
export function computeKey(query: QueryExpression, memo: CanonMemo = new Map()): string {
  const clone: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) {
    if (k === 'name') continue;
    clone[k] = v;
  }
  return canon(clone, undefined, memo);
}
