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

- [search-port-engine.9] (backlog 224e7a44) A network-capture failure never hangs or escapes as an unhandled rejection: when the CDP socket closes or errors during capture (a fake page whose capture rejects with a socket-closed error) the engine falls back to the dom strategy once and returns its results; when the fallback also fails it returns outcome `error` whose message names the cause. Specs under src/test/unit/engine/ register a process `unhandledRejection` listener and assert it never fires; titles carry `socket closed`, `falls back`, `dom`, `unhandledRejection` and the uid 224e7a44, and the spec cites [search-port-engine.9].
- [search-port-engine.10] (backlog 406a4e66) Google result-page (SERP) parsing is a search feature owned by stealth-search, not the core: src/lib/dom.ts holds the Google SERP walker (OD-11 keeps it as a ported feature) and imports no SERP- or Google-named symbol from @adhd/stealth-core-browser; a spec under src/test/unit/engine/ parses a Google result-page fixture through it. Deleting the original from the core is a core-side follow-up that belongs to the OD-11 decision and is recorded as a finding in this state's context, not required here. Titles carry `Google`, `SERP` and the uid 406a4e66, and the spec cites [search-port-engine.10].
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
