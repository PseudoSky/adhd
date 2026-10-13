import type { FilterExpression } from '../../spec';
import { compilePredicate } from './query';
import { rewriteOperators } from './walk';

/**
 * Supported operator set: the engine's operators plus `_within`. `_period` is
 * excluded on purpose: it reads the wall clock, and evaluation must be a pure
 * function of its inputs (QE-08).
 */
export const SUPPORTED_OPERATORS: ReadonlySet<string> = new Set([
  '_and', '_or', '_not',
  '_eq', '_ne', '_neq', '_in', '_nin', '_gt', '_lt', '_gte', '_lte',
  '_like', '_nlike', '_ilike', '_nilike', '_similar', '_nsimilar',
  '_contains', '_contained_in', '_has_key', '_has_keys_any', '_has_keys_all',
  '_is_null', '_regex', '_iregex', '_nregex', '_niregex',
  '_in_datetimerange', '_nin_datetimerange', '_overlaps', '_between', '_nbetween',
  '_within',
]);

const REGEX_OPERATORS = new Set(['_regex', '_iregex', '_nregex', '_niregex']);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * JSON paths (`/permissions/0/args/_regx`) of every operator-looking key
 * (`_...`) not in {@link SUPPORTED_OPERATORS}, of every regular-expression
 * operand that is a literal string that does not compile, and (as `basePath`)
 * of anything the engine rejects with a `QueryValidationError`. `[]` when valid.
 */
export function validateExpression(
  expression: FilterExpression,
  basePath = ''
): readonly string[] {
  const bad: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}/${i}`));
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const child = `${path}/${key}`;
      if (key.startsWith('_') && !SUPPORTED_OPERATORS.has(key)) {
        bad.push(child);
        continue;
      }
      if (REGEX_OPERATORS.has(key) && typeof value === 'string' && !value.startsWith('$attributes.')) {
        try {
          new RegExp(value);
        } catch {
          bad.push(child);
          continue;
        }
      }
      walk(value, child);
    }
  };
  walk(expression, basePath);
  if (bad.length > 0) return bad;
  try {
    const folded = rewriteOperators(expression, (_p, op) =>
      op === '_within' || op === '_contained_in' ? true : undefined
    );
    compilePredicate(folded);
  } catch {
    return [basePath === '' ? '/' : basePath];
  }
  return [];
}
