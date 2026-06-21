/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { builtinModules } from 'node:module';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/packages/apigen/cli',

  plugins: [
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
    }),
  ],

  build: {
    outDir: '../../../dist/packages/apigen/cli',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      entry: 'src/index.ts',
      name: 'apigen-cli',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // platform:node entrypoint — externalize all node built-ins and heavy deps.
      external: [
        /^node:/,
        ...builtinModules,
        /^@modelcontextprotocol\/sdk(\/|$)/,
        /^@adhd\//,
        'commander',
        'fastify',
        'express',
      ],
    },
  },

  test: {
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/packages/apigen/cli',
      provider: 'v8',
    },
  },
});
