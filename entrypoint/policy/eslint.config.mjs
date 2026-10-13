import { createRequire } from 'node:module';
import baseConfig from '../../eslint.base.config.mjs';
import jsoncEslintParser from 'jsonc-eslint-parser';

const require = createRequire(import.meta.url);
const { computeRealDependencyNames } = require('../../tools/nx-plugins/deps/compute-real-deps.js');

/**
 * `@nx/dependency-checks` only sees literal imports inside this project's own
 * sources. Real npm packages reached through bundled `@adhd/*` workspace
 * source (the bundle is what ships) are derived from the same dependency walk
 * the vite `external` list uses, so the list cannot drift.
 */
const ignoredDependencies = [...computeRealDependencyNames(import.meta.dirname)];

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: [
            '{projectRoot}/vite.config.{js,ts,mjs,mts}',
            '{projectRoot}/**/*.e2e.{ts,tsx,mts,cts}',
            // Specs run the real bin code in process and are test-only: vitest is a workspace dev dependency, not a runtime one.
            '{projectRoot}/src/test/**',
          ],
          ignoredDependencies,
        },
      ],
    },
    languageOptions: {
      parser: jsoncEslintParser,
    },
  },
  {
    ignores: ['**/vite.config.js', '**/vite.config.ts', '**/vite.config.mjs', '**/vite.config.mts'],
  },
];
