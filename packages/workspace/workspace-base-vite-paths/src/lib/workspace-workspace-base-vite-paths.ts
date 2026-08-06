import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Walks upward from `fromDir` via `path.dirname` until it finds a directory
 * containing `nx.json` — the Nx workspace root marker.
 *
 * Pure, synchronous, `node:fs` + `node:path` only — deliberately has **no**
 * `@nx/devkit` import. This must be callable from a running `vite.config.ts`,
 * which Vite evaluates directly under Node at build/test time, entirely
 * outside of any nx-devkit `Tree`/generator context — an `@nx/devkit` import
 * there would either fail to resolve or pull in generator-only machinery
 * that has no business running inside a build config.
 *
 * @param fromDir - absolute directory to start the upward search from. Pass
 *   `__dirname` from the calling `vite.config.ts` — that is the ONE
 *   supported call site/contract for every exported helper in this module.
 * @returns the absolute path to the workspace root (the first ancestor
 *   directory — inclusive of `fromDir` itself — containing an `nx.json`).
 * @throws {Error} if the filesystem root is reached without finding an
 *   `nx.json` anywhere in the ancestor chain.
 */
export function findWorkspaceRoot(fromDir: string): string {
  let dir = path.resolve(fromDir);

  for (;;) {
    if (fs.existsSync(path.join(dir, 'nx.json'))) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `findWorkspaceRoot: reached the filesystem root ("${dir}") without finding an "nx.json" ` +
          `while walking up from "${fromDir}". Is this being called from a vite.config.ts inside an Nx workspace?`
      );
    }
    dir = parent;
  }
}

/**
 * Computes the vite `cacheDir` for the package at `fromDir`:
 * `<workspaceRoot>/node_modules/.vite/<path-of-fromDir-relative-to-workspaceRoot>`.
 *
 * Because the relative segment is *derived* from `fromDir` rather than
 * hand-authored as a literal in `vite.config.ts`, moving the package
 * (`git mv packages/<old> packages/<new>`) keeps the cache path correct with
 * zero edits to `vite.config.ts` — the next `vite`/`vitest` invocation
 * re-derives it against the new location automatically.
 *
 * @param fromDir - pass `__dirname` from the calling `vite.config.ts`.
 */
export function projectCacheDir(fromDir: string): string {
  const root = findWorkspaceRoot(fromDir);
  return path.join(root, 'node_modules/.vite', path.relative(root, fromDir));
}

/**
 * Computes the vitest coverage `reportsDirectory` for the package at
 * `fromDir`: `<workspaceRoot>/coverage/<path-of-fromDir-relative-to-workspaceRoot>`.
 *
 * Same move-safety rationale as {@link projectCacheDir}.
 *
 * @param fromDir - pass `__dirname` from the calling `vite.config.ts`.
 */
export function projectCoverage(fromDir: string): string {
  const root = findWorkspaceRoot(fromDir);
  return path.join(root, 'coverage', path.relative(root, fromDir));
}

/**
 * Computes the build `outDir` for the package at `fromDir`: `<fromDir>/dist`.
 *
 * `outDir` is already package-relative (not workspace-root-relative like
 * `cacheDir`/`reportsDirectory`), so it was already move-safe before this
 * package existed (2026-08-05 triage note in DEBT-WORKSPACE-VITE-PATHS-001).
 * Exported here purely for API completeness/consistency with the other
 * three path helpers — using it is not itself a behavior change.
 *
 * @param fromDir - pass `__dirname` from the calling `vite.config.ts`.
 */
export function projectDist(fromDir: string): string {
  return path.join(fromDir, 'dist');
}

/**
 * Computes the workspace-root `node_modules` directory for the package at
 * `fromDir`.
 *
 * @param fromDir - pass `__dirname` from the calling `vite.config.ts`.
 */
export function workspaceNodeModules(fromDir: string): string {
  return path.join(findWorkspaceRoot(fromDir), 'node_modules');
}
