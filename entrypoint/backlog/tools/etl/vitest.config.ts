/// <reference types='vitest' />
/**
 * vitest.config.ts (tools/etl only) — the root `vite.config.ts` (frozen,
 * shared by every verb under `src/`) scopes `test.include` to `src/**`, so
 * `entrypoint/backlog/tools/etl/*.spec.ts` is invisible to it even when
 * explicitly named on the CLI (confirmed empirically: `npx vitest run
 * tools/etl/x.spec.ts` against the root config reports "No test files
 * found"). This is a second, narrowly-scoped config — not an edit to the
 * root one — so this slice's own tests are runnable via
 * `npx vitest run --config tools/etl/vitest.config.ts <file>` without
 * touching a file any other agent depends on.
 */
import { defineConfig } from 'vite';
import * as path from 'path';

export default defineConfig({
  root: __dirname,
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    include: ['**/*.{test,spec}.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ['default'],
    cache: false,
  },
  // Ephemeral scratch belongs under `tmp/<package>/…` (AGENTS.md §10), never
  // scattered inside `tools/etl/` itself.
  cacheDir: path.join(__dirname, '../../tmp/etl/.vitest-cache'),
});
