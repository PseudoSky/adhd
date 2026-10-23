# fix-search-engine evidence

## Fixture source
test/fixtures/providers/pypi/search-requests.html: a plain HTTP GET of https://pypi.org/search/?q=requests (curl, no browser)
returned HTTP 200 with a 3038-byte "Client Challenge" page and no `.package-snippet` markup, so the live page cannot be
captured without a browser. The fixture is transcribed from the upstream warehouse template, fetched with one plain GET of
https://raw.githubusercontent.com/pypi/warehouse/main/warehouse/templates/search/results.html (macro `project_snippet`):
the result container is `a.package-snippet`, the name is `span.package-snippet__name`, the description is
`p.package-snippet__description` (a p, not a span).

## Red-first (specs run on UNTOUCHED source)
RED: test/unit/providers/pypi-dom.spec.ts pypi anchor container: findChild tests the container itself so the url is the anchor href (failed on untouched source: findChild searches descendants, the anchor container is never tested, url comes back empty)
RED: test/unit/providers/pypi-dom.spec.ts pypi title and description: the name span is the title and the description is the p text (failed on untouched source: dom config looked for SPAN, page emits p)
RED: test/unit/providers/pypi-dom.spec.ts pypi network selectors name the same description tag as the dom config (failed on untouched source: selector was span.package-snippet__description)
RED: test/unit/engine/serp-single-walker.spec.ts google anchor without a heading: the dead title fallback is gone: expected [] received [{title: 'A short title a.test deep breadcrumb path here', ...}]
RED: test/unit/engine/serp-single-walker.spec.ts single walker: search dom.ts holds no second copy: expected source not to contain 'function hasDivDiv'
RED: test/unit/engine/serp-single-walker.spec.ts whitespace split fallback: the dead \s{2,} title fallback exists in neither dom.ts: search dom.ts still matched /\s{2,}/

## Fix
- search src/lib/dom.ts and core src/lib/capture/dom.ts: extractValue tests the container before its descendants.
- providers.ts: pypi description is p.package-snippet__description in both the network selectors and the dom config.
- one SERP walker, in the core (OD-11 provisional, docs/plan/stealth-browser/OPEN-DECISIONS.md); search extractGoogleSerp is an async adapter over capture.walkDomTree; the \s{2,} title fallback is deleted from both; core normalizeUrl gained the /goto?url= redirect.

GREEN: test/unit/providers/pypi-dom.spec.ts 4 passed; test/unit/engine/serp-single-walker.spec.ts 7 passed; test/unit/engine/dom.spec.ts passed; stealth-core-browser test/unit/capture-parsers/dom.spec.ts 20 passed

## Gates
EXIT nx run stealth-search:lint: 0
EXIT nx run stealth-search:typecheck: 0
EXIT nx run stealth-search:typecheck-spec: 0
EXIT nx run stealth-search:test: 1
The test exit 1 is two failures in test/unit/guards/tripwire-wiring.spec.ts (TTL expiry audit reason: expected 'captcha', received 'ttl-expired'), driven by the uncommitted resilience-core-tripwire audit.ts edits of another worker; the other 741 tests pass, including every dom, pypi and serp spec.
