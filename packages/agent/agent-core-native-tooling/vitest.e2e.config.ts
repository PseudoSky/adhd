/// <reference types='vitest' />
import { defineE2eConfig } from '../../../tools/vite-plugins/e2e-config.mjs';

/**
 * Subprocess / real-server E2E lane for this project (backlog 5b839b90 AC1;
 * 0ba70e47 AC3b).
 *
 * Runs ONLY the `*.e2e.test.ts` files under src/ — the suites that spawn real
 * processes (`srt` + `uvx mcp-shell-server`). The unit `test` lane excludes
 * exactly these files (`E2E_FILE_EXCLUDES` in `vite.config.mts`). Reached by
 * `nx affected -t e2e --parallel=1` as its own stage, never in `nx test`; no env
 * gate (the suite needs no paid third-party service — it fails loudly, never
 * skips, if `srt`/`uvx` are missing). Lane mechanics live in the shared factory
 * `tools/vite-plugins/e2e-config.mjs`; the decision is
 * docs/decisions/0009-test-lanes-unit-vs-e2e.md.
 */
// NOTE: deliberately NOT built on `./vite.config.mts`. That config pulls in the
// dts/build plugins, which a CommonJS-loaded `.ts` e2e config cannot import
// (`vite-plugin-dts` default-interop failure). The e2e suite imports only
// `src/` relative modules and type-only `@adhd/*` symbols, so it needs none of
// the library-build plugins — just the test settings below.
export default defineE2eConfig(
  {
    root: __dirname,
    test: {
      name: 'agent-core-native-tooling-e2e',
      watch: false,
      globals: true,
      environment: 'node',
      reporters: ['default'],
    },
  },
  __dirname
);
