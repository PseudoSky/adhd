# Migrate the agent-search chrome runner to @adhd/stealth-browser (entrypoint)

Extract the Chrome/CDP runner from `scratch/agent-browser/adhd` into ONE new, generator-built entrypoint package, `@adhd/stealth-browser` (`entrypoint/stealth-browser`), exposing six verbs as a library, a CLI and an MCP stdio server, with apigen tracing under the `adhd` namespace.

Backlog plan item: `8468f7b1-8adc-4237-9986-21ea1e27c537` (adhd, in_progress). Worktree `/Users/nix/dev/node/adhd/.worktrees/stealth-browser`, branch `stealth-browser` (cut from main `c6011647`). Authored artifacts: `SCOPE.md`, `USE_CASES.md`, `demo/DEMO.md`, `demo/UNRESOLVED.md`, `TOOLS.md`, `APPROVAL.md`.

## Consumer

A platform maintainer of the adhd monorepo (and the agents that call the agent-search MCP) who needs a real, quiet Chrome from code, a CLI or MCP, without importing a private path inside a scratch repo.

## Value delta

Before: the Chrome/CDP runner lives inside `scratch/agent-browser/adhd/`, welded to the search server; every other tool copies it or reaches into a private path, and it has no typed API, CLI, MCP host or tracing. After: one workspace package built by the generator exposes the six verbs on three surfaces, traced under `adhd`, proven by use-case unit suites that simulate real scenarios through an in-memory CDP harness, plus a real-consumer cutover (agent-search runs on the packed package and its MCP server keeps serving). The capture pipeline is upgraded to a network recorder and the Chrome lifecycle (19dfb641) is built now, keeping every feature and failsafe of the source runner (feature inventory); the optional recording sink is a store-adapter sink (`@adhd/sox-store-adapter`, lazy import) and the lifecycle is an in-package engine whose default reaper launcher reuses `@adhd/sox-service-proxy`, both recorded in `EVALUATIONS.md`.

## Boundary (the correct package)

Migrates: `agent-browser/adhd/` (CDP connection, `chrome-manager.ts`, `capture/*`, `domains/*`, `storage/*`, `parsers.ts`, `helpers.ts`, `session.ts`, `types.ts`, `docs/*`), the engine-agnostic `search/queries/{activity,context}.ts`, and the six chrome verbs extracted from `search-mcp-source.ts:454-495`. Stays in agent-search (which then consumes `@adhd/stealth-browser`): providers, tripwire, `search`/`listProviders`, `search-challenge.ts`, `search-fetch.ts`, `search-dom.ts`, `last-search.ts`, `server.mjs`, and `search-mcp-source.ts` reduced to search verbs. Evidence: `adhd/` imports only `node-html-parser`, `xpath` and `@xmldom/xmldom` (`adhd/parsers.ts:17-26`) plus `node:*`; `cdp-query-client.ts` is a 42-line barrel over it. The existing agent-search plan (`docs/restructure-proposal.md`, `docs/dispatch-plan.md`) is wrong on strategy: it restructures in place across six branches, keeps search-named items in the generic layer, and plans a nested private `@adhd/cdp-connection` package plus committed `.js` twins. This plan keeps ONE package, one branch, and a single shared worktree. The package is greenfield: no consumers exist, so legacy code, names and tests are not preserved, while every FEATURE and FAILSAFE of the runner is preserved and pinned by a new unit test (`[inv:no-features-removed]`, `evidence/failsafe-inventory.json`). Only `chromeStatus`, `launchChrome` and `shutdownSearchChrome` exist in the runner source; the other verbs and the root namespaces are new design (`surface-api`). Full detail: `SCOPE.md`; every productization decision: `PRODUCTIZATION-CATALOG.md`; items left out: `DEFERRED.md`. Prior comparison input for the capture and lifecycle design: `/Users/nix/dev/projects/reverse-apis/docs/marketing/.catalog/cross-repo-comparison.md`.

## Source package after migration

Until the first `agent-search-cutover` commit the scratch `agent-browser/adhd/` tree equals the baseline commit in `evidence/source-baseline.txt` (guard `source_untouched`, read from git), so the live MCP (`search-mcp-source.ts`) never breaks. The cutover is REQUIRED and runs before `audit-pre-review` and the one blind review: the package built from this worktree is packed into a tarball stored outside every `.worktrees` directory and installed as a real directory in agent-browser's `node_modules`; the 14 consumer files import only the package root; `agent-browser/adhd/` is deleted; the committed `package.json` records only a dependency range and no lockfile changes. Parity is proven through `node server.mjs --transport stdio` before and after (`evidence/cutover-parity.json`), and `evidence/cutover-live-vs-recorded.md` states exactly what is LIVE (the tarball install), RECORDED (the range) and NOT-CHANGED (both lockfiles). The second step, `agent-search-relink`, runs after `merge-readiness` and the dispatcher's release decision (`hb-release-decision`): it switches to the published version or a `link:` into the merged main checkout, never a worktree. The scratch repo is local-only; its dirty tree is respected by staging explicit paths.

## Related backlog items (explicit scope calls)

- `8468f7b1-8adc-4237-9986-21ea1e27c537` (kind plan, in_progress, AC1-AC7): the parent of this plan; cites `restructure-proposal.md:1-8` and `dispatch-plan.md:1-8`. IN scope as the ticket every test cites.
- `5b98d3b2-3894-4142-b899-540bad821a19` (FEAT-AGENT-TRACING, open P1): OUT of scope (unchanged). It is an agent-side plugin (`@adhd/agent-plugin-tracing`) for agent-mcp with new hook events (children TRACE-1..5). It cites `packages/apigen/apigen-plugin-tracing/src/lib/plugin.ts:6-14` only as precedent. Our tracing state uses the apigen side (`makeTracingPlugin`) and nothing from that item. Related open item `5152786d` (apigen tracing design docs stale after the serviceName namespacing change) is the namespacing context for `tracing-namespace-proof`.
- `19dfb641-516f-445d-8fb1-28afbaa9b566` (self-reaping Chrome singleton, open feature): IN scope since the user's decision "build it now, there will not be a v3" (`PRODUCTIZATION-CATALOG.md`). The port (`mig-chrome-manager`) stays faithful; `chrome-lifecycle` then builds the lifecycle with every existing feature kept (idle-safety tiers incl. history recency and `checkHistory`, cross-process coordination, launch lock, group kill, newtab fix, livelock protection, isolated-page cleanup); the backbone is hybrid (in-package engine behind `PresenceStore` and `ReaperLauncher` seams, default launcher over `@adhd/sox-service-proxy`, `EVALUATIONS.md` E2). `agent-search-cutover` re-cites the item to the new package paths. Closed item `90ed0315` records that the reap fixes already exist in the ported code.
- `5152786d-0243-41ab-b232-fff7fdcfd8f2` (apigen tracing design notes stale after the serviceName change, open debt): OUT of scope to fix here (the notes live in `docs/apigen/design-notes/`). IN scope as a pin: `tracing-plugin.8` and `tracing-namespace-proof.6` assert what `plugin.ts` actually emits (`${serviceName}.op`, `${serviceName}.transport`, `${serviceName}.op.error`) so this plan follows the code, not the stale notes.
- Backlog component `24cfccf0-fa28-4fa8-af08-23d0c1c56978` is the registered home of `entrypoint/stealth-browser`; file follow-ups (the P11 learnings review and the PRODUCT-REVIEW.md out-of-scope candidates) against it.

## ONE approved new package

The human's request approves exactly one new package, `entrypoint/stealth-browser`, built with `npx nx g @adhd/workspace-codegen-nx:entrypoint --name stealth-browser --nxLayer entrypoints --platform node` (dry-run first, bare name). No other package may be created (`[inv:one-new-package]`).

## States (40), waves, executors

Wave = dependency depth; states in one wave with no edge between them may run concurrently, and `scripts/check-disjoint.py` proves their owned paths are disjoint. Executors are best-fit, never general/claude; sonnet unless noted. The longest dependency chain has 30 states (productization-hold to agent-search-relink, through the failsafe inventory, the cdp harness, the chrome lifecycle, the surface, error, example, use-case and cutover states). The `prod-*` states and the productization amendments come from `PRODUCT-REVIEW.md`; the user's decisions on it (`PRODUCTIZATION-CATALOG.md`) removed the e2e lane and the publish-readiness state, added `capture-upgrade`, `chrome-lifecycle` (with their `cdp-test-harness`) and `tests-use-cases`, and made the agent-search cutover a required pre-audit state.

| Wave | State | Phase | Kind | Executor | Owned paths | Guard |
|---|---|---|---|---|---|---|
| 0 | `productization-hold` | productization | review | product (sonnet/medium) | `docs/plan/stealth-browser/PRODUCT-REVIEW.md` | `guard.py productization-hold` |
| 1 | `scaffold` | scaffold | work | platform-engineer (sonnet/medium) | `entrypoint/stealth-browser/`, `tsconfig.base.json`, `docs/plan/stealth-browser/evidence/` | `guard.py scaffold` |
| 2 | `entrypoint-parity` | scaffold | work | platform-engineer (sonnet/medium) | `entrypoint/stealth-browser/*`, `docs/plan/stealth-browser/evidence/` | `guard.py entrypoint-parity` |
| 3 | `deps-install` | scaffold | work | platform-engineer (sonnet/medium) | `entrypoint/stealth-browser/package.json`, `pnpm-lock.yaml`, `entrypoint/stealth-browser/eslint.config.mjs` ... | `guard.py deps-install` |
| 4 | `mig-foundation` | migrate | work | refactoring-specialist (sonnet/medium) | `entrypoint/stealth-browser/src/lib/types.ts`, `entrypoint/stealth-browser/src/lib/session.ts`, `entrypoint/stealth-browser/src/lib/helpers.ts` | `guard.py mig-foundation` |
| 5 | `mig-capture-parsers` | migrate | work | refactoring-specialist (sonnet/medium) | `entrypoint/stealth-browser/src/lib/capture/`, `entrypoint/stealth-browser/src/lib/parsers.ts`, `entrypoint/stealth-browser/eslint.config.mjs` | `guard.py mig-capture-parsers` |
| 5 | `mig-cdp` | migrate | work | refactoring-specialist (sonnet/medium) | `entrypoint/stealth-browser/src/lib/cdp/` | `guard.py mig-cdp` |
| 5 | `mig-docs` | migrate | work | refactoring-specialist (sonnet/low) | `entrypoint/stealth-browser/docs/reference/` | `guard.py mig-docs` |
| 6 | `mig-chrome-manager` | migrate | work | refactoring-specialist (sonnet/medium) | `entrypoint/stealth-browser/src/lib/chrome-manager.ts` | `guard.py mig-chrome-manager` |
| 6 | `mig-domains-storage` | migrate | work | refactoring-specialist (sonnet/medium) | `entrypoint/stealth-browser/src/lib/domains/`, `entrypoint/stealth-browser/src/lib/storage/` | `guard.py mig-domains-storage` |
| 7 | `mig-queries` | migrate | work | refactoring-specialist (sonnet/medium) | `entrypoint/stealth-browser/src/lib/queries/` | `guard.py mig-queries` |
| 8 | `failsafe-inventory` | migrate | work | refactoring-specialist (sonnet/high) | `docs/plan/stealth-browser/evidence/failsafe-inventory.json` | `guard.py failsafe-inventory` |
| 9 | `port-fixes` | migrate | work | typescript-pro (sonnet/high) | `entrypoint/stealth-browser/src/lib/`, `entrypoint/stealth-browser/vite.config.ts`, `entrypoint/stealth-browser/tsconfig.spec.json` ... | `guard.py port-fixes` |
| 10 | `cdp-test-harness` | migrate | work | test-automator (sonnet/medium) | `entrypoint/stealth-browser/src/test/support/`, `entrypoint/stealth-browser/src/test/fixtures/cdp/`, `entrypoint/stealth-browser/src/test/unit/support/` | `guard.py cdp-test-harness` |
| 10 | `surface-api` | surface | work | typescript-pro (sonnet/high) | `entrypoint/stealth-browser/src/api.ts`, `entrypoint/stealth-browser/src/index.ts`, `docs/plan/stealth-browser/evidence/product-claims.json` | `guard.py surface-api` |
| 10 | `tests-unit-core` | verify | work | test-automator (sonnet/medium) | `entrypoint/stealth-browser/src/test/unit/foundation/`, `entrypoint/stealth-browser/src/test/unit/cdp/`, `entrypoint/stealth-browser/src/test/unit/chrome-manager/` | `guard.py tests-unit-core` |
| 10 | `tests-unit-data` | verify | work | test-automator (sonnet/medium) | `entrypoint/stealth-browser/src/test/unit/domains-storage/`, `entrypoint/stealth-browser/src/test/unit/queries/` | `guard.py tests-unit-data` |
| 10 | `tests-unit-extract` | verify | work | test-automator (sonnet/medium) | `entrypoint/stealth-browser/src/test/unit/capture-parsers/` | `guard.py tests-unit-extract` |
| 11 | `capture-upgrade` | migrate | work | typescript-pro (sonnet/high) | `entrypoint/stealth-browser/src/lib/recording/`, `entrypoint/stealth-browser/src/lib/capture/network.ts`, `entrypoint/stealth-browser/src/lib/capture/index.ts` ... | `guard.py capture-upgrade` |
| 11 | `chrome-lifecycle` | migrate | work | typescript-pro (sonnet/high) | `entrypoint/stealth-browser/src/lib/lifecycle/`, `entrypoint/stealth-browser/src/lib/chrome-manager.ts`, `entrypoint/stealth-browser/src/lib/cdp/targets.ts` ... | `guard.py chrome-lifecycle` |
| 12 | `surface-hosts` | surface | work | typescript-pro (sonnet/high) | `entrypoint/stealth-browser/src/server.ts`, `entrypoint/stealth-browser/src/cli.ts`, `entrypoint/stealth-browser/src/host-projection.ts` ... | `guard.py surface-hosts` |
| 13 | `tracing-plugin` | surface | work | typescript-pro (sonnet/high) | `entrypoint/stealth-browser/src/tracing.ts`, `entrypoint/stealth-browser/src/server.ts`, `entrypoint/stealth-browser/src/cli.ts` ... | `guard.py tracing-plugin` |
| 14 | `prod-errors` | surface | work | typescript-pro (sonnet/high) | `entrypoint/stealth-browser/src/errors.ts`, `entrypoint/stealth-browser/src/lib/`, `entrypoint/stealth-browser/src/server.ts` ... | `guard.py prod-errors` |
| 14 | `tests-unit-surface` | verify | work | test-automator (sonnet/medium) | `entrypoint/stealth-browser/src/test/unit/surface/` | `guard.py tests-unit-surface` |
| 14 | `tracing-namespace-proof` | verify | work | test-automator (sonnet/high) | `entrypoint/stealth-browser/src/test/unit/tracing/tracing-namespace.spec.ts` | `guard.py tracing-namespace-proof` |
| 15 | `prod-examples` | surface | work | typescript-pro (sonnet/medium) | `entrypoint/stealth-browser/examples/`, `entrypoint/stealth-browser/src/test/unit/examples/`, `entrypoint/stealth-browser/tsconfig.spec.json` | `guard.py prod-examples` |
| 16 | `tests-use-cases` | verify | work | test-automator (sonnet/high) | `entrypoint/stealth-browser/src/test/use-cases/`, `entrypoint/stealth-browser/src/test/support/profile-fixtures.ts`, `entrypoint/stealth-browser/src/test/support/page-fixtures.ts` | `guard.py tests-use-cases` |
| 17 | `agent-search-cutover` | verify | work | typescript-pro (sonnet/high) | `/Users/nix/dev/ai/scratch/agent-browser/adhd/`, `/Users/nix/dev/ai/scratch/agent-browser/cdp-query-client.ts`, `/Users/nix/dev/ai/scratch/agent-browser/cdp-search.ts` ... | `guard.py agent-search-cutover` |
| 18 | `audit-pre-review` | verify | audit | code-reviewer (sonnet/high) | `docs/plan/stealth-browser/review/PRE-REVIEW.json`, `docs/plan/stealth-browser/review/PRE-REVIEW.md` | `guard.py audit-pre-review` |
| 19 | `audit-fixes` | verify | work | typescript-pro (sonnet/high) | `entrypoint/stealth-browser/`, `docs/plan/stealth-browser/review/PRE-REVIEW-RESOLUTION.json`, `/Users/nix/dev/ai/scratch/agent-browser/adhd/` ... | `guard.py audit-fixes` |
| 20 | `gates-first` | verify | work | qa (sonnet/medium) | `docs/plan/stealth-browser/evidence/` | `guard.py gates-first` |
| 21 | `review-prep` | review | work | qa (sonnet/low) | `docs/plan/stealth-browser/review/migration.diff`, `docs/plan/stealth-browser/review/INPUT.sha256`, `docs/plan/stealth-browser/review/BRIEF.txt` | `guard.py review-prep` |
| 22 | `audit-migration-blind` | review | audit | code-reviewer (sonnet/high) | `docs/plan/stealth-browser/review/FINDINGS.json` | `guard.py audit-migration-blind` |
| 23 | `resolve-findings` | remediate | work | typescript-pro (sonnet/high) | `entrypoint/stealth-browser/`, `docs/plan/stealth-browser/review/RESOLUTION.json` | `guard.py resolve-findings` |
| 24 | `gates-rerun` | remediate | work | qa (sonnet/medium) | `docs/plan/stealth-browser/evidence/` | `guard.py gates-rerun` |
| 25 | `docs-marketing-run` | docs | work | doc-steward (sonnet/medium) | `entrypoint/stealth-browser/docs/`, `entrypoint/stealth-browser/AGENTS.md`, `entrypoint/stealth-browser/llms.txt` ... | `guard.py docs-marketing-run` |
| 26 | `readme-rewrite` | docs | work | content-marketer (sonnet/medium) | `entrypoint/stealth-browser/README.md` | `guard.py readme-rewrite` |
| 27 | `audit-final` | release | audit | script () | `docs/plan/stealth-browser/final-review.md` | `guard.py audit-final` |
| 28 | `merge-readiness` | release | work | dispatcher (human/dispatcher) | `docs/plan/stealth-browser/RELEASE-DECISION.md` | `guard.py merge-readiness` |
| 29 | `agent-search-relink` | release | work | typescript-pro (sonnet/medium) | `/Users/nix/dev/ai/scratch/agent-browser/package.json`, `/Users/nix/dev/ai/scratch/agent-browser/pnpm-lock.yaml`, `/Users/nix/dev/ai/scratch/agent-browser/AGENTS.md` ... | `guard.py agent-search-relink` |

- Wave 0: `productization-hold`
- Wave 1: `scaffold`
- Wave 2: `entrypoint-parity`
- Wave 3: `deps-install`
- Wave 4: `mig-foundation`
- Wave 5: `mig-capture-parsers`, `mig-cdp`, `mig-docs`
- Wave 6: `mig-chrome-manager`, `mig-domains-storage`
- Wave 7: `mig-queries`
- Wave 8: `failsafe-inventory`
- Wave 9: `port-fixes`
- Wave 10: `cdp-test-harness`, `surface-api`, `tests-unit-core`, `tests-unit-data`, `tests-unit-extract`
- Wave 11: `capture-upgrade`, `chrome-lifecycle`
- Wave 12: `surface-hosts`
- Wave 13: `tracing-plugin`
- Wave 14: `prod-errors`, `tests-unit-surface`, `tracing-namespace-proof`
- Wave 15: `prod-examples`
- Wave 16: `tests-use-cases`
- Wave 17: `agent-search-cutover`
- Wave 18: `audit-pre-review`
- Wave 19: `audit-fixes`
- Wave 20: `gates-first`
- Wave 21: `review-prep`
- Wave 22: `audit-migration-blind`
- Wave 23: `resolve-findings`
- Wave 24: `gates-rerun`
- Wave 25: `docs-marketing-run`
- Wave 26: `readme-rewrite`
- Wave 27: `audit-final`
- Wave 28: `merge-readiness`
- Wave 29: `agent-search-relink`

## Execution model

All agents work in the same worktree and branch (`stealth-browser`), in non-overlapping buckets declared in `scripts/ownership.json`; commits carry `[psm:<slug>]`. Every `node_modules` need is a symlink from the main checkout until `deps-install` replaces it with a real install (`[inv:node-modules]`, `[inv:worktree-required]`). There is no live-Chrome lane (user decision): unit tests mock process spawn and third-party network libraries, and the use-case suites simulate real scenarios through the shared harness (`cdp-test-harness`: in-memory WebSocket CDP server, in-memory filesystem, fake process table; fixtures labelled `synthetic-protocol-conformant`). The agent-search cutover is the real-consumer integration proof. `audit-pre-review` is a static, non-blind audit followed by `audit-fixes` (ONE implementer); `audit-migration-blind` is the single blind review (the diff plus the single word `Review`), `resolve-findings` (one implementer) resolves every finding, `gates-rerun` re-runs the gates through nx, and `audit-final` is script-only (`audit_dod.py`).

## Acceptance mapping (ticket AC1-AC7)

AC ids are cited in specs with the ticket id `8468f7b1`; the per-state guard ids (`<slug>.N`) are the AC identifiers, mapped into `scripts/criteria.json` (see criteria.json). Coverage: package exists and is structurally identical (`scaffold.*`, `entrypoint-parity.*`, dod.1); behavior preserved and defects fixed at the source (`mig-*`, `port-fixes`, dod.4); six verbs on three surfaces proven by simulated scenarios (`surface-*`, `tests-use-cases`, dod.2); capture and lifecycle (`capture-upgrade.1-28` = CU1-CU27 plus the inventory pins, `chrome-lifecycle.1-27` = CL1-CL25 plus manager shape and inventory pins, `cdp-test-harness.1-6`); typed errors (`prod-errors`, 33 codes); tracing namespace (`tracing-*`, dod.3); source intact then cut over (`audit-final.5`, `agent-search-cutover`, dod.5, dod.9); review and remediation (dod.6); docs (dod.7); merge-readiness (dod.8).

## Productization hold point

`productization-hold` (executor `product`, phase `productization`) is the first state and a review hold point. Product reviewed SCOPE/DEMO/TOOLS and recorded its findings in `PRODUCT-REVIEW.md`. The user then decided each item (`PRODUCTIZATION-CATALOG.md`): product's verdict is the default, with these overrides: unit tests that simulate real use cases replace the e2e lane; the agent-search cutover substitutes for e2e and runs before the audit; typed errors cover 100% of failures (33 codes: 4 host, 14 library, 8 capture, 7 lifecycle); examples cover every verb and namespace; the Chrome lifecycle (19dfb641) is built now. The resulting changes:

- Removed: `tests-e2e`, `prod-public-api` (the greenfield API has no legacy subpath), `prod-publish-readiness` (its checks moved to `gates-first.7-9`), and the human blocker `hb-chrome-binary`.
- Added: `failsafe-inventory` (first, after the migration buckets), `port-fixes` (before the unit-test completions), `cdp-test-harness`, `capture-upgrade`, `chrome-lifecycle`, `tests-use-cases`, `audit-pre-review`, `audit-fixes`, and `agent-search-relink`.
- Reshaped: `surface-api` (greenfield root namespaces + six flat verbs), `prod-errors` (33 codes, the `recording` and `lifecycle` exports), `prod-examples` (a runnable example per verb and per namespace), `agent-search-cutover` (tarball, live-vs-recorded, parity before and after, delegation to the recorder and lifecycle APIs, backlog resolution evidence), `audit-final` (script-only; `.9` and `.10` ids stable).
- Insertion recipe for later items: add a new state with `plan-scaffold.js add-state`, then `set-reservation`, `add-criterion`, extend `scripts/ownership.json`, and make the intended successor depend on it. Existing slugs and criterion ids are never renamed. Re-run `check-disjoint.py` and `check-guards-red.py` after every insertion.

## Step 1c risk checkpoint

Highest risks: (1) apigen extraction failing opaquely on the verb types (pinned export shapes in `surface-api`); (2) a test or guard killing the developer's Chrome on 9222 (`[inv:live-chrome]`; the simulated lifecycle never signals a real process); (3) the cutover breaking the live MCP (dispatcher-gated, probed by a real MCP client, restore path in the context); (4) `node:sqlite` needing Node >= 22.5 (`entrypoint-parity.7`); (5) the namespace silently reverting to `apigen` (mutation proof).

## Open decisions

`EVALUATIONS.md` lists OD-1..OD-11 with the default applied to each and how to reverse it (sink dependency weight, ADR-0001 D5, redaction default, the `extraWaitMs` default, lifecycle backbone, reaper scope, presence records, legacy heartbeat reader, the backlog 19dfb641 AC4 amendment, the service-proxy extension design, the `dom.ts` SERP walker).

## Human action required before execution

1. `hb-deps-approval`: write `docs/plan/stealth-browser/APPROVALS.md` with `DEP-APPROVAL: granted` naming `node-html-parser`, `xpath`, `@xmldom/xmldom` (gates `deps-install`; already granted).
2. `hb-design-evaluations` (provided): the two architect evaluations are recorded in `EVALUATIONS.md`, `EVAL-store-adapter.md` and `EVAL-service-proxy.md` and folded into `capture-upgrade` and `chrome-lifecycle`. Their provisional defaults are the OPEN-DECISIONS OD-1..OD-11 of `EVALUATIONS.md` (all reversible), including the pending service-proxy extension design.
3. `hb-release-decision`: dispatcher writes `RELEASE-DECISION.md` (`DECISION: publish|defer`, a `CONSUME:` line) per `PUBLISHING.md` (gates `merge-readiness` and `agent-search-relink`).

## Dispatch

Run: `plan-orchestrator execute stealth-browser` (resume: `node $SKILL/scripts/state-transition.js docs/plan/stealth-browser`). Plan-time validators: `node $SKILL/scripts/gap-check.js docs/plan/stealth-browser --discover`, `python3 docs/plan/stealth-browser/scripts/check-disjoint.py`, `python3 docs/plan/stealth-browser/scripts/check-guards-red.py`.

## Glossary

- `stealth`: Chrome launched without `--enable-automation` and DOM walks without `Runtime.evaluate`.
- `verb`: one of the six exported chrome-runner functions.
- `surface`: library, CLI or MCP stdio host.
- `adhd`: the telemetry service namespace for tracing records.
- `guard`: the per-state deterministic check run by `scripts/guard.py`.
- `bucket`: the set of paths one state owns.

## Definition of Done

- `[dod.1]` **Exactly one new package exists, entrypoint/stealth-browser named @adhd/stealth-browser, produced by the workspace generator and structurally identical to the sibling entrypoints (structural)** — Exactly one new package exists, entrypoint/stealth-browser named @adhd/stealth-browser, produced by the workspace generator and structurally identical to the sibling entrypoints.
  - delivered-by: `scaffold, entrypoint-parity, deps-install`

- `[dod.2]` **The six chrome-runner verbs work from all three surfaces (library, CLI, MCP stdio), proven by use-case unit suites that simulate real scenarios and by the agent-search cutover (behavioral)** — The six chrome-runner verbs work from all three surfaces (library, CLI, MCP stdio).
  - given: the built package and the shared harness (in-memory CDP server, in-memory filesystem, fake process table, profile and page fixtures)
  - when: the use-case suites call chromeStatus/launchChrome/listPageTargets/checkChromeActivity/getPageContext/shutdownChrome through the library, the stealth-browser CLI and the stealth-browser-mcp host, and exercise at least six typed error codes
  - then: each surface returns the same structured results and shutdown stops only the launched Chrome
  - entrypoint: `nx run stealth-browser:test -- src/test/use-cases`
  - observable: `vitest exit 0 with at least 12 scenario suites green; the suites run in the unit lane with no socket, no subprocess and no network`
  - negative-control: `nx run stealth-browser:test -- src/test/use-cases fails (vitest exit non-zero) if the MCP host module is renamed or chromeStatus is pointed at a port the harness does not serve while a suite expects running=true`
  - delivered-by: `surface-api, surface-hosts, prod-errors, prod-examples, cdp-test-harness, capture-upgrade, chrome-lifecycle, tests-use-cases`

- `[dod.3]` **Tracing is namespaced adhd: a real verb call emits adhd.<op>.start/finish records and never apigen.* records (behavioral)** — Tracing is namespaced adhd: a real verb call emits adhd.<op>.start/finish records and never apigen.* records.
  - given: telemetry initialised against a temp file sink and the configured tracingPlugin mounted on the engine
  - when: a stealth-browser verb is invoked through the engine
  - then: every sink record event starts with adhd. and none starts with apigen.
  - entrypoint: `nx run stealth-browser:test -- entrypoint/stealth-browser/src/test/unit/tracing/tracing-namespace.spec.ts`
  - observable: `tracing-namespace.spec.ts passes and FAILS when src/tracing.ts serviceName is flipped to apigen (guard mutation)`
  - negative-control: `src/test/unit/tracing/tracing-namespace.spec.ts fails when src/tracing.ts serviceName is flipped to apigen or the package-level tracingPlugin singleton is mounted (guard mutation tracing-namespace-proof.4)`
  - delivered-by: `tracing-plugin, tracing-namespace-proof`

- `[dod.4]` **The migration preserves every feature and failsafe of the runner: each row of the failsafe inventory is pinned by a feature-level unit test (structural)** — The migration preserves every feature and failsafe of the runner, each pinned by a unit test; legacy code and names are not preserved.
  - delivered-by: `failsafe-inventory, mig-foundation, mig-cdp, mig-chrome-manager, mig-domains-storage, mig-capture-parsers, mig-queries, mig-docs, tests-unit-core, tests-unit-data, tests-unit-extract, tests-unit-surface, port-fixes`

- `[dod.5]` **The live agent-search source tree is byte-identical to its baseline commit up to the first cutover commit (structural)** — The live agent-search source tree is byte-identical to its baseline commit up to the first cutover commit.
  - delivered-by: `mig-foundation`

- `[dod.6]` **One blind review round ran on the diff plus the word Review, one implementer resolved every finding, and all gates were re-run green (structural)** — One blind review round ran on the diff plus the word Review, one implementer resolved every finding, and all gates were re-run green.
  - delivered-by: `audit-pre-review, audit-fixes, gates-first, review-prep, audit-migration-blind, resolve-findings, gates-rerun`

- `[dod.7]` **The doc-steward marketing run passed review and the content-marketer README is receipts-backed (structural)** — The doc-steward marketing run passed review and the content-marketer README is receipts-backed.
  - delivered-by: `docs-marketing-run, readme-rewrite`

- `[dod.8]` **The branch is fully committed, main node_modules untouched, and ready to fast-forward with a recorded release decision (structural)** — The branch is fully committed, main node_modules untouched, and ready to fast-forward with a recorded release decision.
  - delivered-by: `audit-final, merge-readiness`

- `[dod.9]` **After the cutover the live agent-search MCP server still serves chrome_status and list_providers while consuming @adhd/stealth-browser (behavioral)** — After the cutover the live agent-search MCP server still serves chrome_status and list_providers while consuming @adhd/stealth-browser.
  - given: the tarball packed from this worktree is installed as a real directory in agent-browser's node_modules
  - when: a real MCP stdio client starts `node server.mjs --transport stdio` and calls chrome_status and list_providers
  - then: both calls return structured results identical in shape to the pre-cutover capture and the runner implementation no longer exists under agent-browser
  - entrypoint: `python3 docs/plan/stealth-browser/scripts/guard.py agent-search-cutover`
  - observable: `guard exits 0: tools/list contains search, chrome_status returns a result, evidence/cutover-parity.json before equals after, no class CdpSession/ChromeManager/IdleShutdown/HistoryClient definition remains`
  - negative-control: `docs/plan/stealth-browser/scripts/guard.py agent-search-cutover fails (agent-search-cutover.4) when the migrated runner adhd/ is restored under agent-browser`
  - delivered-by: `agent-search-cutover, agent-search-relink`
