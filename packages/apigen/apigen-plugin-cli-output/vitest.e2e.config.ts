/// <reference types='vitest' />
import baseConfig from './vite.config';
import { defineE2eConfig } from '../../../tools/vite-plugins/e2e-config.mjs';

/**
 * Resource-consuming e2e lane for `apigen-plugin-cli-output`.
 *
 * Hosts every test that spawns the real built `entrypoint/apigen-cli/dist/index.js`
 * via `execFile`, or a real `node <harness>` child process against this
 * package's real built `dist/index.js` (`run-cli-integration.e2e.ts`), plus the
 * real spawned `node -r @swc-node/register <generated cli.ts>` subprocess proof
 * (`root-oneof-branch.e2e.ts`) — extracted out of the default `test` target into
 * sibling `*.e2e.ts` files, leaving the cheap `run-cli-integration.spec.ts` STUB
 * at the original path (and the in-process `root-oneof-branch.spec.ts` unit
 * tests in the default lane). Runs ONLY `src/**\/*.e2e.ts` files, and only under
 * the explicitly-invoked `nx run apigen-plugin-cli-output:e2e` target —
 * deliberately absent from every `test.dependsOn` and from `affected`, so
 * `nx affected -t test` / the pre-commit + pre-push hooks never pay for it.
 * The lane mechanics (include-narrowing, distinct cache + coverage dirs) live in
 * the shared factory `tools/vite-plugins/e2e-config.mjs`.
 */
export default defineE2eConfig(baseConfig, __dirname);
