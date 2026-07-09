/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

const repoRoot = path.resolve(__dirname, '../../..');
const distDir = path.join(repoRoot, 'dist/packages/dispatch/dispatch-spec');

export default defineConfig({
  root: __dirname,
  cacheDir: path.join(repoRoot, 'node_modules/.vite/packages/dispatch/dispatch-spec'),

  plugins: [
    {
      name: 'copy-readme',
      apply: 'build',
      closeBundle() {
        const fs = require('node:fs'),
          p = require('node:path');
        const src = p.resolve(__dirname, 'README.md');
        if (!fs.existsSync(src)) return;
        fs.mkdirSync(distDir, { recursive: true });
        fs.copyFileSync(src, p.join(distDir, 'README.md'));
      },
    },
    {
      name: 'copy-schemas',
      apply: 'build',
      closeBundle() {
        const fs = require('node:fs'),
          p = require('node:path');
        fs.mkdirSync(distDir, { recursive: true });
        for (const f of ['dag-v4.schema.json', 'valid-ops-by-kind.json']) {
          const src = p.resolve(__dirname, 'src', f);
          if (fs.existsSync(src)) fs.copyFileSync(src, p.join(distDir, f));
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
    outDir: distDir,
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: { transformMixedEsModules: true },
    lib: {
      entry: 'src/index.ts',
      name: 'dispatch-spec',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: { external: [] },
  },

  test: {
    globals: true,
    cache: { dir: path.join(repoRoot, 'node_modules/.vitest') },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: path.join(
        repoRoot,
        'coverage/packages/dispatch/dispatch-spec'
      ),
      provider: 'v8',
    },
  },
});
