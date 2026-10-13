import type { FilterExpression } from '../../spec';
import { falsifyAbsentFields, neutralizeAbsent } from './absent';
import { compilePredicate } from './query';
import type { RowPredicate } from './query';
import { isWithinRoots } from './within';
import { rewriteOperators, someOperator } from './walk';

/** Operators resolved against the row before the engine runs. */
const ROW_OPERATORS = new Set(['_within', '_contained_in']);
const REGEX_OPERATORS = new Set(['_regex', '_iregex', '_nregex', '_niregex']);

/** Prefix of every synthetic key this module injects into a row (constants, slots, absent markers). */
const SYNTHETIC_PREFIX = '$$';

const own = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** One row-resolved operator of a template: its field, operator and (already substituted) operand. */
interface ISlot {
  readonly field: string;
  readonly operator: string;
  readonly operand: unknown;
}

/** The row-independent part of a match, built once per expression object. */
interface IMatcher {
  readonly neutralized: FilterExpression;
  /** Compiled once. For a row-free expression it is the predicate itself; otherwise it reads the `$$s<N>` slot booleans. */
  readonly predicate: RowPredicate;
  /** `undefined` for a row-free expression. */
  readonly slots: readonly ISlot[] | undefined;
}

const matcherCache = new WeakMap<object, IMatcher>();

const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Reads `a.b.0` from `row`: an exact (dotted) key first, then an own-property path walk. */
function getPath(row: unknown, path: string): unknown {
  if (isPlain(row) && own(row, path)) return row[path];
  let current: unknown = row;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    if (!own(current, segment)) return undefined;
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
 * Throws when a regular-expression operand cannot be compiled. Run on the
 * expression AFTER placeholder substitution, so an attribute-supplied pattern is
 * checked too: the engine must never be the thing that decides a bad pattern is
 * "false" (a deny rule that cannot be evaluated has to deny the call, FC-01).
 */
function assertRegexOperands(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(assertRegexOperands);
    return;
  }
  if (!isPlain(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (REGEX_OPERATORS.has(key)) {
      if (typeof value !== 'string') throw new TypeError(`${key} needs a string pattern`);
      new RegExp(value);
    } else {
      assertRegexOperands(value);
    }
  }
}

function buildMatcher(expression: FilterExpression): IMatcher {
  const neutralized = neutralizeAbsent(expression);
  assertRegexOperands(neutralized);
  if (!someOperator(neutralized, (op) => ROW_OPERATORS.has(op))) {
    return { neutralized, predicate: compilePredicate(neutralized), slots: undefined };
  }
  const slots: ISlot[] = [];
  const template = rewriteOperators(
    neutralized,
    (field, operator, operand) => {
      if (!ROW_OPERATORS.has(operator)) return undefined;
      slots.push({ field, operator, operand });
      return true;
    },
    { slots: true }
  );
  return { neutralized, predicate: compilePredicate(template), slots };
}

/** The caller's row without any synthetic-prefixed key, so an argument can never forge a constant, slot or absent marker. */
function cleanRow(row: Record<string, unknown>): Record<string, unknown> {
  let dirty = false;
  for (const key of Object.keys(row)) {
    if (key.startsWith(SYNTHETIC_PREFIX)) {
      dirty = true;
      break;
    }
  }
  if (!dirty) return row;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith(SYNTHETIC_PREFIX)) Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * True if `row` satisfies `expression` under the query engine's semantics
 * (QE-01). THROWS when the expression cannot be evaluated (an uncompilable
 * regular expression, an engine error): the caller decides what that means, and
 * `evaluate` turns it into deny `eval-error` (FC-01). Swallowing the error here
 * would turn a broken `deny` rule into "does not match" and let a broader allow
 * through. Absent-placeholder markers become constant-false, and `_within` /
 * array `_contained_in` are resolved against the row (the engine's own
 * `_contained_in` tests list membership of a scalar, not a subset). The
 * compiled predicate is cached per expression object; `_within` rows reuse it
 * and supply their per-row results as slot values.
 */
export function matches(
  row: Readonly<Record<string, unknown>>,
  expression: FilterExpression
): boolean {
  let matcher = matcherCache.get(expression);
  if (matcher === undefined) {
    matcher = buildMatcher(expression);
    matcherCache.set(expression, matcher);
  }
  const clean = cleanRow(row as Record<string, unknown>);
  if (matcher.slots === undefined) return matcher.predicate(clean) === true;

  const resolver = rowResolver(clean);
  const augmented: Record<string, unknown> = { ...clean };
  let deferred = false;
  matcher.slots.forEach((slot, index) => {
    const decided = resolver(slot.field, slot.operator, slot.operand);
    if (decided === undefined) deferred = true;
    else augmented[`${SYNTHETIC_PREFIX}s${index}`] = decided;
  });
  if (!deferred) return matcher.predicate(augmented) === true;
  // An operator the engine must judge for this row (e.g. `_contained_in` over a scalar): fold per row.
  return compilePredicate(rewriteOperators(matcher.neutralized, resolver))(clean) === true;
}

/**
 * `matches` for a permission `context` and `defaults[].where` (AT-10 / AT-12,
 * D-22): a comparison on a field absent from `row` is false, including the
 * negative operators (`_ne`, `_nin`, `_nlike`); `_is_null: true` is the one
 * presence test and stays true. Used for context and defaults evaluation only;
 * `args` rows keep plain engine semantics. Throws like {@link matches}.
 */
export function matchesPresent(
  row: Readonly<Record<string, unknown>>,
  expression: FilterExpression
): boolean {
  return matches(row, falsifyAbsentFields(row, expression));
}
