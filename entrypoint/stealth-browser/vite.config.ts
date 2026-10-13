/// <reference types='vitest' />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import { E2E_FILE_EXCLUDES } from '../../tools/vite-plugins/e2e-globs.mjs';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { importMetaUrlCjs } from '../../tools/vite-plugins/import-meta-url-cjs.mjs';
import { projectCacheDir, projectCoverage } from '../../packages/workspace/workspace-base-vite-paths/src/index';

import { externalizeRealDeps } from '../../tools/vite-plugins/externalize.mjs';
import { vitestTestDefaults } from '../../tools/vite-plugins/vitest-pool-defaults.mjs';
const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  root: __dirname,
  cacheDir: projectCacheDir(__dirname),

  plugins: [
    importMetaUrlCjs(),
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
      // src/test/** holds test-support lacking a .spec/.test suffix; keep it out of shipped declarations.
      exclude: ['bin/**', 'src/test/**'],
    }),
  ],

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      entry: 'src/index.ts',
      name: "stealth-browser",
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // Real npm deps (incl. @adhd/sox-store-adapter, @adhd/sox-service-proxy) stay out of dist/index.js.
      external: [
        /^node:/,
        ...externalizeRealDeps(__dirname),
      ],
    },
  },

  test: {
    ...vitestTestDefaults,
    globals: true,
    cache: {
      dir: path.join(repoRoot, 'node_modules/.vitest'),
    },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Subprocess / real-server suites (`*.e2e.ts`, `*.e2e.test.ts`) run in the separate
    // `e2e` lane (vitest.e2e.config.ts), never here (backlog 5b839b90 AC1;
    // docs/decisions/0009-test-lanes-unit-vs-e2e.md). Gated by check-agent-lane-spawn.mjs.
    exclude: [...configDefaults.exclude, ...E2E_FILE_EXCLUDES],

    reporters: ['default'],
    coverage: {
      reportsDirectory: projectCoverage(__dirname),
      provider: 'v8',
    },
  },
});
