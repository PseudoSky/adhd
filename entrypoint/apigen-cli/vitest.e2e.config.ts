/// <reference types='vitest' />
import baseConfig from './vite.config';
import { defineE2eConfig } from '../../tools/vite-plugins/e2e-config.mjs';

/**
 * Resource-consuming e2e lane for `apigen-cli`.
 *
 * Hosts every test that spawns a real subprocess (the built `dist/index.js`,
 * `python3`, a `java`/`mvn`/`javac` JVM, `grpcurl`), binds a real HTTP server to
 * a port, or drives the CPU-heavy real ts-morph extraction pipeline — extracted
 * out of the default `test` target into sibling `*.e2e.ts` files, leaving a cheap
 * `*.spec.ts` STUB at each original path (see those stubs). Runs ONLY those
 * files, and only under the explicitly-invoked `nx run apigen-cli:e2e` target —
 * deliberately absent from every `test.dependsOn` and from `affected`, so
 * `nx affected -t test` / the pre-commit + pre-push hooks never pay for it.
 * Everything else (plugins, `pool`/`--expose-gc`, reporters, timeouts) is
 * inherited from `vite.config.ts`; the lane mechanics (include-narrowing,
 * distinct cache + coverage dirs) live in the shared factory
 * `tools/vite-plugins/e2e-config.mjs`.
 */
export default defineE2eConfig(baseConfig, __dirname);
