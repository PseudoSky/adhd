'use strict';
const { existsSync, readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

/**
 * Walks a package's dependency graph and returns the plain `Set<string>` of
 * REAL (non-`@adhd/*`) npm package names it reaches at runtime — every real
 * npm dependency declared by the package itself, PLUS the same transitively
 * through every `@adhd/*` workspace package it depends on (because `@adhd/*`
 * source gets BUNDLED, not installed — see the doc comment on
 * `tools/vite-plugins/externalize.mjs`'s `externalizeRealDeps`, which is the
 * other consumer of this exact walk).
 *
 * Single source of truth for "what real npm deps does this bundle actually
 * need at runtime", consumed by BOTH:
 *   - `externalize.mjs`'s `externalizeRealDeps` — builds vite's
 *     `rollupOptions.external` from it (adds regex subpath patterns + Node
 *     builtins on top of the plain names returned here).
 *   - each bundling entrypoint/plugin's `.eslintrc.cjs` — auto-derives
 *     `@nx/dependency-checks`' `ignoredDependencies` from it (see
 *     `entrypoint/backlog/.eslintrc.cjs`'s doc comment for why: `@nx/
 *     dependency-checks` only sees a project's OWN literal `import`/
 *     `require` statements, never what's reachable through bundled `@adhd/*`
 *     source, so any real npm dep used only THAT way — `pino`/`pino-pretty`
 *     via a worker-thread transport resolved by string, `ts-morph` via a
 *     bundled `@adhd/apigen-core-client`, etc — is permanently invisible to
 *     it and gets flagged/stripped as "obsolete" no matter what the source
 *     does, UNLESS something tells the rule to leave it alone).
 *
 * Kept in CommonJS (not `.mjs`) so a legacy `.eslintrc.cjs` can `require()`
 * it directly and synchronously — ESLint's legacy config loader cannot
 * `import()` an ESM module. `externalize.mjs` (ESM) imports this file with a
 * plain `import`, which Node always supports for a CJS target.
 *
 * @param {string} packageJsonDir absolute directory containing the target
 *   package's own `package.json`.
 * @returns {Set<string>} real npm package names reachable from it.
 */
function computeRealDependencyNames(packageJsonDir) {
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
      // @adhd/* dependency: bundle its source too, so walk into ITS deps —
      // UNLESS the name doesn't resolve against tsconfig.base.json's `paths`
      // map at all, which means it isn't actually an in-repo workspace
      // package (e.g. `@adhd/sox-graph-store`, a real, externally-published
      // npm package that happens to share the `@adhd/` scope). Treat an
      // unresolvable `@adhd/*` name as a real external dependency.
      const depDir = resolveAdhdPackageDir(name, pathsMap, repoRoot);
      if (depDir) {
        if (!visitedAdhdDirs.has(depDir)) queue.push(depDir);
      } else {
        realDepNames.add(name);
      }
    }
  }

  return realDepNames;
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
    `computeRealDependencyNames: could not find tsconfig.base.json walking up from ${startDir}`
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

module.exports = { computeRealDependencyNames, findRepoRoot };
