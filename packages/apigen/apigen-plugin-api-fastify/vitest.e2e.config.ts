/// <reference types='vitest' />
import * as path from 'node:path';
import { mergeConfig } from 'vitest/config';
import baseConfig from './vite.config';
import {
  projectCacheDir,
  projectCoverage,
} from '../../workspace/workspace-base-vite-paths/src/index';

/**
 * Dedicated E2E lane for `apigen-plugin-api-fastify`.
 *
 * The resource-consuming suite — the one that starts real, live-dispatched
 * Fastify servers bound to real ports and drives them over real HTTP
 * round-trips plus a live SSE frame stream — was extracted out of the default
 * `test` target into the sibling `plugin.e2e.ts` file, with a `plugin.spec.ts`
 * stub left at the original path (see that stub's header). This config runs
 * ONLY the `*.e2e.ts` files, under the opt-in `e2e` target: never under
 * `nx affected -t test` / the pre-commit + pre-push hooks.
 *
 * Built from the project's own `vite.config.ts` so plugins, aliases and pool
 * settings stay identical to the default lane. `mergeConfig` CONCATENATES
 * arrays, so the base lane's `include` is emptied first — otherwise the
 * default `*.spec.ts` glob would survive the merge and this lane would run
 * the whole suite instead of only the e2e files.
 */
const base = {
  ...baseConfig,
  test: { ...baseConfig.test, include: [] },
};

export default mergeConfig(base, {
  test: {
    include: ['src/**/*.e2e.ts'],
    // Distinct cache + coverage dirs so the e2e lane never clobbers (or is
    // served from) the default lane's vitest cache or coverage report.
    cache: { dir: path.join(projectCacheDir(__dirname), 'e2e') },
    coverage: {
      reportsDirectory: path.join(projectCoverage(__dirname), 'e2e'),
    },
  },
});
