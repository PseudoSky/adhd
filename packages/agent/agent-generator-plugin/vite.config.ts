/// <reference types='vitest' />
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { projectCacheDir, projectCoverage } from '../../workspace/workspace-base-vite-paths/src/index';
import * as path from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';
// NOTE: this project's `build` target now uses `@nx/js:tsc` (not this vite
// config's `build` block) — @nx/js:tsc mirrors the src/ directory structure
// and honors project.json's `assets` array (README, generators.json, the
// generator's __files__ templates, schema.json), which `@nx/vite:build`'s
// single-entry Rollup bundle could not (BUG-AGENTMCP-003/007: the bundle
// never produced a standalone `generator.js` at the path this package's own
// `generators.json` factory field requires). This config is retained only
// for the `test` target below.

export default defineConfig({
  root: __dirname,
  cacheDir: projectCacheDir(__dirname),

  plugins: [
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
    }),
  ],

  // Configuration for building the generator library.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      entry: 'src/index.ts',
      name: 'agent-nx',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // Nx devkit + node builtins stay external — never bundled into the plugin.
      external: ['@nx/devkit', '@nx/devkit/testing', 'node:path', 'node:fs'],
    },
  },

  test: {
    poolOptions: vitestPoolOptions,
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
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
