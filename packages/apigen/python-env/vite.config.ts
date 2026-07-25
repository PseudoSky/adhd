/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';
export default defineConfig({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/packages/apigen/python-env',

  plugins: [
    nxViteTsPaths(),
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
      name: 'apigen-python-env',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // Node-only package: never bundle node builtins.
      external: [/^node:/],
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
      reportsDirectory: '../../../coverage/packages/apigen/python-env',
      provider: 'v8',
    },
  },
});
