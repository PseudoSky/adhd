/// <reference types='vitest' />
import baseConfig from './vite.config';
import { defineE2eConfig } from '../../../tools/vite-plugins/e2e-config.mjs';

/**
 * Resource-consuming e2e lane for `python-env`.
 *
 * Hosts the real venv provisioning plus `spawnSync` python probes and a `dist/`
 * copy — extracted out of the default `test` target into the sibling
 * `python-env.e2e.ts` file, with a `python-env.spec.ts` stub left at the original
 * path (see its header). Runs ONLY `*.e2e.ts` files, under the opt-in `e2e`
 * target: never under `nx affected -t test` / the pre-commit + pre-push hooks.
 * The lane mechanics (include-narrowing, distinct cache + coverage dirs) live in
 * the shared factory `tools/vite-plugins/e2e-config.mjs`.
 */
export default defineE2eConfig(baseConfig, __dirname);
