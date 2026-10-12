# tests-e2e — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** tracing-plugin · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-e2e`
**Executor:** `qa` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])
**Parallel with:** tests-unit-core, tests-unit-data, tests-unit-extract, tests-unit-surface (disjoint owned paths, proven by `check-disjoint.py`)

> **PREREQUISITE — human action required.** This state depends on `HB-CHROME-BINARY` from `human-blockers.json`. Before starting, verify:
>
> ```bash
> test -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
> ```
>
> If it fails, **halt this state as `blocked` (not `failed`) and surface the blocker to the human.** Do not work around it.

---

## Goal

One end-to-end run drives ALL THREE surfaces (library, CLI, MCP stdio) against a real Chrome on a dedicated port with a temp profile, using ONE shared scaffold and ONE teardown, and takes real time (>= 5 s).

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/src/test/e2e/*.e2e.test.ts` and its harness.

- **Reference Pattern:** `entrypoint/dispatch-cli/src/test/cli-smoke.e2e.test.ts` (built-bin e2e), `entrypoint/backlog/src/server.mcp.e2e.ts` (MCP stdio client), `/Users/nix/dev/ai/scratch/agent-browser/chrome-lifecycle-test.ts` (what the old lifecycle test covers).

- **Delta Spec:** `harness.ts` has the single `beforeAll` (allocate a free port, temp user-data-dir, fake HOME/XDG, launch via the built `dist/bin/cli.js launchChrome`, wait ready) and the single `afterAll` (shutdown by the PID it launched; never `lsof`/`pkill`/`killall`, never port 9222). `surfaces.e2e.test.ts` has `describe('[surface:library]')`, `describe('[surface:cli]')`, `describe('[surface:mcp]')`: library calls the six verbs in-process; CLI spawns `node dist/bin/cli.js ...`; MCP spawns `dist/bin/mcp.js`, speaks JSON-RPC (initialize, tools/list, tools/call) and asserts the same results. The run also asserts the `adhd.*` trace record for one verb (cross-checks tracing under real hosts). No mocks.

- **Invariants:** [inv:e2e-shape] [inv:live-chrome] [inv:tests-cite]; the developer's live Chrome on 9222 is never touched (guard compares the 9222 listener before/after). Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tests-e2e]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-e2e` — runs every acceptance criterion below (red until the work is done); `--only tests-e2e.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tests-e2e --only tests-e2e.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [tests-e2e.1] ONE shared scaffold/teardown: exactly one beforeAll and one afterAll across src/test/e2e (harness.ts), shared by every surface.

---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/", "entrypoint/stealth-browser/bin/"]
mutates:    ["entrypoint/stealth-browser/src/test/e2e/"]
```

---

## Contract Promise

Added: `entrypoint/stealth-browser/src/test/e2e/*`. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tests-e2e]`:

- [ ] After the harness + library surface pass -- commit: `test(stealth-browser): e2e harness and library surface [psm:tests-e2e]`
- [ ] After CLI and MCP surfaces pass -- commit: `test(stealth-browser): e2e cli and mcp surfaces [psm:tests-e2e]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Files must be named `*.e2e.test.ts` so the unit lane excludes them and the `e2e` lane includes them.
- Needs the built bins: the `e2e` target dependsOn `build-bin` (set by entrypoint-parity).
- HB-CHROME-BINARY gates this state: it needs a Chrome binary at the default path.
