'use strict';
/**
 * createNodes: attach a standard nx `lint` target (nx's own `@nx/eslint:lint`
 * executor) to every project that has a flat ESLint config
 * (`eslint.config.{mjs,cjs,js}`). No project.json edits.
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
 * `extends`. It also makes every lint scan each project's entire subtree
 * (37 per-project node_modules) — slow.
 * Because the command is `eslint .` with cwd=projectRoot, it never reads the
 * workspace-root config, so there is no central lever to fix it.
 *
 * `@nx/eslint:lint` is nx's canonical lint executor and runs eslint from the
 * WORKSPACE ROOT over explicit, project-scoped `lintFilePatterns`. Running from the
 * root means the workspace-root flat config and its global ignores ARE honored, so
 * node_modules and every project's `dist/**` are pruned before any symlink is
 * followed. Same per-project `lint` target name, so `nx affected -t lint`,
 * `build`'s `dependsOn: ["lint"]`, and the pre-commit gate all keep working
 * unchanged — this is a drop-in swap of the inference mechanism, not a change to
 * the lint contract.
 *
 * Historically this plugin keyed off `.eslintrc.{json,cjs}`; the ESLint v9
 * flat-config migration converted every project to `eslint.config.mjs`, so it now
 * keys off that. Projects that carry an explicit `lint` target in `project.json`
 * (the ones the Nx converter wrote) simply keep it — both shapes are the same
 * `@nx/eslint:lint` executor.
 */
const { existsSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');
const { isScratchPath } = require('../lib/scratch-root');

function skip(p) {
  return (
    p === '.' ||
    p.startsWith('node_modules/') || p.includes('/node_modules/') ||
    p.startsWith('dist/') || p.includes('/dist/') ||
    isScratchPath(p) ||
    p.startsWith('coverage/') || p.includes('/coverage/')
  );
}

// Nx 23 unified the plugin API on the v2 shape: `createNodes[1]` is invoked
// ONCE with the ARRAY of all matched config files and must return an array of
// `[configFile, result]` tuples (see nx's loaded-nx-plugin.js). The pre-23 v1
// shape (one call per file, returning a bare result) is what this plugin used
// and is what throws `dirname(<array>)` under Nx 23.
exports.createNodes = [
  '**/eslint.config.{mjs,cjs,js}',
  (configFiles, _opts, ctx) =>
    configFiles.map((configPath) => {
      const projectRoot = dirname(configPath);
      // The workspace-root flat config is not a project.
      if (skip(projectRoot)) return [configPath, {}];
      // Only real nx projects (must have a project.json or package.json sibling).
      const abs = join(ctx.workspaceRoot, projectRoot);
      if (!existsSync(join(abs, 'project.json')) && !existsSync(join(abs, 'package.json'))) {
        return [configPath, {}];
      }
      return [configPath, {
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
                  '{workspaceRoot}/eslint.base.config.mjs',
                  '{workspaceRoot}/eslint.config.mjs',
                  `{projectRoot}/${basename(configPath)}`,
                  { externalDependencies: ['eslint'] },
                ],
              },
            },
          },
        },
      }];
    }),
];
