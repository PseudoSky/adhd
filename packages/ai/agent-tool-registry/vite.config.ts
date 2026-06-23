/// <reference types='vitest' />
import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/packages/ai/agent-tool-registry',

  plugins: [
    nxViteTsPaths(),
  ],

  test: {
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'node',
    // better-sqlite3 is a native addon; pool:'forks' prevents teardown SIGSEGVs
    // when the native finalizer runs (worker_threads tear down unreliably with
    // native addons). fileParallelism:false serializes files to avoid DB races.
    pool: 'forks',
    fileParallelism: false,
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/packages/ai/agent-tool-registry',
      provider: 'v8',
    },
  },
});
