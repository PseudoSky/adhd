# cdp-test-harness — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** port-fixes · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py cdp-test-harness`
**Executor:** `test-automator` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The unit lane can simulate Chrome honestly: an in-memory CDP server driven by a protocol state machine and fixture files, an in-memory filesystem and a fake process table, so capture-upgrade, chrome-lifecycle and the use-case suites test real behaviour with no socket, no subprocess and no Chrome. Fixtures are labelled honestly: `synthetic-protocol-conformant` until a dev-only recorder (follow-up FU-5) replaces them with `recorded` ones.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/src/test/support/{fake-cdp,mem-fs,fake-proc}.ts`, `src/test/fixtures/cdp/*.cdp.json` (14 fixtures) and `src/test/unit/support/{fake-cdp,mem-fs,fake-proc}.spec.ts`.

- **Reference Pattern:** `/private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/capture-and-lifecycle-spec.md` (copied to `docs/plan/stealth-browser/SPEC-capture-and-lifecycle.md`; read the section named below, nothing else), section 4 and the harness additions in 6.3; the `vi.stubGlobal('WebSocket', ...)` pattern already used by `src/test/unit/capture-parsers/network.spec.ts`.

- **Delta Spec:** `FakeCdpServer(fixture, {strict})` installs a `FakeWebSocket` through `vi.stubGlobal`, answers commands by `id` per fixture steps (`when` subset-match, `reply`, ordered `emit` with `delayMs`), records `received`, lists unknown commands in `unexpected` (strict mode answers CDP error -32601) and exposes `emitNow`, `closeFromServer` and `openCount`. `loadFixture(name)` reads `src/test/fixtures/cdp/<name>.cdp.json`. Fixtures: doc-200, search-404, rate-limit-429, redirect-301-200, extrainfo-before-main, extrainfo-after-main, cached-304, cors-failure, post-json-api, binary-base64, no-body-204, two-tabs-parallel, isolated-context-ok, isolated-context-target-missing; a spec checks every event/param name against an allow-list of Network-domain field names copied from `browser_protocol.json`. `MemFs` is an in-memory `FsLike` (exclusive create, atomic rename, readdir, mode, uid); `FakeProc` provides `pidAlive`, `procStart`, a logged `kill(pid|-pgid, signal)` and a recording `spawn`. HC1-HC5 specs cover id correlation, strict mode, fake-timer ordering, the field-name allow-list and server-side close.

- **Invariants:** [inv:unit-purity] (no node:net, node:http, child_process or ws in src/test/support) [inv:use-case-sim] [inv:tests-cite]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:cdp-test-harness]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py cdp-test-harness` — runs every acceptance criterion below (red until the work is done); `--only cdp-test-harness.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py cdp-test-harness --only cdp-test-harness.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [cdp-test-harness.1] The in-memory CDP harness exists: src/test/support/fake-cdp.ts exports FakeCdpServer (install, received, unexpected, emitNow, closeFromServer, openCount), loadFixture and the CdpFixture / CdpFixtureStep types, and src/test/fixtures/cdp/ holds the 14 `<name>.cdp.json` fixtures (doc-200, search-404, rate-limit-429, redirect-301-200, extrainfo-before-main, extrainfo-after-main, cached-304, cors-failure, post-json-api, binary-base64, no-body-204, two-tabs-parallel, isolated-context-ok, isolated-context-target-missing), each valid JSON with `meta.name`, `meta.origin` (`recorded` or `synthetic-protocol-conformant`) and a `steps` array.
- [cdp-test-harness.2] The harness is pure (unit purity): no `node:net`, `node:http`, `child_process` or `ws` import anywhere under src/test/support (the loopback-socket variant belongs to a later e2e follow-up, not this lane).
- [cdp-test-harness.3] src/test/unit/support/fake-cdp.spec.ts covers HC1 id correlation, HC2 strict unknown command (CDP error -32601, listed in `.unexpected`), HC3 fake-timer ordering of `delayMs` events, HC4 the Network-domain field-name allow-list over every fixture, HC5 `closeFromServer` firing `close`; it cites ticket 8468f7b1 and a valid cdp-test-harness.N id, and `nx run stealth-browser:test` exits 0.
- [cdp-test-harness.4] Only owned paths changed by [psm:cdp-test-harness] commits (src/test/support/, src/test/fixtures/cdp/, src/test/unit/support/).
- [cdp-test-harness.5] src/test/support/mem-fs.ts exports an in-memory FsLike (MemFs) with exclusive create (`wx` fails on an existing file), atomic rename, readdir, mode and uid; src/test/unit/support/mem-fs.spec.ts proves exclusive-create failure and rename atomicity and cites 8468f7b1 and [cdp-test-harness.5].
- [cdp-test-harness.6] src/test/support/fake-proc.ts exports FakeProc with `pidAlive`, `procStart`, `kill(pid|-pgid, signal)` (logged) and a recording `spawn`; src/test/unit/support/fake-proc.spec.ts covers each and cites 8468f7b1 and [cdp-test-harness.6].

---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/lib/"]
mutates:    ["entrypoint/stealth-browser/src/test/support/", "entrypoint/stealth-browser/src/test/fixtures/cdp/", "entrypoint/stealth-browser/src/test/unit/support/"]
```

---

## Contract Promise

Added: the three support files, 14 fixtures, three harness specs. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:cdp-test-harness]`:

- [ ] After the harness and fixtures — commit: `test(stealth-browser): in-memory CDP, fs and process harness [psm:cdp-test-harness]`
- [ ] After the harness specs — commit: `test(stealth-browser): harness specs [psm:cdp-test-harness]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- The harness is the prerequisite of `capture-upgrade` and `chrome-lifecycle`; they may not start before it is complete.
- A loopback-socket variant is a documented follow-up (it violates unit purity), not part of this state.
