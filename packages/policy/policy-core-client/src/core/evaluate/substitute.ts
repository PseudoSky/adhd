import type { Attributes, FilterExpression } from '../../spec';
import { deepClone } from '../canonical/clone';
import { ABSENT } from '../engine/absent';
import { ATTRIBUTE_PLACEHOLDER } from '../compile/expr-walk';

/**
 * Replaces every string leaf exactly equal to `$attributes.<name>` with the
 * attribute value (lists are copied), or ABSENT when the attribute is not in
 * `attributes`. Pure; the input is untouched. `absent` lists the names that
 * were missing (for explain).
 */
export function substitute(
  expression: FilterExpression,
  attributes: Attributes
): { expression: FilterExpression; absent: readonly string[] } {
  const absent: string[] = [];
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const hit = ATTRIBUTE_PLACEHOLDER.exec(node);
      if (hit === null) return node;
      const name = hit[1];
      if (Object.prototype.hasOwnProperty.call(attributes, name)) return deepClone(attributes[name]);
      if (!absent.includes(name)) absent.push(name);
      return ABSENT;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, member] of Object.entries(node as Record<string, unknown>)) {
        Object.defineProperty(out, key, {
          value: walk(member),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return node;
  };
  return { expression: walk(expression) as FilterExpression, absent };
}
