/// <reference types='vitest' />
import baseConfig from './vite.config';
import { defineE2eConfig } from '../../../tools/vite-plugins/e2e-config.mjs';

/**
 * Real-extraction E2E lane for this project (docs/decisions/0009-test-lanes-unit-vs-e2e.md).
 *
 * Runs ONLY the `*.e2e.ts` and `*.e2e.test.ts` files under src/: the tier P suite that drives the real ts-morph
 * extractor behind the IR cache layer (`ir-cache-invalidation.e2e.test.ts`). The unit `test` lane excludes exactly these
 * files (`E2E_FILE_EXCLUDES` in `vite.config.ts`). Reached by `nx affected -t e2e --parallel=1` in CI
 * (`tools/gate/lane-gate.mjs`), never by the local pre-push hook; no env gate. The lane mechanics (include-narrowing,
 * distinct cache + coverage dirs) live in the shared factory `tools/vite-plugins/e2e-config.mjs`.
 */
export default defineE2eConfig(baseConfig, __dirname);
