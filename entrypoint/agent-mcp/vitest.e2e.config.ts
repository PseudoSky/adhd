/// <reference types='vitest' />
import baseConfig from './vite.config';
import { defineE2eConfig } from '../../tools/vite-plugins/e2e-config.mjs';

/**
 * Subprocess / real-server E2E lane for this project (backlog 5b839b90 AC1).
 *
 * Runs ONLY the `*.e2e.ts` and `*.e2e.test.ts` files under src/ — the suites that spawn
 * processes (stdio MCP servers via npx/uvx/srt, built bins, forked lock holders).
 * The unit `test` lane excludes exactly these files (`E2E_FILE_EXCLUDES` in
 * `vite.config.ts`). Reached by `nx affected -t e2e --parallel=1` at the push/CI
 * gate (`tools/gate/lane-gate.mjs`), default-running, no env gate. Lane mechanics
 * (include narrowing, distinct cache + coverage) live in the shared factory
 * `tools/vite-plugins/e2e-config.mjs`; the decision is
 * docs/decisions/0009-test-lanes-unit-vs-e2e.md. Per ADR-0008:32 any e2e that spawns
 * agent-mcp passes an isolated cwd + fake HOME.
 */
export default defineE2eConfig(baseConfig, __dirname);
