import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Returns the `build.rollupOptions.external` array a `platform:node` /
 * `platform:shared` library's `vite.config.ts` should use: every REAL npm
 * dependency reachable from the package — its own `dependencies` +
 * `peerDependencies`, PLUS the same from every `@adhd/*` workspace package it
 * (transitively) depends on — plus every Node builtin. `@adhd/*` package
 * names themselves are never externalized.
 *
 * WHY `@adhd/*` packages stay bundled (not externalized): this monorepo's
 * root `package.json` has no `workspaces` field and `node_modules/@adhd/*`
 * has no symlinks to the in-repo packages — there is no yarn/npm workspace
 * linking at all. `@adhd/*` imports only resolve today via Nx's
 * `tsconfig.base.json` path mapping, which vite's `nxViteTsPaths()` plugin
 * follows straight to SOURCE at build time. An unbundled
 * `require('@adhd/x')` (e.g. from an `@nx/js:tsc` build, or from an
 * externalized vite build) has nothing to resolve against at runtime and
 * throws `Cannot find module '@adhd/x'` / `ERR_MODULE_NOT_FOUND` — verified
 * directly in this repo (devops-engineer session, 2026-07-20): switching
 * `apigen-core-client` to `@nx/js:tsc` made its own `require('@adhd/apigen-
 * base-logical')` fail exactly this way, and `agent-mcp`/`decompile-cli`/
 * `agent-engine-compiler`/`agent-engine-orchestrator` (already on
 * `@nx/js:tsc`, already depending on sibling `@adhd/*` packages at runtime,
 * not just types) fail identically today — see BACKLOG.md
 * `BUG-WORKSPACE-NO-LINKING-001`. Bundling `@adhd/*` source is the only
 * mechanism in this repo that currently makes cross-package runtime imports
 * work, so it must stay bundled even while everything else is externalized.
 *
 * WHY THIS MUST BE TRANSITIVE, not just the package's own package.json:
 * `@adhd/apigen-plugin-api-express` does not itself list `ts-morph` as a
 * dependency, but it imports `@adhd/apigen-core-client`, whose SOURCE (not
 * dist — see above) is bundled straight in, and that source imports
 * `ts-morph`/`typescript`. Externalizing only the express plugin's own
 * declared deps left `ts-morph` bundled anyway (confirmed: verify-dist-load
 * still failed with the same "__filename is not defined in ES module scope"
 * even after externalizing the plugin's own direct deps — the fix only took
 * effect once the walk below started following `@adhd/*` deps recursively).
 *
 * WHY real npm deps (ts-morph, typescript, express, pino, …) MUST be
 * externalized: `external: []` (the prior default in every apigen plugin's
 * `vite.config.ts`) bundled ts-morph/typescript SOURCE directly into each
 * package's own output. Rollup's CJS→ESM interop then emits `__filename` /
 * `__dirname` / `require('perf_hooks')` references that are invalid in the
 * resulting ESM chunk — the confirmed root cause of the "ReferenceError:
 * __filename is not defined in ES module scope" and "TypeError: Cannot read
 * properties of undefined (reading 'timeOrigin')" `verify-dist-load`
 * failures documented in BACKLOG.md `INVESTIGATION-BUILD-TOOL-001`. These are
 * already properly published, dual-format npm packages sitting in
 * `node_modules` — there is no reason to re-bundle them, and doing so is
 * exactly what breaks them.
 *
 * @param {string} packageJsonDir absolute directory containing the package's
 *   own `package.json` (pass `__dirname` from `vite.config.ts`).
 * @returns {(string|RegExp)[]} value for `build.rollupOptions.external`.
 */
export function externalizeRealDeps(packageJsonDir) {
  const repoRoot = findRepoRoot(packageJsonDir);
  const pathsMap = readTsPathsMap(repoRoot);

  const realDepNames = new Set();
  const visitedAdhdDirs = new Set();
  const queue = [packageJsonDir];

  while (queue.length > 0) {
    const dir = queue.shift();
    if (visitedAdhdDirs.has(dir)) continue;
    visitedAdhdDirs.add(dir);

    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const depNames = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);

    for (const name of depNames) {
      if (!name.startsWith('@adhd/')) {
        realDepNames.add(name);
        continue;
      }
      // @adhd/* dependency: bundle its source too, so walk into ITS deps.
      const depDir = resolveAdhdPackageDir(name, pathsMap, repoRoot);
      if (depDir && !visitedAdhdDirs.has(depDir)) {
        queue.push(depDir);
      }
    }
  }

  const externals = [];
  for (const name of realDepNames) {
    externals.push(name);
    // Also externalize the package's own subpath imports (e.g. `ts-morph/foo`).
    externals.push(new RegExp(`^${escapeRegExp(name)}/`));
  }
  externals.push(/^node:/, ...builtinModules);
  return externals;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Walk up from `startDir` until a `tsconfig.base.json` is found. */
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'tsconfig.base.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `externalizeRealDeps: could not find tsconfig.base.json walking up from ${startDir}`
  );
}

/** `{ "@adhd/x": "./packages/.../src/index.ts", ... }` from tsconfig.base.json paths. */
function readTsPathsMap(repoRoot) {
  const tsconfig = JSON.parse(
    readFileSync(join(repoRoot, 'tsconfig.base.json'), 'utf-8')
  );
  return tsconfig.compilerOptions?.paths ?? {};
}

/** Resolve an `@adhd/x` package name to its absolute package directory (containing package.json). */
function resolveAdhdPackageDir(name, pathsMap, repoRoot) {
  const targets = pathsMap[name];
  if (!targets || targets.length === 0) return null;
  // e.g. "./packages/apigen/apigen-core-client/src/index.ts" -> package dir
  const srcIndexPath = targets[0].replace(/^\.\//, '');
  const packageRelDir = srcIndexPath.replace(/\/src\/index\.tsx?$/, '');
  const dir = join(repoRoot, packageRelDir);
  return existsSync(join(dir, 'package.json')) ? dir : null;
}
