# Open decisions

## OD-11 (provisional, reversible)

Question: which package owns the Google result-page (SERP) walker?

Provisional decision, pending the product owner: ONE walker, in the core.

- Kept: `packages/stealth/stealth-core-browser/src/lib/capture/dom.ts` holds the structural walker
  (`extractStructuralFromDom`, reached through the public `capture.walkDomTree` with
  `{ structural: true }`). It now also unwraps the `/goto?url=` Google redirect, which only the search copy did.
- Deleted: the search-side copy in `entrypoint/stealth-search/src/lib/dom.ts` (`extractGoogleSerp` body,
  `hasDivDiv`, `findHeadingText`, `findContainer`, `findSnippet`). `extractGoogleSerp` remains as an async
  adapter that replays the already-fetched tree through `capture.walkDomTree`.
- Deleted: the title fallback that split the anchor text on `/\s{2,}|•|\|/` and took the shortest chunk. It was
  dead in both copies, because `getText` collapses whitespace before the split. An anchor without a heading is
  now skipped instead of receiving a guessed title.

Restore the search-side walker: the last commit that carried it is `9237096eb`
(`git show 9237096eb:entrypoint/stealth-search/src/lib/dom.ts`). Copy the "Google SERP walker" section back
into `src/lib/dom.ts`, make `extractGoogleSerp` synchronous again, restore `/\s{2,}` handling only if
`getText` stops collapsing whitespace, and revert `test/unit/engine/serp-single-walker.spec.ts` plus the
`extractGoogleSerp` cases of `test/unit/engine/dom.spec.ts` to their `9237096eb` state.
