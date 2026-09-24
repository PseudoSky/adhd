/// <reference types='vitest' />
import * as path from 'node:path';
import { mergeConfig } from 'vitest/config';
import baseConfig from './vite.config';
import {
  projectCacheDir,
  projectCoverage,
} from '../../workspace/workspace-base-vite-paths/src/index';

/**
 * Dedicated E2E lane for `apigen-plugin-mcp`.
 *
 * The resource-consuming suites — the ones that start real MCP servers bound
 * to real ports and drive them over real HTTP via the `@modelcontextprotocol`
 * SDK client transports, plus their `spawnSync` negative controls — were
 * extracted out of the default `test` target into sibling `*.e2e.ts` files,
 * with `*.spec.ts` stubs left at the original paths (see each stub's header).
 * This config runs ONLY those `*.e2e.ts` files, under the opt-in `e2e` target:
 * never under `nx affected -t test` / the pre-commit + pre-push hooks.
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
