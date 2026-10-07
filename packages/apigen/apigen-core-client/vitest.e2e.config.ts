/// <reference types='vitest' />
import baseConfig from './vite.config';
import { defineE2eConfig } from '../../../tools/vite-plugins/e2e-config.mjs';

/**
 * Resource-consuming e2e lane for `apigen-core-client`.
 *
 * Hosts the CPU-heavy real ts-morph/TypeScript compilation suites, plus the two
 * `spawnSync` subprocess specs — extracted out of the default `test` target into
 * sibling `*.e2e.ts` files, with `*.spec.ts` stubs left at the original paths
 * (see each stub's header). Runs ONLY those files, under the opt-in `e2e`
 * target: never under `nx affected -t test` / the pre-commit + pre-push hooks.
 * The lane mechanics (include-narrowing, distinct cache + coverage dirs) live in
 * the shared factory `tools/vite-plugins/e2e-config.mjs`.
 */
const e2eConfig = defineE2eConfig(baseConfig, __dirname);

/**
 * Wall-clock ceiling per test in THIS lane. Every suite here does real,
 * CPU-bound ts-morph/TypeScript program builds (1-10s each on an idle box).
 * Measured 2026-10-07 (BUG-APIGEN-CORE-CLIENT-E2E-LOAD-TIMEOUT-001): with 4
 * concurrent copies of the lane on a loaded box, single tests that take 2-10s
 * idle ran 30-78s and tripped the inherited 30s default (3 tests per run), which
 * is how `apigen-core-client:e2e` went red inside a loaded `publish` task graph.
 * A timeout here only ever guards a hang, never speed, so it is set well above
 * the loaded worst case. The default (unit) lane keeps the inherited 30s.
 */
const E2E_TEST_TIMEOUT_MS = 180_000;

export default {
  ...e2eConfig,
  test: {
    ...e2eConfig.test,
    testTimeout: E2E_TEST_TIMEOUT_MS,
    hookTimeout: E2E_TEST_TIMEOUT_MS,
  },
};
