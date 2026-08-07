/**
 * `roots.ts` — directory-root resolution (ARCHITECTURE.md §2.4).
 *
 *   - `project` → `<projectRoot>/.<orgNamespace>/<project>/<namespace>/…`
 *   - `global`  → `~/.<orgNamespace>/<project>/<namespace>/…`
 *   - `system`  → OS app dir/<orgNamespace>/<project>/<namespace>/…
 *
 * Everything nests under `<root>/.adhd/<project>/<namespace>/` — config
 * layer files included — so one consuming project's `.adhd/` holds an
 * isolated subtree per package.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Scope } from '@adhd/environment-base-spec';

export interface ResolveRootsContext {
  project: string;
  namespace: string;
  orgNamespace: string;
  /** The active scope's project root, when `scope === 'project'` (from `resolveScope`). */
  projectRoot?: string;
  /**
   * Overrides the base directory that would otherwise be
   * `os.homedir()/.{orgNamespace}` — used for BOTH the `global` and
   * `system` root bases (test-isolation escape hatch; ARCHITECTURE.md §3.1
   * `EnvironmentOptions.adhdRoot`). Production code should never need this —
   * `os.homedir()` (which itself honors `$HOME`) is the zero-config default.
   */
  adhdRoot?: string;
}

/** Every root, fully nested to `<base>/<project>/<namespace>`. `project` is
 *  `undefined` when no project root could be resolved (`global`/`system`
 *  active scope with no marker found). */
export interface Roots {
  system: string;
  global: string;
  project?: string;
}

/** The literal org directory segment used under a home/project root:
 *  `.adhd` by default. */
export function orgDirSegment(orgNamespace: string): string {
  return `.${orgNamespace}`;
}

/**
 * The OS application-support base directory for `orgNamespace` (no leading
 * dot — this is a "real" application directory, not a hidden dotfile,
 * matching platform convention).
 */
export function systemAppDir(orgNamespace: string): string {
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', orgNamespace);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return join(appData, orgNamespace);
  }
  const xdgDataHome = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  return join(xdgDataHome, orgNamespace);
}

/**
 * Resolves the three root directories (§2.4). `system`/`global` are always
 * populated; `project` only when `ctx.projectRoot` is supplied (i.e. the
 * active scope is `'project'` and a root was found/forced).
 */
export function resolveRoots(ctx: ResolveRootsContext): Roots {
  const org = ctx.orgNamespace;
  const globalBase = ctx.adhdRoot ?? join(homedir(), orgDirSegment(org));
  const systemBase = ctx.adhdRoot ?? systemAppDir(org);

  const roots: Roots = {
    system: join(systemBase, ctx.project, ctx.namespace),
    global: join(globalBase, ctx.project, ctx.namespace),
  };
  if (ctx.projectRoot) {
    roots.project = join(ctx.projectRoot, orgDirSegment(org), ctx.project, ctx.namespace);
  }
  return roots;
}

/**
 * Returns the root directory for a given `Scope`, falling back to `global`
 * when `scope === 'project'` but no project root was resolved — a `DirSpec`
 * or `FieldSpec` may legitimately declare `scope: 'project'` even when the
 * active environment has no project marker; zero-config degrades gracefully
 * rather than throwing.
 */
export function rootForScope(roots: Roots, scope: Scope): string {
  if (scope === 'project') return roots.project ?? roots.global;
  return roots[scope];
}
