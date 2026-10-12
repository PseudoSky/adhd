# mig-cdp — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** mig-foundation · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py mig-cdp`
**Executor:** `refactoring-specialist` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

---

## Goal

The CDP connection layer exists as a plain folder in the single package (`src/lib/cdp/`), NOT as a nested `@adhd/cdp-connection` package: browser launch, session, targets, settle, monitor, shutdown, and the barrel.

---

## Semantic Distillation

- **Primitive:** MIGRATE `/Users/nix/dev/ai/scratch/agent-browser/adhd/cdp-connection/{index,src/*}.ts` -> `entrypoint/stealth-browser/src/lib/cdp/`.

- **Reference Pattern:** `/Users/nix/dev/ai/scratch/agent-browser/adhd/cdp-connection/src/browser.ts:99` the `--remote-debugging-port` flag and `:248` the `lsof -ti tcp:${port}` port-holder kill; `settle.ts` (measured settle logic); `index.ts` export list.

- **Delta Spec:** Port every file listed for this bucket in `docs/plan/stealth-browser/scripts/port-manifest.json` (source `adhd/cdp-connection/{index.ts,src/*.ts}` -> destination under `entrypoint/stealth-browser/`). The port is BEHAVIOR-PRESERVING: copy, then adapt only (a) relative import specifiers to the new layout with `.js` extensions, (b) header comments that name the old repo layout. Every export of the source file must still be exported (guard compares export names) and each file must stay >= the manifest's `min_similarity` line-similar to its source (default 0.80). No `Runtime.evaluate`, no `--enable-automation`, no imports from agent-search, no committed `.js` twins. `src/browser.ts` -> `cdp/browser.ts` etc.; `index.ts` -> `cdp/index.ts` with its imports re-pointed at `./browser.js`, `./session.js`, ... Do NOT carry `package.json`, `tsconfig.json`, README or the committed `.js` twins (`browser.js`, `monitor.js`, `session.js`, `shutdown.js`, `targets.js`): they are build output of the retired nested package. The `lsof` port-holder kill in `killChrome` is carried verbatim (live-Chrome sanctity is enforced in tests, [inv:live-chrome]).

- **Invariants:** No nested package.json/tsconfig and no compiled twins under `src/lib/cdp/`; `--remote-debugging-port` is present and `--enable-automation` is absent. [inv:esm-js-specifiers] [inv:stealth] [ref:runner-port] Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:mig-cdp]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py mig-cdp` — runs every acceptance criterion below (red until the work is done); `--only mig-cdp.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py mig-cdp --only mig-cdp.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [mig-cdp.1] Every manifest file exists, keeps every export, stays >=80% line-similar to the source, keeps its must-contain tokens.

---

## Reservations

```text
read_only:  ["/Users/nix/dev/ai/scratch/agent-browser/adhd/", "entrypoint/stealth-browser/src/lib/types.ts", "entrypoint/stealth-browser/src/lib/session.ts", "entrypoint/stealth-browser/src/lib/helpers.ts"]
mutates:    ["entrypoint/stealth-browser/src/lib/cdp/"]
```

---

## Contract Promise

Added: `entrypoint/stealth-browser/src/lib/cdp/{browser,monitor,session,settle,shutdown,targets,index}.ts`. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:mig-cdp]`:

- [ ] After the barrel resolves all relative imports -- commit by explicit path: `feat(stealth-browser): migrate cdp layer [psm:mig-cdp]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- The cdp files import `../types.ts`-style paths in the source; re-point to `../types.js` (the foundation bucket is already on disk).
- Settle logic is empirical (long measured comments) -- port comments verbatim; do not simplify the algorithm.
