/// <reference types='vitest' />
import baseConfig from './vite.config.mts';
import { defineE2eConfig } from '../../../tools/vite-plugins/e2e-config.mjs';

/**
 * Real-server E2E lane for this project (docs/decisions/0009-test-lanes-unit-vs-e2e.md).
 *
 * Runs ONLY the `*.e2e.ts` and `*.e2e.ts` files under src/: the tier P suites that drive the real
 * OpenAI and Anthropic provider adapters over a loopback HTTP socket (`r10-dispatch-trace.e2e.ts`,
 * `r10-s5b-engine-trace.e2e.ts`). The unit `test` lane excludes exactly these files
 * (`E2E_FILE_EXCLUDES` in `vite.config.mts`). Reached by `nx affected -t e2e --parallel=1` in CI
 * (`tools/gate/lane-gate.mjs`), never by the local pre-push hook; no env gate. `vite.config.mts` exports a
 * config FUNCTION, so it is resolved with the same env vitest passes before the shared factory
 * (`tools/vite-plugins/e2e-config.mjs`) narrows it. A plain config function (no `defineConfig` import) keeps `vite`
 * out of the files `@nx/dependency-checks` reads.
 */
export default async (env: Parameters<Extract<typeof baseConfig, (...args: never[]) => unknown>>[0]) =>
  defineE2eConfig(typeof baseConfig === 'function' ? await baseConfig(env) : baseConfig, import.meta.dirname);
