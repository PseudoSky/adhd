/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/packages/agent/agent-core-env',

  plugins: [
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
    }),
  ],

  build: {
    // nx's `@nx/vite:build` executor overrides this with project.json's
    // `build.options.outputPath` ({projectRoot}/dist, in-source per
    // PUBLISHING.md) — this value only matters if `vite build` is ever run
    // directly. Matches the identical (also-overridden) value in the
    // sibling `@adhd/environment` (environment-core-node) vite.config.ts.
    outDir: 'dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      entry: 'src/index.ts',
      name: 'agent-core-env',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // Node-only package (platform:node) that depends on a native addon
      // (better-sqlite3) — never bundle node builtins OR this package's own
      // real runtime dependencies. Mirrors the identical fix in the sibling
      // `@adhd/environment` (environment-core-node) vite.config.ts: an empty
      // `external: []` here makes Vite try to browser-externalize
      // `node:fs`/`node:path` (build-breaking `"resolve" is not exported by
      // "__vite-browser-external"`), and bundling `better-sqlite3` would
      // break its native `.node` addon entirely.
      external: [/^node:/, 'better-sqlite3', 'drizzle-orm', 'drizzle-orm/better-sqlite3', '@adhd/environment'],
    },
  },

  test: {
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'node',
    // better-sqlite3 is a native addon. Two settings together keep its teardown
    // race-free (it otherwise SIGSEGVs / exits 139 even though every test passes) —
    // mirrors the identical settings in the 5 registry-family packages' own
    // vite.config.ts (agent-store-prompts, agent-core-provider, ...):
    //   1. pool: 'forks' — run test files in child PROCESSES, not worker threads.
    //   2. fileParallelism: false — serialize files so one file's background
    //      tasks can't race another file's DB finalization.
    pool: 'forks',
    fileParallelism: false,
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/packages/agent/agent-core-env',
      provider: 'v8',
    },
  },
});
