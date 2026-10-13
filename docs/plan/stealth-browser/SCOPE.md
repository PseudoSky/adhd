# SCOPE - Migrate the agent-search chrome runner to @adhd/stealth-core-browser and agent-search to @adhd/stealth-search

Backlog plan item: `8468f7b1-8adc-4237-9986-21ea1e27c537` (adhd, in_progress). Plan home: `docs/plan/stealth-browser/`. Worktree: `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` (branch `stealth-browser`, cut from main `c6011647`).

Verbatim request: "Inside agent search there is a plan to migrate the chrome runner to adhd. Develop a fully dag compliant state machine plan to migrate the correct package. It should be called @adhd/stealth-browser and live in entrypoints. After the plan is complete have it reviewed by product for productization tasks. then begin dispatching work to a stealth browser worktree. all agents work from the same branch same dir, non overlapping buckets. review once migration is complete blind. one implementer resolve every review finding. add apigen tracing plugin and confirm correct namespacing. must be built with the workspace generator and match the entrypoint structure. after code complete have doc steward do a marketing run. then have content marketer write a more exciting readme"

## Amendment: split into core and search entrypoint (three packages)

Verbatim request: "port search to the entrypoint transfering all the apigen / tracing requirements over to the cli and mcps for search (which is built on top of the stealth core. Rename the entrypoint stealth search and the cdp to stealth core browser. Similar target slightly more work in the entrypoint, actual purpose. no need to do a full phase on confirming the logs just have an agent fully validate that they are being written - tests are unneeded".

Where the sections below say `@adhd/stealth-browser` or `entrypoint/stealth-browser` for the migrated runner, read `@adhd/stealth-core-browser` at `packages/stealth/stealth-core-browser` (tier core, domain `stealth`). The CLI, the MCP stdio host, the search verbs and the apigen tracing (namespace `adhd`, one `initTelemetry` per bin) live in `@adhd/stealth-search` at `entrypoint/stealth-search`, built on top of the core. The plan builds exactly three packages: `@adhd/resilience-core-tripwire`, `@adhd/stealth-core-browser` and `@adhd/stealth-search`, released in that order, followed by `consumer-relink`. Tracing is confirmed by one validating agent that reads the log files written by the built bins (`tracing-log-validation`), not by a test phase. Detail: `SPEC-stealth-search.md`; direction recorded in `APPROVAL-split.md`.

## 1. Outcomes (falsifiable)

1. `entrypoint/stealth-browser` exists, named `@adhd/stealth-browser`, produced by `npx nx g @adhd/workspace-codegen-nx:entrypoint --name stealth-browser --nxLayer entrypoints --platform node`, and has the same top-level files, tags, package metadata and nx targets that `dispatch-cli`, `backlog` and `apigen-cli` share. Proof: guard `entrypoint-parity.*`, `scaffold.*`.
2. The six chrome-runner verbs (`chromeStatus`, `launchChrome`, `shutdownChrome`, `listPageTargets`, `checkChromeActivity`, `getPageContext`) work from the library, the `stealth-browser` CLI and the `stealth-browser-mcp` stdio server. Proof (user decision, no live-Chrome lane): at least 12 use-case unit suites that simulate real scenarios through the shared in-memory harness (`nx run stealth-browser:test -- src/test/use-cases`), plus the agent-search cutover against a real consumer. Only `chromeStatus`, `launchChrome` and `shutdownSearchChrome` exist in the runner source; the other verbs, the root namespaces and `getPageContext(targetId)` are new design.
3. The apigen tracing plugin is mounted on every host under the `adhd` namespace (records `adhd.<op>.start|finish|error`, never `apigen.*`). Proof: `tracing-namespace-proof.*` incl. a mutation that flips the namespace and must fail the spec.
4. Every FEATURE and FAILSAFE of the runner is preserved ([inv:no-features-removed]): the three idle-safety tiers including history recency and `checkHistory`, the O_EXCL launch lock, group kill, the newtab fix, livelock protection, cross-process coordination, isolated-page cleanup, ban detection, graceful capture outcomes, `--remote-debugging-port` kept, `--enable-automation` and `Runtime.evaluate` absent, SQLite read-only/immutable. Legacy code, names, file layout and legacy tests are NOT preserved (greenfield). Proof: `evidence/failsafe-inventory.json` (built first) with a new feature-level unit test per row; migration-time guards `mig-*.1/.2`.
5. The live agent-search MCP source (`search-mcp-source.ts`, `server.mjs`) keeps working at every point; the baseline commit in `source-baseline.txt` is guarded until the first cutover commit. The required `agent-search-cutover` then runs agent-search on a tarball packed from this worktree (real directory in `node_modules`, no committed link, no lockfile change) and proves identical MCP behaviour through `node server.mjs --transport stdio` before and after; `agent-search-relink` switches to the released package after merge. Proof: `evidence/cutover-*.json`, `evidence/cutover-live-vs-recorded.md`.
5a. Greenfield API: no legacy, compatibility or deprecated surface exists (`[inv:greenfield]`). Root namespaces `cdp`, `storage`, `capture`, `parsers`, `chromeManager`, `recording`, `lifecycle` plus six flat verbs. Every failure is a typed error (29 design-neutral codes plus any the sink and lifecycle designs add).
5b. Capture and lifecycle are built in the package (user decision): `capture-upgrade` (one `NetworkRecorder` pipeline; the optional recording sink is a store-adapter sink, EVALUATIONS.md E1) and `chrome-lifecycle` (every existing lifecycle feature kept; race-free launch, reaper scope, launch circuit breaker, isolated-context cleanup; built once on @adhd/sox-service-proxy 0.6.0: connection-based presence through a reaper host behind one `ReaperLink` port, EVALUATIONS.md E2 and `SPEC-single-pass-lifecycle.md`). 5c. The tripwire is extracted into a second approved package, `@adhd/resilience-core-tripwire` (`packages/resilience/resilience-core-tripwire`, `tripwire-*` states, `SPEC-tripwire.md`), carrying every feature of the three existing tripwires; agent-search consumes it in `agent-search-cutover` and reverse-apis in `tripwire-reverse-migrate`, both on the `cdp-test-harness`.
6. A static non-blind pre-review audit (`audit-pre-review`) resolved by one implementer (`audit-fixes`), then exactly one blind review round (diff + the word "Review"), one implementer resolving every finding, gates re-run green; the final audit is script-only.
7. A doc-steward marketing run passed review; a content-marketer README is receipts-backed.
8. The branch is merge-ready (ff-only) with a dispatcher-recorded release decision.

## 2. Scope boundaries

### The correct package (boundary)

**In scope - migrates:** `agent-browser/adhd/` of the scratch repo (`/Users/nix/dev/ai/scratch/agent-browser/adhd/`): `cdp-connection/{index,src/*}.ts` (as `src/lib/cdp/`), `chrome-manager.ts`, `capture/*`, `domains/*`, `storage/*`, `parsers.ts`, `helpers.ts`, `session.ts`, `types.ts`, `docs/*`, plus the engine-agnostic `search/queries/{activity,context}.ts`, plus the `docs/cdp/*` reference. Plus the six chrome verbs (new `src/api.ts`, extracted from `search-mcp-source.ts:454-495`).

**Out of scope - stays in agent-search (which then consumes `@adhd/stealth-browser`):** every search-engine concern - providers, the tripwire adapter (`search-tripwire.ts`, a thin wrapper over `@adhd/resilience-core-tripwire` after the cutover), `search`/`listProviders` verbs, `search-challenge.ts`, `search-fetch.ts`, `search-dom.ts`, the root `network-capture.ts` duplicate, `search/queries/last-search.ts`, `search/utils.ts`, `server.mjs`, `search-mcp-source.ts` (reduced to search verbs), `package.json`.

**Evidence:** `adhd/` is self-contained - its only third-party imports are `node-html-parser`, `@xmldom/xmldom`, `xpath` at `adhd/parsers.ts:17-26`; no file under `adhd/` imports from outside it (verified by reading the import lines of every file). `cdp-query-client.ts` is a 42-line barrel over `adhd/`. The chrome verbs in `search-mcp-source.ts:454-495` delegate to `ChromeManager`/clients only. `last-search.ts` is search-specific (Google history keyword terms).

**The existing agent-search plan is wrong on this boundary:** `docs/restructure-proposal.md` and `docs/dispatch-plan.md` describe an in-place restructure across six worktrees/branches (a different strategy from "one worktree, one branch, disjoint buckets"), keep search-named items in the generic layer, and plan a nested private `@adhd/cdp-connection` package plus committed `.js` twins (`adhd/cdp-connection/src/{browser,monitor,session,shutdown,targets}.js`). This plan keeps ONE package, drops the nested package and the twins, and uses a single shared branch. The package is greenfield: search-named leftovers are corrected at the source (ADR-0002), not aliased; features and failsafes are preserved, legacy code is not.

### Not in scope
- FEAT-AGENT-TRACING (`5b98d3b2`, an agent-side plugin in agent-mcp): different feature; only the apigen-side precedent `@adhd/apigen-plugin-tracing` is used here.
- Environment/path survey gaps G1/G2 for `scratch-agent-search` (`docs/environment/adoption-survey/scratch/scratch-agent-search.md`).
- Any fourth new package. The user approved exactly THREE: `packages/stealth/stealth-core-browser`, `entrypoint/stealth-search` (`APPROVAL-split.md`) and `packages/resilience/resilience-core-tripwire` (`APPROVAL-tripwire.md`).
- Publishing: the dispatcher decides in `merge-readiness` (PUBLISHING.md).
- A separate package for the lifecycle, and changes to @adhd/sox-service-proxy itself (its 0.6.0 is specified and released in the sox-ecosystem repository; this plan only consumes it).
- A live-Chrome e2e lane and any `./legacy` subpath. Items deferred by the user's decisions are listed in `DEFERRED.md`; the productization decisions in `PRODUCTIZATION-CATALOG.md`.

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
| Unit specs at `src/test/unit/<bucket>/`, use-case suites at `src/test/use-cases/*.spec.ts`, harness at `src/test/support/` | advisory (keeps test buckets disjoint) |
| Cutover runs before the audit against a tarball from this worktree; the post-release `link:`/published consumption is the separate dispatcher-gated `agent-search-relink` | non-negotiable (user decision) |
| Greenfield: no legacy or compatibility surface | non-negotiable (user decision) |
| Typed errors for 100% of failures; a runnable example per verb and namespace | non-negotiable (user decision) |
| Chrome lifecycle (19dfb641) and the capture upgrade are built now; the sink (store adapter) and the lifecycle backbone (hybrid, service-proxy launcher) follow the recorded evaluations (EVALUATIONS.md) | non-negotiable (user decision) |
| No feature or failsafe of the runner is removed; legacy code, names and tests are not preserved | non-negotiable (user decision) |
| Prior comparison input for capture and lifecycle: `/Users/nix/dev/projects/reverse-apis/docs/marketing/.catalog/cross-repo-comparison.md` (reverse-apis) | informative |

## 5. Task breakdown

40 bounded states in 10 phases - see the README table and `dag.json`. Buckets: `scaffold`, `entrypoint-parity`, `deps-install` (serial); `mig-foundation` -> {`mig-cdp` -> {`mig-chrome-manager`, `mig-domains-storage` -> `mig-queries`}, `mig-capture-parsers`, `mig-docs`}; `failsafe-inventory` (the feature/failsafe inventory, built first) then `port-fixes`; then in parallel `surface-api` -> `surface-hosts` -> `tracing-plugin`, the three unit buckets and `cdp-test-harness` -> {`capture-upgrade`, `chrome-lifecycle`}; `prod-errors`, `prod-examples`, `tests-use-cases`; the required `agent-search-cutover`; `audit-pre-review` -> `audit-fixes`; gates; the blind review chain; docs chain; final audit; dispatcher merge; `agent-search-relink`.

## 6. Verification criteria

Every state has binary guard checks in `scripts/guard.py` (see criteria.json, each runnable as `guard.py <slug> --only <slug.N>`); the DoD clauses `[dod.1..9]` are confirmed by `scripts/audit_dod.py`. Tests cite ticket `8468f7b1` and a criterion id. Unit tests mock process spawn and third-party-network libraries and run against the in-memory harness (fixtures labelled `synthetic-protocol-conformant`); the cutover is the real-consumer proof.

## Pinned-vs-Resolve partition

| PIN in the work-order (provided verbatim) | RESOLVE by the executor at dispatch time |
|---|---|
| Falsifiable acceptance signals (guard ids); invariants `[inv:*]`; non-goals above; ground-truth artifacts (`port-manifest.json`, sibling entrypoints, `backlog/src/tracing.ts`); executor tier | Current contents of source files; exact import specifiers to rewrite; which sibling file a top-level artifact is copied from; generator output formatting; apigen option names; ports/paths a 1-second probe reveals |

Tier rule: states run on sonnet; mechanical ports pin the manifest (what to copy, what to preserve) and let the executor own the rewrite; apigen host/tracing states pin the concrete export shapes because the apigen extraction fails opaquely on type mistakes.
