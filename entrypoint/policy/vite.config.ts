/// <reference types='vitest' />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { nxViteTsPathsPre } from '../../tools/vite-plugins/source-resolution.mjs';
import { projectCacheDir, projectCoverage } from '../../packages/workspace/workspace-base-vite-paths/src/index';
import { externalizeRealDeps } from '../../tools/vite-plugins/externalize.mjs';
import { importMetaUrlCjs } from '../../tools/vite-plugins/import-meta-url-cjs.mjs';
import { E2E_FILE_EXCLUDES, UNIT_FILE_INCLUDES } from '../../tools/vite-plugins/e2e-globs.mjs';

export default defineConfig({
  root: __dirname,
  cacheDir: projectCacheDir(__dirname),
  plugins: [importMetaUrlCjs(), nxViteTsPaths(), nxViteTsPathsPre()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    target: 'node20',
    lib: {
      // One bundle per bin. Each entry file is a few lines that call into
      // src/wrapper; the shared code lands in common chunks beside them.
      entry: {
        cli: 'src/entry/cli.ts',
        mcp: 'src/entry/mcp.ts',
        http: 'src/entry/http.ts',
      },
      formats: ['cjs'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      // Bundle only @adhd/* workspace source; externalize every real npm
      // dependency and every Node builtin (same rule as entrypoint/backlog).
      external: externalizeRealDeps(__dirname),
      output: {
        // Real executables: `package.json#bin` points straight at these files.
        banner: '#!/usr/bin/env node',
      },
    },
  },
  test: {
    globals: true,
    cache: { dir: path.join(__dirname, '../../node_modules/.vitest') },
    environment: 'node',
    include: UNIT_FILE_INCLUDES,
    // The socket-binding suites (tier P) are `*.e2e.ts` and run in the `e2e` target (vitest.e2e.config.ts), never here (ADR 0009).
    exclude: [...configDefaults.exclude, ...E2E_FILE_EXCLUDES],
    reporters: ['default'],
    coverage: { reportsDirectory: projectCoverage(__dirname), provider: 'v8' },
  },
});
