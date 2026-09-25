/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { importMetaUrlCjs } from '../../../tools/vite-plugins/import-meta-url-cjs.mjs';
import { nxViteTsPathsPre } from '../../../tools/vite-plugins/source-resolution.mjs';
import { projectCacheDir } from '../workspace-base-vite-paths/src/index';

import { vitestTestDefaults } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';
export default defineConfig({
  root: __dirname,
  cacheDir: projectCacheDir(__dirname),
  plugins: [
    importMetaUrlCjs(),
    nxViteTsPaths(),
    nxViteTsPathsPre(),
    dts({ entryRoot: 'src', tsconfigPath: path.join(__dirname, 'tsconfig.lib.json') }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/index.ts',
      name: 'workspace-codegen-nx',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: { external: ['@nx/devkit'] },
  },
  test: {
    ...vitestTestDefaults,
    globals: true,
    cache: { dir: '../../../node_modules/.vitest' },
    environment: 'node',
    // The two devkit generator specs drive the real Nx devkit generator tree
    // (~2.5-3s each in isolation). Under `nx affected -t test --parallel=5`
    // on a load-saturated box (measured load 100-222 on 10 cores -> up to 22x
    // CPU oversubscription) they exceed vitest's 5s default and fail with
    // `Test timed out in 5000ms`, reding the release test gate. 120_000 is
    // 24-48x the isolated runtime and the repo's established headroom
    // precedent (apigen-plugin-java-javalin, tools/etl), so the gate is
    // deterministic under load without weakening any assertion.
    testTimeout: 120_000,
    // @nx/vite:test passes `reporters: []` when this is unset, which silences
    // ALL vitest output (a passing/failing suite prints nothing). Declaring
    // `['default']` restores normal per-test output. F3 fix.
    reporters: ['default'],
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
  },
});
