# SCOPE - Migrate the agent-search chrome runner to @adhd/stealth-browser

Backlog plan item: `8468f7b1-8adc-4237-9986-21ea1e27c537` (adhd, in_progress). Plan home: `docs/plan/stealth-browser/`. Worktree: `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` (branch `stealth-browser`, cut from main `c6011647`).

Verbatim request: "Inside agent search there is a plan to migrate the chrome runner to adhd. Develop a fully dag compliant state machine plan to migrate the correct package. It should be called @adhd/stealth-browser and live in entrypoints. After the plan is complete have it reviewed by product for productization tasks. then begin dispatching work to a stealth browser worktree. all agents work from the same branch same dir, non overlapping buckets. review once migration is complete blind. one implementer resolve every review finding. add apigen tracing plugin and confirm correct namespacing. must be built with the workspace generator and match the entrypoint structure. after code complete have doc steward do a marketing run. then have content marketer write a more exciting readme"

## 1. Outcomes (falsifiable)

1. `entrypoint/stealth-browser` exists, named `@adhd/stealth-browser`, produced by `npx nx g @adhd/workspace-codegen-nx:entrypoint --name stealth-browser --nxLayer entrypoints --platform node`, and has the same top-level files, tags, package metadata and nx targets that `dispatch-cli`, `backlog` and `apigen-cli` share. Proof: guard `entrypoint-parity.*`, `scaffold.*`.
2. The six chrome-runner verbs (`chromeStatus`, `launchChrome`, `shutdownChrome`, `listPageTargets`, `checkChromeActivity`, `getPageContext`) work from the library, the `stealth-browser` CLI and the `stealth-browser-mcp` stdio server against a real Chrome, in ONE e2e run with one shared setup/teardown. Proof: `nx run stealth-browser:e2e` exit 0, >= 5 s.
3. The apigen tracing plugin is mounted on every host under the `adhd` namespace (records `adhd.<op>.start|finish|error`, never `apigen.*`). Proof: `tracing-namespace-proof.*` incl. a mutation that flips the namespace and must fail the spec.
4. The migration is behavior-preserving: every export of every migrated file is still exported, files stay >= 80% line-similar to the source, `--remote-debugging-port` stays, `--enable-automation` and `Runtime.evaluate` stay absent, SQLite stays read-only/immutable. Proof: `port-manifest.json` + guard `*.1/.2`.
5. The live agent-search MCP source (`search-mcp-source.ts`, `server.mjs`) keeps working at every point, and after the guarded cutover consumes `@adhd/stealth-browser`. Proof: `source-baseline.txt` hash guard until cutover; stdio MCP probe after.
6. Exactly one blind review round (diff + the word "Review"), one implementer resolving every finding, gates re-run green.
7. A doc-steward marketing run passed review; a content-marketer README is receipts-backed.
8. The branch is merge-ready (ff-only) with a dispatcher-recorded release decision.

## 2. Scope boundaries

### The correct package (boundary)

**In scope - migrates:** `agent-browser/adhd/` of the scratch repo (`/Users/nix/dev/ai/scratch/agent-browser/adhd/`): `cdp-connection/{index,src/*}.ts` (as `src/lib/cdp/`), `chrome-manager.ts`, `capture/*`, `domains/*`, `storage/*`, `parsers.ts`, `helpers.ts`, `session.ts`, `types.ts`, `docs/*`, plus the engine-agnostic `search/queries/{activity,context}.ts`, plus the `docs/cdp/*` reference. Plus the six chrome verbs (new `src/api.ts`, extracted from `search-mcp-source.ts:454-495`).

**Out of scope - stays in agent-search (which then consumes `@adhd/stealth-browser`):** every search-engine concern - providers, tripwire, `search`/`listProviders` verbs, `search-challenge.ts`, `search-fetch.ts`, `search-dom.ts`, the root `network-capture.ts` duplicate, `search/queries/last-search.ts`, `search/utils.ts`, `server.mjs`, `search-mcp-source.ts` (reduced to search verbs), `package.json`.

**Evidence:** `adhd/` is self-contained - its only third-party imports are `node-html-parser`, `@xmldom/xmldom`, `xpath` at `adhd/parsers.ts:17-26`; no file under `adhd/` imports from outside it (verified by reading the import lines of every file). `cdp-query-client.ts` is a 42-line barrel over `adhd/`. The chrome verbs in `search-mcp-source.ts:454-495` delegate to `ChromeManager`/clients only. `last-search.ts` is search-specific (Google history keyword terms).

**The existing agent-search plan is wrong on this boundary:** `docs/restructure-proposal.md` and `docs/dispatch-plan.md` describe an in-place restructure across six worktrees/branches (a different strategy from "one worktree, one branch, disjoint buckets"), keep search-named items in the generic layer, and plan a nested private `@adhd/cdp-connection` package plus committed `.js` twins (`adhd/cdp-connection/src/{browser,monitor,session,shutdown,targets}.js`). This plan keeps ONE package, drops the nested package and the twins, and uses a single shared branch.

### Not in scope
- The sox-service-proxy self-reaping Chrome singleton (backlog `19dfb641`): the port preserves the heartbeat/IdleShutdown behavior verbatim; the redesign is follow-up work on the NEW package paths.
- FEAT-AGENT-TRACING (`5b98d3b2`, an agent-side plugin in agent-mcp): different feature; only the apigen-side precedent `@adhd/apigen-plugin-tracing` is used here.
- Environment/path survey gaps G1/G2 for `scratch-agent-search` (`docs/environment/adoption-survey/scratch/scratch-agent-search.md`).
- Any second new package. The human approved exactly ONE: `entrypoint/stealth-browser`.
- Publishing: the dispatcher decides in `merge-readiness` (PUBLISHING.md).
- Renaming search-named leftovers (`SearchResultSource`, `getSearchSessionId` alias): a productization decision.

## 3. Constraints and assumptions

- Monorepo (nx, pnpm@8.15.9): all executors share one worktree and branch; `node_modules` symlinked from main for the generator only, replaced by a real worktree install before the lockfile changes ([inv:node-modules], [inv:worktree-required]).
- ESM `.js` import specifiers in `src/` and `bin/` (sibling convention); the source uses `.ts` specifiers.
- Stealth: Chrome launched without `--enable-automation`; DOM walks only (no `Runtime.evaluate`).
- Live Chrome on 9222 is the developer's: no test may connect to or kill it.
- The scratch repo is local-only and its working tree is dirty with other projects' edits; the cutover stages explicit paths.
- Three new third-party dependencies (`node-html-parser`, `xpath`, `@xmldom/xmldom`) need human approval (blocker `hb-deps-approval`).
- Assumption: `entrypoint/` is untiered in this workspace (observed from siblings); the generator decides tags.

## 4. Prior decisions

| Decision | Class |
|---|---|
| Package name `@adhd/stealth-browser`, dir `entrypoint/stealth-browser`, generator-built | non-negotiable (request) |
| One shared worktree + branch, disjoint ownership buckets, commit tag `[psm:<slug>]` | non-negotiable (request) |
| One blind review; one implementer resolves all findings | non-negotiable (request) |
| Tracing namespace `adhd` via `makeTracingPlugin({serviceName:'adhd'})`, never the singleton | non-negotiable (backlog precedent) |
| Nested `@adhd/cdp-connection` becomes `src/lib/cdp/` | non-negotiable (one-package approval) |
| MCP/CLI hosts via apigen from `src/api.ts` | advisory (mirrors backlog; alternative: hand-rolled MCP) |
| Unit specs at `src/test/unit/<bucket>/`, e2e at `src/test/e2e/*.e2e.test.ts` | advisory (keeps test buckets disjoint) |
| Cutover gated behind release decision; consumption by published version or `link:` into merged main | advisory (dispatcher may choose) |

## 5. Task breakdown

30 bounded states in 9 phases - see README table and `dag.json`. Buckets: `scaffold`, `entrypoint-parity`, `deps-install` (serial); `mig-foundation` -> {`mig-cdp` -> {`mig-chrome-manager`, `mig-domains-storage` -> `mig-queries`}, `mig-capture-parsers`, `mig-docs`}; `surface-api` -> `surface-hosts` -> `tracing-plugin`; tests in four unit buckets + e2e + namespace proof; gates; blind review chain; docs chain; final audit; dispatcher merge; guarded cutover.

## 6. Verification criteria

Every state has binary guard checks in `scripts/guard.py` (154 criteria, each runnable as `guard.py <slug> --only <slug.N>`); the DoD clauses `[dod.1..9]` are confirmed by `scripts/audit_dod.py`. Tests cite ticket `8468f7b1` and a criterion id. Unit tests mock process spawn and third-party-network libraries; e2e uses a dedicated port, temp profile, fake HOME.

## Pinned-vs-Resolve partition

| PIN in the work-order (provided verbatim) | RESOLVE by the executor at dispatch time |
|---|---|
| Falsifiable acceptance signals (guard ids); invariants `[inv:*]`; non-goals above; ground-truth artifacts (`port-manifest.json`, sibling entrypoints, `backlog/src/tracing.ts`); executor tier | Current contents of source files; exact import specifiers to rewrite; which sibling file a top-level artifact is copied from; generator output formatting; apigen option names; ports/paths a 1-second probe reveals |

Tier rule: states run on sonnet; mechanical ports pin the manifest (what to copy, what to preserve) and let the executor own the rewrite; apigen host/tracing states pin the concrete export shapes because the apigen extraction fails opaquely on type mistakes.
