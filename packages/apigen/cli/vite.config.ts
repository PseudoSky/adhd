/// <reference types='vitest' />
import { defineConfig, type Plugin } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import * as fs from 'node:fs';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { copyReadme } from '../tools/vite-copy-readme.mjs';
import { builtinModules } from 'node:module';

const OUT_DIR = path.resolve(__dirname, '../../../dist/packages/apigen/cli');

/** Ships the builtin default tsconfig beside the bundled entry so resolve-tsconfig can find it. */
function copyDefaultTsconfig(): Plugin {
  return {
    name: 'apigen-copy-default-tsconfig',
    closeBundle() {
      const src = path.join(__dirname, 'src/lib/default-tsconfig.json');
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.copyFileSync(src, path.join(OUT_DIR, 'default-tsconfig.json'));
    },
  };
}

export default defineConfig({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/packages/apigen/cli',

  plugins: [
    copyReadme(__dirname),
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
    }),
    copyDefaultTsconfig(),
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
      // platform:node standalone entrypoint — the whole @adhd/apigen-* graph
      // (core, runtime, all 5 plugins) is INLINED into index.js so the built CLI
      // runs from anywhere without resolving workspace packages. Only real npm
      // deps and node built-ins stay external (resolved from the install tree).
      external: [
        /^node:/,
        ...builtinModules,
        /^@modelcontextprotocol\/sdk(\/|$)/,
        'commander',
        'fastify',
        'express',
        'ts-morph',
        'ts-json-schema-generator',
        'typescript',
        'tsx',
        /^tsx\//,
        // pino uses worker-thread transports (pino-pretty) that cannot be
        // bundled; keep the whole logging stack external + installed.
        'pino',
        'pino-pretty',
        'pino-http',
        'thread-stream',
        'sonic-boom',
      ],
      output: {
        // Real executable: node shebang on the built entry.
        banner: '#!/usr/bin/env node',
      },
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
