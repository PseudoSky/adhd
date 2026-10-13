# search-errors — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** search-inventory, prod-errors · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-errors`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The entrypoint has one typed error family: `StealthSearchError extends StealthCoreBrowserError`, 13 stable codes with exit codes, one unit test per code through the real failing path, and `docs/ERRORS.md`. Every later search state throws these and nothing else.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-search/src/errors.ts`, `entrypoint/stealth-search/src/test/unit/errors/*.spec.ts`, `entrypoint/stealth-search/docs/ERRORS.md`.

- **Reference Pattern:** `packages/stealth/stealth-core-browser/src/lib/errors.ts` (the core `StealthCoreBrowserError`, codes, `exitCodeFor`, as created by `prod-errors`); `SPEC-stealth-search.md` section 2.4.

- **Delta Spec:** (1) FIRST: read the core error module to mirror its shape (class, `code`, `exitCodeFor`, message format). Do not copy: `import { StealthCoreBrowserError } from '@adhd/stealth-core-browser'` and extend it. (2) Codes: UNKNOWN_PROVIDER, SEARCH_FAILED, SELECTOR_TIMEOUT (re-exported from the core, still listed), HITL_ABORTED, TRIPWIRE_STATE_UNREADABLE, TRIPWIRE_CLEAR_FAILED, PROVIDER_STATE_IO, FETCH_URL_REFUSED (also carried in the message of a response outcome `error`), PDF_EXTRACT_FAILED, HOST_FLAG_INVALID, HOST_TRANSPORT_UNSUPPORTED, HOST_BOOT_FAILED, NODE_TOO_OLD. Outcomes (`success|empty|error|timeout|hitl|captcha|rate_limited|banned`) stay data, never exceptions. (3) Each code spec triggers the failure through the real exported function that will raise it later (for codes whose raising module belongs to a later state, construct the error and assert class, `instanceof` both classes, `code`, `exitCodeFor`, and message format; later states add the real-path specs under their own directories). CLI form `<CODE>: <message>` on stderr; MCP form `isError: true` with code and message — document both in `docs/ERRORS.md`.

- **Invariants:** [inv:typed-errors] [inv:tests-cite] [inv:search-over-core]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:search-errors]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py search-errors` — runs every acceptance criterion below (red until the work is done); `--only search-errors.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guards/search_a.py` (`python3 docs/plan/stealth-browser/scripts/guard.py search-errors --only search-errors.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [search-errors.1] src/errors.ts defines `StealthSearchError extends StealthCoreBrowserError` (imported from @adhd/stealth-core-browser, which exports it), exports `SEARCH_ERROR_CODES` containing every code UNKNOWN_PROVIDER, SEARCH_FAILED, SELECTOR_TIMEOUT, HITL_ABORTED, TRIPWIRE_STATE_UNREADABLE, TRIPWIRE_CLEAR_FAILED, PROVIDER_STATE_IO, FETCH_URL_REFUSED, PDF_EXTRACT_FAILED, HOST_FLAG_INVALID, HOST_TRANSPORT_UNSUPPORTED, HOST_BOOT_FAILED and NODE_TOO_OLD, and exports `exitCodeFor`.
- [search-errors.2] Every code is proven by a unit spec through the real path (the spec triggers the failure and asserts `instanceof StealthSearchError`, `instanceof StealthCoreBrowserError`, the `code` and the `exitCodeFor` value; no mocking of the error class), each spec cites ticket 8468f7b1 and a search-errors.N id, and each of the 13 code strings appears in at least one spec under src/test/unit/errors/.
- [search-errors.3] 100% typed errors in the entrypoint so far: no bare `new Error(`, `TypeError`, `RangeError`, string throw or string rejection in non-test source under entrypoint/stealth-search/src and bin, and no `process.env`.
- [search-errors.4] docs/ERRORS.md lists every code with its exit code, cause and remedy (a table row per code, the same strings as SEARCH_ERROR_CODES), states that outcomes (`success|empty|error|timeout|hitl|captcha|rate_limited|banned`) are data and not exceptions, and shows the CLI `<CODE>: <message>` stderr form and the MCP `isError: true` form.
- [search-errors.5] The state gates are green: `nx run stealth-search:typecheck`, `:lint` and `:test` exit 0.
- [search-errors.6] Only owned paths changed by [psm:search-errors] commits.

---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/stealth-search/src/errors.ts", "entrypoint/stealth-search/src/test/unit/errors/", "entrypoint/stealth-search/docs/ERRORS.md"]
```

---

## Contract Promise

Added: `src/errors.ts`, error specs, `docs/ERRORS.md`. Modified: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:search-errors]`:

- [ ] After the specs are green: `feat(stealth-search): typed error family [psm:search-errors]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.
