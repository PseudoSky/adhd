import { mergeConfig } from 'vitest/config';
import {
  projectCacheDir,
  projectCoverage,
} from '../../packages/workspace/workspace-base-vite-paths/src/index.ts';

/**
 * Shared factory for a package's opt-in resource-consuming E2E lane
 * (`vitest.e2e.config.ts`).
 *
 * Every project that splits its resource-consuming suites out of the default
 * `test` target (real servers on bound ports, spawned subprocesses, a real JVM,
 * venv provisioning, …) needs the identical four overrides on top of its own
 * `vite.config.ts`, and those overrides are exactly where the boilerplate — and
 * the bug — lived: a hand-copied `vitest.e2e.config.ts` per package carried two
 * divergent spellings, and the hard-coded ones silently went stale on a move.
 * This factory is the single source of truth for the lane's mechanics.
 *
 * It applies exactly three things:
 *   1. Narrows `test.include` to `src/**\/*.e2e.ts` — the resource suites only.
 *   2. Points the vitest transform cache at a DISTINCT `<cacheDir>-e2e`.
 *   3. Points coverage at a DISTINCT `<coverageDir>-e2e` `reportsDirectory`.
 *
 * Both DISTINCT suffixes are `${helper(…)}-e2e` — matching each project's
 * declared `e2e` target `outputs` (`coverage/<pkgrel>-e2e`) and the sibling
 * `entrypoint/backlog` lane, so the declared output and the directory actually
 * written never drift apart.
 *
 * `include` REPLACE, not concatenate: vite's `mergeConfig` CONCATENATES array
 * fields (`mergeConfigRecursively`: `[...existing, ...value]`), so merging the
 * base config as-is would leave the base lane's `include: ['src/**\/*.spec.ts']`
 * in place and this lane would also re-run every default-lane spec (verified
 * against vitest 1.6.1). Destructuring `test` out of the base before merging,
 * then re-adding it with a single-element `include`, makes the override's glob
 * the only one that survives. This is why `defineE2eConfig` takes the base
 * config and `__dirname` rather than being a plain object the projects spread.
 *
 * Both derived paths come from `workspace-base-vite-paths`, which recomputes
 * them from `dirname` on every call — so `git mv`-ing a package keeps the lane's
 * cache/coverage correct with zero edits, the same move-safety that helper
 * exists to provide. (The prior hand-copied configs hard-coded
 * `../../../node_modules/.vitest/<name>-e2e` literals.)
 *
 * @param {import('vite').UserConfig} baseConfig the package's own `vite.config.ts`
 *   default export. Plugins, aliases, `poolOptions`, reporters and timeouts are
 *   all inherited from it; only the lane-selecting fields above are overridden.
 * @param {string} dirname the package directory (`__dirname` from the calling
 *   `vitest.e2e.config.ts`). Passed to the move-safe path helpers.
 * @returns {import('vite').UserConfig} the E2E-lane config to default-export.
 */
export function defineE2eConfig(baseConfig, dirname) {
  const { test: baseTest, ...baseViteConfig } = baseConfig ?? {};
  const sharedTest = baseTest ?? {};
  const sharedCache = sharedTest.cache ?? {};
  const sharedCoverage = sharedTest.coverage ?? {};

  return mergeConfig(baseViteConfig, {
    test: {
      ...sharedTest,
      include: ['src/**/*.e2e.ts'],
      cache: {
        ...sharedCache,
        dir: `${projectCacheDir(dirname)}-e2e`,
      },
      coverage: {
        ...sharedCoverage,
        provider: 'v8',
        reportsDirectory: `${projectCoverage(dirname)}-e2e`,
      },
    },
  });
}
