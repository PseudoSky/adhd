/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { externalizeRealDeps } from '../../tools/vite-plugins/externalize.mjs';

const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  root: __dirname,
  cacheDir: path.join(repoRoot, 'node_modules/.vite/entrypoint/backlog'),

  plugins: [
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
      // src/test/** holds test-support (fixtures + the real-server-spawn
      // harness) that lacks a .spec/.test suffix, so tsconfig.lib.json's
      // *.spec/*.test excludes miss them — never ship test .d.ts.
      exclude: ['src/test/**'],
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
      name: 'backlog',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // Bundle only @adhd/* workspace source (no workspace node_modules
      // symlinks in this repo — see externalize.mjs's doc comment);
      // externalize every real npm dependency (better-sqlite3 — a native
      // module that must never be bundled — plus fastify, the MCP SDK,
      // ts-morph/typescript transitively via apigen-core-client, and
      // `@adhd/sox-graph-store`, the first externally-published npm package
      // in this monorepo to also carry the `@adhd/` scope) + every Node
      // builtin. See BACKLOG.md INVESTIGATION-BUILD-TOOL-001 and this
      // package's DESIGN.md §10.
      external: externalizeRealDeps(__dirname),
      output: {
        // Real executable: node shebang on the built entry, matching
        // `entrypoint/apigen-cli`'s proven `bin` mechanism (its
        // `vite.config.ts` uses the identical banner). Harmless for the
        // library-import path (`require('@adhd/backlog')` /
        // `require(distIndexPath)`, e.g. `src/test/fixtures/mcp-stdio-
        // entry.js`) — Node's module loader strips a leading `#!` line for
        // ANY `.js`/`.mjs` file it compiles, not only the process's main
        // module.
        banner: '#!/usr/bin/env node',
      },
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
    testTimeout: 30000,
    hookTimeout: 30000,

    reporters: ['default'],
    coverage: {
      reportsDirectory: path.join(repoRoot, 'coverage/entrypoint/backlog'),
      provider: 'v8',
    },
  },
});
