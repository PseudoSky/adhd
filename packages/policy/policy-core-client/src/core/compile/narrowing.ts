import type { ICompiledPermission } from '../../spec';
import { setOwn } from '../canonical/clone';
import { collectFieldPaths } from './expr-walk';

/**
 * D-11: tool -> attribute names for which a deny/guard exists. A tool is
 * child-creating iff some permission for it has an `args` filter reading
 * `child.*`; an attribute is covered when a `child.<attr>` path appears in
 * such a filter for that tool. Keys and lists are sorted (deterministic).
 */
export function computeNarrowingCoverage(
  permissions: readonly ICompiledPermission[]
): Readonly<Record<string, readonly string[]>> {
  const coverage = new Map<string, Set<string>>();
  for (const permission of permissions) {
    if (permission.args === undefined) continue;
    const childRefs = collectFieldPaths(permission.args, '').filter(
      (ref) => ref.segments[0] === 'child'
    );
    if (childRefs.length === 0) continue;
    for (const tool of permission.tools) {
      const attrs = coverage.get(tool) ?? new Set<string>();
      for (const ref of childRefs) if (ref.segments[1] !== undefined) attrs.add(ref.segments[1]);
      coverage.set(tool, attrs);
    }
  }
  const out: Record<string, readonly string[]> = {};
  for (const tool of [...coverage.keys()].sort()) {
    setOwn(out, tool, [...(coverage.get(tool) as Set<string>)].sort());
  }
  return out;
}
