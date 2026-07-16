/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

export default defineConfig({
  root: __dirname,
  cacheDir:
    '../../../node_modules/.vite/packages/environment/environment-core-builder',

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
    outDir: '../../../dist/packages/environment/environment-core-builder',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      // Could also be a dictionary or array of multiple entry points.
      entry: 'src/index.ts',
      name: 'environment-environment-core-builder',
      fileName: 'index',
      // Change this to the formats you want to support.
      // Don't forget to update your package.json as well.
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // Node-only package (platform:node): never bundle node builtins.
      // (BUG, pre-existing: this was `external: []`, which made Vite try to
      // browser-externalize `node:fs`/`node:path`/`node:os`/`node:crypto` —
      // producing a build-breaking `"readFileSync" is not exported by
      // "__vite-browser-external"` error. Latent because index.ts previously
      // only re-exported an unused `lib/` stub, so no file that imports a
      // `node:*` builtin was ever reachable from the build entrypoint until
      // `builder-snapshot-api` wired the real pipeline together. See
      // `packages/apigen/python-env/vite.config.ts` for the same fix.)
      external: [/^node:/],
    },
  },

  test: {
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory:
        '../../../coverage/packages/environment/environment-core-builder',
      provider: 'v8',
    },
  },
});
