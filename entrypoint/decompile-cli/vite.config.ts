/// <reference types='vitest' />
import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

import { vitestPoolOptions } from '../../tools/vite-plugins/vitest-pool-defaults.mjs';
export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/entrypoint/decompile-cli',

  plugins: [nxViteTsPaths()],

  // Test-only Vite config — decompile-cli's `build` target compiles via
  // `@nx/js:tsc` (see BUILD-CONSIST-008: native/legacy-CJS-heavy deps make
  // it a bundling-risk candidate; full rationale + category writeup:
  // docs/contributing/conventions/build-executor-choice.md), matching the
  // pattern already used by several `@nx/js:tsc`-built packages (e.g.
  // agent-store-prompts) that still run their `test` target through
  // `@nx/vite:test`.
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
      reportsDirectory: '../../coverage/entrypoint/decompile-cli',
      provider: 'v8',
    },
  },
});
