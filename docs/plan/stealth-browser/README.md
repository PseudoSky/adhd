# Migrate the agent-search chrome runner to @adhd/stealth-core-browser and agent-search to the @adhd/stealth-search entrypoint

Extract the Chrome/CDP runner from `scratch/agent-browser/adhd` into a generator-built core library, `@adhd/stealth-core-browser` (`packages/stealth/stealth-core-browser`, tier core), and port agent-search itself into a generator-built entrypoint, `@adhd/stealth-search` (`entrypoint/stealth-search`), which is built on top of the core and exposes the search and chrome verbs as a library, a CLI and an MCP stdio server, with every apigen tracing requirement (namespace `adhd`, one telemetry init per bin) carried over to the CLI and the MCP host. A third package, `@adhd/resilience-core-tripwire` (`packages/resilience/resilience-core-tripwire`), is the one tripwire that serves the three consumers (the reverse-apis request-builder gate, the reverse-apis unlock tool and the search entrypoint), and a single-pass Chrome lifecycle is built directly on `@adhd/sox-service-proxy` 0.6.0. The earlier `entrypoint/stealth-browser` package is retired and renamed to the core; `SPEC-stealth-search.md` is the architect specification and `APPROVAL-split.md` records the three-package direction. Release order: tripwire, then core, then search, then `consumer-relink`.

Backlog plan item: `8468f7b1-8adc-4237-9986-21ea1e27c537` (adhd, in_progress). Worktree `/Users/nix/dev/node/adhd/.worktrees/stealth-browser`, branch `stealth-browser` (cut from main `c6011647`). Authored artifacts: `SCOPE.md`, `USE_CASES.md`, `demo/DEMO.md`, `demo/UNRESOLVED.md`, `TOOLS.md`, `APPROVAL.md`, `APPROVAL-tripwire.md`, `SPEC-capture-and-lifecycle.md`, `SPEC-single-pass-lifecycle.md`, `SPEC-tripwire.md`.

## Consumer

A platform maintainer of the adhd monorepo (and the agents that call the agent-search MCP) who needs a real, quiet Chrome from code, a CLI or MCP, without importing a private path inside a scratch repo.

## Value delta

Before: the Chrome/CDP runner lives inside `scratch/agent-browser/adhd/`, welded to the search server; every other tool copies it or reaches into a private path, and it has no typed API, CLI, MCP host or tracing. After: one workspace package built by the generator exposes the six verbs on three surfaces, traced under `adhd`, proven by use-case unit suites that simulate real scenarios through an in-memory CDP harness, plus a real-consumer cutover (agent-search runs on the packed package and its MCP server keeps serving). The capture pipeline is upgraded to a network recorder and the Chrome lifecycle (19dfb641) is built now, keeping every feature and failsafe of the source runner (feature inventory); the optional recording sink is a store-adapter sink (`@adhd/sox-store-adapter`, lazy import) and the lifecycle is an in-package engine whose default reaper launcher reuses `@adhd/sox-service-proxy`, both recorded in `EVALUATIONS.md`.

## Boundary (the correct package)

Migrates: `agent-browser/adhd/` (CDP connection, `chrome-manager.ts`, `capture/*`, `domains/*`, `storage/*`, `parsers.ts`, `helpers.ts`, `session.ts`, `types.ts`, `docs/*`), the engine-agnostic `search/queries/{activity,context}.ts`, and the six chrome verbs extracted from `search-mcp-source.ts:454-495`. Stays in agent-search (which then consumes `@adhd/stealth-core-browser`): providers, the tripwire adapter (the tripwire logic itself moves to `@adhd/resilience-core-tripwire`, which agent-search consumes in the same cutover), `search`/`listProviders`, `search-challenge.ts`, `search-fetch.ts`, `search-dom.ts`, `last-search.ts`, `server.mjs`, and `search-mcp-source.ts` reduced to search verbs. Evidence: `adhd/` imports only `node-html-parser`, `xpath` and `@xmldom/xmldom` (`adhd/parsers.ts:17-26`) plus `node:*`; `cdp-query-client.ts` is a 42-line barrel over it. The existing agent-search plan (`docs/restructure-proposal.md`, `docs/dispatch-plan.md`) is wrong on strategy: it restructures in place across six branches, keeps search-named items in the generic layer, and plans a nested private `@adhd/cdp-connection` package plus committed `.js` twins. This plan keeps ONE package, one branch, and a single shared worktree. The package is greenfield: no consumers exist, so legacy code, names and tests are not preserved, while every FEATURE and FAILSAFE of the runner is preserved and pinned by a new unit test (`[inv:no-features-removed]`, `evidence/failsafe-inventory.json`). Only `chromeStatus`, `launchChrome` and `shutdownSearchChrome` exist in the runner source; the other verbs and the root namespaces are new design (`surface-api`). Full detail: `SCOPE.md`; every productization decision: `PRODUCTIZATION-CATALOG.md`; items left out: `DEFERRED.md`. Prior comparison input for the capture and lifecycle design: `/Users/nix/dev/projects/reverse-apis/docs/marketing/.catalog/cross-repo-comparison.md`.

## Source package after migration

Until the first `search-cutover` commit the scratch `agent-browser/adhd/` tree equals the baseline commit in `evidence/source-baseline.txt` (guard `source_untouched`, read from git), so the live MCP (`search-mcp-source.ts`) never breaks. The cutover is REQUIRED and runs before `audit-pre-review` and the one blind review: the package built from this worktree is packed into a tarball stored outside every `.worktrees` directory and installed as a real directory in agent-browser's `node_modules`; the 14 consumer files import only the package root; `agent-browser/adhd/` is deleted; the committed `package.json` records only a dependency range and no lockfile changes. Parity is proven through `node server.mjs --transport stdio` before and after (`evidence/cutover-parity.json`), and `evidence/cutover-live-vs-recorded.md` states exactly what is LIVE (the tarball install), RECORDED (the range) and NOT-CHANGED (both lockfiles). The second step, `consumer-relink`, runs after `merge-readiness` and the dispatcher's release decision (`hb-release-decision`): it switches to the published version or a `link:` into the merged main checkout, never a worktree. The scratch repo is local-only; its dirty tree is respected by staging explicit paths.

## Related backlog items (explicit scope calls)

- `8468f7b1-8adc-4237-9986-21ea1e27c537` (kind plan, in_progress, AC1-AC7): the parent of this plan; cites `restructure-proposal.md:1-8` and `dispatch-plan.md:1-8`. IN scope as the ticket every test cites.
- `5b98d3b2-3894-4142-b899-540bad821a19` (FEAT-AGENT-TRACING, open P1): OUT of scope (unchanged). It is an agent-side plugin (`@adhd/agent-plugin-tracing`) for agent-mcp with new hook events (children TRACE-1..5). It cites `packages/apigen/apigen-plugin-tracing/src/lib/plugin.ts:6-14` only as precedent. Our tracing state uses the apigen side (`makeTracingPlugin`) and nothing from that item. Related open item `5152786d` (apigen tracing design docs stale after the serviceName namespacing change) is the namespacing context for `tracing-log-validation`.
- `19dfb641-516f-445d-8fb1-28afbaa9b566` (self-reaping Chrome singleton, open feature): IN scope since the user's decision "build it now, there will not be a v3" (`PRODUCTIZATION-CATALOG.md`). The port (`mig-chrome-manager`) stays faithful; `chrome-lifecycle` then builds the lifecycle with every existing feature kept (idle-safety tiers incl. history recency and `checkHistory`, cross-process coordination, launch lock, group kill, newtab fix, livelock protection, isolated-page cleanup); the design is single-pass (`SPEC-single-pass-lifecycle.md`): presence is one held connection per client to a reaper host built on `@adhd/sox-service-proxy` 0.6.0 (`dialBackend`, `serveBackend`, `createIdleRetirer`, `createCircuitBreaker`), one `ReaperLink` port, a pure `decideReap`, no presence registry and no heartbeat file. `search-cutover` re-cites the item to the new package paths. Closed item `90ed0315` records that the reap fixes already exist in the ported code.
- `5152786d-0243-41ab-b232-fff7fdcfd8f2` (apigen tracing design notes stale after the serviceName change, open debt): OUT of scope to fix here (the notes live in `docs/apigen/design-notes/`). IN scope as a pin: `search-tracing.8` and `tracing-log-validation.6` assert what `plugin.ts` actually emits (`${serviceName}.op`, `${serviceName}.transport`, `${serviceName}.op.error`) so this plan follows the code, not the stale notes.
- Backlog component `24cfccf0-fa28-4fa8-af08-23d0c1c56978` is the registered home of `packages/stealth/stealth-core-browser`; file follow-ups (the P11 learnings review and the PRODUCT-REVIEW.md out-of-scope candidates) against it.

### Backlog bugs against the old agent-search, folded into port acceptance criteria

Each bug is a red-before-work guard on the state that owns the behavior; the criterion text is in `scripts/guards/` and mirrored in `contexts/<state>.md` under "Backlog fold-in". The backlog is not edited here.

| Backlog uid | Sev | Criterion (owning state) |
|---|---|---|
| cd05ad09 | HIGH | `search-port-fetch.9`, `search-verbs.10` |
| 861571da | | `search-port-providers.9`, `search-verbs.11` |
| 224e7a44 | | `search-port-providers.9`, `search-port-engine.9`, `search-verbs.11` |
| 86ed154e | | `search-port-fetch.10`, `search-verbs.12`, `search-hosts.21` |
| abeedba8 | | `search-hosts.18` |
| 657bd597 | | `search-hosts.19` |
| 93dee018 | | `search-port-guards.10` |
| c6d7fbcf | HIGH | `search-port-guards.9` |
| 982ea870 | HIGH | `search-port-guards.9` |
| 9487dcd0, d201694e, a3266358, 6ae134b9, 08801f2a, 84e1f7a2, 3aaa855f | | `search-port-guards.9` |
| 9d05e8b2 | | `search-hosts.20` |
| 7f881aa7 | HIGH | `core-seam.6` (not covered by the completed `chrome-lifecycle`: default `reaperScope` is `port-occupant` and `launchChrome` accepts any reachable listener) |
| 406a4e66 | | `search-port-engine.10`, `search-inventory.6` |
| e093636f | | `core-seam.5` (static scan stays `chrome-lifecycle.24`) |
| 591e1a7 (old commit: github code search via embedded JSON, HITL login wall, raw network status, request timeout) | | `core-seam.7`, `core-seam.8`, `core-seam.9`, `search-port-providers.9`, `search-port-providers.10`, `search-port-engine.9`, `search-port-engine.11`, `search-port-engine.12`, `search-port-engine.13`, `search-port-engine.14`, `search-port-guards.11`, `search-verbs.13`, `search-verbs.14`, `search-verbs.15`, `search-errors.7`, `search-hosts.22`, `search-inventory.7` |
| c00edea (old commit: no retry of a zero-result page, retry only transport failures) | | `core-seam.10`, `search-port-engine.15`, `search-verbs.16`, `search-inventory.7` |

### Delta fold-in (2026-10-21): fixes that went into the old agent-search after the port inventory

The old `agent-browser/` (agent-search) gained two commits after the failsafe inventory baseline: `591e1a7` and `c00edea`. The delta report listed 15 behavioral rows; each is now a red-before-work guard (`scripts/guards/search_c.py`, criterion text in `scripts/guards/delta-criteria.json`, mirrored in `contexts/<state>.md`) proven by a unit test that simulates the real use case (mocked process spawn and network, fixtures from `agent-browser/test-fixtures/github/`). Criterion ids are appended, never renumbered.

| Delta row | Behavior | Criterion (owning state) |
|---|---|---|
| 1 | provider config types, no `github-code` provider name pinned | `search-port-providers.9` (reworded) |
| 2 | `emptyRequiresLogin`, `fallbackNetwork`, `sharedProfile`, `fallbackView` | `search-port-providers.9`, `search-port-providers.10` |
| 3 | login wall response (`login_required`, `return_to`, signed-in vs signed-out) | `search-port-engine.11` |
| 4 | login wall trips the guard without a lock; `reveal` and `confirmSolved` | `search-port-guards.11`, `search-verbs.13` (`search-verbs.4` carved out) |
| 5 | `sharedProfile` page option (browser context create/close/dispose) | `core-seam.7` |
| 7 | raw network status: 429 and 503 with `retry-after` | `search-port-engine.12` |
| 8 | request `timeoutMs` honoured | `search-port-engine.13`, `search-verbs.14` |
| 9 | unsupported strategy fails before any page: `SEARCH_FAILED` reason `strategy-unsupported` | `search-verbs.15`, `search-errors.7`, `search-port-engine.14`, `search-port-engine.9` (reworded: no "fall back to dom once") |
| 10 | `fallbackView` and the no-DOM-strategy case | `search-port-providers.10`, `search-port-engine.14` |
| 11 | embedded-json `{path}` interpolation, markup stripping, entity decoding | `core-seam.8` |
| 12, 13 | HITL on closed stdin aborts with exit 2 (`HITL_ABORTED`) | `search-hosts.22`, `search-errors.7` |
| 14 | `lsof -sTCP:LISTEN` idle-shutdown lookup | `core-seam.9` |
| 18 | `decideRetry` does not retry `empty` (legitimate zero results) | `core-seam.10`, `search-verbs.16` |
| 19 | `noCaptureOutcome` (WebSocket error or timeout vs empty) | `search-port-engine.15` |
| 6, 15 | already covered by existing criteria (no change) | unchanged |
| 16, 17, 20 | no action (not behavior of the port) | none |

`search-inventory.7` makes the inventory own every delta symbol (`fallbackView`, `resolveProvider`, `loginWallResponse`, `noCaptureOutcome`, `decideRetry`, `sharedProfile`, `lsof`). Core-side rows land on `core-seam`, which stays in progress; its reservation gained `cdp/targets.ts`, `parsers.ts`, `capture/bans.ts`, the three `lifecycle/reaper-*.ts` files and the specs below.

Repairs reported by the orchestrator, folded in the same pass:

- `core-seam.12` and a relaxed `chrome-lifecycle.11`: three specs the guards did not own (`cdp/browser.spec.ts`, `lifecycle/concurrent-launch.spec.ts`, `lifecycle/reaper-scope.spec.ts`) plus `capture-parsers/bans.spec.ts` are now in `core-seam` mutates, edited for fixtures only (assertion lines compared against the state start, `lsof` flag spelling normalized); `chrome-lifecycle.11` compares assertion lines rather than bytes. `core-seam.6` text was corrected to match its guard.
- `prod-errors.9`: `api.launchChrome` and the other verbs that wrap a lifecycle failure rethrow the typed `LifecycleError`/reason (`src/api.ts` added to `prod-errors` mutates).
- `core-seam.11`: the reaper port-occupant path threads the resolved profile through `ChromeReaperConfig` to `killChrome` instead of using the default profile.
- `core-scaffold.2` and `tripwire-reverse-migrate.1`: criterion text now states what the guard checks.
- `human-blockers.json` declares `hb-confirm-token` and `hb-tripwire-invalid-key` (code identifiers, not secrets) so gap-check no longer warns.

Decisions: no new error code (the `strategy-unsupported` case is a reason of `SEARCH_FAILED`); `search-hosts.23` pins commander `^14.0.3` because commander 15 requires node >=22.12.0 while the entrypoint engines is >=22.5 and the workspace pins 14.0.3; the delta fixtures live under the existing `agent-browser/test-fixtures/github/` and are copied by the owning states, not shared across packages.

## THREE approved new packages

The plan builds exactly three packages, each produced by the workspace generator: `packages/resilience/resilience-core-tripwire` (`@adhd/resilience-core-tripwire`, `APPROVAL-tripwire.md`, decision D1), `packages/stealth/stealth-core-browser` (`@adhd/stealth-core-browser`, built with `npx nx g @adhd/workspace-codegen-nx:core --name=browser --group=stealth ...` after the new `stealth` workspace group is added) and `entrypoint/stealth-search` (`@adhd/stealth-search`, built with `npx nx g @adhd/workspace-codegen-nx:entrypoint --name stealth-search --nxLayer entrypoints --platform node`). The user's request "port search to the entrypoint transfering all the apigen / tracing requirements over to the cli and mcps for search ... Rename the entrypoint stealth search and the cdp to stealth core browser" (`APPROVAL-split.md`) is the approval. No fourth package may be created (`[inv:one-new-package]`). Build order: tripwire, core, search; the new third-party dependencies of the search entrypoint (`turndown`, `pdfjs-dist`, `commander`) and the sox packages are owned or commodity choices and need no approval gate.

## States (64), waves, executors

Wave = dependency depth; states in one wave with no edge between them may run concurrently, and `scripts/check-disjoint.py` proves their owned paths are disjoint. The executor is named in each state's `notes`. The longest dependency chain has 38 states. Release order: tripwire, then core (`@adhd/stealth-core-browser`), then search (`@adhd/stealth-search`), then `consumer-relink`.

| Wave | State | Phase | Kind | Executor | Owned paths | Guard |
|---|---|---|---|---|---|---|
| 0 | `productization-hold` | productization | review | executor=product tier=sonnet/medium | `docs/plan/stealth-browser/PRODUCT-REVIEW.md` | `guard.py productization-hold` |
| 1 | `scaffold` | scaffold | work | executor=platform-engineer tier=sonnet/medium | `entrypoint/stealth-browser/`, `tsconfig.base.json`, `docs/plan/stealth-browser/evidence/` | `guard.py scaffold` |
| 2 | `entrypoint-parity` | scaffold | work | executor=platform-engineer tier=sonnet/medium | `entrypoint/stealth-browser/*`, `docs/plan/stealth-browser/evidence/` | `guard.py entrypoint-parity` |
| 3 | `deps-install` | scaffold | work | executor=platform-engineer tier=sonnet/medium | `entrypoint/stealth-browser/package.json`, `pnpm-lock.yaml`, `entrypoint/stealth-browser/eslint.config.mjs` ... | `guard.py deps-install` |
| 4 | `mig-foundation` | migrate | work | executor=refactoring-specialist tier=sonnet/medium | `entrypoint/stealth-browser/src/lib/types.ts`, `entrypoint/stealth-browser/src/lib/session.ts`, `entrypoint/stealth-browser/src/lib/helpers.ts` | `guard.py mig-foundation` |
| 5 | `mig-cdp` | migrate | work | executor=refactoring-specialist tier=sonnet/medium | `entrypoint/stealth-browser/src/lib/cdp/` | `guard.py mig-cdp` |
| 5 | `mig-capture-parsers` | migrate | work | executor=refactoring-specialist tier=sonnet/medium | `entrypoint/stealth-browser/src/lib/capture/`, `entrypoint/stealth-browser/src/lib/parsers.ts`, `entrypoint/stealth-browser/eslint.config.mjs` | `guard.py mig-capture-parsers` |
| 5 | `mig-docs` | migrate | work | executor=refactoring-specialist tier=sonnet/low | `entrypoint/stealth-browser/docs/reference/` | `guard.py mig-docs` |
| 6 | `mig-chrome-manager` | migrate | work | executor=refactoring-specialist tier=sonnet/medium | `entrypoint/stealth-browser/src/lib/chrome-manager.ts` | `guard.py mig-chrome-manager` |
| 6 | `mig-domains-storage` | migrate | work | executor=refactoring-specialist tier=sonnet/medium | `entrypoint/stealth-browser/src/lib/domains/`, `entrypoint/stealth-browser/src/lib/storage/` | `guard.py mig-domains-storage` |
| 7 | `mig-queries` | migrate | work | executor=refactoring-specialist tier=sonnet/medium | `entrypoint/stealth-browser/src/lib/queries/` | `guard.py mig-queries` |
| 8 | `failsafe-inventory` | migrate | work | executor=refactoring-specialist tier=sonnet/high | `docs/plan/stealth-browser/evidence/failsafe-inventory.json` | `guard.py failsafe-inventory` |
| 9 | `port-fixes` | migrate | work | executor=typescript-pro tier=sonnet/high | `entrypoint/stealth-browser/src/lib/`, `entrypoint/stealth-browser/vite.config.ts`, `entrypoint/stealth-browser/tsconfig.spec.json` ... | `guard.py port-fixes` |
| 10 | `surface-api` | surface | work | executor=typescript-pro tier=sonnet/high | `entrypoint/stealth-browser/src/api.ts`, `entrypoint/stealth-browser/src/index.ts`, `docs/plan/stealth-browser/evidence/product-claims.json` | `guard.py surface-api` |
| 10 | `tests-unit-core` | verify | work | executor=test-automator tier=sonnet/medium | `entrypoint/stealth-browser/src/test/unit/foundation/`, `entrypoint/stealth-browser/src/test/unit/cdp/`, `entrypoint/stealth-browser/src/test/unit/chrome-manager/` | `guard.py tests-unit-core` |
| 10 | `tests-unit-data` | verify | work | executor=test-automator tier=sonnet/medium | `entrypoint/stealth-browser/src/test/unit/domains-storage/`, `entrypoint/stealth-browser/src/test/unit/queries/` | `guard.py tests-unit-data` |
| 10 | `tests-unit-extract` | verify | work | executor=test-automator tier=sonnet/medium | `entrypoint/stealth-browser/src/test/unit/capture-parsers/` | `guard.py tests-unit-extract` |
| 10 | `cdp-test-harness` | migrate | work | executor=test-automator tier=sonnet/medium | `entrypoint/stealth-browser/src/test/support/`, `entrypoint/stealth-browser/src/test/fixtures/cdp/`, `entrypoint/stealth-browser/src/test/unit/support/` | `guard.py cdp-test-harness` |
| 10 | `sp-reaper-load-proof` | migrate | work | executor=typescript-pro tier=sonnet/medium | `docs/plan/stealth-browser/smoke/reaper-load-proof.md` | `guard.py sp-reaper-load-proof` |
| 10 | `sp-link` | migrate | work | executor=devops-engineer tier=sonnet/medium | `entrypoint/stealth-browser/package.json`, `package.json`, `pnpm-lock.yaml` ... | `guard.py sp-link` |
| 10 | `tripwire-scaffold` | scaffold | work | executor=typescript-pro tier=sonnet/medium | `packages/resilience/resilience-core-tripwire/`, `tsconfig.base.json`, `.adhd/workspace.json` ... | `guard.py tripwire-scaffold` |
| 11 | `capture-upgrade` | migrate | work | executor=typescript-pro tier=sonnet/high | `entrypoint/stealth-browser/src/lib/recording/`, `entrypoint/stealth-browser/src/lib/capture/network.ts`, `entrypoint/stealth-browser/src/lib/capture/index.ts` ... | `guard.py capture-upgrade` |
| 11 | `chrome-lifecycle` | migrate | work | executor=typescript-pro tier=sonnet/high | `entrypoint/stealth-browser/src/lib/lifecycle/`, `entrypoint/stealth-browser/src/lib/chrome-manager.ts`, `entrypoint/stealth-browser/src/lib/cdp/targets.ts` ... | `guard.py chrome-lifecycle` |
| 11 | `tripwire-core` | migrate | work | executor=typescript-pro tier=sonnet/high | `packages/resilience/resilience-core-tripwire/src/`, `packages/resilience/resilience-core-tripwire/*` | `guard.py tripwire-core` |
| 12 | `tripwire-interactive` | migrate | work | executor=typescript-pro tier=sonnet/high | `packages/resilience/resilience-core-tripwire/src/`, `packages/resilience/resilience-core-tripwire/*` | `guard.py tripwire-interactive` |
| 13 | `tripwire-docs` | docs | work | executor=typescript-pro tier=sonnet/medium | `packages/resilience/resilience-core-tripwire/README.md`, `packages/resilience/resilience-core-tripwire/CHANGELOG.md`, `packages/resilience/resilience-core-tripwire/docs/` ... | `guard.py tripwire-docs` |
| 14 | `tripwire-pack` | verify | work | executor=typescript-pro tier=sonnet/medium | `docs/plan/stealth-browser/evidence/tripwire/`, `packages/resilience/resilience-core-tripwire/package.json`, `packages/resilience/resilience-core-tripwire/project.json` ... | `guard.py tripwire-pack` |
| 15 | `tripwire-reverse-migrate` | migrate | work | executor=typescript-pro tier=sonnet/high | `/Users/nix/dev/projects/reverse-apis/.worktrees/tripwire-adopt/`, `/Users/nix/dev/projects/reverse-apis/.git/info/exclude`, `docs/plan/stealth-browser/tripwire-reverse/` | `guard.py tripwire-reverse-migrate` |
| 15 | `split-plan-repair` | scaffold | work | plan-builder amendment: rename core to @adhd/stealth-core-br | `docs/plan/stealth-browser/scripts/`, `docs/plan/stealth-browser/dag.json`, `docs/plan/stealth-browser/contexts/` ... | `guard.py split-plan-repair` |
| 16 | `core-scaffold` | scaffold | work | typescript-pro sonnet/high | `packages/stealth/stealth-core-browser/`, `entrypoint/stealth-browser/`, `.adhd/workspace.json` ... | `guard.py core-scaffold` |
| 17 | `core-seam` | migrate | work | typescript-pro sonnet/high | `packages/stealth/stealth-core-browser/src/lib/managers.ts`, `packages/stealth/stealth-core-browser/src/lib/chrome-manager.ts`, `packages/stealth/stealth-core-browser/src/lib/lifecycle/index.ts` ... | `guard.py core-seam` delta: core-seam.7-12 (591e1a7, c00edea, repairs) |
| 17 | `search-scaffold` | scaffold | work | typescript-pro sonnet/high | `entrypoint/stealth-search/`, `tsconfig.base.json`, `pnpm-lock.yaml` ... | `guard.py search-scaffold` |
| 18 | `tests-unit-surface` | verify | work | executor=test-automator tier=sonnet/medium | `packages/stealth/stealth-core-browser/src/test/unit/surface/` | `guard.py tests-unit-surface` |
| 18 | `prod-errors` | surface | work | executor=typescript-pro tier=sonnet/high | `packages/stealth/stealth-core-browser/src/errors.ts`, `packages/stealth/stealth-core-browser/src/lib/`, `packages/stealth/stealth-core-browser/src/index.ts` ... | `guard.py prod-errors` delta: prod-errors.9 (api.launchChrome typed errors) |
| 18 | `search-inventory` | migrate | work | typescript-pro sonnet/high | `docs/plan/stealth-browser/evidence/search-failsafe-inventory.json` | `guard.py search-inventory` delta: search-inventory.7 (591e1a7, c00edea) |
| 18 | `search-tracing` | surface | work | typescript-pro sonnet/medium | `entrypoint/stealth-search/src/tracing.ts`, `entrypoint/stealth-search/src/telemetry.ts` | `guard.py search-tracing` |
| 19 | `prod-examples` | surface | work | executor=typescript-pro tier=sonnet/medium | `packages/stealth/stealth-core-browser/examples/`, `packages/stealth/stealth-core-browser/src/test/unit/examples/`, `packages/stealth/stealth-core-browser/tsconfig.spec.json` | `guard.py prod-examples` |
| 19 | `sp-reaper-smoke` | verify | work | executor=qa tier=sonnet/medium | `docs/plan/stealth-browser/smoke/reaper-smoke.mjs`, `docs/plan/stealth-browser/smoke/reaper-smoke.md`, `docs/plan/stealth-browser/smoke/reaper-smoke.json` | `guard.py sp-reaper-smoke` |
| 19 | `search-errors` | migrate | work | typescript-pro sonnet/high | `entrypoint/stealth-search/src/errors.ts`, `entrypoint/stealth-search/src/test/unit/errors/`, `entrypoint/stealth-search/docs/ERRORS.md` | `guard.py search-errors` delta: search-errors.7 (591e1a7) |
| 20 | `tests-use-cases` | verify | work | executor=test-automator tier=sonnet/high | `packages/stealth/stealth-core-browser/src/test/use-cases/`, `packages/stealth/stealth-core-browser/src/test/support/profile-fixtures.ts`, `packages/stealth/stealth-core-browser/src/test/support/page-fixtures.ts` | `guard.py tests-use-cases` |
| 20 | `search-port-providers` | migrate | work | typescript-pro sonnet/high | `entrypoint/stealth-search/src/lib/types.ts`, `entrypoint/stealth-search/src/lib/providers.ts`, `entrypoint/stealth-search/src/lib/utils.ts` ... | `guard.py search-port-providers` delta: providers.9 reworded, .10 (591e1a7) |
| 20 | `search-port-fetch` | migrate | work | typescript-pro sonnet/high | `entrypoint/stealth-search/src/lib/fetch/`, `entrypoint/stealth-search/src/test/unit/fetch/`, `docs/plan/stealth-browser/evidence/split/u-pdf.json` | `guard.py search-port-fetch` |
| 20 | `search-port-guards` | migrate | work | typescript-pro sonnet/high | `entrypoint/stealth-search/src/lib/guard.ts`, `entrypoint/stealth-search/src/lib/tripwire.ts`, `entrypoint/stealth-search/src/lib/config.ts` ... | `guard.py search-port-guards` delta: guards.11 (591e1a7) |
| 21 | `search-port-engine` | migrate | work | typescript-pro sonnet/high | `entrypoint/stealth-search/src/lib/network.ts`, `entrypoint/stealth-search/src/lib/dom.ts`, `entrypoint/stealth-search/src/lib/challenge.ts` ... | `guard.py search-port-engine` delta: engine.9 reworded, .11-.15 (591e1a7, c00edea) |
| 22 | `search-verbs` | surface | work | typescript-pro sonnet/high | `entrypoint/stealth-search/src/api.ts`, `entrypoint/stealth-search/src/lib/search.ts`, `entrypoint/stealth-search/src/host-projection.ts` ... | `guard.py search-verbs` delta: verbs.4 carved out, .13-.16 (591e1a7, c00edea) |
| 23 | `search-hosts` | surface | work | typescript-pro sonnet/high | `entrypoint/stealth-search/src/server.ts`, `entrypoint/stealth-search/src/cli.ts`, `entrypoint/stealth-search/src/host-flags.ts` ... | `guard.py search-hosts` delta: hosts.22 (591e1a7), .23 (commander ^14.0.3) |
| 24 | `sp-switch` | verify | work | executor=devops-engineer tier=sonnet/medium | `package.json`, `pnpm-lock.yaml`, `docs/plan/stealth-browser/smoke/switch.md` | `guard.py sp-switch` |
| 24 | `search-usecases` | verify | work | typescript-pro sonnet/high | `entrypoint/stealth-search/src/test/use-cases/` | `guard.py search-usecases` |
| 24 | `search-examples` | verify | work | typescript-pro sonnet/medium | `entrypoint/stealth-search/examples/`, `entrypoint/stealth-search/src/test/unit/examples/`, `entrypoint/stealth-search/README.md` | `guard.py search-examples` |
| 24 | `tracing-log-validation` | verify | work | general-purpose sonnet/medium | `docs/plan/stealth-browser/evidence/tracing-log-validation.md`, `docs/plan/stealth-browser/evidence/tracing-log-validation.json` | `guard.py tracing-log-validation` |
| 25 | `search-cutover` | verify | work | typescript-pro sonnet/high | `docs/plan/stealth-browser/evidence/cutover/`, `/Users/nix/dev/ai/scratch/agent-browser/`, `/Users/nix/dev/ai/scratch/bin/scratch-agent-search` ... | `guard.py search-cutover` |
| 26 | `audit-pre-review` | verify | audit | executor=code-reviewer tier=sonnet/high | `/Users/nix/dev/node/adhd/.worktrees/stealth-browser/docs/plan/stealth-browser/review/PRE-REVIEW.json`, `/Users/nix/dev/node/adhd/.worktrees/stealth-browser/docs/plan/stealth-browser/review/PRE-REVIEW.md` | `guard.py audit-pre-review` |
| 27 | `audit-fixes` | verify | work | executor=typescript-pro tier=sonnet/high | `packages/stealth/stealth-core-browser/`, `entrypoint/stealth-search/`, `/Users/nix/dev/node/adhd/.worktrees/stealth-browser/docs/plan/stealth-browser/review/PRE-REVIEW-RESOLUTION.json` ... | `guard.py audit-fixes` |
| 28 | `gates-first` | verify | work | executor=qa tier=sonnet/medium | `docs/plan/stealth-browser/evidence/` | `guard.py gates-first` |
| 29 | `review-prep` | review | work | executor=qa tier=sonnet/low | `docs/plan/stealth-browser/review/migration.diff`, `docs/plan/stealth-browser/review/INPUT.sha256`, `docs/plan/stealth-browser/review/BRIEF.txt` | `guard.py review-prep` |
| 30 | `audit-migration-blind` | review | audit | executor=code-reviewer tier=sonnet/high | `docs/plan/stealth-browser/review/FINDINGS.json` | `guard.py audit-migration-blind` |
| 31 | `resolve-findings` | remediate | work | executor=typescript-pro tier=sonnet/high | `packages/stealth/stealth-core-browser/`, `entrypoint/stealth-search/`, `docs/plan/stealth-browser/review/RESOLUTION.json` ... | `guard.py resolve-findings` |
| 32 | `gates-rerun` | remediate | work | executor=qa tier=sonnet/medium | `docs/plan/stealth-browser/evidence/` | `guard.py gates-rerun` |
| 33 | `docs-marketing-run` | docs | work | executor=doc-steward tier=sonnet/medium | `packages/stealth/stealth-core-browser/docs/`, `packages/stealth/stealth-core-browser/AGENTS.md`, `packages/stealth/stealth-core-browser/llms.txt` ... | `guard.py docs-marketing-run` |
| 34 | `readme-rewrite` | docs | work | executor=content-marketer tier=sonnet/medium | `packages/stealth/stealth-core-browser/README.md`, `entrypoint/stealth-search/README.md` | `guard.py readme-rewrite` |
| 35 | `audit-final` | release | audit | executor=script (audit_dod.py via guard.py audit-final | `docs/plan/stealth-browser/final-review.md` | `guard.py audit-final` |
| 36 | `merge-readiness` | release | work | executor=dispatcher tier=human/dispatcher | `docs/plan/stealth-browser/RELEASE-DECISION.md` | `guard.py merge-readiness` |
| 37 | `tripwire-reverse-relink` | release | work | executor=typescript-pro tier=sonnet/medium | `/Users/nix/dev/projects/reverse-apis/.worktrees/tripwire-adopt/package.json`, `/Users/nix/dev/projects/reverse-apis/.worktrees/tripwire-adopt/pnpm-lock.yaml`, `docs/plan/stealth-browser/tripwire-reverse/` | `guard.py tripwire-reverse-relink` |
| 37 | `consumer-relink` | release | work | dispatcher-gated after publication in order tripwire, stealt | `docs/plan/stealth-browser/evidence/relink/`, `/Users/nix/.claude/agents/`, `/Users/nix/.config/opencode/` ... | `guard.py consumer-relink` |

- Wave 0: `productization-hold`
- Wave 1: `scaffold`
- Wave 2: `entrypoint-parity`
- Wave 3: `deps-install`
- Wave 4: `mig-foundation`
- Wave 5: `mig-cdp`, `mig-capture-parsers`, `mig-docs`
- Wave 6: `mig-chrome-manager`, `mig-domains-storage`
- Wave 7: `mig-queries`
- Wave 8: `failsafe-inventory`
- Wave 9: `port-fixes`
- Wave 10: `surface-api`, `tests-unit-core`, `tests-unit-data`, `tests-unit-extract`, `cdp-test-harness`, `sp-reaper-load-proof`, `sp-link`, `tripwire-scaffold`
- Wave 11: `capture-upgrade`, `chrome-lifecycle`, `tripwire-core`
- Wave 12: `tripwire-interactive`
- Wave 13: `tripwire-docs`
- Wave 14: `tripwire-pack`
- Wave 15: `tripwire-reverse-migrate`, `split-plan-repair`
- Wave 16: `core-scaffold`
- Wave 17: `core-seam`, `search-scaffold`
- Wave 18: `tests-unit-surface`, `prod-errors`, `search-inventory`, `search-tracing`
- Wave 19: `prod-examples`, `sp-reaper-smoke`, `search-errors`
- Wave 20: `tests-use-cases`, `search-port-providers`, `search-port-fetch`, `search-port-guards`
- Wave 21: `search-port-engine`
- Wave 22: `search-verbs`
- Wave 23: `search-hosts`
- Wave 24: `sp-switch`, `search-usecases`, `search-examples`, `tracing-log-validation`
- Wave 25: `search-cutover`
- Wave 26: `audit-pre-review`
- Wave 27: `audit-fixes`
- Wave 28: `gates-first`
- Wave 29: `review-prep`
- Wave 30: `audit-migration-blind`
- Wave 31: `resolve-findings`
- Wave 32: `gates-rerun`
- Wave 33: `docs-marketing-run`
- Wave 34: `readme-rewrite`
- Wave 35: `audit-final`
- Wave 36: `merge-readiness`
- Wave 37: `tripwire-reverse-relink`, `consumer-relink`

## Execution model

All agents work in the same worktree and branch (`stealth-browser`), in non-overlapping buckets declared in `scripts/ownership.json`; commits carry `[psm:<slug>]`. Every `node_modules` need is a symlink from the main checkout until `deps-install` replaces it with a real install (`[inv:node-modules]`, `[inv:worktree-required]`). There is no live-Chrome lane (user decision): unit tests mock process spawn and third-party network libraries, and the use-case suites simulate real scenarios through the shared harness (`cdp-test-harness`: in-memory WebSocket CDP server, in-memory filesystem, fake process table; fixtures labelled `synthetic-protocol-conformant`). The agent-search cutover is the real-consumer integration proof. `audit-pre-review` is a static, non-blind audit followed by `audit-fixes` (ONE implementer); `audit-migration-blind` is the single blind review (the diff plus the single word `Review`), `resolve-findings` (one implementer) resolves every finding, `gates-rerun` re-runs the gates through nx, and `audit-final` is script-only (`audit_dod.py`).

## Acceptance mapping (ticket AC1-AC7)

AC ids are cited in specs with the ticket id `8468f7b1`; the per-state guard ids (`<slug>.N`) are the AC identifiers, mapped into `scripts/criteria.json` (see criteria.json). Coverage: package exists and is structurally identical (`scaffold.*`, `entrypoint-parity.*`, dod.1); behavior preserved and defects fixed at the source (`mig-*`, `port-fixes`, dod.4); six verbs on three surfaces proven by simulated scenarios (`surface-*`, `tests-use-cases`, dod.2); capture and lifecycle (`capture-upgrade.1-28` = CU1-CU27 plus the inventory pins, `chrome-lifecycle.1-29` = CL1-CL29 (CL30 is `sp-reaper-smoke.1-3`) plus manager shape and inventory pins; `sp-reaper-load-proof`, `sp-link`, `sp-reaper-smoke` and `sp-switch` carry the proxy dependency, the entry-path proof and the real-process gate; `tripwire-*.N` carry TW1-TW38, `cdp-test-harness.1-6`); typed errors (`prod-errors`, 32 codes); tracing namespace (`tracing-*`, dod.3); source intact then cut over (`audit-final.5`, `search-cutover`, dod.5, dod.9); review and remediation (dod.6); docs (dod.7); merge-readiness (dod.8).

## Productization hold point

`productization-hold` (executor `product`, phase `productization`) is the first state and a review hold point. Product reviewed SCOPE/DEMO/TOOLS and recorded its findings in `PRODUCT-REVIEW.md`. The user then decided each item (`PRODUCTIZATION-CATALOG.md`): product's verdict is the default, with these overrides: unit tests that simulate real use cases replace the e2e lane; the agent-search cutover substitutes for e2e and runs before the audit; typed errors cover 100% of failures (32 codes: 4 host, 14 library, 8 capture, 6 lifecycle); examples cover every verb and namespace; the Chrome lifecycle (19dfb641) is built now. The resulting changes:

- Removed: `tests-e2e`, `prod-public-api` (the greenfield API has no legacy subpath), `prod-publish-readiness` (its checks moved to `gates-first.7-9`), and the human blocker `hb-chrome-binary`.
- Added: `failsafe-inventory` (first, after the migration buckets), `port-fixes` (before the unit-test completions), `cdp-test-harness`, `capture-upgrade`, `chrome-lifecycle`, `tests-use-cases`, `audit-pre-review`, `audit-fixes`, and `consumer-relink`.
- Reshaped: `surface-api` (greenfield root namespaces + six flat verbs), `prod-errors` (32 codes, the `recording` and `lifecycle` exports), `prod-examples` (a runnable example per verb and per namespace), `search-cutover` (tarball, live-vs-recorded, parity before and after, delegation to the recorder and lifecycle APIs, backlog resolution evidence), `audit-final` (script-only; `.9` and `.10` ids stable).
- Insertion recipe for later items: add a new state with `plan-scaffold.js add-state`, then `set-reservation`, `add-criterion`, extend `scripts/ownership.json`, and make the intended successor depend on it. Existing slugs and criterion ids are never renamed. Re-run `check-disjoint.py` and `check-guards-red.py` after every insertion.

## Step 1c risk checkpoint

Highest risks: (1) apigen extraction failing opaquely on the verb types (pinned export shapes in `surface-api`); (2) a test or guard killing the developer's Chrome on 9222 (`[inv:live-chrome]`; the simulated lifecycle never signals a real process); (3) the cutover breaking the live MCP (dispatcher-gated, probed by a real MCP client, restore path in the context); (4) `node:sqlite` needing Node >= 22.5 (`entrypoint-parity.7`); (5) the namespace silently reverting to `apigen` (mutation proof).

## Open decisions

`EVALUATIONS.md` lists OD-1..OD-11 with the default applied to each and how to reverse it (sink dependency weight, ADR-0001 D5, redaction default, the `extraWaitMs` default, lifecycle design (now single-pass over the proxy), reaper scope, the backlog 19dfb641 AC4 amendment, the service-proxy extension design, the `dom.ts` SERP walker).

## Human action required before execution

0. `hb-sp-release` (needed before `sp-link` and `sp-switch`): the `@adhd/sox-service-proxy` 0.6.0 dev tarball built in the sox-ecosystem `sp-lifecycle` worktree must exist at `/Users/nix/.cache/adhd-dev-tarballs/` (for `sp-link`), and 0.6.0 must be published (for `sp-switch`); publishing is a human go. `hb-tripwire-domain` is resolved (`APPROVAL-tripwire.md`).

1. `hb-deps-approval`: write `docs/plan/stealth-browser/APPROVALS.md` with `DEP-APPROVAL: granted` naming `node-html-parser`, `xpath`, `@xmldom/xmldom` (gates `deps-install`; already granted).
2. `hb-design-evaluations` (provided): the two architect evaluations are recorded in `EVALUATIONS.md`, `EVAL-store-adapter.md` and `EVAL-service-proxy.md` and folded into `capture-upgrade` and `chrome-lifecycle`. Their provisional defaults are the OPEN-DECISIONS OD-1..OD-11 of `EVALUATIONS.md` (all reversible), including the pending service-proxy extension design.
3. `hb-release-decision`: dispatcher writes `RELEASE-DECISION.md` (`DECISION: publish|defer`, a `CONSUME:` line) per `PUBLISHING.md` (gates `merge-readiness` and `consumer-relink`).

## Known issues

1. Core-seam `.8` is untagged: it sits inside commit `aa5df30a` without its `[psm:...]` tag. History is not rewritten, so this note is the only action.
2. `compile-task.js` truncates piped output at 64 KiB. This is a plan-tooling bug in the sox plugin cache. The dispatcher files it upstream, and the plugin cache is not edited.
3. `plan-scaffold` commits with `--no-verify`. This is a plan-tooling bug in the same class as item 2: filed upstream, with the plugin cache not edited.
4. `plan-scaffold` has no verb to add a dependency edge to an existing state. The 2026-10-23 amendment re-ran `add-state` on `tracing-log-validation` and `audit-pre-review`, which restored their contexts.
5. Main's test layout moved the packages' tests from `src/test` to `test`. Completed states keep their historical wording, and their guards resolve the new locations.
6. The shared apigen tracing plugin (`packages/apigen/apigen-plugin-tracing`) emits a documented upstream twin event, `adhd.op.error` (op id `op`), beside every `adhd.<op>.error`. The search entrypoint keeps `makeTracingPlugin({serviceName:'adhd'})` as required and documents the twin in its `OBSERVABILITY.md`. `tracing-log-validation.11` tolerates exactly that event.
7. The full `--complete` audit of a phase runs every guard of the phase and takes 10 to 15 minutes under load. A loaded run can fail a timing-sensitive criterion that passes standalone.

## Amendment 2026-10-23

The amendment adds these states, listed in wave order: `main-merge`; `conform-tripwire`, `conform-core`, `conform-search`; `fix-tripwire`, `fix-core-parsers`, `fix-core-lifecycle`, `fix-core-errors`, `fix-search-fetch`, `fix-search-engine`, `fix-search-output`; `search-mcp-iserror`; `fix-search-build`; `search-tracing-fixes`; the `tracing-log-validation` re-run; `search-cutover`; `plan-notes`; `release-gate-fixes`; `release-readiness`; and `audit-pre-review`. Main was merged at `e21558fc1` (merge commit `eb6526ed9`).

Plan-script repairs made during the wave: the `search-usecases` guard resolves `test/unit/use-cases`; the repeat-guard passes `--skip-nx-cache` before `--`; `tracing-log-validation.11` tolerates the upstream twin event; `fix-search-output` owns `tripwire-wiring.spec.ts`; and `search-tracing-fixes` owns `use-cases/hosts.spec.ts` and `docs/ERRORS.md`.

Provisional resolution of OD-11: one SERP walker is kept, in core `capture/dom.ts`. The search `dom.ts` delegates to it, and the dead `\s{2,}` title fallback is deleted. This resolution is reversible; see `docs/plan/stealth-browser/OPEN-DECISIONS.md`.

## Scheduled fixes for the audit-fixes wave

These are resolved by `audit-fixes`. They are not deferrals.

- `extractSnippet`'s forward 5000-char window must be bounded at the next result card (core `parsers.ts`).
- The pypi `extra.version` selector (`span.package-snippet__version`) matches nothing, because upstream emits `span.package-snippet__created`. This needs a version-vs-created decision.
- `StealthSearchError` reaches MCP clients as a JSON-RPC rejection with no machine-readable code. It must carry the code in an `isError` result.
- DNS is resolved and pinned before credential-bearing tiers. Today the fetch policy resolves, then the browser resolves again.
- The baked `dist/operations.baked.json` file mode (0600 from `nodeHostFs.writeFile`) must survive pack and publish. Verify it.
- `pypi-dom.spec.ts` has 3 no-non-null-assertion lint warnings (lines 27, 32, 43).
- `reaper-link.ts` uses `@ts-ignore` on `import.meta.url`, with ban-ts-comment disabled on that line. Replace it with a typed approach.

## Findings for filing

These are filed by the dispatcher.

- The tripwire expiry audit line carries `trippedAt` only; it does not carry the original trip reason.
- `MemoryFs.schedule` polls with `setImmediate`, so `expiry.spec` (`exploreExhaustive`) and `interleave.spec` can slow under load.
- The default-entry test in `reaper-link.spec` is weak: it has two branches and needs an injectable `ReaperEntrySource`. `resolveReaperEntry` and `ReaperEntrySource` are not exported, and `public-api.spec` pins members.
- An invalid endpoint is a plain typed `StealthCoreBrowserError` (`CDP_UNREACHABLE`, `detail.reason` `invalid-endpoint`), not a `RangeError`. `isStealthCoreBrowserError` does not exist.
- The conform-core `guards:` header lines were derived from each spec's first `it()` title and need hand tightening.
- The core AGENTS.md mentions an e2e target via `vitest.e2e.config.ts`, which does not exist.
- `test/helpers/hosts/host-harness.ts` `expectMcpToolError` checks only `isError` plus text, not the code or `_meta`.
- The pypi fixture is transcribed from the upstream warehouse template, because live pypi.org returns a Client Challenge. A real capture needs a HITL browser session.
- Heading-less Google anchors are skipped.
- Core `normalizeUrl` handles `/goto?url=`, and `extractValue` tests the container first.
- The byte bound (`SearchOutput.omitted`, `maxResultBytes`, `DEFAULT_MAX_RESULT_BYTES`) applies only to engine providers. `search_a.py` and `SPEC-stealth-search.md` do not mention `maxResultBytes` or `omitted`.
- The baked operations cache is produced by `build-bin`, not by the vite build target.
- `package.spec.ts` has no direct `$ref`-inlining tests; `buildApigenPackage` keeps `$ref`.
- The plan guard for the search usecases and the old `src/test` wording in contexts of completed states are historical.

## Release gate fixes (2026-10-24)

The first `release-readiness` run exposed four root causes, repaired by the `release-gate-fixes` state before the gates were re-run: `check-test-wiring` now honours Nx-inferred test targets (project graph), `release:dry` exports `ADHD_NX_VERSION_DRY_RUN=1` for its whole chain and no longer mutates tracked files, the publish executor reports a pending bump in a dry run instead of failing, and the decompile-cli spec reads `test/fixtures`. The affected gate runs with the merge-base of HEAD and LOCAL main as its base. The release order is recorded in `release-readiness/release-order.md`: publish `@adhd/apigen-engine-runtime` (planned 0.3.6) first, then bump `entrypoint/stealth-search` to `^0.3.6`, then the core and search packages.

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

- `[dod.1]` **Exactly the three approved new packages exist, all produced by the workspace generator: packages/stealth/stealth-core-browser named @adhd/stealth-core-browser, entrypoint/stealth-search named @adhd/stealth-search (structurally identical to the sibling entrypoints), and packages/resilience/resilience-core-tripwire named @adhd/resilience-core-tripwire, a zero-dependency CJS-only core package (structural)** — Exactly the three approved new packages exist, all produced by the workspace generator.
  - delivered-by: `scaffold, entrypoint-parity, deps-install, tripwire-scaffold, tripwire-pack, tripwire-core, tripwire-interactive, tripwire-docs, tripwire-reverse-migrate, tripwire-reverse-relink, split-plan-repair, core-scaffold, core-seam, search-scaffold, search-inventory`

- `[dod.2]` **The chrome and search verbs work from the library, the CLI and the MCP stdio host of @adhd/stealth-search on top of @adhd/stealth-core-browser, proven by use-case unit suites that simulate real scenarios and by the search cutover (behavioral)** — The verbs work from all three surfaces.
  - given: the built packages and the shared harness (in-memory CDP server, in-memory filesystem, fake process table, profile and page fixtures)
  - when: the core use-case suites call the chrome verbs through the library and the search use-case suites call the search and chrome verbs through the library, the stealth-search CLI and the stealth-search-mcp host, exercising at least six typed error codes
  - then: each surface returns the same structured results and shutdown stops only the launched Chrome
  - entrypoint: `nx run stealth-search:test -- test/unit/use-cases`
  - observable: `vitest exit 0 in stealth-core-browser and stealth-search with at least 12 core and 12 search scenario suites green; the suites run in the unit lane with no socket, no subprocess and no network`
  - negative-control: `nx run stealth-search:test -- test/unit/use-cases fails (vitest exit non-zero) if the MCP host module is renamed or a verb is pointed at a port the harness does not serve while a suite expects success`
  - delivered-by: `surface-api, prod-errors, prod-examples, cdp-test-harness, capture-upgrade, chrome-lifecycle, tests-use-cases, search-errors, search-port-providers, search-port-fetch, search-port-engine, search-port-guards, search-verbs, search-hosts, search-usecases, search-examples`

- `[dod.3]` **Tracing is namespaced adhd in the stealth-search CLI and MCP host: configuration pins hold and one validating agent read the logs the built bins wrote, which carry adhd.<op> records and no apigen.* records (behavioral)** — Tracing is namespaced adhd on both hosts; no tests, one agent validates the written logs.
  - given: the built stealth-search CLI and MCP bins run by the validating agent with telemetry pointed at a temp sink
  - when: the agent invokes a verb through each bin and reads the written log files
  - then: every record event starts with adhd. and none starts with apigen.
  - entrypoint: `python3 docs/plan/stealth-browser/scripts/guard.py tracing-log-validation`
  - observable: `guard exits 0 and evidence/tracing-log-validation.md records, per bin, the log path, the record count and the first and last event names`
  - negative-control: `docs/plan/stealth-browser/scripts/guard.py tracing-log-validation fails when the evidence file is missing or records an apigen.-prefixed event`
  - delivered-by: `search-tracing, tracing-log-validation`

- `[dod.4]` **The migration preserves every feature and failsafe of the runner: each row of the failsafe inventory is pinned by a feature-level unit test (structural)** — The migration preserves every feature and failsafe of the runner, each pinned by a unit test; legacy code and names are not preserved.
  - delivered-by: `failsafe-inventory, mig-foundation, mig-cdp, mig-chrome-manager, mig-domains-storage, mig-capture-parsers, mig-queries, mig-docs, tests-unit-core, tests-unit-data, tests-unit-extract, tests-unit-surface, port-fixes, sp-reaper-load-proof, sp-link, sp-reaper-smoke, sp-switch`

- `[dod.5]` **The live agent-search source tree is byte-identical to its baseline commit up to the first cutover commit (structural)** — The live agent-search source tree is byte-identical to its baseline commit up to the first cutover commit.
  - delivered-by: `mig-foundation`

- `[dod.6]` **One blind review round ran on the diff plus the word Review, one implementer resolved every finding, and all gates were re-run green (structural)** — One blind review round ran on the diff plus the word Review, one implementer resolved every finding, and all gates were re-run green.
  - delivered-by: `audit-pre-review, audit-fixes, gates-first, review-prep, audit-migration-blind, resolve-findings, gates-rerun`

- `[dod.7]` **The doc-steward marketing run passed review and the content-marketer README is receipts-backed (structural)** — The doc-steward marketing run passed review and the content-marketer README is receipts-backed.
  - delivered-by: `docs-marketing-run, readme-rewrite`

- `[dod.8]` **The branch is fully committed, main node_modules untouched, and ready to fast-forward with a recorded release decision (structural)** — The branch is fully committed, main node_modules untouched, and ready to fast-forward with a recorded release decision.
  - delivered-by: `audit-final, merge-readiness`

- `[dod.9]` **After the cutover the live agent-search MCP server still serves its tools while consuming @adhd/stealth-search, and after publication every consumer is relinked (behavioral)** — agent-search runs on the stealth-search entrypoint and the consumers are relinked.
  - given: the tarballs packed from this worktree are installed as real directories in agent-browser's node_modules
  - when: a real MCP stdio client starts the server and calls search, chrome_status and list_providers
  - then: the calls return structured results identical in shape to the pre-cutover capture and the runner implementation no longer exists under agent-browser
  - entrypoint: `python3 docs/plan/stealth-browser/scripts/guard.py search-cutover`
  - observable: `guard exits 0: tools/list contains search, chrome_status returns a result, evidence/cutover-parity.json before equals after, no class CdpSession/ChromeManager/IdleShutdown/HistoryClient definition remains`
  - negative-control: `docs/plan/stealth-browser/scripts/guard.py search-cutover fails when the migrated runner adhd/ is restored under agent-browser`
  - delivered-by: `search-cutover, consumer-relink`
