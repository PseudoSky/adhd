import type { FilterExpression } from '../../spec';

/**
 * Decides one operator node. Returns `true`/`false` to replace the node by a
 * constant, or `undefined` to keep it for the engine.
 */
export type OperatorResolver = (
  fieldPath: string,
  operator: string,
  operand: unknown
) => boolean | undefined;

const LOGICAL = new Set(['_and', '_or', '_not']);

/** Constant-true / constant-false nodes. They address a field no row carries. */
const CONST_TRUE = { _ne: 1 } as const;
const CONST_FALSE = { _eq: 1 } as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Pre-engine rewrite. Walks a query-engine expression and replaces every
 * operator node for which `resolve` returns a boolean by a constant node
 * (`{ '$$cN': { _ne: 1 } }` is true, `{ '$$cN': { _eq: 1 } }` is false) hoisted
 * next to the field. Also folds `_and: []` to true and `_or: []` to false,
 * which the engine rejects. Returns a NEW expression; the input is untouched.
 * This is how operators the engine lacks or implements differently
 * (`_within`, array `_contained_in`) and absent placeholders stay outside it.
 */
export function rewriteOperators(
  expression: FilterExpression,
  resolve: OperatorResolver
): FilterExpression {
  let counter = 0;
  const constName = (): string => `$$c${counter++}`;

  const processNode = (node: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (LOGICAL.has(key)) {
        if ((key === '_and' || key === '_or') && Array.isArray(value) && value.length === 0) {
          out[constName()] = key === '_and' ? CONST_TRUE : CONST_FALSE;
          continue;
        }
        if (Array.isArray(value)) {
          out[key] = value.map((child) => (isPlainObject(child) ? processNode(child) : child));
        } else {
          out[key] = isPlainObject(value) ? processNode(value) : value;
        }
      } else if (isPlainObject(value)) {
        const remaining = processField([key], value, out);
        if (remaining !== undefined) out[key] = remaining;
      } else {
        out[key] = value;
      }
    }
    return out;
  };

  const processField = (
    path: string[],
    value: Record<string, unknown>,
    hoist: Record<string, unknown>
  ): Record<string, unknown> | undefined => {
    const rest: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      if (LOGICAL.has(key)) {
        rest[key] = member;
      } else if (key.startsWith('_')) {
        const decided = resolve(path.join('.'), key, member);
        if (decided === undefined) rest[key] = member;
        else hoist[constName()] = decided ? CONST_TRUE : CONST_FALSE;
      } else if (isPlainObject(member)) {
        const nested = processField([...path, key], member, hoist);
        if (nested !== undefined) rest[key] = nested;
      } else {
        rest[key] = member;
      }
    }
    return Object.keys(rest).length > 0 ? rest : undefined;
  };

  return processNode(expression as Record<string, unknown>);
}

/** True when any operator node in `expression` satisfies `predicate`. */
export function someOperator(
  expression: unknown,
  predicate: (operator: string) => boolean
): boolean {
  if (Array.isArray(expression)) return expression.some((e) => someOperator(e, predicate));
  if (!isPlainObject(expression)) return false;
  for (const [key, value] of Object.entries(expression)) {
    if (key.startsWith('_') && !LOGICAL.has(key) && predicate(key)) return true;
    if (someOperator(value, predicate)) return true;
  }
  return false;
}
