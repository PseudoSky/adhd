# sp-reaper-smoke — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** prod-errors, sp-link · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py sp-reaper-smoke`
**Executor:** `qa` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

CL30 as a real-process gate: the built `dist` spawns the detached reaper host through `ensureBackend`, the host answers `ping`, `hello`, `activity` and `status`, retires on its own after `orphanWindowMs` (1 s in the script) once Chrome is gone, and removes its socket. This proves the entry path, the `lifecycle` namespace export and the package externalization on real processes, the one thing the unit lane (ADR-0009) cannot.

---

## Semantic Distillation

- **Primitive:** CREATE `docs/plan/stealth-browser/smoke/reaper-smoke.mjs` (the gate script), `smoke/reaper-smoke.md` and `smoke/reaper-smoke.json` (the recorded run). No package source is modified.

- **Reference Pattern:** `entrypoint/stealth-browser/src/lib/lifecycle/reaper-entry.ts` and `reaper-link.ts` (the spawn form the script reproduces), `docs/plan/stealth-browser/smoke/reaper-load-proof.md` (the pinned entry form), `SPEC-single-pass-lifecycle.md` section 3.3 (the host's JSON-RPC: `ping`, `hello`, `activity`, `release`, `reapIfIdle`, `status`).

- **Delta Spec:** The script uses `mkdtemp` directories under `os.tmpdir()` for `stateDir`, picks a CLOSED CDP port at run time (bind port 0, read it, close it), never names port 9222 and never touches the user's Chrome profile. It `require`s the built `dist/index.js`, asserts the `lifecycle` namespace exposes `runChromeReaper`, calls `ensureBackend` the way `reaper-link.ts` does (the same spawn form recorded by `sp-reaper-load-proof`) with `orphanWindowMs: 1000`, then dials, sends `hello`, an `activity` notification and `status`, closes the connection, waits for the host to retire (poll the socket path, bounded 15 s) and prints ONE final JSON line: `{ensure, ping, hello, activity, status, entryLoaded, retired, socketRemoved}` with `ensure` = "spawned" and every other value true. Exit 0 only when all hold; on any failure kill the spawned host by its recorded pid and exit 1. The executor runs `nx run stealth-browser:build` first, runs the script, and records `RUN: exit=0`, the dist/index.js sha256 and the service-proxy version in `reaper-smoke.md` and the script output in `reaper-smoke.json`.

- **Invariants:** [inv:live-chrome] (closed port, scratch dirs, no Chrome is ever started or killed) [inv:no-features-removed] [inv:greenfield]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:sp-reaper-smoke]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py sp-reaper-smoke` — runs every acceptance criterion below (red until the work is done); `--only sp-reaper-smoke.N` runs one. `node docs/plan/stealth-browser/smoke/reaper-smoke.mjs` after a green build is the proof (.2).

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py sp-reaper-smoke --only sp-reaper-smoke.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [sp-reaper-smoke.1] CL30 the gate script exists and is safe: smoke/reaper-smoke.mjs creates every directory with `mkdtemp` under os.tmpdir() (scratch stateDir), uses a CLOSED CDP port chosen at run time, never mentions port 9222, never touches the user's Chrome profile, and drives the BUILT dist (`require` of dist/index.js and `lifecycle.runChromeReaper` through the package entry, spawned the way reaper-link spawns it).
- [sp-reaper-smoke.2] CL30 the real-process proof passes: `node smoke/reaper-smoke.mjs` (after `nx run stealth-browser:build` exits 0) exits 0 and its last stdout line is a JSON object with `ensure` = "spawned" and true values for `ping`, `hello`, `activity`, `status`, `entryLoaded` (the package entry exposes the `lifecycle` namespace), `retired` (the host retired on its own after `orphanWindowMs` = 1 s) and `socketRemoved`.
- [sp-reaper-smoke.3] The run is recorded and the state is read-only for the package: smoke/reaper-smoke.md records `RUN: exit=0`, the dist/index.js sha256 and the service-proxy version used, smoke/reaper-smoke.json holds the script output, only owned paths changed by [psm:sp-reaper-smoke] commits and no file under entrypoint/stealth-browser/src is modified.

---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/", "entrypoint/stealth-browser/package.json", "docs/plan/stealth-browser/smoke/reaper-load-proof.md"]
mutates:    ["docs/plan/stealth-browser/smoke/reaper-smoke.mjs", "docs/plan/stealth-browser/smoke/reaper-smoke.md", "docs/plan/stealth-browser/smoke/reaper-smoke.json"]
```

---

## Contract Promise

Added: `smoke/reaper-smoke.mjs`, `smoke/reaper-smoke.md`, `smoke/reaper-smoke.json`. Read-only for the package.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:sp-reaper-smoke]`:

- [ ] After the script and a green run — commit: `test(stealth-browser): real-process reaper smoke gate [psm:sp-reaper-smoke]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- A host that does not retire, a socket that remains or a spawn that fails is a product defect of `chrome-lifecycle` or `prod-errors`: report it, do not patch the package here.
- Kill any host the script spawned before exiting, on every path; leave no process and no scratch directory behind.
