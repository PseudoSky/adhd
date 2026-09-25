/// <reference types='vitest' />
import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { importMetaUrlCjs } from '../../tools/vite-plugins/import-meta-url-cjs.mjs';
import { projectCacheDir, projectCoverage } from '../../packages/workspace/workspace-base-vite-paths/src/index';
import { vitestTestDefaults } from '../../tools/vite-plugins/vitest-pool-defaults.mjs';

export default defineConfig({
  root: __dirname,
  cacheDir: projectCacheDir(__dirname),

  plugins: [importMetaUrlCjs(), nxViteTsPaths()],
  // Deliberately OMITS nxViteTsPathsPre(): src/__tests__/main-entry-symlink.test.ts
  // spawns the REAL built entry (dist/src/index.js) as a Node child process, and
  // a real-Node child resolves `@adhd/*` through node_modules to each
  // dependency's built `dist` — it cannot be made to follow the parent's
  // tsconfig paths. The pre-order tsconfig-paths plugin only reorders the vitest
  // PARENT graph, so adding it here would resolve the parent to `src` while the
  // child stays on `dist`: one test run, two builds of one package (BUG-062).
  // Keep this project consistently all-`dist`; `^build` stays in the test
  // target's dependsOn (project.json) so the child's `dist` is always fresh.
  // Do NOT re-add nxViteTsPathsPre() here.
  plugins: [nxViteTsPaths()],

  build: {
    outDir: 'dist',
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      entry: 'src/index.ts',
      name: 'agent-mcp',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [/@adhd\/.*/],
    },
  },

  test: {
    // Shared worker cap + 30s test timeout (DEBT-TEST-CPU-OVERSUSCRIBED-001).
    // Without this agent-mcp ran on Vitest's 5s default and a config
    // scope-resolution integration test (config.scope-resolution.test.ts, test 4)
    // timed out under a full `nx affected -t test` parallel run (63 projects),
    // reding the gate nondeterministically while passing in isolation — the
    // same class of load-only timeout already fixed for apigen-plugin-ir-cache.
    ...vitestTestDefaults,
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory: projectCoverage(__dirname),
      provider: 'v8',
    },
  },
});
