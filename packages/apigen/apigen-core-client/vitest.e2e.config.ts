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
export default defineE2eConfig(baseConfig, __dirname);
