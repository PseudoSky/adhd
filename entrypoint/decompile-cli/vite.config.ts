/// <reference types='vitest' />
import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { projectCacheDir, projectCoverage } from '../../packages/workspace/workspace-base-vite-paths/src/index';

import { vitestPoolOptions } from '../../tools/vite-plugins/vitest-pool-defaults.mjs';
export default defineConfig({
  root: __dirname,
  cacheDir: projectCacheDir(__dirname),

  plugins: [nxViteTsPaths()],

  // Test-only Vite config — decompile-cli's `build` target compiles via
  // `@nx/js:tsc` (see BUILD-CONSIST-008: native/legacy-CJS-heavy deps make
  // it a bundling-risk candidate), matching the pattern already used by
  // several `@nx/js:tsc`-built packages (e.g. agent-store-prompts) that
  // still run their `test` target through `@nx/vite:test`.
  test: {
    poolOptions: vitestPoolOptions,
    globals: true,
    cache: {
      dir: '../../node_modules/.vitest',
    },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory: projectCoverage(__dirname),
      provider: 'v8',
    },
  },
});
