# mig-queries — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** mig-domains-storage · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py mig-queries`
**Executor:** `refactoring-specialist` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])
**Parallel with:** mig-chrome-manager, mig-capture-parsers, mig-docs (disjoint owned paths, proven by `check-disjoint.py`)

---

## Goal

The two engine-agnostic activity queries (`activity.ts`, `context.ts`) that agent-search's chrome verbs call exist in the new package. `last-search.ts` (search-engine specific) stays in agent-search.

---

## Semantic Distillation

- **Primitive:** MIGRATE `/Users/nix/dev/ai/scratch/agent-browser/search/queries/{activity,context}.ts` -> `entrypoint/stealth-browser/src/lib/queries/`.

- **Reference Pattern:** `/Users/nix/dev/ai/scratch/agent-browser/search/queries/activity.ts:1-3` and `context.ts:1-3` (imports of CdpClient, HistoryClient, CookieClient).

- **Delta Spec:** Port every file listed for this bucket in `docs/plan/stealth-browser/scripts/port-manifest.json` (source `search/queries/{activity,context}.ts` -> destination under `entrypoint/stealth-browser/`). The port is BEHAVIOR-PRESERVING: copy, then adapt only (a) relative import specifiers to the new layout with `.js` extensions, (b) header comments that name the old repo layout. Every export of the source file must still be exported (guard compares export names) and each file must stay >= the manifest's `min_similarity` line-similar to its source (default 0.80). No `Runtime.evaluate`, no `--enable-automation`, no imports from agent-search, no committed `.js` twins. Imports change from `../../adhd/...ts` to `../domains/index.js`, `../storage/history.js`, `../types.js`.

- **Invariants:** `last-search.ts` and `search/utils.ts` are NOT migrated (search-engine concerns). [inv:esm-js-specifiers] [inv:stealth] [ref:runner-port] Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:mig-queries]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py mig-queries` — runs every acceptance criterion below (red until the work is done); `--only mig-queries.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py mig-queries --only mig-queries.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [mig-queries.1] Every manifest file exists, keeps every export, stays >=80% line-similar to the source, keeps its must-contain tokens.

- [mig-queries.2] No .ts import specifiers, no reach into agent-search, no Runtime.evaluate/--enable-automation; every relative import resolves.
---

## Reservations

```text
read_only:  ["/Users/nix/dev/ai/scratch/agent-browser/adhd/", "/Users/nix/dev/ai/scratch/agent-browser/search/queries/", "entrypoint/stealth-browser/src/lib/domains/", "entrypoint/stealth-browser/src/lib/storage/"]
mutates:    ["entrypoint/stealth-browser/src/lib/queries/"]
```

---

## Contract Promise

Added: `entrypoint/stealth-browser/src/lib/queries/activity.ts`, `entrypoint/stealth-browser/src/lib/queries/context.ts`. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:mig-queries]`:

- [ ] After both compile -- commit: `feat(stealth-browser): migrate activity queries [psm:mig-queries]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- If either file imports from `search/utils.ts`, STOP and report: the boundary assumption (queries are engine-agnostic) would be wrong.
