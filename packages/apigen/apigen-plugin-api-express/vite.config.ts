/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { projectCacheDir, projectCoverage } from '../../workspace/workspace-base-vite-paths/src/index';
import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';

import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';
export default defineConfig({
  root: __dirname,
  cacheDir: projectCacheDir(__dirname),

  plugins: [
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
      // `*.e2e.ts` suites are resource-consuming tests (see their `.spec.ts`
      // stubs); like `src/test/**` they must never emit declarations into
      // dist/.
      exclude: ['src/test/**', 'src/**/*.e2e.ts'],
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
      name: 'apigen-plugin-api-express',
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
    poolOptions: vitestPoolOptions,
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'node',
    // `*.spec.ts` ONLY — never `*.e2e.ts`. The resource-consuming suites (real
    // live-dispatched Express servers on real ports, driven over real HTTP
    // round-trips) were extracted out of this default target into sibling
    // `*.e2e.ts` files (see their `.spec.ts` stubs); those must never run under
    // `nx affected -t test` or the pre-commit/pre-push hooks. This project has
    // exclusively `*.spec.ts` test files, so narrowing the glob is
    // behaviour-preserving and makes the `.e2e.ts` exclusion structural rather
    // than an emergent property of glob semantics.
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: projectCoverage(__dirname),
      provider: 'v8',
    },
  },
});
