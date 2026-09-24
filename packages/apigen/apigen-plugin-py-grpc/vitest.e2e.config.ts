/// <reference types='vitest' />
import baseConfig from './vite.config';
import { defineE2eConfig } from '../../../tools/vite-plugins/e2e-config.mjs';

/**
 * Resource-consuming e2e lane for `apigen-plugin-py-grpc`.
 *
 * Hosts every test that spawns a real managed `python3` interpreter (a live gRPC
 * server bound to an OS-assigned port, driven by the external `grpcurl` binary),
 * plus a `node`/`npx` subprocess for the golden-parity negative control —
 * extracted out of the default `test` target into a sibling `plugin.e2e.ts` file,
 * leaving a cheap `plugin.spec.ts` STUB at the original path. Runs ONLY that
 * file, and only under the explicitly-invoked `nx run apigen-plugin-py-grpc:e2e`
 * target — deliberately absent from every `test.dependsOn` and from `affected`,
 * so `nx affected -t test` / the pre-commit + pre-push hooks never pay for it.
 * The lane mechanics (include-narrowing, distinct cache + coverage dirs) live in
 * the shared factory `tools/vite-plugins/e2e-config.mjs`.
 */
export default defineE2eConfig(baseConfig, __dirname);
