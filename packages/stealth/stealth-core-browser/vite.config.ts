/// <reference types='vitest' />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import { E2E_FILE_EXCLUDES } from '../../../tools/vite-plugins/e2e-globs.mjs';
import { vitestTestDefaults } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { nxViteTsPathsPre } from '../../../tools/vite-plugins/source-resolution.mjs';
import {
  projectCacheDir,
  projectCoverage,
} from '../../workspace/workspace-base-vite-paths/src/index';
import { importMetaUrlCjs } from '../../../tools/vite-plugins/import-meta-url-cjs.mjs';
import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';
import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: projectCacheDir(__dirname),
  // NOTE (test resolution): the pre-ordered tsconfig-paths plugin below makes
  // the vitest PARENT resolve @adhd/* to `src`. If this project's tests spawn a
  // real Node child process (which resolves @adhd/* from each dependency's built
  // `dist`), DELETE that pre-ordered plugin and keep ^build in the test target —
  // otherwise one test run uses two builds. See BUG-062.
  plugins: [
    importMetaUrlCjs(),
    nxViteTsPaths(),
    nxViteTsPathsPre(),
    nxCopyAssetsPlugin(['*.md']),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(import.meta.dirname, 'tsconfig.lib.json'),
      // src/test/** holds test-support lacking a .spec/.test suffix; keep it out of shipped declarations.
      exclude: ['src/test/**'],
      pathsToAliases: false,
    }),
  ],
  // Uncomment this if you are using workers.
  // worker: {
  //   plugins: () => [ nxViteTsPaths() ],
  // },
  // Configuration for building your library.
  // See: https://vite.dev/guide/build.html#library-mode
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      // Could also be a dictionary or array of multiple entry points.
      entry: 'src/index.ts',
      name: 'stealth-core-browser',
      fileName: 'index',
      // CJS only (ADR-0003).
      formats: ['cjs' as const],
    },
    rolldownOptions: {
      // External packages that should not be bundled into your library.
      external: externalizeRealDeps(__dirname),
    },
  },
  test: {
    ...vitestTestDefaults,
    name: 'stealth-core-browser',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Subprocess / real-server suites run in the separate e2e lane, never here
    // (docs/decisions/0009-test-lanes-unit-vs-e2e.md).
    exclude: [...configDefaults.exclude, ...E2E_FILE_EXCLUDES],
    reporters: ['default'],
    coverage: {
      reportsDirectory: projectCoverage(__dirname),
      provider: 'v8' as const,
    },
  },
}));
