import { builtinModules } from 'node:module';
import { computeRealDependencyNames } from '../nx-plugins/deps/compute-real-deps.js';

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
  // The dependency-graph walk itself lives in `compute-real-deps.js` (plain
  // CommonJS) — it's shared verbatim with each bundling package's
  // `.eslintrc.cjs`, which auto-derives `@nx/dependency-checks`'
  // `ignoredDependencies` from the SAME real-dep set this function
  // externalizes. See that file's doc comment for why both consumers need
  // the identical walk. This function's own behavior is unchanged: only the
  // walk was extracted, not altered.
  const realDepNames = computeRealDependencyNames(packageJsonDir);

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
