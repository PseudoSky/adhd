'use strict';

/**
 * Local Nx plugin: infers a `verify-dist-load` target for every buildable
 * project in the workspace.
 *
 * WHY THIS EXISTS (devops-engineer session, see BACKLOG): `nx build` and
 * `nx test` passing is not proof a published package actually works.
 * Verified in this repo: `apigen-plugin-api-express` builds clean and
 * tests 25/25 green, but its BUILT dist artifacts (both `index.js` CJS and
 * `index.mjs` ESM) throw on load — `require()`/`import()` both crash with
 * `TypeError: Cannot read properties of undefined (reading 'map')` (a Node
 * builtin got wrongly bundled as a `__vite-browser-external` stub by the
 * Rollup production build). `nx test` never exercises this because Vite/
 * Vitest resolves everything straight to source in dev/test mode — the
 * only thing that ever actually loads the PRODUCTION bundle is a real
 * consumer's `require`/`import`, which nothing in this repo did before now.
 *
 * `verify-dist-load` closes that gap: `dependsOn: ["build"]`, then loads
 * every entry point the project's built package.json declares
 * (`main`/`module`/`exports`) exactly the way a real consumer would, and
 * fails (non-zero exit) if any of them throw. See scripts/verify-dist-
 * load.mjs for the actual load logic and its exit-code contract.
 *
 * Target name is exactly `verify-dist-load` — the nx-release publish
 * config (owned separately, see PUBLISHING.md / each project.json's
 * `nx-release-publish.dependsOn`) references it by that literal name as a
 * publish-gating dependency; this plugin is what makes that target exist.
 */

const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { hasBuildTarget } = require('../shared/detect-build-target');

const TARGET_NAME = 'verify-dist-load';

/**
 * @type {[string, (configFilePath: string, options: unknown, context: { workspaceRoot: string }) => { projects?: Record<string, unknown> }]}
 */
exports.createNodes = [
  '**/package.json',
  (packageJsonPath, _options, context) => {
    const projectRoot = dirname(packageJsonPath);

    if (
      projectRoot === '.' ||
      projectRoot.startsWith('node_modules/') ||
      projectRoot.includes('/node_modules/') ||
      projectRoot.startsWith('dist/') ||
      projectRoot.includes('/dist/') ||
      projectRoot.startsWith('tmp/') ||
      projectRoot.includes('/tmp/')
    ) {
      return {};
    }

    const projectJsonPath = join(
      context.workspaceRoot,
      projectRoot,
      'project.json'
    );
    if (!existsSync(projectJsonPath)) {
      return {};
    }

    // `build` is often INFERRED (e.g. via @nx/vite/plugin from
    // vite.config.ts), not declared in project.json — see
    // shared/detect-build-target.js for why this can't just read
    // project.json's own `targets.build`.
    if (!hasBuildTarget(context.workspaceRoot, projectRoot)) {
      return {};
    }

    return {
      projects: {
        [projectRoot]: {
          targets: {
            [TARGET_NAME]: {
              executor: 'nx:run-commands',
              dependsOn: ['build'],
              options: {
                // Relative, not `{workspaceRoot}/...` — see the
                // dependency-sync plugin's comment: the token is only
                // valid at the START of an option value, and `cwd` here
                // already IS `{workspaceRoot}`, so the command can stay
                // relative to it.
                cwd: '{workspaceRoot}',
                command: `node ./scripts/verify-dist-load.mjs ${projectRoot}`,
              },
              // Deterministic given dist/ content: cacheable. `dependsOn:
              // ["build"]` already makes dist/ a real input via nx's task
              // graph; explicitly listing it too keeps the cache correct
              // even if this target is ever invoked without going through
              // the dependsOn chain (e.g. a direct `nx run <p>:verify-
              // dist-load` after a manual build).
              cache: true,
              inputs: [
                `{workspaceRoot}/dist/${projectRoot}/**/*`,
                `{workspaceRoot}/${projectRoot}/package.json`,
                '{workspaceRoot}/scripts/verify-dist-load.mjs',
                '{workspaceRoot}/tools/nx-plugins/verify-dist-load/plugin.js',
              ],
              metadata: {
                description: `Load ${projectRoot}'s built dist/ entry point(s) (require()/import()) the way a real consumer would, and fail if any throw.`,
                technologies: ['node'],
              },
            },
          },
        },
      },
    };
  },
];
