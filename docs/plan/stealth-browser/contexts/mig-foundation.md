# mig-foundation — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** deps-install · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py mig-foundation`
**Executor:** `refactoring-specialist` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

---

## Goal

The shared base layer exists in the new package: `types.ts`, `session.ts` and `helpers.ts`. Everything else in the runner imports from these, so this state is the first migration bucket and unblocks every other bucket.

---

## Semantic Distillation

- **Primitive:** MIGRATE `/Users/nix/dev/ai/scratch/agent-browser/adhd/{types,session,helpers}.ts` -> `entrypoint/stealth-browser/src/lib/`.

- **Reference Pattern:** `/Users/nix/dev/ai/scratch/agent-browser/adhd/types.ts:151` ChromeActivity, `:201` SearchResultSource; `/Users/nix/dev/ai/scratch/agent-browser/adhd/session.ts:24` getSearchSessionId; `/Users/nix/dev/ai/scratch/agent-browser/adhd/helpers.ts:53` the immutable read-only SQLite URI.

- **Delta Spec:** Port every file listed for this bucket in `docs/plan/stealth-browser/scripts/port-manifest.json` (source `adhd/{types,session,helpers}.ts` -> destination under `entrypoint/stealth-browser/`). The port is BEHAVIOR-PRESERVING: copy, then adapt only (a) relative import specifiers to the new layout with `.js` extensions, (b) header comments that name the old repo layout. Every export of the source file must still be exported (guard compares export names) and each file must stay >= the manifest's `min_similarity` line-similar to its source (default 0.80). No `Runtime.evaluate`, no `--enable-automation`, no imports from agent-search, no committed `.js` twins. In `session.ts` ADD `getSessionId` as the primary name and KEEP `getSearchSessionId` as an alias to the identical function (agent-search keeps importing the old name through the cutover). In `helpers.ts` keep the `file:<path>?mode=ro&immutable=1` URI exactly. Search-named types in `types.ts` are carried over unchanged (renaming is a productization decision, not a migration change).

- **Invariants:** Exports are a superset of the source; the SQLite open stays read-only/immutable. [inv:esm-js-specifiers] [inv:stealth] [ref:runner-port] Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:mig-foundation]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py mig-foundation` — runs every acceptance criterion below (red until the work is done); `--only mig-foundation.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py mig-foundation --only mig-foundation.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [mig-foundation.1] Every manifest file exists, keeps every export, stays >=80% line-similar to the source, keeps its must-contain tokens.

---

## Reservations

```text
read_only:  ["/Users/nix/dev/ai/scratch/agent-browser/adhd/"]
mutates:    ["entrypoint/stealth-browser/src/lib/types.ts", "entrypoint/stealth-browser/src/lib/session.ts", "entrypoint/stealth-browser/src/lib/helpers.ts"]
```

---

## Contract Promise

Added: `entrypoint/stealth-browser/src/lib/types.ts`, `session.ts`, `helpers.ts`. Modified: none. Deleted: none (source stays until cutover).

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:mig-foundation]`:

- [ ] After the three files compile in isolation -- commit by explicit path: `feat(stealth-browser): migrate foundation layer [psm:mig-foundation]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- `session.ts` is a one-function module; getSessionId vs getSearchSessionId must be the same function object (`export const getSearchSessionId = getSessionId`).
- Do NOT edit the source tree under agent-browser; copy from it.
