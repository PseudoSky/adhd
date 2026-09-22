/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { importMetaUrlCjs } from '../../tools/vite-plugins/import-meta-url-cjs.mjs';
import { projectCacheDir, projectCoverage } from '../../packages/workspace/workspace-base-vite-paths/src/index';

import { vitestTestDefaults } from '../../tools/vite-plugins/vitest-pool-defaults.mjs';
const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  root: __dirname,
  cacheDir: projectCacheDir(__dirname),

  // Deliberately OMITS nxViteTsPathsPre(): src/test/cli-smoke.spec.ts spawns the
  // COMPILED bin (dist/bin/cli.js) as a real Node child process, and a real-Node
  // child resolves `@adhd/*` through node_modules to each dependency's built
  // `dist` — it cannot be made to follow the parent's tsconfig paths. The
  // pre-order tsconfig-paths plugin only reorders the vitest PARENT graph, so
  // adding it here would resolve the parent to `src` while the child stays on
  // `dist`: one test run, two builds of one package (BUG-062). Keep this project
  // consistently all-`dist`; `^build` stays in the test target's dependsOn
  // (project.json) so the child's `dist` is always fresh.
  // Do NOT re-add nxViteTsPathsPre() here.
  plugins: [
    importMetaUrlCjs(),
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
    ...vitestTestDefaults,
    globals: true,
    cache: {
      dir: path.join(repoRoot, 'node_modules/.vitest'),
    },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory: projectCoverage(__dirname),
      provider: 'v8',
    },
  },
});
