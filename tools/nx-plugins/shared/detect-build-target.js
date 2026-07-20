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

module.exports = { hasBuildTarget };
