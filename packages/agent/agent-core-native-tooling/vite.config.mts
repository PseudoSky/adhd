/// <reference types='vitest' />
import { configDefaults } from 'vitest/config';
import { defineConfig } from 'vite';
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
import { E2E_FILE_EXCLUDES } from '../../../tools/vite-plugins/e2e-globs.mjs';
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
      name: 'agent-core-native-tooling',
      fileName: 'index',
      // CommonJS-only per adhd ADR-0003 (single `main: ./dist/index.js`, no
      // `module`, no `exports` map, `type` unset). The production build is `tsc`
      // (see project.json); this entry exists so any vite build stays consistent.
      formats: ['cjs' as const],
    },
    rolldownOptions: {
      // External packages that should not be bundled into your library.
      external: externalizeRealDeps(__dirname),
    },
  },
  test: {
    name: 'agent-core-native-tooling',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Subprocess suites (real srt + uvx) run in the `e2e` lane (ADR-0009).
    exclude: [...configDefaults.exclude, ...E2E_FILE_EXCLUDES],
    reporters: ['default'],
    coverage: {
      reportsDirectory: projectCoverage(__dirname),
      provider: 'v8' as const,
    },
  },
}));
