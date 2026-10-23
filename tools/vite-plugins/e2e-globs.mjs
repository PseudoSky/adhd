/**
 * The single definition of which files belong to each vitest lane (backlog 5b839b90 AC1).
 *
 * Tests live in `<project>/test/`, split by lane:
 *   - `test/unit/**\/*.spec.ts(x)` — the unit `test` lane (tiers S).
 *   - `test/e2e/**\/*.e2e.ts`      — the `e2e` lane (tiers P, H and X).
 * Both trees mirror the `src/` directory of the code they exercise. Shared support
 * code lives in `test/helpers/`, data in `test/fixtures/` and `test/golden/`.
 * `check-test-layout.mjs` enforces the layout; `docs/standards/testing.md` states it.
 *
 * A project's `vite.config.ts` sets `test.include` to `UNIT_FILE_INCLUDES` and excludes
 * `E2E_FILE_EXCLUDES`; its `vitest.e2e.config.ts` (via `defineE2eConfig`) sets
 * `test.include` to `E2E_FILE_INCLUDES`. Because the lists live here, a file is in
 * exactly one lane — never both, never neither.
 *
 * See docs/decisions/0009-test-lanes-unit-vs-e2e.md.
 */

/** Include globs (relative to the project root) selecting the unit lane. */
export const UNIT_FILE_INCLUDES = ['test/unit/**/*.spec.ts', 'test/unit/**/*.spec.tsx'];

/** Include globs (relative to the project root) selecting the e2e lane. */
export const E2E_FILE_INCLUDES = ['test/e2e/**/*.e2e.ts'];

/** Exclude globs for the unit lane: the e2e files, rooted at `**` for vitest's `exclude`. */
export const E2E_FILE_EXCLUDES = ['**/*.e2e.ts'];
