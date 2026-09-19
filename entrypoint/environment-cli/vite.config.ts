/// <reference types='vitest' />
import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { projectCacheDir } from '../../packages/workspace/workspace-base-vite-paths/src/index';

import { vitestTestDefaults } from '../../tools/vite-plugins/vitest-pool-defaults.mjs';
export default defineConfig({
  root: __dirname,
  cacheDir: projectCacheDir(__dirname),

  plugins: [nxViteTsPaths()],

  test: {
    ...vitestTestDefaults,
    globals: true,
    cache: {
      dir: '../../node_modules/.vitest',
    },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
  },
});
