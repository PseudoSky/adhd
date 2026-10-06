/**
 * The single definition of which files belong to the `e2e` lane (backlog 5b839b90 AC1).
 *
 * Two filename conventions exist and both are first-class:
 *   - `*.e2e.ts`       — the apigen-* / entrypoint/backlog convention.
 *   - `*.e2e.test.ts`  — the agent-family convention (agent-mcp, dispatch-cli,
 *                         agent-*), so editors and tsconfig.lib excludes that key
 *                         on `*.test.ts` keep treating them as tests.
 *
 * A project's unit `test` lane EXCLUDES these (`E2E_FILE_EXCLUDES`, merged into its
 * `vite.config.ts` `test.exclude`); its `e2e` lane INCLUDES exactly these
 * (`E2E_FILE_INCLUDES`, via `defineE2eConfig`). Because both lists derive from the
 * one array below, a file is in exactly one lane — never both, never neither.
 *
 * See docs/decisions/0009-test-lanes-unit-vs-e2e.md.
 */

/** Include globs (relative to the project root) selecting the e2e lane. */
export const E2E_FILE_INCLUDES = ['src/**/*.e2e.ts', 'src/**/*.e2e.test.ts'];

/** Exclude globs for the unit lane: the same files, rooted at `**` for vitest's `exclude`. */
export const E2E_FILE_EXCLUDES = ['**/*.e2e.ts', '**/*.e2e.test.ts'];
