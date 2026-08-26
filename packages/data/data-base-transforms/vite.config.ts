/// <reference types='vitest' />
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { projectCacheDir, projectCoverage } from '../../workspace/workspace-base-vite-paths/src/index';
import * as path from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

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

  // Uncomment this if you are using workers.
  // worker: {
  //  plugins: [ nxViteTsPaths() ],
  // },

  // Configuration for building your library.
  // See: https://vitejs.dev/guide/build.html#library-mode
  build: {
    sourcemap: 'inline',
    outDir: 'dist',
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      // Could also be a dictionary or array of multiple entry points.
      entry: 'src/index.ts',
      name: 'transform',
      fileName: 'index',
      // Change this to the formats you want to support.
      // Don't forget to update your package.json as well.
      formats: ['es', 'cjs', 'umd'],
    },
    rollupOptions: {
      // External packages that should not be bundled into your library.
      external: [],
    },
  },

  test: {
    // date.spec.ts stubs TZ via `vi.stubEnv('TZ', ...)` to make timezone-
    // dependent formatting deterministic. Node only wires the live-TZ-
    // invalidation hook into `process.env`'s setter on a process's main
    // thread; a `worker_threads` worker (vitest's default `'threads'` pool)
    // never observes a `TZ` mutation made after the thread starts, so
    // `Intl`/`Date` local-time resolution silently keeps leaking the host
    // machine's real default timezone regardless of the stub — this made
    // date.spec.ts pass only by coincidence on machines whose real TZ
    // happened to match the hardcoded expectations, and fail elsewhere
    // (DEBT-DATA-BASE-TRANSFORMS-DATE-SPEC-TZ-FLAKE-001). `'forks'` gives
    // each test file its own child process, whose main thread does observe
    // the stub — verified directly: `vi.stubEnv('TZ','UTC')` correctly
    // flips `Intl.DateTimeFormat().resolvedOptions().timeZone` under
    // `'forks'` but not under `'threads'`.
    pool: 'forks',
    poolOptions: vitestPoolOptions,
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
