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
 * an impossible value). Required so `_not` over an absent comparison cannot
 * flip to true on a bare engine quirk: the result is exactly "that comparison
 * is false" (AT-10). Returns a new expression; the input is untouched.
 */
export function neutralizeAbsent(expression: FilterExpression): FilterExpression {
  return rewriteOperators(expression, (_path, _op, operand) =>
    containsAbsent(operand) ? false : undefined
  );
}
