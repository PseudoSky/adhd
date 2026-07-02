/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import fs from 'node:fs';
import pathMod from 'node:path';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/packages/dispatch/dispatch-client',

  plugins: [
    {
      // ship README.md into dist (npm page) — @nx/vite:build ignores project.json assets
      name: 'apigen-copy-readme',
      apply: 'build',
      closeBundle() {
        const srcPath = pathMod.resolve(__dirname, 'README.md');
        if (!fs.existsSync(srcPath)) return;
        const outDir = pathMod.resolve(__dirname, '../../../dist/packages/dispatch/dispatch-client');
        fs.mkdirSync(outDir, { recursive: true });
        fs.copyFileSync(srcPath, pathMod.join(outDir, 'README.md'));
      },
    },
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
    outDir: '../../../dist/packages/dispatch/dispatch-client',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      // Could also be a dictionary or array of multiple entry points.
      entry: 'src/index.ts',
      name: "dispatch-client",
      fileName: 'index',
      // Change this to the formats you want to support.
      // Don't forget to update your package.json as well.
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // External packages that should not be bundled into your library.
      external: [],
    },
  },

  test: {
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/packages/dispatch/dispatch-client',
      provider: 'v8',
    },
  },
});
