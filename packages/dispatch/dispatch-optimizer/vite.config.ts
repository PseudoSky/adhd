/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import fs from 'node:fs';
import p from 'node:path';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/packages/dispatch/dispatch-optimizer',

  plugins: [
    {
      // ship README.md into dist (npm page) — @nx/vite:build ignores project.json assets
      name: 'apigen-copy-readme',
      apply: 'build',
      closeBundle() {
        const src = p.resolve(__dirname, 'README.md');
        if (!fs.existsSync(src)) return;
        const out = p.resolve(__dirname, '../../../dist/packages/dispatch/dispatch-optimizer');
        fs.mkdirSync(out, { recursive: true });
        fs.copyFileSync(src, p.join(out, 'README.md'));
      },
    },
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: p.join(__dirname, 'tsconfig.lib.json'),
    }),
  ],

  // Uncomment this if you are using workers.
  // worker: {
  //  plugins: [ nxViteTsPaths() ],
  // },

  // Configuration for building your library.
  // See: https://vitejs.dev/guide/build.html#library-mode
  build: {
    outDir: '../../../dist/packages/dispatch/dispatch-optimizer',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      // Could also be a dictionary or array of multiple entry points.
      entry: 'src/index.ts',
      name: "dispatch-optimizer",
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
      reportsDirectory: '../../../coverage/packages/dispatch/dispatch-optimizer',
      provider: 'v8',
    },
  },
});
