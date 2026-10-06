/// <reference types='vitest' />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import { E2E_FILE_EXCLUDES } from '../../../tools/vite-plugins/e2e-globs.mjs';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { projectCacheDir, projectCoverage } from '../../workspace/workspace-base-vite-paths/src/index';

export default defineConfig({
  root: __dirname,
  cacheDir: projectCacheDir(__dirname),

  // Deliberately OMITS nxViteTsPathsPre(): src/__tests__/compile-cli.e2e.test.ts and
  // compile-cli-migration-resolution.e2e.test.ts spawn the BUILT bin
  // (dist/src/cli/compile.js) as a real Node child process, and a real-Node child
  // resolves `@adhd/*` through node_modules to each dependency's built `dist` —
  // it cannot be made to follow the parent's tsconfig paths. The pre-order
  // tsconfig-paths plugin only reorders the vitest PARENT graph, so adding it
  // here would resolve the parent to `src` while the child stays on `dist`: one
  // test run, two builds of one package (BUG-062). Keep this project
  // consistently all-`dist`; `^build` stays in the test target's dependsOn
  // (project.json) so the child's `dist` is always fresh.
  // Do NOT re-add nxViteTsPathsPre() here.
  plugins: [nxViteTsPaths()],

  test: {
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'node',
    // better-sqlite3 is a native addon — same precautions as the shipped
    // registry packages:
    //   pool: 'forks' keeps native finalizers stable on real process exit;
    //   fileParallelism: false serializes files to avoid DB teardown races.
    pool: 'forks',
    fileParallelism: false,
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Subprocess / real-server suites (`*.e2e.ts`, `*.e2e.test.ts`) run in the separate
    // `e2e` lane (vitest.e2e.config.ts), never here (backlog 5b839b90 AC1;
    // docs/decisions/0009-test-lanes-unit-vs-e2e.md). Gated by check-agent-lane-spawn.mjs.
    exclude: [...configDefaults.exclude, ...E2E_FILE_EXCLUDES],

    reporters: ['default'],
    coverage: {
      reportsDirectory: projectCoverage(__dirname),
      provider: 'v8',
    },
  },
});
