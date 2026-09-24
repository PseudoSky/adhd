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
      name: 'apigen-plugin-py-grpc',
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
    // `*.spec.ts` ONLY — never `*.e2e.ts`. The resource-consuming suite (a real
    // spawned `python3` gRPC server bound to a port, driven by `grpcurl`) was
    // extracted out of this default target into a sibling `plugin.e2e.ts` file
    // (see the `plugin.spec.ts` STUB left at the original path); it must never
    // run under `nx affected -t test` or the pre-commit / pre-push hooks.
    // Narrowing the glob is behaviour-preserving AND makes the `.e2e.ts`
    // exclusion structural rather than an emergent property of glob semantics.
    // The resource lane runs only via `nx run apigen-plugin-py-grpc:e2e` (see
    // the sibling `vitest.e2e.config.ts`, the only place that includes `.e2e.ts`).
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: projectCoverage(__dirname),
      provider: 'v8',
    },
  },
});
