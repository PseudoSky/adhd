/// <reference types='vitest' />
import baseConfig from './vite.config';
import { defineE2eConfig } from '../../../tools/vite-plugins/e2e-config.mjs';

/**
 * Resource-consuming e2e lane for `apigen-plugin-java-javalin`.
 *
 * Hosts `plugin.e2e.ts` (a real two-phase `mvn` extraction + `javac` compile + a
 * live Javalin `java` server on an ephemeral port) and `process-cleanup.e2e.ts`
 * (real child-process spawn + `SIGTERM` + `pgrep`/`ps` JVM reaping) — extracted
 * out of the default `test` target into sibling `*.e2e.ts` files, leaving a cheap
 * `*.spec.ts` STUB at each original path. Runs ONLY those files, and only under
 * the explicitly-invoked `nx run apigen-plugin-java-javalin:e2e` target —
 * deliberately absent from every `test.dependsOn` and from `affected`, so
 * `nx affected -t test` / the pre-commit + pre-push hooks never pay for it.
 * The lane mechanics (include-narrowing, distinct cache + coverage dirs) live in
 * the shared factory `tools/vite-plugins/e2e-config.mjs`.
 */
export default defineE2eConfig(baseConfig, __dirname);
