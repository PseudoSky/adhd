/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';
export default defineConfig({
  root: __dirname,
  cacheDir:
    '../../../node_modules/.vite/packages/environment/environment-core-node',

  plugins: [
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
    }),
  ],

  // Uncomment this if you are using workers.
  // worker: {
  //  plugins: [ nxViteTsPaths() ],
  // },

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
      name: 'environment-environment-core-node',
      fileName: 'index',
      // Change this to the formats you want to support.
      // Don't forget to update your package.json as well.
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // Node-only package (platform:node): never bundle node builtins.
      // (BUG, pre-existing, ENV-CORE-014 fix pass: this was `external: []`,
      // which made Vite try to browser-externalize `node:fs`/`node:path`/
      // `node:os` — producing a build-breaking `"isAbsolute" is not exported
      // by "__vite-browser-external"` error. Latent because `src/index.ts`
      // previously only re-exported an unused `lib/` scaffold stub, so no
      // file importing a `node:*` builtin was ever reachable from the build
      // entrypoint until the real `Environment` runtime client was wired in
      // here. Same fix already applied in the sibling `environment-builder`
      // package's `vite.config.ts` — see its comment for the same root cause.)
      external: [/^node:/],
    },
  },

  test: {
    poolOptions: vitestPoolOptions,
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory:
        '../../../coverage/packages/environment/environment-core-node',
      provider: 'v8',
    },
  },
});
