import type { FilterExpression } from '../../spec';
import { someOperator } from './walk';

/**
 * Path normalisation (D-13): collapses `.`, `..` and duplicate slashes
 * lexically with posix semantics; no filesystem access. A trailing slash is
 * dropped except for root. A relative `p` is resolved against `cwd` when `cwd`
 * is an absolute path; otherwise it is normalised as given.
 */
export function normalizePath(p: string, cwd?: string): string {
  const absoluteCwd = typeof cwd === 'string' && cwd.startsWith('/');
  const joined = !p.startsWith('/') && absoluteCwd ? `${cwd}/${p}` : p;
  const absolute = joined.startsWith('/');
  const segments: string[] = [];
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else if (!absolute) segments.push('..');
      continue;
    }
    segments.push(segment);
  }
  if (absolute) return '/' + segments.join('/');
  return segments.length > 0 ? segments.join('/') : '.';
}

/** True when the expression (recursively) contains `_within`. */
export function containsWithin(expression: FilterExpression | undefined): boolean {
  return expression !== undefined && someOperator(expression, (op) => op === '_within');
}

/**
 * `_within` (FX-06, D-13): the row value (a path, or a list of paths) lies
 * inside one of `roots`. `roots` must be a list; an empty or non-list `roots`
 * is false for any path. An empty list of paths is vacuously within. Paths
 * compare lexically after {@link normalizePath} (no filesystem access).
 */
export function isWithinRoots(value: unknown, roots: unknown, cwd?: string): boolean {
  const normalisedRoots = Array.isArray(roots)
    ? roots.filter((r): r is string => typeof r === 'string').map((r) => normalizePath(r))
    : [];
  const inside = (candidate: unknown): boolean => {
    if (typeof candidate !== 'string' || candidate === '') return false;
    const p = normalizePath(candidate, cwd);
    return normalisedRoots.some(
      (root) => p === root || p.startsWith(root === '/' ? '/' : root + '/')
    );
  };
  if (Array.isArray(value)) return value.every(inside);
  return inside(value);
}
