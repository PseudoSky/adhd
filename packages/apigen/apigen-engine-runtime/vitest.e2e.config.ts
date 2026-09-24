/// <reference types='vitest' />
import { mergeConfig } from 'vitest/config';
import type { UserConfig } from 'vitest/config';
import baseConfig from './vite.config';

/**
 * Resource-consuming e2e lane for `apigen-engine-runtime`.
 *
 * The resource-consuming self-tests — `isolated-git.e2e.ts` (real `git`
 * subprocesses creating/mutating disposable repos) and `parity-harness.e2e.ts`
 * (a real `node:http` server over real `fetch` + a real `git apply` cycle) —
 * were extracted out of the default `test` target into sibling `*.e2e.ts`
 * files, leaving a cheap `*.spec.ts` STUB at each original path. This config
 * runs ONLY those `*.e2e.ts` files, and only under the explicitly-invoked
 * `nx run apigen-engine-runtime:e2e` target. That target is deliberately
 * ABSENT from every `test.dependsOn` and from `affected`, so
 * `nx affected -t test` / the pre-commit + pre-push hooks never pay for it.
 *
 * Both moved suites are currently `describe.skip`'d (CPU-THRASH-SKIP,
 * owner-requested) — preserved verbatim; the lane exists so they have their
 * correct home the moment the owner re-enables them.
 *
 * Everything (plugins, `poolOptions`, reporters) is inherited from
 * `vite.config.ts`; only the lane-selecting fields are overridden.
 *
 * WHY `include` is destructured out of the base before merging: `mergeConfig`
 * CONCATENATES array fields — it does NOT replace them. Merging the base as-is
 * would therefore produce `include: ['src/**\/*.spec.ts', 'src/**\/*.e2e.ts']`
 * and this lane would also re-run the default lane's specs (verified against
 * vitest 1.6.1). Stripping the base `test` block from the first argument and
 * re-adding it (minus `include`) inside the override makes the override's
 * single-element `include` the only one that survives.
 *
 * The distinct coverage `reportsDirectory` and vitest `cache.dir` keep the two
 * lanes' coverage reports and transform caches from cross-poisoning each other.
 */
const { test: baseTest, ...baseViteConfig } = baseConfig as UserConfig;
const sharedTest = (baseTest ?? {}) as Record<string, unknown>;
const sharedCache = (sharedTest.cache ?? {}) as Record<string, unknown>;
const sharedCoverage = (sharedTest.coverage ?? {}) as Record<string, unknown>;

export default mergeConfig(baseViteConfig as UserConfig, {
  test: {
    ...sharedTest,
    include: ['src/**/*.e2e.ts'],
    cache: {
      ...sharedCache,
      dir: '../../../node_modules/.vitest/apigen-engine-runtime-e2e',
    },
    coverage: {
      ...sharedCoverage,
      provider: 'v8',
      reportsDirectory:
        '../../../coverage/packages/apigen/apigen-engine-runtime-e2e',
    },
  },
} as UserConfig);
