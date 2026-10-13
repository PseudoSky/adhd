import type { FilterExpression } from '../../spec';
import { rewriteOperators } from './walk';

/**
 * Marker substituted for a `$attributes.<name>` whose attribute is absent
 * (AT-10). It never equals any real value.
 */
export const ABSENT: Readonly<{ readonly $absent: true }> = Object.freeze({
  $absent: true as const,
});

/** True when `v` is the {@link ABSENT} marker. */
export function isAbsent(v: unknown): boolean {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    (v as Record<string, unknown>)['$absent'] === true
  );
}

/** True when `v` is, or deeply contains, the ABSENT marker. */
export function containsAbsent(v: unknown): boolean {
  if (isAbsent(v)) return true;
  if (Array.isArray(v)) return v.some(containsAbsent);
  if (v !== null && typeof v === 'object') {
    return Object.values(v as Record<string, unknown>).some(containsAbsent);
  }
  return false;
}

/**
 * Replaces every operator node `{_op: operand}` whose operand (deeply)
 * contains ABSENT with a constant-false node (a field no row has compared to
 * an impossible value), so a comparison against an absent `$attributes.<name>`
 * is exactly "false" and never a bare engine quirk (AT-10). Logic stays
 * two-valued: `_not` over that false node DOES flip to true, as it does for any
 * false comparison. Returns a new expression; the input is untouched.
 */
export function neutralizeAbsent(expression: FilterExpression): FilterExpression {
  return rewriteOperators(expression, (_path, _op, operand) =>
    containsAbsent(operand) ? false : undefined
  );
}

const LOGICAL_KEYS = new Set(['_and', '_or', '_not']);

const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const own = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** True when `path` (an exact key, else a dotted walk) resolves to a defined value in `row`. */
function hasPath(row: unknown, path: string): boolean {
  if (isPlain(row) && own(row, path)) return row[path] !== undefined;
  let current: unknown = row;
  for (const segment of path.split('.')) {
    if (!isPlain(current) || !own(current, segment)) return false;
    current = current[segment];
  }
  return current !== undefined;
}

/** True when the operator set is exactly the `_is_null` presence check (AT-12). */
const isPresenceCheck = (ops: Record<string, unknown>): boolean => {
  const keys = Object.keys(ops);
  return keys.length === 1 && keys[0] === '_is_null';
};

/**
 * Row-dependent rewrite for `context` evaluation (AT-10 / AT-12). Every field
 * comparison whose field path is absent from `row` becomes the constant-false
 * node `{ '$$never<N>': { _eq: 1 } }`, so negative operators (`_ne`, `_nin`,
 * `_nlike`, `_is_null: true`) cannot succeed on an attribute that is not
 * there. The one exception is a field whose operator set is exactly
 * `_is_null`: that is the documented presence test and is left to the engine
 * (absent field => `_is_null: true` holds, `_is_null: false` does not).
 * Returns the input unchanged (same identity, so predicate caches hit) when no
 * field is absent.
 */
export function falsifyAbsentFields(
  row: Readonly<Record<string, unknown>>,
  expression: FilterExpression
): FilterExpression {
  let counter = 0;
  let changed = false;
  const never = (): Record<string, unknown> => {
    changed = true;
    return { [`$$never${counter++}`]: { _eq: 1 } };
  };

  /** Returns the replacement VALUE for the field at `path`, or undefined to keep it. */
  const field = (path: string[], value: unknown): unknown => {
    const joined = path.join('.');
    if (!isPlain(value)) return hasPath(row, joined) ? undefined : never();
    const ops: Record<string, unknown> = {};
    let hasOperators = false;
    for (const k of Object.keys(value)) {
      if (k.startsWith('_') && !LOGICAL_KEYS.has(k)) {
        ops[k] = value[k];
        hasOperators = true;
      }
    }
    if (hasOperators && !hasPath(row, joined) && !isPresenceCheck(ops)) return never();
    // Nested sub-fields inside the field object.
    let out: Record<string, unknown> | undefined;
    for (const k of Object.keys(value)) {
      if (k.startsWith('_')) continue;
      const replaced = field([...path, k], value[k]);
      if (replaced !== undefined) {
        out ??= { ...value };
        out[k] = replaced;
      }
    }
    return out;
  };

  const node = (n: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(n)) {
      if (LOGICAL_KEYS.has(key)) {
        if (Array.isArray(value)) {
          out[key] = value.map((child) => (isPlain(child) ? node(child) : child));
        } else {
          out[key] = isPlain(value) ? node(value) : value;
        }
      } else if (key.startsWith('$$')) {
        out[key] = value;
      } else {
        const replaced = field([key], value);
        out[key] = replaced === undefined ? value : replaced;
      }
    }
    return out;
  };

  const result = node(expression as Record<string, unknown>);
  return changed ? (result as FilterExpression) : expression;
}
