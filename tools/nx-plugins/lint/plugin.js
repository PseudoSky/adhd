'use strict';
/**
 * createNodes: attach a standard nx `lint` target (nx's own `@nx/eslint:lint`
 * executor) to every project that has an `.eslintrc.json`. No project.json edits.
 *
 * WHY THIS REPLACES `@nx/eslint/plugin`
 * The stock `@nx/eslint/plugin` infers a lint target whose command is hardcoded
 * to `eslint .` run with `cwd = projectRoot` (see @nx/eslint/src/plugins/plugin.js —
 * `command: 'eslint .'`, `cwd: projectRoot`; there is no option to change it).
 * That model breaks under pnpm: pnpm links workspace deps as real symlinks inside
 * each project's own `node_modules/@adhd/*`. `eslint .` enumerates them, follows the
 * symlink to the sibling package's REAL source dir (which is NOT under any
 * `node_modules/`, so eslint's built-in node_modules ignore no longer matches the
 * resolved path), tries to lint it, and dies resolving that sibling's relative
 * `extends: ["../../../.eslintrc.base.json"]` from the wrong location. It also makes
 * every lint scan each project's entire subtree (37 per-project node_modules) — slow.
 * Because the command is `eslint .` with cwd=projectRoot, it never reads the
 * workspace-root `.eslintignore`, so there is no central lever to fix it.
 *
 * `@nx/eslint:lint` is nx's canonical lint executor and runs eslint from the
 * WORKSPACE ROOT over explicit, project-scoped `lintFilePatterns`. Running from the
 * root means the root `.eslintignore` (node_modules, dist, coverage, tmp, .nx) IS
 * honored, so node_modules is pruned before any symlink is followed. Same per-project
 * `lint` target name, so `nx affected -t lint`, `build`'s `dependsOn: ["lint"]`, and
 * the pre-commit gate all keep working unchanged — this is a drop-in swap of the
 * inference mechanism, not a change to the lint contract.
 */
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');

function skip(p) {
  return (
    p === '.' ||
    p.startsWith('node_modules/') || p.includes('/node_modules/') ||
    p.startsWith('dist/') || p.includes('/dist/') ||
    p.startsWith('tmp/') || p.includes('/tmp/') ||
    p.startsWith('coverage/') || p.includes('/coverage/')
  );
}

exports.createNodes = [
  '**/.eslintrc.json',
  (eslintrcPath, _opts, ctx) => {
    const projectRoot = dirname(eslintrcPath);
    if (skip(projectRoot)) return {};
    // Only real nx projects (must have a project.json or package.json sibling).
    const abs = join(ctx.workspaceRoot, projectRoot);
    if (!existsSync(join(abs, 'project.json')) && !existsSync(join(abs, 'package.json'))) {
      return {};
    }
    return {
      projects: {
        [projectRoot]: {
          targets: {
            lint: {
              executor: '@nx/eslint:lint',
              cache: true,
              options: {
                lintFilePatterns: [
                  `${projectRoot}/**/*.{ts,tsx,js,jsx,cjs,mjs}`,
                  `${projectRoot}/package.json`,
                  `${projectRoot}/project.json`,
                ],
              },
              inputs: [
                'default',
                '{workspaceRoot}/.eslintrc.base.json',
                `{projectRoot}/.eslintrc.json`,
                '{workspaceRoot}/.eslintignore',
                '{workspaceRoot}/tools/eslint-rules/**/*',
                { externalDependencies: ['eslint'] },
              ],
            },
          },
        },
      },
    };
  },
];
