# mig-chrome-manager — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** mig-cdp · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py mig-chrome-manager`
**Executor:** `refactoring-specialist` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

---

## Goal

The `ChromeManager` (launch-once, heartbeat, idle shutdown, three-tier safety) exists in the new package with identical behavior. Backlog 19dfb641's redesign (sox-service-proxy self-reaping singleton) is explicitly NOT part of this port.

---

## Semantic Distillation

- **Primitive:** MIGRATE `/Users/nix/dev/ai/scratch/agent-browser/adhd/chrome-manager.ts` -> `entrypoint/stealth-browser/src/lib/chrome-manager.ts`.

- **Reference Pattern:** `/Users/nix/dev/ai/scratch/agent-browser/adhd/chrome-manager.ts` heartbeat `/tmp/stealth-browser-heartbeat`, ready/bump/shutdownIfIdle, ChromeManagerOptions.

- **Delta Spec:** Port every file listed for this bucket in `docs/plan/stealth-browser/scripts/port-manifest.json` (source `adhd/chrome-manager.ts` -> destination under `entrypoint/stealth-browser/`). The port is BEHAVIOR-PRESERVING: copy, then adapt only (a) relative import specifiers to the new layout with `.js` extensions, (b) header comments that name the old repo layout. Every export of the source file must still be exported (guard compares export names) and each file must stay >= the manifest's `min_similarity` line-similar to its source (default 0.80). No `Runtime.evaluate`, no `--enable-automation`, no imports from agent-search, no committed `.js` twins. The heartbeat path, option names and three-tier shutdown semantics must be preserved byte-for-byte in behavior.

- **Invariants:** Behavior parity only; no singleton/proxy redesign (out of scope, backlog 19dfb641). [inv:esm-js-specifiers] [inv:stealth] [ref:runner-port] Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:mig-chrome-manager]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py mig-chrome-manager` — runs every acceptance criterion below (red until the work is done); `--only mig-chrome-manager.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py mig-chrome-manager --only mig-chrome-manager.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [mig-chrome-manager.1] Every manifest file exists, keeps every export, stays >=80% line-similar to the source, keeps its must-contain tokens.

- [mig-chrome-manager.2] No .ts import specifiers, no reach into agent-search, no Runtime.evaluate/--enable-automation; every relative import resolves.
- [mig-chrome-manager.3] Only owned paths changed by [psm:mig-chrome-manager] commits; agent-search source tree and main checkout node_modules untouched.
- [mig-chrome-manager.4] Behavior parity: heartbeat file path, three-tier safety shutdown and the ChromeManagerOptions type are preserved (backlog 19dfb641 redesign is OUT of scope).
---

## Reservations

```text
read_only:  ["/Users/nix/dev/ai/scratch/agent-browser/adhd/", "entrypoint/stealth-browser/src/lib/cdp/"]
mutates:    ["entrypoint/stealth-browser/src/lib/chrome-manager.ts"]
```

---

## Contract Promise

Added: `entrypoint/stealth-browser/src/lib/chrome-manager.ts`. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:mig-chrome-manager]`:

- [ ] After import re-pointing -- commit: `feat(stealth-browser): migrate chrome manager [psm:mig-chrome-manager]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- The manager spawns Chrome and writes /tmp: unit tests (tests-unit-core) mock child_process and fs; never launch Chrome from this state.
