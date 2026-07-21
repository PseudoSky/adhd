'use strict';

/**
 * Shared by tools/nx-plugins/dependency-sync/plugin.js and
 * tools/nx-plugins/verify-dist-load/plugin.js.
 *
 * A project's `build` target is often NOT declared explicitly in its own
 * project.json — `@nx/vite/plugin` (registered in nx.json `plugins`, this
 * repo's config: `{ buildTargetName: "build" }`) INFERS one purely from a
 * `vite.config.{js,ts,mjs,mts}` sitting next to the project root. Reading
 * only project.json's own `targets.build` misses every such project (e.g.
 * `ui-react-base-storybook`, which has zero explicit targets besides
 * `test` yet nx's fully-resolved graph gives it a real `build` via
 * `vite.config.ts`). Since a local `createNodes` plugin can't see what
 * OTHER plugins will infer for the same project, this mirrors
 * `@nx/vite/plugin`'s own detection heuristic (vite config presence) so
 * coverage matches the real, fully-resolved project graph.
 */

const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const VITE_CONFIG_NAMES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.mts',
];

/**
 * @param {string} workspaceRoot
 * @param {string} projectRoot
 * @returns {boolean}
 */
function hasBuildTarget(workspaceRoot, projectRoot) {
  const projectJsonPath = join(workspaceRoot, projectRoot, 'project.json');
  if (existsSync(projectJsonPath)) {
    try {
      const projectJson = JSON.parse(readFileSync(projectJsonPath, 'utf-8'));
      if (projectJson.targets && projectJson.targets.build) {
        return true;
      }
    } catch {
      // fall through to the vite-config heuristic below
    }
  }
  return VITE_CONFIG_NAMES.some((name) =>
    existsSync(join(workspaceRoot, projectRoot, name))
  );
}

/**
 * A package is publishable unless its package.json declares `"private": true`.
 * The publish-related build targets (verify-dist-load, publish-hygiene,
 * publish) exist to prove/ship a PUBLISHED artifact, so they must not attach
 * to private packages (e.g. `ui-react-base-storybook`, the CLI-only
 * `environment-cli`) — those have no npm entry to verify or publish.
 * @param {string} workspaceRoot
 * @param {string} projectRoot
 * @returns {boolean}
 */
function isPublishable(workspaceRoot, projectRoot) {
  const pkgPath = join(workspaceRoot, projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).private !== true;
  } catch {
    return false;
  }
}

module.exports = { hasBuildTarget, isPublishable };
