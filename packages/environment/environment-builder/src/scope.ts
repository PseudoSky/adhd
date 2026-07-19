/**
 * `scope.ts` — active-scope resolution (ARCHITECTURE.md §2.3).
 *
 * Scope resolution, first match wins:
 *   1. explicit `options.scope`
 *   2. `ADHD_ENV_SCOPE` env var
 *   3. auto: a project marker (`.git` / `.adhd` / `adhd.environment.yaml`)
 *      found at/above `cwd` → `project`; otherwise → `global`.
 *
 * Pure except for the marker filesystem probe in `findProjectRoot`.
 */

import { existsSync } from 'node:fs';
import { dirname, parse, resolve } from 'node:path';
import type { Scope } from '@adhd/environment-base-spec';

/** Filenames/dirnames that mark a directory as a project root (ARCHITECTURE.md §2.3). */
export const PROJECT_MARKERS: readonly string[] = ['.git', '.adhd', 'adhd.environment.yaml'];

/**
 * Walks upward from `startDir` looking for any `PROJECT_MARKERS` entry.
 * Returns the first (deepest/closest) matching directory, or `undefined`
 * if none is found before reaching the filesystem root.
 */
export function findProjectRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  const { root } = parse(dir);

  // Bounded by the filesystem root — never infinite, matches real tool
  // behavior (git, Claude Code) of walking to the fs root.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(`${dir}/${marker}`)) return dir;
    }
    if (dir === root) return undefined;
    const parentDir = dirname(dir);
    if (parentDir === dir) return undefined;
    dir = parentDir;
  }
}

export interface ResolveScopeOptions {
  /** Explicit scope override (step 1). */
  scope?: Scope;
  /** Working directory used for marker auto-detection. Defaults to `process.cwd()`. */
  cwd?: string;
}

export interface ResolvedScope {
  scope: Scope;
  /** The discovered (or forced-fallback) project root — only ever set when `scope === 'project'`. */
  projectRoot?: string;
}

const VALID_SCOPES: ReadonlySet<string> = new Set(['system', 'global', 'project']);

/**
 * Resolves the active `Scope` per ARCHITECTURE.md §2.3. When the resolved
 * scope is `'project'`, also resolves the project root: the nearest marker
 * directory at/above `cwd`, or `cwd` itself when the scope was forced to
 * `'project'` (explicitly or via `ADHD_ENV_SCOPE`) but no marker was found.
 */
export function resolveScope(
  options: ResolveScopeOptions,
  processEnv: Record<string, string | undefined>,
): ResolvedScope {
  const cwd = options.cwd ?? process.cwd();

  if (options.scope) {
    return options.scope === 'project'
      ? { scope: 'project', projectRoot: findProjectRoot(cwd) ?? cwd }
      : { scope: options.scope };
  }

  const envScope = processEnv.ADHD_ENV_SCOPE;
  if (envScope !== undefined && VALID_SCOPES.has(envScope)) {
    const scope = envScope as Scope;
    return scope === 'project' ? { scope: 'project', projectRoot: findProjectRoot(cwd) ?? cwd } : { scope };
  }

  const autoProjectRoot = findProjectRoot(cwd);
  return autoProjectRoot ? { scope: 'project', projectRoot: autoProjectRoot } : { scope: 'global' };
}
