/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/packages/ai/agent-mcp',

  // Resolve workspace @adhd deps imported DYNAMICALLY (e.g. the optional budget
  // plugin via `await import("@adhd/agent-mcp-budget")`) to their SOURCE.
  // nxViteTsPaths aliases static imports, but a bare dynamic-import specifier
  // falls through to node resolution → the package's `exports` (pointing at an
  // unbuilt path like `./index.mjs` or `./src/index.js`) → "failed to resolve
  // entry". An explicit source alias runs the test against source with no build
  // step required.
  //
  // Entries here:
  //   @adhd/agent-mcp-budget — optional plugin; dynamically imported in loader.ts
  //   @adhd/agent-compiler   — optional dep; dynamically imported in index.ts
  //                            (and top-level awaited in integration test files)
  resolve: {
    alias: {
      '@adhd/agent-mcp-budget': path.join(__dirname, '../agent-mcp-budget/src/index.ts'),
      '@adhd/agent-compiler':   path.join(__dirname, '../agent-compiler/src/index.ts'),
    },
  },

  plugins: [
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
    }),
  ],

  // Uncomment this if you are using workers.
  // worker: {
  //  plugins: [ nxViteTsPaths() ],
  // },

  // Configuration for building your library.
  // See: https://vitejs.dev/guide/build.html#library-mode
  build: {
    outDir: '../../../dist/packages/ai/agent-mcp',
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      // Could also be a dictionary or array of multiple entry points.
      entry: 'src/index.ts',
      name: 'ai-agent-mcp',
      fileName: 'index',
      // Change this to the formats you want to support.
      // Don't forget to update your package.json as well.
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // Externalize workspace @adhd packages so dynamic imports (plugin loader,
      // optional deps) can resolve them at runtime via node_modules.
      // Third-party deps (sdk, better-sqlite3, openai, etc.) remain bundled.
      external: [/@adhd\/.*/],
    },
  },

  test: {
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'node',
    // better-sqlite3 is a native addon. Two settings together keep its teardown
    // race-free (it otherwise SIGSEGVs / exits 139 even though every test passes):
    //   1. pool: 'forks' — run test files in child PROCESSES, not worker threads.
    //      better-sqlite3's native finalizers are stable on real process exit but
    //      crash intermittently when a worker_thread is torn down with the addon
    //      loaded (the default 'threads' pool).
    //   2. fileParallelism: false — serialize files so one file's background
    //      tasks (DagEngine dispatch, queued orchestrator runs) can't race another
    //      file's DB finalization.
    // The integration harness also closes each connection (TRUNCATE-checkpoint +
    // close) BEFORE unlinking its temp DB, so handles never accumulate or get
    // checkpointed against a deleted file.
    pool: 'forks',
    fileParallelism: false,
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/packages/ai/agent-mcp',
      provider: 'v8',
    },
  },
});
