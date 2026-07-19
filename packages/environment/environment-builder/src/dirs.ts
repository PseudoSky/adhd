/**
 * `dirs.ts` — resolves `EnvironmentSpec.dirs`/`.files` to absolute paths
 * (ARCHITECTURE.md §3.1, §5).
 *
 * A directory's default multi-instance `Share` policy comes from its `kind`
 * (`DEFAULT_SHARE_BY_KIND`); a `per-instance` share suffixes the resolved
 * path with the environment's `instanceId` so two instances never collide.
 * `shared`/`singleton` resolve to the identical physical path across
 * instances — `singleton` differs only in that the *consumer* is expected
 * to serialize writers via `Environment#lock()`.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DirSpec, FileSpec, ResolvedDirEntry, ResolvedFileEntry, Scope } from '@adhd/environment-base-spec';
import { DEFAULT_SHARE_BY_KIND } from '@adhd/environment-base-spec';

import type { Roots } from './roots';
import { rootForScope } from './roots';

export interface ResolveDirsContext {
  roots: Roots;
  activeScope: Scope;
  instanceId: string;
  /** Used for `${PROJECT_ROOT}` interpolation in an explicit `DirSpec.path`. */
  projectRoot?: string;
  namespace: string;
}

function interpolateDirPath(path: string, ctx: ResolveDirsContext): string {
  return path
    .replace(/\$\{HOME\}/g, homedir())
    .replace(/\$HOME\b/g, homedir())
    .replace(/\$\{PROJECT_ROOT\}/g, ctx.projectRoot ?? process.cwd())
    .replace(/\$\{NAMESPACE\}/g, ctx.namespace);
}

/**
 * Resolves every declared `DirSpec` to an absolute, instance-aware path.
 * Directory-record keys map 1:1 onto the returned entries' `name` (and are
 * also the physical path segment under the scope root when no explicit
 * `path` override is given) — see `Environment#paths`.
 */
export function resolveDirs(
  dirs: Record<string, DirSpec> | undefined,
  ctx: ResolveDirsContext,
): Record<string, ResolvedDirEntry> {
  const result: Record<string, ResolvedDirEntry> = {};
  for (const [name, spec] of Object.entries(dirs ?? {})) {
    const scope = spec.scope ?? ctx.activeScope;
    const share = spec.share ?? DEFAULT_SHARE_BY_KIND[spec.kind];
    const base = spec.path ? interpolateDirPath(spec.path, ctx) : join(rootForScope(ctx.roots, scope), name);
    const path = share === 'per-instance' ? join(base, ctx.instanceId) : base;
    result[name] = { name, kind: spec.kind, path, scope, share };
  }
  return result;
}

/**
 * Resolves every declared `FileSpec` against its already-resolved parent
 * directory (`FileSpec.in`). Throws if `in` references an undeclared `dirs`
 * key — a spec authoring error, not a runtime/environment condition.
 */
export function resolveFiles(
  files: Record<string, FileSpec> | undefined,
  resolvedDirs: Record<string, ResolvedDirEntry>,
): Record<string, ResolvedFileEntry> {
  const result: Record<string, ResolvedFileEntry> = {};
  for (const [name, spec] of Object.entries(files ?? {})) {
    const dir = resolvedDirs[spec.in];
    if (!dir) {
      throw new Error(`files.${name}.in references unknown dirs key "${spec.in}"`);
    }
    result[name] = { name, in: spec.in, path: join(dir.path, spec.name), share: spec.share ?? 'shared' };
  }
  return result;
}
