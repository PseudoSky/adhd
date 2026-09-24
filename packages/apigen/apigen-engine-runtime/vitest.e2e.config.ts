/// <reference types='vitest' />
import baseConfig from './vite.config';
import { defineE2eConfig } from '../../../tools/vite-plugins/e2e-config.mjs';

/**
 * Resource-consuming e2e lane for `apigen-engine-runtime`.
 *
 * Hosts `isolated-git.e2e.ts` (real `git` subprocesses creating/mutating
 * disposable repos) and `parity-harness.e2e.ts` (a real `node:http` server over
 * real `fetch` + a real `git apply` cycle) — the suites extracted out of the
 * default `test` target, leaving a cheap `*.spec.ts` stub at each original path.
 * Both are currently `describe.skip`'d (CPU-THRASH-SKIP, owner-requested),
 * preserved verbatim; the lane exists so they have their correct home the moment
 * the owner re-enables them.
 *
 * Runs only under the explicitly-invoked `nx run apigen-engine-runtime:e2e` —
 * deliberately absent from every `test.dependsOn` and from `affected`, so
 * `nx affected -t test` / the pre-commit + pre-push hooks never pay for it.
 * The lane mechanics (include-narrowing, distinct cache + coverage dirs) live in
 * the shared factory `tools/vite-plugins/e2e-config.mjs`.
 */
export default defineE2eConfig(baseConfig, __dirname);
