/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { importMetaUrlCjs } from '../../../tools/vite-plugins/import-meta-url-cjs.mjs';
import { projectCacheDir, projectCoverage } from '../../workspace/workspace-base-vite-paths/src/index';
import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';

import { vitestTestDefaults } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';
export default defineConfig({
  root: __dirname,
  cacheDir: projectCacheDir(__dirname),

  // Deliberately OMITS nxViteTsPathsPre(): src/test/gate-workspace-root.spec.ts
  // esbuild-bundles src/lib/gate.ts (with `--external:@adhd/*`) and runs it in a
  // real Node child process, which resolves `@adhd/*` through node_modules to
  // each dependency's built `dist` — it cannot be made to follow the parent's
  // tsconfig paths. The pre-order tsconfig-paths plugin only reorders the vitest
  // PARENT graph, so adding it here would resolve the parent to `src` while the
  // child stays on `dist`: one test run, two builds of one package (BUG-062).
  // Keep this project consistently all-`dist`; `^build` stays in the test
  // target's dependsOn (nx.json targetDefaults) so the child's `dist` is fresh.
  // Do NOT re-add nxViteTsPathsPre() here.
  plugins: [
    importMetaUrlCjs(),
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
    }),
  ],

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      entry: 'src/index.ts',
      name: 'apigen-conformance',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // Bundle only @adhd/* workspace source (no workspace symlinks in
      // this repo — see tools/vite-external-deps.mjs); externalize every
      // real npm dependency + Node builtin. See BACKLOG.md
      // INVESTIGATION-BUILD-TOOL-001.
      external: externalizeRealDeps(__dirname),
    },
  },

  test: {
    ...vitestTestDefaults,
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory: projectCoverage(__dirname),
      provider: 'v8',
    },
  },
});
