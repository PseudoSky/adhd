# surface-api — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** mig-chrome-manager, mig-queries, mig-capture-parsers, port-fixes · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py surface-api`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The package has one greenfield public surface at the root (`src/index.ts`, ADR-0003, no subpaths): the library areas as namespaces (`cdp`, `storage`, `capture`, `parsers`, `chromeManager`; `recording` and `lifecycle` are wired by `prod-errors` once they exist) plus the six flat verbs of `src/api.ts` (`chromeStatus`, `launchChrome`, `shutdownChrome`, `listPageTargets`, `checkChromeActivity`, `getPageContext`), the apigen-visible surface the CLI and MCP hosts project. No consumer of the old names exists, so nothing is aliased or deprecated.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/src/api.ts`; REWRITE `entrypoint/stealth-browser/src/index.ts`.

- **Reference Pattern:** `/Users/nix/dev/ai/scratch/agent-browser/cdp-query-client.ts` (42-line barrel), `/Users/nix/dev/ai/scratch/agent-browser/search-mcp-source.ts:454-495` (chromeStatus, launchChrome, shutdownChrome, listPageTargets, checkChromeActivity, getPageContext), `ChromeStatus` non-optional `managed` comment, `entrypoint/stealth-browser/../backlog/src/api.ts` for the apigen module shape ([ref:apigen-host]).

- **Delta Spec:** `api.ts` exports ONLY async functions `chromeStatus, launchChrome, shutdownChrome, listPageTargets, checkChromeActivity, getPageContext` (plus their types). They are thin: construct a `ChromeManager` from typed options (host/port/profile; no `process.env` toggles) and delegate to the migrated library. Keep the `ChromeStatus.managed: boolean` NON-optional (the source comment explains the apigen oneOf duplicate-boolean failure on optional booleans). `index.ts` is the greenfield root: `export * as cdp|storage|capture|parsers|chromeManager from './lib/...'`, `export * from './api.js'`, `export type * from './lib/types.js'`; no flat re-export of library classes, no default export (criterion surface-api.3). `getPageContext` takes a `targetId`; only `chromeStatus`, `launchChrome` and `shutdownChrome` existed in the runner source, the rest are new design. Every verb carries a TSDoc description of at least 40 characters (the hosts surface it as the tool description, P4). BEFORE writing the verb types, resolve two claims product could not verify and record them with file:line evidence in `docs/plan/stealth-browser/evidence/product-claims.json`: (1) which option names the ported launch path accepts and that none of `chromePath`/`extraArgs` reaches the verb input (`launchChromeOptions`); (2) whether `getPageContext` returns cookie VALUES or only names (`getPageContextCookieValues.returnsValues`; when true the hosts must redact, when false the redaction tests become regression guards). Do not assume either answer: read `queries/context.ts`, `storage/cookies.ts` and the launch options and cite them.

- **Invariants:** [inv:esm-js-specifiers]; no imports from agent-search; no `process.env` reads in api.ts; [inv:greenfield] (no legacy file, subpath, alias or deprecation; criterion surface-api.10); every name the agent-search consumer files import resolves inside a root namespace. `chrome-lifecycle` rewrites `ChromeManagerOptions` in parallel: depend only on the `ChromeManager` methods `api.ts` calls and keep the manager construction in one helper so the rewrite is a one-line change. `launchChrome`'s verb input type exposes only `port` and `userDataDir` (PRODUCT-REVIEW.md P1): `chromePath` and `extraArgs` stay library-only options. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:surface-api]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py surface-api` — runs every acceptance criterion below (red until the work is done); `--only surface-api.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py surface-api --only surface-api.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [surface-api.1] src/api.ts exports exactly the six chrome-runner verbs: chromeStatus, launchChrome, shutdownChrome, listPageTargets, checkChromeActivity, getPageContext (async functions only).
- [surface-api.2] chromeStatus returns a type with NON-optional `managed: boolean` and the apigen oneOf-duplicate-boolean warning comment is preserved.
- [surface-api.3] The package root (src/index.ts) is the greenfield public API, one root entry (ADR-0003, no subpaths): the five core library areas as namespace exports `cdp`, `storage`, `capture`, `parsers`, `chromeManager` (prod-errors adds `recording` and `lifecycle`) (`export * as <area> from './lib/...'`), `export * from './api.js'` for the six verbs, and `export type * from './lib/types.js'` for the shared types, optionally `export * from './errors.js'` (the typed errors); no default export and no other export statement; every name the agent-search consumer files import (the ~10 deep-imported cdp-connection names included) resolves inside its namespace.
- [surface-api.4] api.ts and index.ts import nothing from agent-search, use .js specifiers, and every relative import resolves.
- [surface-api.5] The ChromeManager is configured through typed options only (no process.env toggles) and uses port/host options, never a hard-coded 9222 in api.ts defaults without an override.
- [surface-api.6] Only owned paths changed by [psm:surface-api] commits.
- [surface-api.7] (PA1.1) The launchChrome verb's input type declares only `port` and `userDataDir`; chromePath and extraArgs stay library-only (never on an apigen-visible verb input).
- [surface-api.9] (PA4.1) Each of the six verbs in src/api.ts has a TSDoc block whose description is at least 40 characters (the hosts surface it as the tool description).
- [surface-api.10] Greenfield: no legacy construct exists in the package: no src/legacy.ts, no `@deprecated` tag, no `getSearchSessionId` / `SearchResultSource` / `shutdownSearchChrome` identifier and no `legacy` export anywhere in non-test source, and package.json has no `./legacy` entry.
- [surface-api.11] [inv:no-features-removed] the six chrome verbs exist as features (chromeStatus, launchChrome, shutdownChrome, listPageTargets, checkChromeActivity, getPageContext) and every inventory row tagged `verb` names tests-unit-surface as its owner; export-name parity with the source is not required (greenfield).

---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/lib/", "/Users/nix/dev/ai/scratch/agent-browser/cdp-query-client.ts", "/Users/nix/dev/ai/scratch/agent-browser/search-mcp-source.ts"]
mutates:    ["entrypoint/stealth-browser/src/api.ts", "entrypoint/stealth-browser/src/index.ts", "docs/plan/stealth-browser/evidence/product-claims.json"]
```

---

## Contract Promise

Added: `entrypoint/stealth-browser/src/api.ts`. Added: `docs/plan/stealth-browser/evidence/product-claims.json`. Modified: `entrypoint/stealth-browser/src/index.ts` (generator placeholder -> greenfield root namespaces; `prod-errors` later adds the errors, `recording` and `lifecycle` exports). Deleted: none.

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
