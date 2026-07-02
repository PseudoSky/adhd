/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/packages/shared/dispatch-spec',

  plugins: [
    {
      name: 'copy-readme',
      apply: 'build',
      closeBundle() {
        const fs = require('node:fs'),
          p = require('node:path');
        const src = p.resolve(__dirname, 'README.md');
        if (!fs.existsSync(src)) return;
        const out = p.resolve(
          __dirname,
          '../../../dist/packages/shared/dispatch-spec'
        );
        fs.mkdirSync(out, { recursive: true });
        fs.copyFileSync(src, p.join(out, 'README.md'));
      },
    },
    {
      name: 'copy-schemas',
      apply: 'build',
      closeBundle() {
        const fs = require('node:fs'),
          p = require('node:path');
        const out = p.resolve(
          __dirname,
          '../../../dist/packages/shared/dispatch-spec'
        );
        fs.mkdirSync(out, { recursive: true });
        for (const f of ['dag-v4.schema.json', 'valid-ops-by-kind.json']) {
          const src = p.resolve(__dirname, 'src', f);
          if (fs.existsSync(src)) fs.copyFileSync(src, p.join(out, f));
        }
      },
    },
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
    }),
  ],

  build: {
    outDir: '../../../dist/packages/shared/dispatch-spec',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: { transformMixedEsModules: true },
    lib: {
      entry: 'src/index.ts',
      name: 'shared-dispatch-spec',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: { external: [] },
  },

  test: {
    globals: true,
    cache: { dir: '../../../node_modules/.vitest' },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/packages/shared/dispatch-spec',
      provider: 'v8',
    },
  },
});
