/**
 * Shared directory walk for the wiring checkers (plan discovery-sweep-1014 blind-review D AC1).
 *
 * `fs.globSync` does NOT accept `ignore`: that option is silently dropped on Node 22 and 24, so an
 * `ignore: ['**\/node_modules/**']` list excludes nothing and the walker visits every installed
 * dependency. The option that works is `exclude`, a predicate over each directory entry.
 *
 * On the installed Node (24.11.1) the predicate receives a cwd-relative path string for each entry;
 * Node 22 (CI, ci.yml) may hand it a `Dirent` instead. {@link excludeEntry} accepts both, resolves
 * the entry against the scan root, and excludes it when ANY path segment of the scan-root-relative
 * path is an excluded directory name. Matching is on segments of the RELATIVE path, never the
 * absolute one, because the workspace itself can live under `.worktrees/`.
 */
import { globSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Directory names the wiring checkers never descend into. */
export const EXCLUDED_DIR_NAMES = Object.freeze(['node_modules', 'dist', '.worktrees', '.claude']);

const EXCLUDED = new Set(EXCLUDED_DIR_NAMES);

/**
 * Predicate for `fs.globSync({ exclude })`: true when the entry sits under an excluded directory.
 * @param {string} cwd Absolute scan root the glob is run from.
 * @returns {(entry: string | { name: string, parentPath?: string, path?: string }) => boolean}
 */
export function excludeEntry(cwd) {
  return (entry) => {
    if (entry === undefined || entry === null) return false;
    let abs;
    if (typeof entry === 'string') {
      abs = isAbsolute(entry) ? entry : join(cwd, entry);
    } else {
      abs = join(entry.parentPath ?? entry.path ?? cwd, entry.name);
    }
    const rel = relative(cwd, abs);
    return rel.split(sep).some((segment) => EXCLUDED.has(segment));
  };
}

/**
 * Glob `pattern` under `cwd`, never descending into {@link EXCLUDED_DIR_NAMES}.
 * @param {string} cwd Absolute scan root.
 * @param {string} pattern A glob relative to `cwd`.
 * @returns {string[]} Matched paths relative to `cwd`.
 */
export function globScan(cwd, pattern) {
  return globSync(pattern, { cwd, exclude: excludeEntry(cwd) });
}
