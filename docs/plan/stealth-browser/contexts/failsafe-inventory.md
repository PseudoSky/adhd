# failsafe-inventory — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** mig-chrome-manager, mig-queries, mig-capture-parsers · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py failsafe-inventory`
**Executor:** `refactoring-specialist` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Before anything is fixed, rewritten or upgraded, every failsafe and feature of the source package (agent-browser/adhd/ plus the six chrome verbs) is enumerated with its source file:line and the unit test that will pin it in the migrated package. The inventory is the contract of [inv:no-features-removed]: it lists FEATURES and FAILSAFES (behavior), never code, exports or legacy tests; every later state, the pre-review audit and the blind-review gate prove it row by row.

---

## Semantic Distillation

- **Primitive:** CREATE `docs/plan/stealth-browser/evidence/failsafe-inventory.json` (schema: `{schema: 1, baseline_commit, row_count, rows: [{id: 'fs-NNN', feature, tags: [...], source: {file, line, anchor}, owner_state, pin: {file, test}}]}`). No package source is touched.

- **Reference Pattern:** The BASELINE source in git (`evidence/source-baseline.txt`; read with `git show <baseline_commit>:<path>` from the scratch repo, not the working tree): `adhd/chrome-manager.ts`, `adhd/cdp-connection/src/{browser,shutdown,targets,session,settle,monitor}.ts`, `adhd/capture/*`, `adhd/storage/*`, `adhd/domains/*`, `adhd/session.ts`, `adhd/parsers.ts`, `adhd/helpers.ts`, `search/queries/{activity,context}.ts`, and `search-mcp-source.ts:454-495` (the verbs); the scratch `chrome-lifecycle-test.ts`; the migrated tree `entrypoint/stealth-browser/src/lib` to name where each row lives now.

- **Delta Spec:** Read the source and list EVERY failsafe and feature (at least 40 rows): the three safety tiers of `shutdownIfIdle`, `IdleShutdown`, the launch lock (O_EXCL), process-group kill, the newtab fix, the cross-process coordination and its livelock fix (`_rearmIdle`), isolated-page cleanup, the history-recency tier and `checkHistory`, read-only/immutable SQLite opening, ban detection and rules, settle and navigation failure handling, session id derivation, target selection, capture behaviors (single winner, size rules, extra wait), storage clients, parsers, the stealth flags (no `--enable-automation`, no `Runtime.evaluate`), and the six verbs. Tag each row from this closed set where it applies: safety-tier, launch-lock-oexcl, group-kill, newtab-fix, cross-process (the heartbeat or any equivalent coordination), livelock, history-recency (the history tier and `checkHistory`), idle-shutdown, isolated-page-cleanup, reaper, ban-detection, readonly-sqlite, stealth-flags, settle, session, targets, capture, storage, parsers, verb (every tag must be used at least once). `source.anchor` is a text fragment found on `source.line` (+-2) of the baseline file. Assign `owner_state` from: port-fixes, tests-unit-core, tests-unit-data, tests-unit-extract, tests-unit-surface, capture-upgrade, chrome-lifecycle: rows about chrome-manager.ts, cdp/targets.ts, the heartbeat, livelock, reaper, launch lock, group kill and newtab fix belong to chrome-lifecycle (or tests-unit-core for cdp/browser.ts and shutdown.ts internals); capture/network.ts rows to capture-upgrade; other capture/parsers rows to tests-unit-extract; storage/domains/queries to tests-unit-data; verbs to tests-unit-surface; behavior fixes to port-fixes. `pin.file` is a spec path relative to `entrypoint/stealth-browser/` inside the owner's owned test directory and `pin.test` a name fragment the owner must use in an `it()`; the owner's spec must also cite `[fs-NNN]`. Set `row_count` to the number of rows. Rows are never deleted later. If the inventory shows the capture/dom.ts Google-SERP walker is only a search-provider leftover, write a row tagged capture with the feature text `FLAG-FOR-USER: search-provider leftover` and do not decide it. Lifecycle coverage (failsafe-inventory.5): the architect inventory F1-F26 in `EVAL-service-proxy.md` section 2 is the starting list for the lifecycle rows; give each row an `eval_refs` list naming the F ids it covers (F22 and F23 rows are owned by `tests-unit-surface`, F23-F25 cite `server.mjs` / `cdp-search.ts` / `search-mcp-source.ts` of the scratch agent-browser tree). Re-read the sources: add any lifecycle feature the evaluation missed, never drop one.

- **Invariants:** [inv:no-features-removed] [inv:source-untouched] [inv:tests-cite]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:failsafe-inventory]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py failsafe-inventory` — runs every acceptance criterion below (red until the work is done); `--only failsafe-inventory.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py failsafe-inventory --only failsafe-inventory.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [failsafe-inventory.1] The inventory evidence/failsafe-inventory.json exists with at least 40 rows, unique ids `fs-NNN`, and covers every failsafe/feature topic by tag: safety-tier (the three safety tiers), launch-lock-oexcl, group-kill, newtab-fix, cross-process, livelock, history-recency, idle-shutdown, isolated-page-cleanup, reaper, ban-detection, readonly-sqlite, stealth-flags, settle, session, targets, capture, storage, parsers, verb.
- [failsafe-inventory.2] Every row cites its source: `source.file` (relative to the scratch agent-browser tree, e.g. adhd/chrome-manager.ts), `source.line` and `source.anchor` where the anchor text appears on that line (+-2) of the BASELINE source read from git, plus a non-empty `feature` sentence; the source files cover adhd/chrome-manager.ts, adhd/cdp-connection/src/browser.ts, shutdown.ts, targets.ts, adhd/capture/, adhd/storage/ and adhd/session.ts.
- [failsafe-inventory.3] Every row names an `owner_state` from the closed set (port-fixes, tests-unit-core, tests-unit-data, tests-unit-extract, tests-unit-surface, capture-upgrade, chrome-lifecycle) and a planned `pin` ({file under entrypoint/stealth-browser/src/test/ inside that owner's owned test directory, test: an it()/test() name substring}); rows tagged reaper, cross-process, livelock, launch-lock-oexcl, group-kill or newtab-fix are owned by chrome-lifecycle or tests-unit-core, rows tagged capture by capture-upgrade or tests-unit-extract.
- [failsafe-inventory.4] Only owned paths changed by [psm:failsafe-inventory] commits, and no package source file is touched.
- [failsafe-inventory.5] The inventory covers the features F1 to F26 of EVAL-service-proxy.md section 2: each row may carry `eval_refs` (a list of ids such as "F7") and the union over all rows covers every id F1 to F26; F22 (consumer cleanup on every path) and F23 (exit-path shutdown of a hosting process) rows are owned by tests-unit-surface; rows for F23 to F25 cite agent-browser files (server.mjs, cdp-search.ts) whose anchors are verified like every other source.

---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/", "/Users/nix/dev/ai/scratch/agent-browser/"]
mutates:    ["docs/plan/stealth-browser/evidence/failsafe-inventory.json"]
```

---

## Contract Promise

Added: `evidence/failsafe-inventory.json`. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:failsafe-inventory]`:

- [ ] After the inventory file is complete and its guard passes — commit by explicit path: `docs(stealth-browser): failsafe and functionality inventory [psm:failsafe-inventory]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- This state runs FIRST after the migration buckets; `port-fixes` depends on it. Do not judge or fix anything: enumerate.
- Think of every guard, lock, retry, fallback and cleanup path as a row; a state that later rewrites a file is held to its rows instead of to line similarity.
