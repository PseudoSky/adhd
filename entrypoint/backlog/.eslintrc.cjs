'use strict';
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
 * `entrypoint/apigen-cli/.eslintrc.json`, which hardcodes 11 names for this
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
 * correctly (`fastify`, `yaml`, `@adhd/sox-graph-store`, …) is a
 * harmless no-op to also list here. Add a new npm dependency to any bundled
 * `@adhd/*` package and this list grows with it automatically — no manual
 * edit, no drift, and this file must stay `.cjs` (not `.json`) specifically
 * so it can compute that list instead of hand-listing it.
 */
const ignoredDependencies = [
  ...computeRealDependencyNames(__dirname),
  // `@adhd/apigen-base-logical` is the same structural blind spot as the
  // pino/pino-pretty case above, one level up: `findNpmDependencies` (which
  // backs `@nx/dependency-checks`) walks only the `build` target's own file
  // graph (`vite.config.ts`'s `main: src/index.ts`), which never reaches a
  // `*.spec.ts` file — so a dependency imported ONLY by a spec (here,
  // `src/mcp-discoverability-real-ops.spec.ts`'s `synthesizeExample` /
  // `X_APIGEN_*` imports, proving apigen's schema-driven worked-example
  // synthesis against backlog's own real, already-built `dist/api.d.ts`) is
  // permanently invisible to the rule and gets reported/stripped as
  // "obsolete" no matter what the source does. Declared here so
  // `sync-deps`/`lint` stop deleting the real, needed `package.json` entry.
  '@adhd/apigen-base-logical',
];

module.exports = {
  extends: ['../../.eslintrc.base.json'],
  ignorePatterns: [
    '!**/*',
    'vite.config.js',
    'vite.config.ts',
    'vite.config.mjs',
    'vite.config.mts',
  ],
  overrides: [
    {
      files: ['*.ts', '*.tsx', '*.js', '*.jsx'],
      rules: {},
    },
    {
      files: ['*.ts', '*.tsx'],
      rules: {},
    },
    {
      files: ['*.js', '*.jsx'],
      rules: {},
    },
    {
      // This config file itself: `.eslintrc.base.json`'s `*.js`/`*.jsx`
      // override (which sets modern `parserOptions` via `plugin:@nx/
      // javascript`) doesn't match `.cjs`, so without this override eslint
      // falls back to its ES5 default parse and rejects `const`/`require()`
      // destructuring in this very file.
      files: ['*.cjs'],
      parserOptions: { ecmaVersion: 2022, sourceType: 'script' },
      env: { node: true },
    },
    {
      // `tools/*.mjs` (web UI prototype: `run-web-ui.mjs`,
      // `web-ui-server.mjs`) are genuine ESM modules — top-level `import`
      // and top-level `await`. Without this override the base config's
      // ES5/script default parse rejects `import` outright ("The keyword
      // 'import' is reserved").
      files: ['*.mjs'],
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      env: { node: true },
    },
    {
      files: ['*.json'],
      parser: 'jsonc-eslint-parser',
      rules: {
        '@nx/dependency-checks': [
          'error',
          {
            ignoredFiles: [
              '{projectRoot}/vite.config.{js,ts,mjs,mts}',
              // The resource-consuming `*.e2e.ts` suites (extracted out of the
              // default `test` target — see their sibling `*.spec.ts` stubs)
              // are TESTS, exactly like `*.spec.ts`. `@nx/dependency-checks`'s
              // built-in test-file ignore predates the `.e2e.ts` suffix, so
              // without this their test-only imports (`vitest`, `jsdom`) would
              // be tallied as production usage and `sync-deps` would demand
              // them in `dependencies` (verified: it does, and this silences it
              // correctly rather than declaring test-only deps as runtime deps).
              '{projectRoot}/**/*.e2e.{ts,tsx,mts,cts}',
            ],
            ignoredDependencies,
          },
        ],
      },
    },
  ],
};
