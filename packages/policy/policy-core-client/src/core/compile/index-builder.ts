import type { ICompiledPermission, ICompiledPolicy } from '../../spec';
import { setOwn } from '../canonical/clone';

const compareStrings = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/**
 * Builds the lookup index. `exact`: tool name -> permission indexes
 * (ascending). `patterns`: trailing-wildcard `prefix*` entries, sorted by
 * prefix length descending then lexicographically (deterministic).
 */
export function buildIndex(permissions: readonly ICompiledPermission[]): ICompiledPolicy['index'] {
  const exact = new Map<string, number[]>();
  const patterns = new Map<string, number[]>();
  permissions.forEach((permission, index) => {
    for (const tool of permission.tools) {
      const target = tool.endsWith('*') ? patterns : exact;
      const key = tool.endsWith('*') ? tool.slice(0, -1) : tool;
      const list = target.get(key) ?? [];
      if (!list.includes(index)) list.push(index);
      target.set(key, list);
    }
  });
  const exactOut: Record<string, readonly number[]> = {};
  for (const key of [...exact.keys()].sort()) setOwn(exactOut, key, exact.get(key));
  const patternsOut = [...patterns.entries()]
    .sort((a, b) => b[0].length - a[0].length || compareStrings(a[0], b[0]))
    .map(([prefix, rules]) => ({ prefix, rules }));
  return { exact: exactOut, patterns: patternsOut };
}

/**
 * Returns the permission indexes whose tools match `tool` (exact, then
 * patterns), ascending and deduplicated.
 */
export function selectIndexes(index: ICompiledPolicy['index'], tool: string): readonly number[] {
  const found = new Set<number>();
  const exact = Object.prototype.hasOwnProperty.call(index.exact, tool) ? index.exact[tool] : undefined;
  for (const i of exact ?? []) found.add(i);
  for (const pattern of index.patterns) {
    if (tool.startsWith(pattern.prefix)) for (const i of pattern.rules) found.add(i);
  }
  return [...found].sort((a, b) => a - b);
}
