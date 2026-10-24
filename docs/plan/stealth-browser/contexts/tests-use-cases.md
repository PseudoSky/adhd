# tests-use-cases — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** prod-examples, capture-upgrade, chrome-lifecycle · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-use-cases`
**Executor:** `test-automator` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The package is proven by realistic user scenarios, not by module mirrors: a person recovering a crashed Chrome, auditing their browsing history, replaying a session cookie flow, scraping a result page, driving the library through its chrome verbs and namespaces. Every scenario runs in the unit lane against an in-process fake CDP server, a fake Chrome launcher, real-shape profile databases and realistic HTML/network traces. This replaces the live-Chrome e2e lane (user decision) and makes the examples and the typed errors exercised, not just typechecked.

---

## Semantic Distillation

- **Primitive:** CREATE `packages/stealth/stealth-core-browser/src/test/support/{profile-fixtures,page-fixtures}.ts` and `src/test/use-cases/*.spec.ts`; the in-memory CDP server, `MemFs` and `FakeProc` come from `cdp-test-harness`.

- **Reference Pattern:** `src/test/unit/**` (existing unit specs for style and mocking), `examples/**` (run by the suites), `src/errors.ts` (codes asserted through scenarios), ticket 8468f7b1 AC1-AC7, `docs/plan/stealth-browser/USE_CASES.md` (the 20+ scenarios; name suites after the library ones).

- **Delta Spec:** Harness: reuse `FakeCdpServer`, `loadFixture`, `MemFs` and `FakeProc` from `cdp-test-harness` (an in-memory WebSocket stub, not a loopback socket: the lane stays pure); add a profile fixture builder that writes real SQLite `History`, `Cookies` and `Bookmarks` files with redirect chains and session + persistent cookies (opened through the library's immutable read-only opener) and HTML plus network-trace fixtures with at least three distinct page shapes. Suites: at least 12 specs named after user scenarios (e.g. `recover-a-crashed-chrome.spec.ts`), each opening `describe('Scenario: ...')`, covering the six verbs, the seven root namespaces (cdp, storage, capture, parsers, chromeManager, recording, lifecycle), at least six typed error codes. Each suite cites 8468f7b1 plus a `tests-use-cases.N` id and the AC ids it exercises. Every spawning or third-party network library is mocked.

- **Invariants:** [inv:use-case-sim] [inv:unit-purity] [inv:live-chrome] [inv:tests-cite] [inv:greenfield]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tests-use-cases]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-use-cases` — runs every acceptance criterion below (red until the work is done); `--only tests-use-cases.N` runs one. `nx run stealth-core-browser:test -- src/test/use-cases` is the whole lane and must finish well under a minute.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tests-use-cases --only tests-use-cases.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [tests-use-cases.1] The scenario fixtures exist under src/test/support/: real-shape profile databases (profile-fixtures.ts builds History, Cookies and Bookmarks SQLite files through a builder, no hand-written rows in the specs) and realistic HTML plus network-trace fixtures (page-fixtures.ts); the suites reuse the cdp-test-harness (FakeCdpServer, loadFixture, FakeProc) and add no loopback socket (no node:net, node:http or ws).
- [tests-use-cases.2] At least 12 use-case specs under src/test/use-cases/, named after user scenarios (not modules: e.g. `recover-a-crashed-chrome.spec.ts`), each `describe` opening with `Scenario:` plus the user goal; together they cover all six verbs and all seven root namespaces (library scenarios only: the CLI and MCP host scenarios live in search-usecases), each citing ticket 8468f7b1, a valid tests-use-cases.N id and the AC ids they exercise.
- [tests-use-cases.3] The suites are pure simulations: no live Chrome, no socket and no outbound network (every spawner is the harness FakeProc or a `node:child_process` vi.mock, no spec contains `fetch('http` to a non-loopback host, `puppeteer`, `playwright` or a Chrome binary path), the fixtures are real-shape (a profile fixture opens with the immutable read-only opener and contains >= 20 history rows, redirect chains and session plus persistent cookies) and the realistic HTML fixtures contain >= 3 distinct page shapes.
- [tests-use-cases.4] The examples are consumed: the suites import and `run()` every examples/verbs and examples/namespaces file (prod-examples), and the typed errors are reached through user scenarios (>= 6 distinct StealthCoreBrowserError codes asserted across the suites).
- [tests-use-cases.5] `nx run stealth-core-browser:test -- src/test/use-cases` exits 0 in under 120 seconds wall clock and leaves no listener behind on the ports it used.
- [tests-use-cases.6] Only owned paths changed by [psm:tests-use-cases] commits (src/test/use-cases/**, src/test/support/**); no production file is edited to make a simulation pass.

---

## Reservations

```text
read_only:  ["packages/stealth/stealth-core-browser/src/index.ts", "packages/stealth/stealth-core-browser/examples/"]
mutates:    ["packages/stealth/stealth-core-browser/src/test/use-cases/", "packages/stealth/stealth-core-browser/src/test/support/profile-fixtures.ts", "packages/stealth/stealth-core-browser/src/test/support/page-fixtures.ts"]
```

---

## Contract Promise

Added: `src/test/support/**`, `src/test/use-cases/**`. Modified: none. Deleted: none. No production file changes to make a simulation pass; a simulation that exposes a defect is reported as a finding and fixed in `audit-fixes`.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tests-use-cases]`:

- [ ] After the harness and fixtures — commit: `test(stealth-core-browser): in-process fake CDP server and profile fixtures [psm:tests-use-cases]`
- [ ] After the scenario suites — commit: `test(stealth-core-browser): user-scenario use-case suites [psm:tests-use-cases]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Why simulated: the user decided against live-Chrome e2e; the search cutover (`search-cutover`) is the integration proof against a real consumer.
- Name suites after what a user is trying to do, never after a module.
