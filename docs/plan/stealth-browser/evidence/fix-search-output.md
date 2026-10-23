# fix-search-output evidence

Change: `search` output gains a byte bound. `DEFAULT_MAX_RESULT_BYTES` (8192, exported from `src/lib/search.ts`) bounds `Buffer.byteLength(JSON.stringify(output))`; input `maxResultBytes` overrides it (positive integer, else SEARCH_FAILED with detail.reason `invalid-option`, detail.field `maxResultBytes`, raised before any page opens). `boundResults` runs in `shapeEngine` after the engine's own result count: whole results are kept from the head, never cut mid-record, and `SearchOutput.omitted` carries the dropped count (absent when nothing is dropped; there is no `truncated` boolean because api.ts permits no optional boolean property, enforced by surface.spec.ts). `SearchDeps.providers` injects the provider registry (default: the module `PROVIDERS`); `retry.spec.ts` now passes a per-test copy built by `providersWithGithubRetry` (test/helpers/verbs/harness.ts) and no spec under test/unit assigns to `PROVIDERS.*`.

Specs: test/unit/verbs/result-bytes.spec.ts [fix-search-output.1], test/unit/verbs/registry-pristine.spec.ts [fix-search-output.2], test/unit/verbs/retry.spec.ts (abort case via injected registry).

RED: result-bytes.spec.ts on untouched src: AssertionError: expected undefined to be 8192 (DEFAULT_MAX_RESULT_BYTES not exported), result-bytes.spec.ts:28
RED: result-bytes.spec.ts on untouched src: AssertionError: expected undefined to be true (no truncation marker on 40 long-snippet results), result-bytes.spec.ts:39
RED: result-bytes.spec.ts on untouched src: AssertionError: expected [ { title: 'Result 0', ... }, ...(39) ] to deeply equal [] (maxResultBytes ignored, all 40 results returned)
RED: result-bytes.spec.ts on untouched src: maxResultBytes 0, -1, 1.5 and NaN do not raise SEARCH_FAILED (8 of 10 tests failed)
RED: registry-pristine.spec.ts on untouched src: AssertionError: expected { provider: 'github', ... } to match object { outcome: 'timeout', attempts: 1 } (the injected registry is ignored), registry-pristine.spec.ts:21
RED: retry.spec.ts on untouched src: "decideRetry onTimeout 'abort' stops after the first timeout" failed once the PROVIDERS.github.retry mutation was removed (1 of 9 failed)
GREEN: result-bytes.spec.ts, registry-pristine.spec.ts, retry.spec.ts after the fix: all pass; the full stealth-search:test run passes 

EXIT pnpm nx run stealth-search:lint: 0
EXIT pnpm nx run stealth-search:typecheck: 0
EXIT pnpm nx run stealth-search:typecheck-spec: 0
EXIT pnpm nx run stealth-search:test: 0
