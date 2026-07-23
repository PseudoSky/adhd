/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  root: __dirname,
  cacheDir: path.join(repoRoot, 'node_modules/.vite/entrypoint/dispatch-cli'),

  plugins: [
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
      // src/test/** holds test-support (fixtures + the real-e2e harness) that lack a
      // .spec/.test suffix, so tsconfig.lib.json's *.spec/*.test excludes miss them and
      // vite-plugin-dts would ship test/*.d.ts (DEBT-DISPATCH-CLI-TEST-DECL-BLOAT-001).
      // Public API types (index/api/lib) are unaffected.
      exclude: ['bin/**', 'src/test/**'],
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
      name: "dispatch-cli",
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [
        /^node:/,
        /^@modelcontextprotocol\/sdk(\/|$)/,
      ],
    },
  },

  test: {
    globals: true,
    cache: {
      dir: path.join(repoRoot, 'node_modules/.vitest'),
    },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory: path.join(
        repoRoot,
        'coverage/entrypoint/dispatch-cli'
      ),
      provider: 'v8',
    },
  },
});
