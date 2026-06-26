/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/packages/ai/agent-provider',

  plugins: [
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
    }),
  ],

  build: {
    outDir: '../../../dist/packages/ai/agent-provider',
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      entry: 'src/index.ts',
      name: 'ai-agent-provider',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [],
    },
  },

  test: {
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'node',
    // better-sqlite3 is a native addon. Two settings together keep its teardown
    // race-free (it otherwise SIGSEGVs / exits 139 even though every test passes):
    //   1. pool: 'forks' — run test files in child PROCESSES, not worker threads.
    //      better-sqlite3's native finalizers are stable on real process exit but
    //      crash intermittently when a worker_thread is torn down with the addon
    //      loaded (the default 'threads' pool).
    //   2. fileParallelism: false — serialize files so one file's background
    //      tasks can't race another file's DB finalization.
    pool: 'forks',
    fileParallelism: false,
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/packages/ai/agent-provider',
      provider: 'v8',
    },
  },
});
