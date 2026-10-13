import type { FilterExpression } from '../../spec';
import { falsifyAbsentFields, neutralizeAbsent } from './absent';
import { compilePredicate } from './query';
import type { RowPredicate } from './query';
import { isWithinRoots } from './within';
import { rewriteOperators, someOperator } from './walk';

/** Operators resolved against the row before the engine runs. */
const ROW_OPERATORS = new Set(['_within', '_contained_in']);

const neutralizedCache = new WeakMap<object, FilterExpression>();
const rowFreeCache = new WeakMap<object, boolean>();
const predicateCache = new WeakMap<object, RowPredicate>();

/** Reads `a.b.0` from `row`: an exact (dotted) key first, then a path walk. */
function getPath(row: unknown, path: string): unknown {
  if (row !== null && typeof row === 'object' && path in (row as object)) {
    return (row as Record<string, unknown>)[path];
  }
  let current: unknown = row;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Resolves `_within` and array-valued `_contained_in` for one row; `undefined` defers to the engine. */
function rowResolver(row: Record<string, unknown>) {
  const cwd = typeof row['cwd'] === 'string' ? (row['cwd'] as string) : undefined;
  return (fieldPath: string, operator: string, operand: unknown): boolean | undefined => {
    if (operator === '_within') return isWithinRoots(getPath(row, fieldPath), operand, cwd);
    if (operator === '_contained_in') {
      const value = getPath(row, fieldPath);
      if (!Array.isArray(value) || !Array.isArray(operand)) return undefined;
      return value.every((item) => operand.includes(item));
    }
    return undefined;
  };
}

/**
 * True if `row` satisfies `expression` under the query engine's semantics
 * (QE-01). Never throws: an engine error returns false. Absent-placeholder
 * markers become constant-false, and `_within` / array `_contained_in` are
 * resolved against the row before the engine runs (the engine's own
 * `_contained_in` tests list membership of a scalar, not a subset).
 */
export function matches(
  row: Readonly<Record<string, unknown>>,
  expression: FilterExpression
): boolean {
  try {
    let neutralized = neutralizedCache.get(expression);
    if (neutralized === undefined) {
      neutralized = neutralizeAbsent(expression);
      neutralizedCache.set(expression, neutralized);
    }
    let rowFree = rowFreeCache.get(expression);
    if (rowFree === undefined) {
      rowFree = !someOperator(neutralized, (op) => ROW_OPERATORS.has(op));
      rowFreeCache.set(expression, rowFree);
    }
    const mutableRow = row as Record<string, unknown>;
    if (rowFree) {
      let predicate = predicateCache.get(expression);
      if (predicate === undefined) {
        predicate = compilePredicate(neutralized);
        predicateCache.set(expression, predicate);
      }
      return predicate(mutableRow) === true;
    }
    const folded = rewriteOperators(neutralized, rowResolver(mutableRow));
    return compilePredicate(folded)(mutableRow) === true;
  } catch {
    return false;
  }
}

/**
 * `matches` for a permission `context` (AT-10 / AT-12): a comparison on a field
 * absent from `row` is false, including the negative operators (`_ne`, `_nin`,
 * `_nlike`, `_is_null: true` is the one presence test and stays true). Used for
 * context evaluation only; `args` rows keep plain engine semantics.
 */
export function matchesPresent(
  row: Readonly<Record<string, unknown>>,
  expression: FilterExpression
): boolean {
  try {
    return matches(row, falsifyAbsentFields(row, expression));
  } catch {
    return false;
  }
}
