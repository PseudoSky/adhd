# search-port-providers — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** search-errors · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-port-providers`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The twelve providers, the shared types, the qualifier utilities and the last-search recovery are ported onto the core, with every outcome and extractor config preserved and unit scenarios on real provider ids.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-search/src/lib/{types,providers,utils}.ts`, `entrypoint/stealth-search/src/lib/queries/last-search.ts`, `entrypoint/stealth-search/src/test/unit/providers/*.spec.ts`. READ the source files `search-types.ts`, `search-providers.ts`, `search/utils.ts`, `search/queries/last-search.ts` of `/Users/nix/dev/ai/scratch/agent-browser/`.

- **Reference Pattern:** `PLAN:evidence/search-failsafe-inventory.json` rows owned by this state (I-10, I-22, I-23, I-31); `SPEC-stealth-search.md` section 2.2 (enums replace includeContent/foreground/keepPage).

- **Delta Spec:** (1) Port verbatim in behaviour; change only what the spec dictates: `SearchResultSource` becomes the core `PageSource`; no optional boolean in any exported type (enums `content`, `visibility`, `pageDisposal`); the unknown-provider throw becomes UNKNOWN_PROVIDER. (2) `last-search.ts` reads the core `storage.history` API; resolve at dispatch the exact core signature from the built core `dist/index.d.ts`. (3) Cite inventory row ids (`I-22`, ...) in the source docblock or spec titles. Specs are unit scenarios (a provider list, a qualifier example, a github code search, a history fixture), tagged `8468f7b1` and `search-port-providers.N`.

- **Invariants:** [inv:typed-errors] [inv:tests-cite] [inv:search-over-core] [inv:greenfield]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:search-port-providers]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py search-port-providers` — runs every acceptance criterion below (red until the work is done); `--only search-port-providers.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guards/search_a.py` (`python3 docs/plan/stealth-browser/scripts/guard.py search-port-providers --only search-port-providers.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [search-port-providers.1] src/lib/providers.ts registers exactly the 12 providers duckduckgo, google, arxiv, npm, github, maven, wikipedia, crates, pypi, mdn, stackoverflow and fetch (a spec asserts the ordered id list equals these twelve), each with its extractor config and qualifier examples, and `getProvider` of an unknown id throws StealthSearchError with code UNKNOWN_PROVIDER (asserted through the real call, not a mock).
- [search-port-providers.2] src/lib/types.ts reuses the core `PageSource` (imported from @adhd/stealth-core-browser, no second definition of it), declares the eight outcomes success, empty, error, timeout, hitl, captcha, rate_limited and banned, and has no optional boolean property in any exported input or output type (`?: boolean` is forbidden, enums replace includeContent/foreground/keepPage).
- [search-port-providers.3] src/lib/utils.ts prepends the qualifier to the query and maps a github `type:code` search to the github-code provider, proven by a spec that runs both transformations on real provider ids (including the no-qualifier and fetch-provider no-prepend cases).
- [search-port-providers.4] src/lib/queries/last-search.ts recovers the last Google search keyword by reading the core `storage.history` API (imported from @adhd/stealth-core-browser; no `node:sqlite`, no SQL and no profile path in this file), proven by a spec over a history fixture with a result, an empty history and a non-Google URL.
- [search-port-providers.5] Every inventory row owned by search-port-providers is cited by its id (e.g. `I-22`) in the source or its specs, and every spec cites ticket 8468f7b1 and a search-port-providers.N id with at least two spec files simulating real provider use.
- [search-port-providers.6] Hygiene of the owned files: no `process.env`, no bare Error, no `@adhd/stealth-browser` string, no deep import into the core's src/, no own WebSocket.
- [search-port-providers.7] The state gates are green: `nx run stealth-search:typecheck`, `:lint` and `:test` exit 0.
- [search-port-providers.8] Only owned paths changed by [psm:search-port-providers] commits.

- [search-port-providers.9] (backlog 861571da, 224e7a44) The github provider returns results or a typed outcome, never a silent empty or a long hang: repository search (default `type=repositories`, dom strategy) yields results from a result-page fixture and, when the dom path finds none, falls back once to an API fixture inside the same call; `type:code` search maps to the github-code provider and, given an unauthenticated login wall fixture, returns outcome `error` whose message names the login wall (never `empty` or `success` with zero results); a rate-limit fixture returns `rate_limited`. Specs under src/test/unit/providers/ drive the real provider functions over fixtures; titles carry `type:code`, `login wall`, `fallback`, `rate_limited`, `repositories` and the uids 861571da and 224e7a44, and the spec cites [search-port-providers.9].
---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/stealth-search/src/lib/types.ts", "entrypoint/stealth-search/src/lib/providers.ts", "entrypoint/stealth-search/src/lib/utils.ts", "entrypoint/stealth-search/src/lib/queries/last-search.ts", "entrypoint/stealth-search/src/test/unit/providers/"]
```

---

## Contract Promise

Added: the four modules and provider specs. Modified: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:search-port-providers]`:

- [ ] After the guard passes: `feat(stealth-search): port providers, types, utils, last-search [psm:search-port-providers]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.
