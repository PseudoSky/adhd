/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { importMetaUrlCjs } from '../../tools/vite-plugins/import-meta-url-cjs.mjs';
import { nxViteTsPathsPre } from '../../tools/vite-plugins/source-resolution.mjs';
import { builtinModules } from 'node:module';
import { vitestTestDefaults } from '../../tools/vite-plugins/vitest-pool-defaults.mjs';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apigen-cli',

  plugins: [
    importMetaUrlCjs(),
    nxViteTsPaths(),
    nxViteTsPathsPre(),
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
    ...vitestTestDefaults,
    globals: true,
    cache: {
      dir: '../../node_modules/.vitest',
    },
    environment: 'node',
    // `*.spec.ts` ONLY — never `*.e2e.ts`. The resource-consuming suites (real
    // subprocess spawns of the built `dist/index.js`, real python/JVM hosts,
    // real HTTP servers bound to ports, and the CPU-heavy real ts-morph
    // extraction suites) were extracted out of this default target into sibling
    // `*.e2e.ts` files (see the `*.spec.ts` STUB left at each original path);
    // those must never run under `nx affected -t test` or the pre-commit /
    // pre-push hooks. This project has exclusively `*.spec.ts` test files, so
    // narrowing the glob is behaviour-preserving AND makes the `.e2e.ts`
    // exclusion structural rather than an emergent property of glob semantics.
    // The resource lane runs only via `nx run apigen-cli:e2e` (see the sibling
    // `vitest.e2e.config.ts`, which is the only place that includes `.e2e.ts`).
    include: ['src/**/*.spec.ts'],
    // perf.e2e.ts asserts heap flatness across repeated buildDescriptor runs;
    // it needs a real global.gc so heap measurements are deterministic.
    // worker_threads reject V8 flags in execArgv (ERR_WORKER_INVALID_EXEC_ARGV),
    // so the suite runs in the forks pool, where --expose-gc is legal.
    // Vitest 4 moved `poolOptions.forks.execArgv` to the top-level `execArgv`.
    pool: 'forks',
    execArgv: ['--expose-gc'],

    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apigen-cli',
      provider: 'v8',
    },
  },
});
