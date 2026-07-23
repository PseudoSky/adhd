/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { builtinModules } from 'node:module';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apigen-cli',

  plugins: [
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
    }),
  ],

  build: {
    outDir: 'dist',
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
      dir: '../../node_modules/.vitest',
    },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // perf.spec.ts asserts heap flatness across repeated buildDescriptor runs;
    // it needs a real global.gc so heap measurements are deterministic.
    // worker_threads reject V8 flags in execArgv (ERR_WORKER_INVALID_EXEC_ARGV),
    // so the suite runs in the forks pool, where --expose-gc is legal.
    pool: 'forks',
    poolOptions: {
      forks: { execArgv: ['--expose-gc'] },
    },

    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apigen-cli',
      provider: 'v8',
    },
  },
});
