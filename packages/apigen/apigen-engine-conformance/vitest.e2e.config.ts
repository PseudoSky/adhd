/// <reference types='vitest' />
import baseConfig from './vite.config';
import { defineE2eConfig } from '../../../tools/vite-plugins/e2e-config.mjs';

/**
 * Resource-consuming e2e lane for `apigen-engine-conformance`.
 *
 * Hosts `gate.e2e.ts` — the resource-consuming half of the conformance-gate test
 * surface: the live-matrix assertions (asserted against the durable report the
 * `conformance` target's single live run wrote) and the `runJavaMatrix`
 * negative-control proof (a real JVM) — extracted out of the default `test`
 * target, leaving the pure-logic tests in `gate.spec.ts`. Runs ONLY `*.e2e.ts`,
 * and only under the explicitly-invoked `nx run apigen-engine-conformance:e2e`
 * target — deliberately absent from every `test.dependsOn` and from `affected`,
 * so `nx affected -t test` / the pre-commit + pre-push hooks never pay for it.
 * The lane mechanics (include-narrowing, distinct cache + coverage dirs) live in
 * the shared factory `tools/vite-plugins/e2e-config.mjs`.
 */
export default defineE2eConfig(baseConfig, __dirname);
