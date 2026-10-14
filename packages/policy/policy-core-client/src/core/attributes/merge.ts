import type { AttributeKind, AttributeValue } from '../../spec';
import { normalizePath } from '../engine/within';
import { valueMatchesKind } from './kinds';

/**
 * Union per MG-04: `names`/`paths` -> set union preserving first-seen order,
 * deduplicated; `number` -> the larger value; `name` -> the second argument
 * replaces the first. A value of the wrong shape for `kind` yields `b`.
 */
export function unionValues(kind: AttributeKind, a: AttributeValue, b: AttributeValue): AttributeValue {
  if (!valueMatchesKind(kind, a) || !valueMatchesKind(kind, b)) return b;
  if (kind === 'names' || kind === 'paths') {
    const out: string[] = [];
    for (const item of [...(a as readonly string[]), ...(b as readonly string[])]) {
      if (!out.includes(item)) out.push(item);
    }
    return out;
  }
  if (kind === 'number') return Math.max(a as number, b as number);
  return b;
}

/**
 * True when `child` lies within `parent` for that kind (NR-03): `paths` ->
 * every child path is inside some parent path after `normalizePath` (equal
 * counts as inside; an empty child list is inside); `names` -> child is a
 * subset of parent; `number` -> child <= parent; `name` -> equal. A kind
 * mismatch or wrong value type is false.
 */
export function isWithin(kind: AttributeKind, child: AttributeValue, parent: AttributeValue): boolean {
  if (!valueMatchesKind(kind, child) || !valueMatchesKind(kind, parent)) return false;
  switch (kind) {
    case 'paths': {
      const roots = (parent as readonly string[]).map((p) => normalizePath(p));
      return (child as readonly string[]).every((c) => {
        const path = normalizePath(c);
        return roots.some((root) => path === root || path.startsWith(root === '/' ? '/' : `${root}/`));
      });
    }
    case 'names':
      return (child as readonly string[]).every((c) => (parent as readonly string[]).includes(c));
    case 'number':
      return (child as number) <= (parent as number);
    case 'name':
      return child === parent;
    default:
      return false;
  }
}
