# fix-core-parsers evidence

extractSnippet (src/lib/parsers.ts) started its 500-character window before the card, so on a list of short cards it returned the previous card's snippet. The window now starts at the card's own match index and still extends 5000 characters forward.

Spec: packages/stealth/stealth-core-browser/test/unit/parsers/extract-snippet.spec.ts (12 short cards rendered through extractResultsFromHtml; first card; card without its own snippet; long card truncating at the forward window).

RED: on untouched source, "short cards ... each of 12 cards returns its own snippet" failed: AssertionError: expected 'snippet-0' to be 'snippet-1' (card 1 took the previous card's snippet).
RED: on untouched source, "previous card snippet is not borrowed when the card has no snippet of its own" failed: AssertionError: expected 'only-first' to be ''.
GREEN: after the fix, test/unit/parsers and test/unit/capture-parsers pass (71 tests); full lane 128 files, 1221 tests passed.

EXIT pnpm nx run stealth-core-browser:lint: 0
EXIT pnpm nx run stealth-core-browser:typecheck: 0
EXIT pnpm nx run stealth-core-browser:typecheck-spec: 0
EXIT pnpm nx run stealth-core-browser:test: 0
