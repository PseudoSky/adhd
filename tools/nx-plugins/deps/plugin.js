'use strict';
/** createNodes: attach @adhd/nx-deps executor-backed targets to every buildable project. No project.json edits. */
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { hasBuildTarget } = require('../build/detect-target');
function skip(p) { return p === '.' || p.startsWith('node_modules/') || p.includes('/node_modules/') || p.startsWith('dist/') || p.includes('/dist/') || p.startsWith('tmp/') || p.includes('/tmp/'); }
// Shared cache inputs for both targets (BUILD-TOOLING-METRICS-001 profiling
// found sync-deps/sync-deps-check UNCACHED — 1566 calls, 66% of all
// build-tooling-plugin wall-time, almost all of them no-op re-runs against
// unchanged inputs). `default` (not `production` — `production` deliberately
// EXCLUDES `{projectRoot}/.eslintrc.json`, whose `ignoredDependencies`/etc.
// affect this check's outcome) covers the project's OWN source + package.json
// + eslintrc; `^production` covers every internal dependency's package.json
// (the only thing about a dependency this check reads is its declared name +
// version, both in `production`) so a dependency bumping its OWN version (or
// changing its own deps) still invalidates. The shared base eslintrc config
// and the guarded wrapper script are both real correctness-affecting inputs.
const SYNC_DEPS_INPUTS = [
  'default',
  '^production',
  '{workspaceRoot}/.eslintrc.base.json',
  '{workspaceRoot}/tools/nx-plugins/deps/eslint-check.mjs',
  { externalDependencies: ['eslint'] },
];
exports.createNodes = ['**/package.json', (pkgPath, _o, ctx) => {
  const projectRoot = dirname(pkgPath);
  if (skip(projectRoot)) return {};
  if (!existsSync(join(ctx.workspaceRoot, projectRoot, 'project.json'))) return {};
  if (!hasBuildTarget(ctx.workspaceRoot, projectRoot)) return {};
  return {
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
            inputs: SYNC_DEPS_INPUTS,
          },
          'sync-deps-check': {
            executor: '@adhd/nx-deps:check',
            cache: true,
            inputs: SYNC_DEPS_INPUTS,
          },
        },
      },
    },
  };
}];
