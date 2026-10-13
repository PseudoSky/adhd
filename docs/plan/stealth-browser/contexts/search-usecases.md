# search-usecases — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** search-hosts · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-usecases`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Every ported end-to-end, guard and lifecycle scenario of agent-search (I-40) and the productization scenarios (P1/P2, the MCP-driven session) are proven as unit scenarios against the real stealth-search code with only the Chrome/CDP edge faked in-process. No e2e lane, no process, no socket (ADR-0009).

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-search/src/test/use-cases/*.spec.ts` (and support helpers next to them).

- **Reference Pattern:** `PLAN/USE_CASES.md`, the scratch scenario sources `e2e-test.ts`, `search-guard-test.ts`, `chrome-lifecycle-test.ts` (read-only, at the baseline recorded in `evidence/source-baseline.txt`), the core `src/test/support/` fakes (`fake-reaper-link.ts`, fixtures) reached through the built core package.

- **Delta Spec:** One spec file per scenario family: `tripwire-gate.spec.ts` (locked search returns `hitl`, attempts 0, no Chrome call; tripwire status/clear; expiry), `cooldown-concurrency.spec.ts` (hostile outcome arms the cooldown, hitl excluded, `rate_limited` fail-fast without a window, FIFO cap of 2, atomic cooldown file), `challenge-hitl.spec.ts` (managed-challenge reveal, poll, single retry; HITL fires the tripwire, reveals the page and keeps the context alive; page disposal rules), `fetch.spec.ts` (SSRF matrix incl. `::ffff:169.254.169.254`, `localhost.`, credentials, `file:`; PDF branch; markdown cap and truncation marker), `hosts.spec.ts` (in-process MCP session through the exported host factories: eleven `stealth_*` tools, `stealth_search` call, P1 extraArgs rejection, P2 `SECRET123` redaction, `UNKNOWN_PROVIDER` code and exit mapping, exit-hook soft shutdown). Each case cites `8468f7b1` and a `search-usecases.N` id. Use real modules end to end; only the CDP transport and clock are injected.

- **Invariants:** [inv:search-over-core] [inv:trace-namespace] [inv:typed-errors] [inv:greenfield] [inv:pnpm-only] [inv:tests-cite]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:search-usecases]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py search-usecases` runs every acceptance criterion below (red until the work is done); `--only search-usecases.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py search-usecases --only search-usecases.N`, loaded from `scripts/guards/search_b.py`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [search-usecases.1] src/test/use-cases/ holds spec files that each cite ticket 8468f7b1 and a search-usecases.N id, with at least 14 test cases in total (ported e2e, guard and lifecycle scenarios, no e2e lane).
- [search-usecases.2] Engine scenarios are covered with the real modules: tripwire-gated search returns outcome hitl with zero Chrome calls; cooldown fail-fast returns rate_limited without opening a window; the concurrency cap of 2 queues the third call FIFO; managed-challenge recovery reveals, polls and retries once; HITL fires the tripwire and keeps the context alive; hostile outcomes arm the cooldown but hitl does not.
- [search-usecases.3] Fetch scenarios are covered: the SSRF refusal matrix (169.254.169.254, ::ffff:169.254.169.254, localhost., embedded credentials, file:) returns outcome error with FETCH_URL_REFUSED and no browser call, a PDF response takes the PDF branch, and markdown output is capped with the truncation marker.
- [search-usecases.4] Host scenarios are covered in-process through the exported host factories: an MCP-driven session lists the eleven stealth_* tools and calls stealth_search, a launchChrome call with extraArgs is rejected (P1), getPageContext output carries cookie names and counts but never the SECRET123 value (P2), exit hooks soft-shut Chrome down, and a wrong provider surfaces UNKNOWN_PROVIDER with the code and exit mapping.
- [search-usecases.5] ADR-0009: the use-case specs spawn no process, open no real socket and touch no Chrome: no child_process, spawn/exec, WebSocket construction, port 9222 or non-loopback URL fetch appears in them, and none uses .skip, .only or .todo.
- [search-usecases.6] The scenarios exercise the real code, not mocks of it: no spec replaces a stealth-search module with vi.mock of a relative src path, and every spec imports from src (relative '../../').
- [search-usecases.7] `nx run stealth-search:test -- src/test/use-cases` exits 0.
- [search-usecases.8] Only owned paths changed by [psm:search-usecases] commits.

---

## Reservations

```text
read_only:  ["entrypoint/stealth-search/src/api.ts"]
mutates:    ["entrypoint/stealth-search/src/test/use-cases/"]
```

---

## Contract Promise

Added: `src/test/use-cases/*.spec.ts`. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:search-usecases]`:

- [ ] After the engine and guard scenarios — commit: `test(stealth-search): engine and guard use cases [psm:search-usecases]`
- [ ] After the fetch and host scenarios — commit: `test(stealth-search): fetch and host use cases [psm:search-usecases]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- Unit lane only: no `child_process`, no listening socket, no port 9222, no real network (guard `.5`). A scenario that seems to need Chrome gets the core fake CDP target instead.
- Do not edit `src/` production code; a defect found here is reported to the dispatcher (an implementer fixes it in the owning state).
- Parallel sibling: `search-examples` (disjoint scope).
