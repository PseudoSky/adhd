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
- [search-verbs.4] src/lib/search.ts orchestrates the search in the ported order and is proven by unit scenarios on a fake core (zero real Chrome): unknown provider raises UNKNOWN_PROVIDER before any gate; a tripped provider returns outcome `hitl` with attempts 0 and ZERO Chrome calls; an armed cooldown returns `rate_limited` with a retry hint and no window; the concurrency cap queues the third call; a hostile outcome (captcha, rate_limited, banned) arms the cooldown but `hitl` does not; a HITL outcome fires the tripwire, reveals the page and keeps the context alive; `pageDisposal: 'dispose'` disposes the context in the finally path and an outer catch disposes a leaked one.
- [search-verbs.5] src/index.ts exports the eleven verbs, `configureSearch` (accepting `{ interaction?, config? }` with the `InteractionPort`), the types and the error classes; the package root has no side effect on import (no listen, no spawn, no telemetry init), asserted by a spec that imports it and checks that no handle was created.
- [search-verbs.6] Every inventory row owned by search-verbs is cited by id in the source or specs, and the specs (at least three files) cite ticket 8468f7b1 and a search-verbs.N id.
- [search-verbs.7] Hygiene of the owned files: no `process.env`, no bare Error, no `@adhd/stealth-browser` string, no deep import into the core's src/, no own WebSocket.
- [search-verbs.8] The state gates are green: `nx run stealth-search:typecheck`, `:lint`, `:test` and `:build` exit 0.
- [search-verbs.9] Only owned paths changed by [psm:search-verbs] commits.

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
