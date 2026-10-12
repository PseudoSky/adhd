# surface-api — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** mig-chrome-manager, mig-queries, mig-capture-parsers · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py surface-api`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

---

## Goal

The package has one public library surface: `src/index.ts` re-exports everything the old `cdp-query-client.ts` barrel exported (minus search-only `getLastSearchFromHistory`) plus the six chrome-runner verbs in `src/api.ts`, which is the apigen-visible surface the CLI and MCP hosts will project.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/src/api.ts`; REWRITE `entrypoint/stealth-browser/src/index.ts`.

- **Reference Pattern:** `/Users/nix/dev/ai/scratch/agent-browser/cdp-query-client.ts` (42-line barrel), `/Users/nix/dev/ai/scratch/agent-browser/search-mcp-source.ts:454-495` (chromeStatus, launchChrome, shutdownChrome, listPageTargets, checkChromeActivity, getPageContext), `ChromeStatus` non-optional `managed` comment, `entrypoint/stealth-browser/../backlog/src/api.ts` for the apigen module shape ([ref:apigen-host]).

- **Delta Spec:** `api.ts` exports ONLY async functions `chromeStatus, launchChrome, shutdownChrome, listPageTargets, checkChromeActivity, getPageContext` (plus their types). They are thin: construct a `ChromeManager` from typed options (host/port/profile; no `process.env` toggles) and delegate to the migrated library. Keep the `ChromeStatus.managed: boolean` NON-optional (the source comment explains the apigen oneOf duplicate-boolean failure on optional booleans). `index.ts` exports the library barrel (`ChromeManager`, `CdpClient`, `CdpSession`, `HistoryClient`, `CookieClient`, parsers, capture helpers, types) and `export * from './api.js'`.

- **Invariants:** [inv:esm-js-specifiers]; no imports from agent-search; no `process.env` reads in api.ts; every old barrel name (except `getLastSearchFromHistory`) still resolves from `@adhd/stealth-browser`. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:surface-api]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py surface-api` — runs every acceptance criterion below (red until the work is done); `--only surface-api.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py surface-api --only surface-api.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [surface-api.1] src/api.ts exports exactly the six chrome-runner verbs: chromeStatus, launchChrome, shutdownChrome, listPageTargets, checkChromeActivity, getPageContext (async functions only).

- [surface-api.2] chromeStatus returns a type with NON-optional `managed: boolean` and the apigen oneOf-duplicate-boolean warning comment is preserved.
---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/lib/", "/Users/nix/dev/ai/scratch/agent-browser/cdp-query-client.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-mcp-source.ts"]
mutates:    ["entrypoint/stealth-browser/src/api.ts", "entrypoint/stealth-browser/src/index.ts"]
```

---

## Contract Promise

Added: `entrypoint/stealth-browser/src/api.ts`. Modified: `entrypoint/stealth-browser/src/index.ts` (generator placeholder -> barrel). Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:surface-api]`:

- [ ] After api.ts compiles -- commit: `feat(stealth-browser): chrome-runner api verbs [psm:surface-api]`
- [ ] After the barrel -- commit: `feat(stealth-browser): library barrel [psm:surface-api]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- `getPageContext` composes `queries/context.ts`; `checkChromeActivity` composes `queries/activity.ts`. They return plain JSON-serializable shapes so apigen can project them to MCP/CLI.
- Do NOT add search verbs (`search`, `listProviders`, tripwire): those stay in agent-search.
