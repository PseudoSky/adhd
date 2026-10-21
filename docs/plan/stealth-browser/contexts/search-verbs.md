# search-verbs — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** search-port-providers, search-port-fetch, search-port-engine, search-port-guards · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-verbs`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The eleven verbs exist in `src/api.ts` as greenfield single-input-object functions over the ported modules and the core, with the search orchestration, the cookie-redaction projection and the package root, proven by unit scenarios on a fake core.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-search/src/api.ts`, `entrypoint/stealth-search/src/lib/search.ts`, `entrypoint/stealth-search/src/host-projection.ts`, `entrypoint/stealth-search/src/index.ts`, `entrypoint/stealth-search/src/test/unit/verbs/*.spec.ts`, `docs/plan/stealth-browser/evidence/split/search-verbs-probes.json`. READ `search-mcp-source.ts` and `cdp-search.ts` of the source repo.

- **Reference Pattern:** inventory rows I-02..I-08, I-13..I-18; `SPEC-stealth-search.md` section 2.2 (verbs, `SearchInput`, probes) and 2.3 (host projection, InteractionPort).

- **Delta Spec:** (1) Port the orchestration order exactly: unknown provider -> tripwire gate -> cooldown -> concurrency queue -> window open -> engine -> hostile-outcome cooldown (hitl excluded) -> HITL fire and keep context -> finally dispose (`pageDisposal`). `configureSearch({ interaction, config })` wires the injected `InteractionPort` and `SearchHostConfig`. (2) FIRST STEP (probes U-REEXPORT, U-BOOL): build, extract the IR from the BUILT `dist/api.d.ts`, check the five re-exported core verbs keep their input properties (ADR-0004 `b6a04e7f`), and that `SearchInput` does not crash `--help`/`tools/list` generation. Record `evidence/split/search-verbs-probes.json` {u_reexport, u_bool}. On u_reexport red, replace the five `export { ... } from` lines with local wrappers of identical signature. The hosts themselves are a later state: run the probes with a throwaway script under the scratchpad, not committed. (3) `getPageContext` calls the core verb then `redactCookieValues` (names and counts, never values). `launchChrome` keeps the core input `{port, userDataDir}`: no `chromePath`/`extraArgs`.

- **Invariants:** [inv:typed-errors] [inv:tests-cite] [inv:search-over-core]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:search-verbs]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py search-verbs` — runs every acceptance criterion below (red until the work is done); `--only search-verbs.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guards/search_a.py` (`python3 docs/plan/stealth-browser/scripts/guard.py search-verbs --only search-verbs.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [search-verbs.1] FIRST STEP, probes U-REEXPORT and U-BOOL: evidence/split/search-verbs-probes.json records `u_reexport` {result: pass|fallback, tools_checked: the five re-exported core verbs, properties_seen} from extracting the BUILT dist/api.d.ts, and `u_bool` {result: pass, help_ok: true, tools_list_ok: true} (`--help` and `tools/list` do not crash on `SearchInput`); when u_reexport is `fallback`, src/api.ts declares the five verbs as local wrappers with identical signatures instead of `export { ... } from`.
- [search-verbs.2] src/api.ts exports exactly the eleven tools search, listProviders, describeProvider, tripwireStatus, clearTripwire, chromeStatus, launchChrome, shutdownChrome, listPageTargets, checkChromeActivity and getPageContext (no `shutdownSearchChrome`, no `providerUsage`), every verb takes at most one JSON input object, `SearchInput` carries the enums `strategy`, `content: 'none'|'full'`, `visibility: 'offscreen'|'foreground'`, `pageDisposal: 'dispose'|'keep'`, and no optional boolean property exists in any input or output type of src/api.ts and src/lib/types.ts.
- [search-verbs.3] `launchChrome` exposes no `chromePath` and no `extraArgs` property anywhere in src/api.ts or in the type it takes (it inherits the core `LaunchChromeInput` of `{port, userDataDir}`), and getPageContext's pipeline lives in src/host-projection.ts as `redactCookieValues`, called by the `getPageContext` verb so both hosts share one redaction site; a spec over a cookie fixture whose value is `SECRET123` asserts the output keeps cookie names and counts and contains no value string.
- [search-verbs.4] src/lib/search.ts orchestrates the search in the ported order and is proven by unit scenarios on a fake core (zero real Chrome): unknown provider raises UNKNOWN_PROVIDER before any gate; a provider tripped for any reason except `login_required` returns outcome `hitl` with attempts 0 and ZERO Chrome calls (a stored `login_required` lock never gates, search-verbs.13); an armed cooldown returns `rate_limited` with a retry hint and no window; the concurrency cap queues the third call; a hostile outcome (captcha, rate_limited, banned) arms the cooldown but `hitl` does not; a HITL outcome fires the tripwire (not for reason `login_required`, search-verbs.13), reveals the page and keeps the context alive; `pageDisposal: 'dispose'` disposes the context in the finally path and an outer catch disposes a leaked one.
- [search-verbs.5] src/index.ts exports the eleven verbs, `configureSearch` (accepting `{ interaction?, config? }` with the `InteractionPort`), the types and the error classes; the package root has no side effect on import (no listen, no spawn, no telemetry init), asserted by a spec that imports it and checks that no handle was created.
- [search-verbs.6] Every inventory row owned by search-verbs is cited by id in the source or specs, and the specs (at least three files) cite ticket 8468f7b1 and a search-verbs.N id.
- [search-verbs.7] Hygiene of the owned files: no `process.env`, no bare Error, no `@adhd/stealth-browser` string, no deep import into the core's src/, no own WebSocket.
- [search-verbs.8] The state gates are green: `nx run stealth-search:typecheck`, `:lint`, `:test` and `:build` exit 0.
- [search-verbs.9] Only owned paths changed by [psm:search-verbs] commits.

- [search-verbs.10] (backlog cd05ad09) Verb output is token-efficient by default: `SearchInput` gains `offset` (number) and `preview: 'none'|'include'` (an enum, no boolean) and defaults to `content: 'none'`, `preview: 'none'` and `maxContentSize` = `DEFAULT_MAX_CONTENT_SIZE` (20000 bytes); `search` results are `{title, url, snippet}` items with no `raw.preview` and no HTML unless `preview: 'include'`. A spec under src/test/unit/verbs/ on the fake core simulates a 400 KB page for the duckduckgo, github and fetch providers and asserts the default serialized result stays under 8192 bytes (`Buffer.byteLength`), that `preview: 'include'` adds the preview, and that `content: 'full'` is bounded by `maxContentSize` with `nextOffset`; titles carry `maxContentSize`, `nextOffset`, `snippet`, `preview`, `byteLength`, `8192` and the uid cd05ad09, and the spec cites [search-verbs.10].
- [search-verbs.11] (backlog 861571da, 224e7a44) A hung provider cannot outlive the deadline: src/lib/search.ts applies one overall deadline `timeoutMs` (default `DEFAULT_SEARCH_TIMEOUT_MS = 30000`, shared across all attempts, never the 90 s of the old tool) and, when the engine never settles, a github search resolves under vitest fake timers with outcome `timeout` at that deadline (not `error` after two attempts), the concurrency slot is released, the context is disposed and the cooldown is not armed by the timeout. A spec under src/test/unit/verbs/ simulates it; titles carry `useFakeTimers`, `timeout`, `github`, `dispose`, `release`, `30000` and the uids 861571da and 224e7a44, and the spec cites [search-verbs.11].
- [search-verbs.12] (backlog 86ed154e) Parallel calls return one result each: a spec under src/test/unit/verbs/ starts five concurrent `search` calls with the fetch provider through the real queue on the fake core (one URL not found, one whose CDP call rejects with a Page.enable timeout, one whose page closes mid-render, two good) and asserts with Promise.all that five results come back, each carrying its own `url` and `provider`, the failing ones as outcome `error` (never undefined, null, an empty object or a thrown rejection), and the concurrency cap respected. Titles carry `Promise.all`, `concurrent`, `per-URL`, `Page.enable`, `outcome` and the uid 86ed154e, and the spec cites [search-verbs.12].
- [search-verbs.13] (commit 591e1a7, delta report row 4) The login interrupt flows through the verb without a lock: for a `hitl` response of reason `login_required` src/lib/search.ts writes no tripwire record and arms no cooldown; a pre-existing `login_required` lock does not fail-fast the verb (the search runs and a success clears the lock) while a lock of any other reason still returns hitl with attempts 0 and zero Chrome calls; after `ctx.reveal()` the revealed page is navigated to `hitl.pageUrl` (the sign-in URL) before `interaction.confirmSolved` is awaited. A spec under src/test/unit/verbs/ over a fake core and a recording InteractionPort asserts the call order (reveal, navigate, confirmSolved), no fire, no cooldown, the stored-lock cases and the other-reason fail-fast. Titles carry `login_required`, `reveal`, `confirmSolved`, `pageUrl`, `no tripwire`, `attempts` and the uid 591e1a7, and the spec cites [search-verbs.13]; `nx run stealth-search:test -- src/test/unit/verbs` exits 0.
---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/stealth-search/src/api.ts", "entrypoint/stealth-search/src/lib/search.ts", "entrypoint/stealth-search/src/host-projection.ts", "entrypoint/stealth-search/src/index.ts", "entrypoint/stealth-search/src/test/unit/verbs/", "docs/plan/stealth-browser/evidence/split/search-verbs-probes.json"]
```

---

## Contract Promise

Added: verbs, orchestration, projection, root, specs, probe evidence. Modified: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:search-verbs]`:

- [ ] After the probes: `docs(plan): U-REEXPORT and U-BOOL probes [psm:search-verbs]`
- [ ] After the guard passes: `feat(stealth-search): the eleven search verbs [psm:search-verbs]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

## Backlog fold-in (2026-10-14 search bugs)

Backlog-facing: each criterion below is cited by a unit test simulating the real use case; ids are stable (appended, never renumbered).

- cd05ad09 (HIGH) -> [search-verbs.10]: token-efficient defaults (`content: 'none'`, `preview: 'none'`, numeric default cap 20000, `offset`/`nextOffset`, results are `{title, url, snippet}`).
- 861571da, 224e7a44 -> [search-verbs.11]: one overall deadline (`DEFAULT_SEARCH_TIMEOUT_MS = 30000`), a hung provider resolves as outcome `timeout`, never a 90 s `error`.
- 86ed154e -> [search-verbs.12]: concurrent fetch/search calls each return their own result, failures as outcome `error`.
