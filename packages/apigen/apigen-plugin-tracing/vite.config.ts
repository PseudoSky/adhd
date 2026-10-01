/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { importMetaUrlCjs } from '../../../tools/vite-plugins/import-meta-url-cjs.mjs';
import { nxViteTsPathsPre } from '../../../tools/vite-plugins/source-resolution.mjs';
import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';
import { vitestTestDefaults } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/packages/apigen/apigen-plugin-tracing',
  plugins: [
    importMetaUrlCjs(),
    nxViteTsPaths(),
    nxViteTsPathsPre(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
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
      name: 'apigen-plugin-tracing',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: externalizeRealDeps(__dirname),
    },
  },
  test: {
    ...vitestTestDefaults,
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    testTimeout: 120_000,
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/packages/apigen/apigen-plugin-tracing',
      provider: 'v8',
    },
  },
});
