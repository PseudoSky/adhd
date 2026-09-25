/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { importMetaUrlCjs } from '../../../tools/vite-plugins/import-meta-url-cjs.mjs';
import { nxViteTsPathsPre } from '../../../tools/vite-plugins/source-resolution.mjs';
import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';

import { vitestTestDefaults } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';
export default defineConfig({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/packages/apigen/plugins/java-javalin',

  plugins: [
    importMetaUrlCjs(),
    nxViteTsPaths(),
    nxViteTsPathsPre(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
    }),
  ],

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      entry: 'src/index.ts',
      name: 'apigen-plugin-java-javalin',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // Bundle only @adhd/* workspace source (no workspace symlinks in
      // this repo — see tools/vite-external-deps.mjs); externalize every
      // real npm dependency + Node builtin. See BACKLOG.md
      // INVESTIGATION-BUILD-TOOL-001.
      external: externalizeRealDeps(__dirname),
    },
  },

  test: {
    ...vitestTestDefaults,
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'node',
    // `*.spec.ts` ONLY — never `*.e2e.ts`. The resource-consuming suites (a
    // real `mvn`/`javac`/`java` pipeline + a real Javalin server bound to a
    // port, and the real child-process SIGTERM/`pgrep` hygiene test) were
    // extracted out of this default target into sibling `*.e2e.ts` files (see
    // the `*.spec.ts` STUB left at each original path); those must never run
    // under `nx affected -t test` or the pre-commit / pre-push hooks. The
    // resource lane runs only via `nx run apigen-plugin-java-javalin:e2e`
    // (see the sibling `vitest.e2e.config.ts`, the only place that includes
    // `.e2e.ts`).
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/packages/apigen/plugins/java-javalin',
      provider: 'v8',
    },
    // Real mvn subprocess + real Javalin server + real HTTP round trip — the
    // integration tests in plugin.e2e.ts spawn a JVM (compile + start) and
    // wait for a real port bind, so they need headroom beyond vitest's
    // default 5s test / hook timeouts. (Inherited by `vitest.e2e.config.ts`
    // via mergeConfig; harmless for the default `*.spec.ts` lane, which has no
    // long-running case.)
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
