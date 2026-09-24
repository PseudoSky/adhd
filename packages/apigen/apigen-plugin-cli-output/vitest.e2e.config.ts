/// <reference types='vitest' />
import { mergeConfig } from 'vitest/config';
import type { UserConfig } from 'vitest/config';
import baseConfig from './vite.config';

/**
 * Resource-consuming e2e lane for `apigen-plugin-cli-output`.
 *
 * The resource-consuming suites — every test that spawns the real built
 * `entrypoint/apigen-cli/dist/index.js` via `execFile`, or a real
 * `node <harness>` child process against the real built `dist/index.js` of
 * this package (`run-cli-integration.e2e.ts`), plus the real spawned
 * `node -r @swc-node/register <generated cli.ts>` subprocess proof
 * (`root-oneof-branch.e2e.ts`) — were extracted out of the default `test`
 * target into sibling `*.e2e.ts` files, leaving the cheap `run-cli-integration.spec.ts`
 * STUB at the original path (and the in-process `root-oneof-branch.spec.ts`
 * unit tests in the default lane). This config runs ONLY `src/**\/*.e2e.ts`
 * files, and only under the explicitly-invoked
 * `nx run apigen-plugin-cli-output:e2e` target. That target is deliberately
 * ABSENT from every `test.dependsOn` and from `affected`, so
 * `nx affected -t test` / the pre-commit + pre-push hooks never pay for it.
 *
 * Everything (plugins, `poolOptions`, reporters, timeouts) is inherited from
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
      dir: '../../../node_modules/.vitest/apigen-plugin-cli-output-e2e',
    },
    coverage: {
      ...sharedCoverage,
      provider: 'v8',
      reportsDirectory:
        '../../../coverage/packages/apigen/apigen-plugin-cli-output-e2e',
    },
  },
} as UserConfig);
