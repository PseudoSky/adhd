# fix-search-fetch evidence

Spec: entrypoint/stealth-search/test/unit/fetch/fetch-resolve.spec.ts [fix-search-fetch.1]

RED: on the untouched source, `pnpm exec vitest run test/unit/fetch/fetch-resolve.spec.ts` failed 9 of 10 tests; first assertion `expect(r.outcome).toBe('error')` at fetch-resolve.spec.ts:50 got `AssertionError: expected 'success' to be 'error'` (a host resolving to 169.254.169.254 was fetched), and `TypeError: resolveAndCheck is not a function`.

GREEN: after the fix, `pnpm exec vitest run test/unit/fetch test/unit/use-cases test/unit/examples` passed 14 files, 158 tests, including all 10 in fetch-resolve.spec.ts.

fetch-route.spec.ts: no non-null assertion remains (narrowing guard `if (!settle) throw`); lint prints no warning for it.
