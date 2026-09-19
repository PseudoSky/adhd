import { createRequire } from 'node:module';
import globals from 'globals';
import baseConfig from '../../eslint.base.config.mjs';
import jsoncEslintParser from 'jsonc-eslint-parser';

const require = createRequire(import.meta.url);
const {
  computeRealDependencyNames,
} = require('../../tools/nx-plugins/deps/compute-real-deps.js');

/**
 * `@nx/dependency-checks` (run via `sync-deps`/`lint`) decides a package.json
 * dependency is "used" ONLY if it sees a literal `import`/`require` of it
 * inside THIS project's own source files (`entrypoint/backlog/src/**`). It
 * never looks inside a bundled `@adhd/*` workspace dependency's source, even
 * though that source ships INSIDE this package's own build (see
 * `tools/vite-plugins/externalize.mjs`'s doc comment on why `@adhd/*` stays
 * bundled, not externalized).
 *
 * `pino`/`pino-pretty` are exactly this case: `@adhd/apigen-plugin-cli-
 * output`'s `run()` calls `@adhd/apigen-engine-runtime`'s `createLogger()`,
 * which selects `pino-pretty` as a pino WORKER-THREAD transport, resolved by
 * STRING at runtime (`transport: { target: 'pino-pretty' }`) — never a
 * static import anywhere backlog's own files can see. Nothing in this
 * project's source imports `pino` or `pino-pretty` directly, so
 * `@nx/dependency-checks` always concluded they were unused and `sync-deps
 * --fix` kept silently deleting them from `package.json` — which then made
 * `npx @adhd/backlog --help` crash with "unable to determine transport
 * target for pino-pretty" the moment it ran in a real TTY (pino-pretty
 * wasn't installed at all).
 *
 * A hand-maintained `ignoredDependencies` list (see
 * `entrypoint/apigen-cli/eslint.config.mjs`, which hardcodes 11 names for this
 * exact class of problem) only fixes today's known offenders and silently
 * rots the next time a bundled `@adhd/*` dependency starts using a new real
 * npm package this way — nobody remembers to add it, and `sync-deps --fix`
 * quietly strips it again with no warning.
 *
 * Instead: derive `ignoredDependencies` from `computeRealDependencyNames`,
 * the SAME dependency-graph walk `externalizeRealDeps` already uses to build
 * this package's vite `rollupOptions.external` (`tools/nx-plugins/deps/
 * compute-real-deps.js` — single shared implementation). That walk already
 * knows, authoritatively, every real npm package this bundle needs at
 * runtime, including everything reachable transitively through bundled
 * `@adhd/*` source — so it's exactly the set `@nx/dependency-checks`
 * structurally cannot compute on its own. Any dependency it can already see
 * correctly (`better-sqlite3`, `yaml`, `@adhd/sox-graph-store`, …) is a
 * harmless no-op to also list here. Add a new npm dependency to any bundled
 * `@adhd/*` package and this list grows with it automatically — no manual
 * edit, no drift. This config is `.mjs` (not `.cjs`) so it can both compute
 * that list via `createRequire` and import the shared flat base config.
 */
const ignoredDependencies = Array.from(
  computeRealDependencyNames(import.meta.dirname),
);

export default [
  ...baseConfig,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    // Override or add rules here
    rules: {},
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    // Override or add rules here
    rules: {},
  },
  {
    files: ['**/*.js', '**/*.jsx'],
    // Override or add rules here
    rules: {},
  },
  {
    // CommonJS scripts (`scripts/*.cjs`, `tools/*.cjs`, fixtures): parse as
    // ES2022 script with Node globals.
    files: ['**/*.cjs'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'script' },
      globals: { ...globals.node },
    },
  },
  {
    // ESM tooling (`tools/*.mjs` — web UI prototype) uses top-level import and
    // top-level await, so it must parse as a module.
    files: ['**/*.mjs'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: ['{projectRoot}/vite.config.{js,ts,mjs,mts}'],
          ignoredDependencies,
        },
      ],
    },
    languageOptions: {
      parser: jsoncEslintParser,
    },
  },
  {
    ignores: [
      '**/vite.config.js',
      '**/vite.config.ts',
      '**/vite.config.mjs',
      '**/vite.config.mts',
    ],
  },
];
