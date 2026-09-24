/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';

import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';

export default defineConfig({
  root: __dirname,
  cacheDir:
    '../../../node_modules/.vite/packages/apigen/apigen-plugin-ir-cache',

  plugins: [
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
    }),
  ],

  // Configuration for building your library.
  // See: https://vitejs.dev/guide/build.html#library-mode
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      // Could also be a dictionary or array of multiple entry points.
      entry: 'src/index.ts',
      name: 'apigen-plugin-ir-cache',
      fileName: 'index',
      // Change this to the formats you want to support.
      // Don't forget to update your package.json as well.
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // Bundle only @adhd/* workspace source (no workspace symlinks in
      // this repo — see tools/vite-plugins/externalize.mjs); externalize
      // every real npm dependency + Node builtin. See BACKLOG.md
      // INVESTIGATION-BUILD-TOOL-001.
      external: externalizeRealDeps(__dirname),
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

    // `computeCacheKey`'s spec (ir-cache-layer.spec.ts) times out at vitest's
    // 5s default under the CI `nx affected -t test --parallel=5` run (load
    // 100-222 on 10 cores -> up to 22x CPU oversubscription), which reds the
    // release test gate. 120_000 matches the sibling apigen package
    // (apigen-plugin-java-javalin) and tools/etl — headroom for the whole
    // suite, no assertion weakened.
    testTimeout: 120_000,

    reporters: ['default'],
    coverage: {
      reportsDirectory:
        '../../../coverage/packages/apigen/apigen-plugin-ir-cache',
      provider: 'v8',
    },
  },
});
