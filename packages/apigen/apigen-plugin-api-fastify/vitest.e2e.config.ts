/// <reference types='vitest' />
import baseConfig from './vite.config';
import { defineE2eConfig } from '../../../tools/vite-plugins/e2e-config.mjs';

/**
 * Resource-consuming e2e lane for `apigen-plugin-api-fastify`.
 *
 * Hosts the suite that starts real, live-dispatched Fastify servers bound to
 * real ports and drives them over real HTTP round-trips plus a live SSE frame
 * stream (`plugin.e2e.ts`) — extracted out of the default `test` target, with a
 * `plugin.spec.ts` stub left at the original path (see that stub's header). Runs
 * ONLY the `*.e2e.ts` files, under the opt-in `e2e` target: never under
 * `nx affected -t test` / the pre-commit + pre-push hooks. The lane mechanics
 * (include-narrowing, distinct cache + coverage dirs) live in the shared factory
 * `tools/vite-plugins/e2e-config.mjs`.
 */
export default defineE2eConfig(baseConfig, __dirname);
