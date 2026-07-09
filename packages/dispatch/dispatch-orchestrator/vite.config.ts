/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import fs from 'node:fs';
import pathMod from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');
const distDir = path.join(repoRoot, 'dist/packages/dispatch/dispatch-orchestrator');

export default defineConfig({
  root: __dirname,
  cacheDir: path.join(repoRoot, 'node_modules/.vite/packages/dispatch/dispatch-orchestrator'),

  plugins: [
    {
      name: 'apigen-copy-readme',
      apply: 'build',
      closeBundle() {
        const srcPath = pathMod.resolve(__dirname, 'README.md');
        if (!fs.existsSync(srcPath)) return;
        fs.mkdirSync(distDir, { recursive: true });
        fs.copyFileSync(srcPath, pathMod.join(distDir, 'README.md'));
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
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      entry: 'src/index.ts',
      name: "dispatch-orchestrator",
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [
        /^node:/,
        /^@modelcontextprotocol\/sdk(\/|$)/,
      ],
    },
  },

  test: {
    globals: true,
    cache: {
      dir: path.join(repoRoot, 'node_modules/.vitest'),
    },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory: path.join(
        repoRoot,
        'coverage/packages/dispatch/dispatch-orchestrator'
      ),
      provider: 'v8',
    },
  },
});
