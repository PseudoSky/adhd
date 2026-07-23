/// <reference types='vitest' />
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import * as path from 'path';
import { defineConfig } from 'vite';

const repoRoot = path.resolve(__dirname, '../../..');

export default defineConfig({
  root: __dirname,
  cacheDir: path.join(repoRoot, 'node_modules/.vite/packages/agent/agent-engine-orchestrator'),

  plugins: [nxViteTsPaths()],

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

    reporters: ['default'],
    coverage: {
      reportsDirectory: path.join(
        repoRoot,
        'coverage/packages/agent/agent-engine-orchestrator'
      ),
      provider: 'v8',
    },
  },
});
