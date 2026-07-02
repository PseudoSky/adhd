/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import fs from 'node:fs';
import pathMod from 'node:path';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/packages/dispatch/dispatch-cli',

  plugins: [
    {
      // ship README.md into dist (npm page) — @nx/vite:build ignores project.json assets
      name: 'apigen-copy-readme',
      apply: 'build',
      closeBundle() {
        const srcPath = pathMod.resolve(__dirname, 'README.md');
        if (!fs.existsSync(srcPath)) return;
        const outDir = pathMod.resolve(__dirname, '../../../dist/packages/dispatch/dispatch-cli');
        fs.mkdirSync(outDir, { recursive: true });
        fs.copyFileSync(srcPath, pathMod.join(outDir, 'README.md'));
      },
    },
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
      // bin/cli.ts is a standalone, hand-written CLI entrypoint (never
      // imported by src/index.ts or any consumer) — it's in
      // tsconfig.lib.json's `include` only so `nx typecheck` covers it
      // (matches packages/decompile's precedent). Excluded here so
      // vite-plugin-dts doesn't try to bundle a declaration for it outside
      // entryRoot ("Outside emitted" — a stray dist/packages/dispatch/bin/
      // artifact with no consumer).
      exclude: ['bin/**'],
    }),
  ],

  // Uncomment this if you are using workers.
  // worker: {
  //  plugins: [ nxViteTsPaths() ],
  // },

  // Configuration for building your library.
  // See: https://vitejs.dev/guide/build.html#library-mode
  build: {
    outDir: '../../../dist/packages/dispatch/dispatch-cli',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      // Could also be a dictionary or array of multiple entry points.
      entry: 'src/index.ts',
      name: "dispatch-cli",
      fileName: 'index',
      // Change this to the formats you want to support.
      // Don't forget to update your package.json as well.
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [
        // platform:node — resolve node builtins from the runtime instead of
        // bundling/stubbing them for a browser target (matches
        // apigen/python-env's and dispatch-orchestrator's pattern).
        /^node:/,
        // Real npm dep, not a workspace package — reached transitively via
        // @adhd/dispatch-orchestrator's agent-runner.ts (AgentMcpRunner),
        // whose source this package's build bundles directly through the
        // tsconfig path mapping. Resolved from the consumer's install tree
        // rather than bundled (matches dispatch-orchestrator's own pattern).
        /^@modelcontextprotocol\/sdk(\/|$)/,
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
      reportsDirectory: '../../../coverage/packages/dispatch/dispatch-cli',
      provider: 'v8',
    },
  },
});
