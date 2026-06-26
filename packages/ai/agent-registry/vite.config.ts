/// <reference types='vitest' />
import { defineConfig } from 'vite';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/packages/ai/agent-registry',

  plugins: [
    nxViteTsPaths(),
  ],

  test: {
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'node',
    // better-sqlite3 is a native addon — same precautions as agent-mcp:
    //   pool: 'forks' keeps native finalizers stable on real process exit;
    //   fileParallelism: false serializes files to avoid DB teardown races.
    pool: 'forks',
    fileParallelism: false,
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/packages/ai/agent-registry',
      provider: 'v8',
    },
  },
});
