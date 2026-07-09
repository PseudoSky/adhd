/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import fs from 'node:fs';
import p from 'node:path';

const repoRoot = p.resolve(__dirname, '../../..');
const distDir = p.join(repoRoot, 'dist/packages/dispatch/dispatch-optimizer');

export default defineConfig({
  root: __dirname,
  cacheDir: p.join(repoRoot, 'node_modules/.vite/packages/dispatch/dispatch-optimizer'),

  plugins: [
    {
      name: 'apigen-copy-readme',
      apply: 'build',
      closeBundle() {
        const src = p.resolve(__dirname, 'README.md');
        if (!fs.existsSync(src)) return;
        fs.mkdirSync(distDir, { recursive: true });
        fs.copyFileSync(src, p.join(distDir, 'README.md'));
      },
    },
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: p.join(__dirname, 'tsconfig.lib.json'),
    }),
  ],

  build: {
    outDir: distDir,
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      entry: 'src/index.ts',
      name: 'dispatch-optimizer',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [],
    },
  },

  test: {
    globals: true,
    cache: {
      dir: p.join(repoRoot, 'node_modules/.vitest'),
    },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory: p.join(
        repoRoot,
        'coverage/packages/dispatch/dispatch-optimizer'
      ),
      provider: 'v8',
    },
  },
});
