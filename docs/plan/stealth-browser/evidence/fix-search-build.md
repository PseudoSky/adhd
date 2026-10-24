# fix-search-build evidence

Change: the operations cache is baked at build time (I-35). `src/server.ts` gains `BAKED_OPERATIONS_FILE` (`operations.baked.json`), `resolveOperations` (baked file, then the runtime cache, then extraction; a baked file whose key mismatches reports a typed HOST_BOOT_FAILED with detail.reason `baked-cache-stale` through `onStale`, then re-extracts), `bakeOperations` (typed HOST_BOOT_FAILED on failure), and the injectable `extractor`, `bakedFile`, `onStale` options and optional `HostFs.rename`. `scripts/bake-operations.mjs` runs as the last step of `build-bin` and writes `dist/operations.baked.json` (declared in the target outputs). Real run: `nx run stealth-search:build-bin` printed `bake-operations: 11 operations -> .../dist/operations.baked.json`; the compiled `resolveOperations` read it in 1 ms with no extraction.

Published manifest: `generateDistManifest` (the dist-manifest step) already deletes `nx`; the source package.json keeps it. The new spec pins that on the generator output. After `nx run stealth-search:dist-manifest` (exit 0) dist/package.json contains no `"nx"` key, while the pre-dist-manifest dist/package.json (assets copy of the source) did contain it.

Specs: test/unit/build/baked-operations.spec.ts [fix-search-build.1], test/unit/build/published-manifest.spec.ts [fix-search-build.2].

RED: baked-operations.spec.ts on untouched src: TypeError: bakeOperations is not a function (6 of 10 tests, I-35 build, cold start, stale, stale versus fresh, baking failure)
RED: baked-operations.spec.ts on untouched src: TypeError: resolveOperations is not a function (I-35 control and corrupt baked file tests)
RED: baked-operations.spec.ts on untouched src: AssertionError: expected 'node node_modules/typescript/bin/tsc ...' to contain 'scripts/bake-operations.mjs' (build-bin has no bake step)
RED: baked-operations.spec.ts on untouched src: Error: ENOENT scripts/bake-operations.mjs; AssertionError: server.ts does not default bakedFile to the baked file next to api.d.ts (10 of 10 tests failed)
RED: published-manifest.spec.ts on untouched source: no assertion fails, because generateDistManifest already strips nx (3 of 4 tests pass); the one failure was my own bin expectation (received bin/cli.js, expected ./bin/cli.js), corrected in the spec. The unstripped state is observable only before dist-manifest: dist/package.json carried `"nx": {` at line 57 after build/assets.
GREEN: baked-operations.spec.ts and published-manifest.spec.ts after the fix: 14 of 14 pass; the full stealth-search:test run passes (757 tests)
EXIT pnpm nx run stealth-search:lint: 0
EXIT pnpm nx run stealth-search:typecheck: 0
EXIT pnpm nx run stealth-search:typecheck-spec: 0
EXIT pnpm nx run stealth-search:test: 0
EXIT pnpm nx run stealth-search:build: 0
EXIT pnpm nx run stealth-search:build-bin: 0
EXIT pnpm nx run stealth-search:dist-manifest: 0
EXIT pnpm nx run stealth-search:verify-dist-load: 0
