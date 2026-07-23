'use strict';
/**
 * @adhd/nx-build:reconcile — per-project TASK that (re)builds this package's
 * entry in the committed `published-state.json` cache from npm
 * (PUBLISHED-STATE-CACHE-001, Deliverable 4).
 *
 * This is the ONLY task that may pull a full published tarball, and only for
 * packages whose local dist has actually diverged from what's published (see
 * `reconcile-core.js`'s integrity gate). Run it:
 *
 *   - across the whole workspace to populate/refresh the cache from scratch
 *     (`npx nx run-many -t reconcile`), or
 *   - for one package directly (`npx nx run <project>:reconcile`).
 *
 * `version` also calls `reconcile-core.js`'s `reconcilePackage` directly
 * (in-process, no nx sub-invocation) as its own single-package fallback on a
 * cache MISS — this executor and that fallback share the exact same core
 * logic, never a duplicated reimplementation.
 *
 * `dependsOn: ["build", "assets"]` (wired in plugin.js) — needs a fresh,
 * doc-complete dist to pack for the integrity-gate comparison. `cache:false`:
 * this is a network task with no stable, cacheable input (the registry's
 * live state is exactly what it's reading).
 */
const { existsSync, readFileSync, rmSync } = require('node:fs');
const { join, relative } = require('node:path');
const { reconcilePackage } = require('./reconcile-core');
const { updatePublishedState } = require('../../lib/published-state');

async function run(_options, context) {
  const projectRoot = context.projectsConfigurations.projects[context.projectName].root;
  const pkgRoot = join(context.root, projectRoot);
  const distDir = join(pkgRoot, 'dist');
  const srcPkgPath = join(pkgRoot, 'package.json');

  if (!existsSync(srcPkgPath)) {
    console.error(`reconcile: no source package.json at ${relative(context.root, srcPkgPath)}.`);
    return { success: false };
  }
  const { name, version } = JSON.parse(readFileSync(srcPkgPath, 'utf8'));
  if (!name || !version) {
    console.error(`reconcile: ${relative(context.root, srcPkgPath)} missing name/version.`);
    return { success: false };
  }
  if (!existsSync(distDir)) {
    console.error(`reconcile: no built dist at ${relative(context.root, distDir)} — this target dependsOn build.`);
    return { success: false };
  }

  const workDir = join(context.root, 'tmp', 'nx-build-reconcile', context.projectName);
  try {
    const result = reconcilePackage({ name, version, distDir, workDir });

    if (result.status === 'pending') {
      console.error(`reconcile: ${name}@${version} not yet on npm — no cache entry (release pending).`);
      return { success: true };
    }
    if (result.status === 'error') {
      console.error(`reconcile: FAILED for ${name}@${version}: ${result.error}`);
      return { success: false };
    }

    await updatePublishedState(context.root, (state) => {
      state[name] = result.entry;
      return state;
    });
    console.error(
      `reconcile: ${name}@${version} -> published-state.json ` +
        (result.status === 'fast' ? '[integrity match — no tarball pull]' : '[content diverged — tarball pulled]')
    );
    return { success: true };
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // best-effort scratch cleanup
    }
  }
}

module.exports = run;
module.exports.default = run;
// Test-only introspection seam, mirroring version/impl.js's __internals.
module.exports.__internals = { reconcilePackage };
