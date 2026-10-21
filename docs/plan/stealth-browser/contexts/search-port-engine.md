# search-port-engine — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** search-port-providers · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-port-engine`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The browser-driven search engine layer (network capture search, DOM extraction, challenge recovery) is ported on top of the core, deleting the duplicate network-capture implementation.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-search/src/lib/{network,dom,challenge}.ts`, `entrypoint/stealth-search/src/test/unit/engine/*.spec.ts`. READ `search-network.ts`, `search-dom.ts`, `search-challenge.ts`, `network-capture.ts` of the source repo.

- **Reference Pattern:** inventory rows I-11, I-12, I-24, I-25, I-26 (I-26 is a deletion: use core `capture.captureNetworkResponse` with `select`); `SPEC-stealth-search.md` section 3.

- **Delta Spec:** (1) Port behaviour: direct JSON-API fetch without a browser, network capture search (the `#rso` preference becomes the `select` function), DOM pattern and structural extraction, ban checks, selector wait with jittered 600-1800 ms retries (StealthSearchError SELECTOR_TIMEOUT when exhausted), Cloudflare managed-challenge recovery (reveal, poll provider ban markers, retry once). (2) Specs drive the modules with fake page objects shaped like the core's page type over real HTML fixtures (a result page, an empty page, a banned page, a challenge page); resolve the page type from the core `dist/index.d.ts` at dispatch.

- **Invariants:** [inv:typed-errors] [inv:tests-cite] [inv:search-over-core]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:search-port-engine]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py search-port-engine` — runs every acceptance criterion below (red until the work is done); `--only search-port-engine.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guards/search_a.py` (`python3 docs/plan/stealth-browser/scripts/guard.py search-port-engine --only search-port-engine.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [search-port-engine.1] src/lib/network.ts, dom.ts and challenge.ts exist; network capture is done through the core `capture.captureNetworkResponse` with a `select` function (no second capture implementation, no file named network-capture* in the package), and the direct JSON-API fetch path needs no browser.
- [search-port-engine.2] dom.ts ports the DOM extraction (pattern and structural extractors, ban checks) and the selector wait with jittered 600-1800 ms retries, raising StealthSearchError SELECTOR_TIMEOUT when the wait is exhausted; a spec drives it with a fake page object over a real result-page HTML fixture, an empty page, a banned page and a selector timeout.
- [search-port-engine.3] challenge.ts ports the Cloudflare managed-challenge recovery: reveal the page, poll the provider ban markers, retry exactly once; a spec asserts recovery then one retry, an unrecoverable challenge returning outcome `captcha`, and that no second retry is attempted.
- [search-port-engine.4] The engine layer is pure over core calls: network.ts, dom.ts and challenge.ts import their browser access only from @adhd/stealth-core-browser (no `ws`, no raw CDP client of their own), and a spec covers the no-network-config error outcome and the direct JSON fetch.
- [search-port-engine.5] Every inventory row owned by search-port-engine is cited by id in the source or specs, and the specs (at least three files: network, dom, challenge) cite ticket 8468f7b1 and a search-port-engine.N id.
- [search-port-engine.6] Hygiene of the owned files: no `process.env`, no bare Error, no `@adhd/stealth-browser` string, no deep import into the core's src/, no own WebSocket.
- [search-port-engine.7] The state gates are green: `nx run stealth-search:typecheck`, `:lint` and `:test` exit 0.
- [search-port-engine.8] Only owned paths changed by [psm:search-port-engine] commits.

- [search-port-engine.9] (backlog 224e7a44) A network-capture failure never hangs or escapes as an unhandled rejection: when the CDP socket closes or errors during capture (a fake page whose capture rejects with a socket-closed error) the engine falls back once to the provider's next strategy when it declares one (the dom strategy only for a provider that has a `dom` config; github has none, so there the failure returns outcome `error` naming the cause, search-port-engine.14) and returns its results; when the fallback also fails it returns outcome `error` whose message names the cause. Specs under src/test/unit/engine/ register a process `unhandledRejection` listener and assert it never fires; titles carry `socket closed`, `falls back`, `dom`, `unhandledRejection` and the uid 224e7a44, and the spec cites [search-port-engine.9].
- [search-port-engine.10] (backlog 406a4e66) Google result-page (SERP) parsing is a search feature owned by stealth-search, not the core: src/lib/dom.ts holds the Google SERP walker (OD-11 keeps it as a ported feature) and imports no SERP- or Google-named symbol from @adhd/stealth-core-browser; a spec under src/test/unit/engine/ parses a Google result-page fixture through it. Deleting the original from the core is a core-side follow-up that belongs to the OD-11 decision and is recorded as a finding in this state's context, not required here. Titles carry `Google`, `SERP` and the uid 406a4e66, and the spec cites [search-port-engine.10].
- [search-port-engine.11] (commit 591e1a7, delta report row 3) A zero-result page behind a login wall is a hitl interrupt, not an error: src/lib/network.ts applies the provider's `emptyRequiresLogin` rule only when the capture parsed zero results and returns outcome `hitl` with `hitl.reason` `login_required`, `hitl.pageUrl` equal to `loginUrl(searchUrl)` (`https://github.com/login?return_to=<encoded search url>`), `hitl.strategy` `network`, `count` 0 and the rule's error text (it mentions the signed-in session), built by an exported `loginWallResponse`. A spec under src/test/unit/engine/ runs the engine over the code-search-signed-out.html fixture (fake capture, no browser) and asserts outcome hitl, reason login_required, a pageUrl starting `https://github.com/login?return_to=` whose decoded value is the code-search URL, and count 0; a signed-in variant of the fixture (the same page with `logged_in` true) returns its results and repo-search.html never matches the rule. This replaces the outcome `error` expectation of the earlier login-wall wording of search-port-providers.9. Titles carry `login_required`, `loginWallResponse`, `return_to`, `signed-out`, `signed-in`, `emptyRequiresLogin` and the uid 591e1a7, and the spec cites [search-port-engine.11]; `nx run stealth-search:test -- src/test/unit/engine` exits 0.
- [search-port-engine.12] (commit 591e1a7, delta report row 7) Rate limits are visible even when the page is small: the `select` function the engine passes to `capture.captureNetworkResponse` prefers a captured 429 or 503 response over the `id="rso"` body rule and over a larger 200 body, and a response with no recorded status is assumed 200. A spec over a fake session that delivers a large 200 body and a small 429 body with `retry-after: 30` asserts outcome `rate_limited` with the retry-after of 30 surfaced, a 503 case, and the unchanged no-status case. Titles carry `429`, `503`, `retry-after`, `rso`, `rate_limited`, `select` and the uid 591e1a7, and the spec cites [search-port-engine.12]; `nx run stealth-search:test -- src/test/unit/engine` exits 0.
- [search-port-engine.13] (commit 591e1a7, delta report row 8) The capture wait honours the request timeout: `engine.networkSearch` passes the SearchInput `timeoutMs` (default 30000) as the capture wait for the primary call, the fallback call and the post-challenge retry call (never a fixed 10 s). A fake-timer spec (`vi.useFakeTimers`) delivers the response at 14000 ms and asserts results with `timeoutMs: 30000` and outcome `timeout` with `timeoutMs: 5000`, and asserts through a recording capture mock that all three call sites receive the value. Titles carry `timeoutMs`, `useFakeTimers`, `14000`, `5000`, `30000`, `timeout` and the uid 591e1a7, and the spec cites [search-port-engine.13]; `nx run stealth-search:test -- src/test/unit/engine` exits 0.
- [search-port-engine.14] (commit 591e1a7, delta report rows 9 and 10) The strategy loop is provider-shaped: strategy index 0 runs against the provider as given and a `network` strategy at index above 0 runs against `fallbackView(provider)`; a `dom` strategy on a provider that has no `dom` config (github) returns outcome `error` whose message says the provider has no DOM strategy config, never throws, and the retry loop is not entered for it. A spec over fakes asserts that github's fallback call hits the page url pattern while its primary call hits the API, and the no-dom error for github (primary failing, no dom to fall back to). Titles carry `fallbackView`, `no DOM strategy config`, `index`, `dom` and the uid 591e1a7, and the spec cites [search-port-engine.14]; `nx run stealth-search:test -- src/test/unit/engine` exits 0.
---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/stealth-search/src/lib/network.ts", "entrypoint/stealth-search/src/lib/dom.ts", "entrypoint/stealth-search/src/lib/challenge.ts", "entrypoint/stealth-search/src/test/unit/engine/"]
```

---

## Contract Promise

Added: three engine modules and specs. Modified: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:search-port-engine]`:

- [ ] After the guard passes: `feat(stealth-search): port the network, DOM and challenge engines [psm:search-port-engine]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

## Backlog fold-in (2026-10-14 search bugs)

Backlog-facing: each criterion below is cited by a unit test simulating the real use case; ids are stable (appended, never renumbered).

- 224e7a44 -> [search-port-engine.9]: a capture socket failure falls back to the dom strategy once, never hangs, never escapes as an unhandled rejection.
- 406a4e66 -> [search-port-engine.10]: the Google SERP walker lives in stealth-search (`src/lib/dom.ts`), not the core. The inventory side is [search-inventory.6].

## Findings

- The core still holds the original Google SERP walker (`packages/stealth/stealth-core-browser/src/lib/capture/dom.ts`, built by completed states). Removing it from the core is a core-side follow-up that no pending state owns and that depends on the OD-11 user decision (keep the walker as a ported feature); this state only guarantees the search-side copy and that the search package imports no SERP symbol from the core.
