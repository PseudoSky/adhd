/// <reference types='vitest' />
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { importMetaUrlCjs } from '../../../tools/vite-plugins/import-meta-url-cjs.mjs';
import { nxViteTsPathsPre } from '../../../tools/vite-plugins/source-resolution.mjs';
import { projectCacheDir, projectCoverage } from '../../workspace/workspace-base-vite-paths/src/index';
import * as path from 'path';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import { E2E_FILE_EXCLUDES } from '../../../tools/vite-plugins/e2e-globs.mjs';

const repoRoot = path.resolve(__dirname, '../../..');

export default defineConfig({
  root: __dirname,
  cacheDir: projectCacheDir(__dirname),

  // ONE array: a duplicate `plugins:` key would silently drop every plugin but
  // the last (importMetaUrlCjs() was the casualty — backlog 50b77657). All
  // three are required: importMetaUrlCjs() restores `import.meta.url` in the
  // CJS output; nxViteTsPaths()/nxViteTsPathsPre() provide test-time @adhd/*
  // source resolution.
  plugins: [importMetaUrlCjs(), nxViteTsPaths(), nxViteTsPathsPre()],

  build: {
    outDir: 'dist',
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      entry: 'src/index.ts',
      name: 'agent-engine-orchestrator',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [/@adhd\/.*/],
    },
  },

  test: {
    globals: true,
    cache: {
      dir: path.join(repoRoot, 'node_modules/.vitest'),
    },
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Subprocess / real-server suites (`*.e2e.ts`, `*.e2e.test.ts`) run in the separate
    // `e2e` lane (vitest.e2e.config.ts), never here (backlog 5b839b90 AC1;
    // docs/decisions/0009-test-lanes-unit-vs-e2e.md). Gated by check-agent-lane-spawn.mjs.
    exclude: [...configDefaults.exclude, ...E2E_FILE_EXCLUDES],

    reporters: ['default'],
    coverage: {
      reportsDirectory: projectCoverage(__dirname),
      provider: 'v8',
    },
  },
});
