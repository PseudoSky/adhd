/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import fs from 'node:fs';
import pathMod from 'node:path';
import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';

const repoRoot = path.resolve(__dirname, '../../..');
const distDir = path.join(repoRoot, 'dist/packages/dispatch/dispatch-serializer-json');

export default defineConfig({
  root: __dirname,
  cacheDir: path.join(repoRoot, 'node_modules/.vite/packages/dispatch/dispatch-serializer-json'),

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
      name: "dispatch-serializer-json",
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // Bundle only @adhd/* workspace source (no workspace symlinks resolve
      // to source, only to each package's own dist — see
      // tools/vite-plugins/externalize.mjs); externalize every real npm
      // dependency + Node builtin (this package imports 'fs'/'path'
      // directly). Previously `external: []` bundled 'fs'/'path' as if they
      // were ordinary modules; Rollup couldn't resolve them and emitted
      // `(void 0)` call-site placeholders in the built dist, which is what
      // pnpm's real node_modules/@adhd/* workspace symlinks (main ->
      // ./dist/index.js) now load transitively via dispatch-core-client,
      // crashing dispatch-orchestrator's tests with "(void 0) is not a
      // function". See BACKLOG.md BUG-DISPATCH-SERIALIZER-EXTERNAL-001.
      external: externalizeRealDeps(__dirname),
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
        'coverage/packages/dispatch/dispatch-serializer-json'
      ),
      provider: 'v8',
    },
  },
});
