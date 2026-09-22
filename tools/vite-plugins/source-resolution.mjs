import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

/**
 * Test-time source resolution for workspace `@adhd/*` packages.
 *
 * WHY THIS EXISTS: at TEST time a bare `@adhd/<dep>` specifier resolves through
 * the `node_modules/@adhd/<dep>` symlink to the dependency's `package.json`
 * `main`/`module`/`exports` — i.e. its built `dist`, NOT its `src`. Vite's
 * built-in `vite:resolve` plugin runs BEFORE normal-order user plugins, so the
 * `nxViteTsPaths()` plugin sitting in `plugins: [...]` is only ever consulted
 * when `vite:resolve` returns `null`. A workspace package symlinked into
 * `node_modules` IS resolvable by `vite:resolve`, so `dist` wins (and when the
 * dependency's `dist` is absent, `vite:resolve` THROWS
 * `Failed to resolve entry for package` instead of deferring). The result: the
 * test module graph terminates at project boundaries — a dependency's `src`
 * change is invisible to a dependent's test, `^build` becomes load-bearing, and
 * `vitest --changed` selects zero tests in dependents.
 *
 * THE FIX: return a copy of the same tsconfig-paths plugin hoisted ahead of
 * `vite:resolve` via `enforce: 'pre'`, so it gets first refusal on every
 * `@adhd/*` specifier and maps it to `src/index.ts` before `vite:resolve` can
 * resolve it to `dist`. Drop it into `plugins: [...]` right after the normal
 * `nxViteTsPaths()` entry:
 *
 *   plugins: [nxViteTsPaths(), nxViteTsPathsPre()],
 *
 * WHY `apply: 'serve'` IS LOAD-BEARING (do not remove it): a bare
 * `enforce: 'pre'` also reorders resolution for the PRODUCTION build, which
 * inlines dependency SOURCE into the bundle and shrinks the published artifact.
 * Measured on `data-query-engine`: `dist/index.js` is 364480 B with the normal
 * config and with `apply: 'serve'`, but drops to 223798 B with a bare
 * `enforce: 'pre'`. `apply: 'serve'` scopes the pre-order copy to dev/test only
 * (vitest runs in serve mode) so the build output stays byte-for-byte
 * unchanged.
 *
 * FUTURE NOTE (not used deliberately): Vite also supports
 * `apply: (_, { command }) => command !== 'build'`, which would express the same
 * serve-only intent with a predicate. `apply: 'serve'` is kept because it is the
 * form that was measured and proven byte-identical on the build.
 *
 * This helper is the single definition of the fix — generated `vite.config.ts`
 * files import it (via `@adhd/workspace-codegen-nx`) and every hand-authored
 * config uses it, so a new project cannot miss it.
 *
 * @returns {import('vite').Plugin} a pre-ordered, serve-scoped tsconfig-paths
 *   plugin that maps workspace `@adhd/*` imports to source during tests.
 */
export function nxViteTsPathsPre() {
  return { ...nxViteTsPaths(), name: 'nx-vite-ts-paths-pre', enforce: 'pre', apply: 'serve' };
}
