'use strict';
/** createNodes: attach @adhd/nx-deps executor-backed targets to every buildable project. No project.json edits. */
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { hasBuildTarget } = require('../build/detect-target');
const { isScratchPath } = require('../lib/scratch-root');
const { declaredExternalDeps } = require('../lib/declared-external-deps');
function skip(p) { return p === '.' || p.startsWith('node_modules/') || p.includes('/node_modules/') || p.startsWith('dist/') || p.includes('/dist/') || isScratchPath(p); }
// Shared cache inputs for both targets (BUILD-TOOLING-METRICS-001 profiling
// found sync-deps UNCACHED — 1566 calls, 66% of all
// build-tooling-plugin wall-time, almost all of them no-op re-runs against
// unchanged inputs). `default` (not `production` — `production` deliberately
// EXCLUDES `{projectRoot}/eslint.config.mjs`, whose `ignoredDependencies`/etc.
// affect this check's outcome) covers the project's OWN source + package.json
// + eslint config; `^production` covers every internal dependency's package.json
// (the only thing about a dependency this check reads is its declared name +
// version, both in `production`) so a dependency bumping its OWN version (or
// changing its own deps) still invalidates. The shared base eslint config
// and the guarded wrapper script are both real correctness-affecting inputs.
// fbbb1464: `externalDependencies` REPLACES Nx's default hashing of installed
// external versions, so the project's own declared npm deps are listed here
// too; without them a bump of a declared-but-not-imported dep misses this
// cache entry, and the check reports a stale verdict from a warm cache.
/**
 * Cache inputs of `sync-deps` for one project.
 * Per-project because the declared external dependency set is per-project
 * (fbbb1464); the rest of the list is identical for every project.
 *
 * @param {string} projectRoot Workspace-relative project directory, as Nx's `createNodes` hands it.
 * @param {string} workspaceRoot Absolute workspace root (`ctx.workspaceRoot`).
 * @returns {Array<string | { externalDependencies: string[] }>} Nx target `inputs`.
 */
function syncDepsInputs(projectRoot, workspaceRoot) {
  return [
    'default',
    '^production',
    '{workspaceRoot}/eslint.base.config.mjs',
    '{workspaceRoot}/tools/nx-plugins/deps/eslint-check.mjs',
    { externalDependencies: ['eslint', ...declaredExternalDeps(projectRoot, workspaceRoot)] },
  ];
}
// Nx 23 unified on the v2 plugin API: createNodes[1] receives the ARRAY of
// matched config files and returns [configFile, result] tuples.
exports.createNodes = ['**/package.json', (configFiles, _o, ctx) =>
  configFiles.map((pkgPath) => {
  const projectRoot = dirname(pkgPath);
  if (skip(projectRoot)) return [pkgPath, {}];
  if (!existsSync(join(ctx.workspaceRoot, projectRoot, 'project.json'))) return [pkgPath, {}];
  if (!hasBuildTarget(ctx.workspaceRoot, projectRoot)) return [pkgPath, {}];
  // One read of the project's package.json per project, shared by both targets.
  const inputs = syncDepsInputs(projectRoot, ctx.workspaceRoot);
  return [pkgPath, {
    projects: {
      [projectRoot]: {
        targets: {
          // `sync-deps` (--fix) MUTATES this project's own package.json.
          // Declaring `outputs` lets Nx's cache restore the exact fixed
          // bytes on a hit (not just replay the recorded exit code) — the
          // correct way to cache a file-mutating target, rather than
          // leaving it uncached the way `version`/`reconcile` are (those
          // read live registry state with no stable cache key; this reads
          // only workspace-local inputs, which DO hash stably).
          'sync-deps': {
            executor: '@adhd/nx-deps:sync',
            cache: true,
            outputs: ['{projectRoot}/package.json'],
            inputs,
          },
        },
      },
    },
  }];
  }),
];
