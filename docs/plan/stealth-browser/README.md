# Migrate the agent-search chrome runner to @adhd/stealth-browser (entrypoint)

Extract the Chrome/CDP runner from `scratch/agent-browser/adhd` into ONE new, generator-built entrypoint package, `@adhd/stealth-browser` (`entrypoint/stealth-browser`), exposing six verbs as a library, a CLI and an MCP stdio server, with apigen tracing under the `adhd` namespace.

Backlog plan item: `8468f7b1-8adc-4237-9986-21ea1e27c537` (adhd, in_progress). Worktree `/Users/nix/dev/node/adhd/.worktrees/stealth-browser`, branch `stealth-browser` (cut from main `c6011647`). Authored artifacts: `SCOPE.md`, `USE_CASES.md`, `demo/DEMO.md`, `demo/UNRESOLVED.md`, `TOOLS.md`, `APPROVAL.md`.

## Consumer

A platform maintainer of the adhd monorepo (and the agents that call the agent-search MCP) who needs a real, quiet Chrome from code, a CLI or MCP, without importing a private path inside a scratch repo.

## Value delta

Before: the Chrome/CDP runner lives inside `scratch/agent-browser/adhd/`, welded to the search server; every other tool copies it or reaches into a private path, and it has no typed API, CLI, MCP host or tracing. After: one workspace package built by the generator exposes the six verbs on three surfaces, traced under `adhd`, proven by a single real-Chrome e2e run; agent-search consumes it and its MCP server keeps serving.

## Boundary (the correct package)

Migrates: `agent-browser/adhd/` (CDP connection, `chrome-manager.ts`, `capture/*`, `domains/*`, `storage/*`, `parsers.ts`, `helpers.ts`, `session.ts`, `types.ts`, `docs/*`), the engine-agnostic `search/queries/{activity,context}.ts`, and the six chrome verbs extracted from `search-mcp-source.ts:454-495`. Stays in agent-search (which then consumes `@adhd/stealth-browser`): providers, tripwire, `search`/`listProviders`, `search-challenge.ts`, `search-fetch.ts`, `search-dom.ts`, `last-search.ts`, `server.mjs`, and `search-mcp-source.ts` reduced to search verbs. Evidence: `adhd/` imports only `node-html-parser`, `xpath` and `@xmldom/xmldom` (`adhd/parsers.ts:17-26`) plus `node:*`; `cdp-query-client.ts` is a 42-line barrel over it. The existing agent-search plan (`docs/restructure-proposal.md`, `docs/dispatch-plan.md`) is wrong on strategy: it restructures in place across six branches, keeps search-named items in the generic layer, and plans a nested private `@adhd/cdp-connection` package plus committed `.js` twins. This plan keeps ONE package, one branch, and a single shared worktree. Full detail: `SCOPE.md`.

## Source package after migration

Until `agent-search-cutover` the scratch `agent-browser/adhd/` tree is byte-identical to `evidence/source-baseline.txt` (guard `source_untouched`), so the live MCP (`search-mcp-source.ts`) never breaks. The cutover is dispatcher-gated (`hb-release-decision`) and runs after `merge-readiness`: it reinstalls the runner as a dependency on `@adhd/stealth-browser` (published version or `link:` into the merged main checkout, never into `.worktrees`), deletes the migrated runner, reduces `search-mcp-source.ts` to search verbs, and proves the result with a real MCP stdio client (`agent-search-cutover.4`, `[dod.9]`). The scratch repo is local-only; its dirty tree is respected by staging explicit paths.

## Related backlog items (explicit scope calls)

- `8468f7b1-8adc-4237-9986-21ea1e27c537` (kind plan, in_progress, AC1-AC7): the parent of this plan; cites `restructure-proposal.md:1-8` and `dispatch-plan.md:1-8`. IN scope as the ticket every test cites.
- `5b98d3b2-3894-4142-b899-540bad821a19` (FEAT-AGENT-TRACING, open P1): OUT of scope. It is an agent-side plugin (`@adhd/agent-plugin-tracing`) for agent-mcp with new hook events (children TRACE-1..5). It cites `packages/apigen/apigen-plugin-tracing/src/lib/plugin.ts:6-14` only as precedent. Our tracing state uses the apigen side (`makeTracingPlugin`) and nothing from that item. Related open item `5152786d` (apigen tracing design docs stale after the serviceName namespacing change) is the namespacing context for `tracing-namespace-proof`.
- `19dfb641-516f-445d-8fb1-28afbaa9b566` (sox-service-proxy self-reaping Chrome singleton, open feature): OUT of scope. Its targets are the very files being ported (`adhd/chrome-manager.ts`, `cdp-connection/src/{browser,shutdown}.ts`); this port preserves the heartbeat, IdleShutdown and three-tier logic verbatim (guard `mig-chrome-manager.4`). The redesign is follow-up work on the NEW package paths; its citations point at `scratch/agent-browser/adhd/...`, which the cutover deletes, so they need re-citing after the cutover. Closed item `90ed0315` records that the reap fixes already exist in the ported code.
- `5152786d-0243-41ab-b232-fff7fdcfd8f2` (apigen tracing design notes stale after the serviceName change, open debt): OUT of scope to fix here (the notes live in `docs/apigen/design-notes/`). IN scope as a pin: `tracing-plugin.8` and `tracing-namespace-proof.6` assert what `plugin.ts` actually emits (`${serviceName}.op`, `${serviceName}.transport`, `${serviceName}.op.error`) so this plan follows the code, not the stale notes.
- Backlog component `24cfccf0-fa28-4fa8-af08-23d0c1c56978` is the registered home of `entrypoint/stealth-browser`; file follow-ups (the P11 learnings review and the PRODUCT-REVIEW.md out-of-scope candidates) against it.

## ONE approved new package

The human's request approves exactly one new package, `entrypoint/stealth-browser`, built with `npx nx g @adhd/workspace-codegen-nx:entrypoint --name stealth-browser --nxLayer entrypoints --platform node` (dry-run first, bare name). No other package may be created (`[inv:one-new-package]`).

## States (34), waves, executors

Wave = dependency depth; states in one wave with no edge between them may run concurrently, and `scripts/check-disjoint.py` proves their owned paths are disjoint (exit 0: 34 states, 67 concurrent pairs, 0 overlaps). Executors are best-fit, never general/claude; sonnet unless noted. The four `prod-*` states and the productization amendments were folded in from `PRODUCT-REVIEW.md` (tasks P1-P10, decisions D1-D5; P11 stays a backlog follow-up).

| Wave | State | Phase | Kind | Executor | Owned paths | Guard |
|---|---|---|---|---|---|---|
| 0 | `productization-hold` | productization | review | product (sonnet/medium) | `docs/plan/stealth-browser/PRODUCT-REVIEW.md` | `guard.py productization-hold` |
| 1 | `scaffold` | scaffold | work | platform-engineer (sonnet/medium) | `entrypoint/stealth-browser/`, `tsconfig.base.json`, `docs/plan/stealth-browser/evidence/` | `guard.py scaffold` |
| 2 | `entrypoint-parity` | scaffold | work | platform-engineer (sonnet/medium) | `entrypoint/stealth-browser/*`, `docs/plan/stealth-browser/evidence/` | `guard.py entrypoint-parity` |
| 3 | `deps-install` | scaffold | work | platform-engineer (sonnet/medium) | `entrypoint/stealth-browser/package.json`, `pnpm-lock.yaml`, `docs/plan/stealth-browser/APPROVALS.md` | `guard.py deps-install` |
| 4 | `mig-foundation` | migrate | work | refactoring-specialist (sonnet/medium) | `entrypoint/stealth-browser/src/lib/types.ts`, `entrypoint/stealth-browser/src/lib/session.ts`, `entrypoint/stealth-browser/src/lib/helpers.ts` | `guard.py mig-foundation` |
| 5 | `mig-cdp` | migrate | work | refactoring-specialist (sonnet/medium) | `entrypoint/stealth-browser/src/lib/cdp/` | `guard.py mig-cdp` |
| 6 | `mig-chrome-manager` | migrate | work | refactoring-specialist (sonnet/medium) | `entrypoint/stealth-browser/src/lib/chrome-manager.ts` | `guard.py mig-chrome-manager` |
| 6 | `mig-domains-storage` | migrate | work | refactoring-specialist (sonnet/medium) | `entrypoint/stealth-browser/src/lib/domains/`, `entrypoint/stealth-browser/src/lib/storage/` | `guard.py mig-domains-storage` |
| 5 | `mig-capture-parsers` | migrate | work | refactoring-specialist (sonnet/medium) | `entrypoint/stealth-browser/src/lib/capture/`, `entrypoint/stealth-browser/src/lib/parsers.ts` | `guard.py mig-capture-parsers` |
| 7 | `mig-queries` | migrate | work | refactoring-specialist (sonnet/medium) | `entrypoint/stealth-browser/src/lib/queries/` | `guard.py mig-queries` |
| 5 | `mig-docs` | migrate | work | refactoring-specialist (sonnet/low) | `entrypoint/stealth-browser/docs/reference/` | `guard.py mig-docs` |
| 8 | `surface-api` | surface | work | typescript-pro (sonnet/high) | `entrypoint/stealth-browser/src/api.ts`, `entrypoint/stealth-browser/src/index.ts`, `docs/plan/stealth-browser/evidence/product-claims.json` | `guard.py surface-api` |
| 9 | `prod-public-api` | surface | work | typescript-pro (sonnet/high) | `entrypoint/stealth-browser/src/legacy.ts`, `entrypoint/stealth-browser/src/index.ts`, `entrypoint/stealth-browser/src/test/unit/public-api/` | `guard.py prod-public-api` |
| 9 | `prod-errors` | surface | work | typescript-pro (sonnet/high) | `entrypoint/stealth-browser/src/errors.ts`, `entrypoint/stealth-browser/src/test/unit/errors/` | `guard.py prod-errors` |
| 10 | `surface-hosts` | surface | work | typescript-pro (sonnet/high) | `entrypoint/stealth-browser/src/server.ts`, `entrypoint/stealth-browser/src/cli.ts`, `entrypoint/stealth-browser/src/host-projection.ts` ... | `guard.py surface-hosts` |
| 11 | `tracing-plugin` | surface | work | typescript-pro (sonnet/high) | `entrypoint/stealth-browser/src/tracing.ts`, `entrypoint/stealth-browser/src/server.ts`, `entrypoint/stealth-browser/src/cli.ts` ... | `guard.py tracing-plugin` |
| 12 | `prod-examples` | surface | work | typescript-pro (sonnet/medium) | `entrypoint/stealth-browser/examples/`, `entrypoint/stealth-browser/src/test/unit/examples/`, `entrypoint/stealth-browser/tsconfig.spec.json` | `guard.py prod-examples` |
| 7 | `tests-unit-core` | verify | work | test-automator (sonnet/medium) | `entrypoint/stealth-browser/src/test/unit/foundation/`, `entrypoint/stealth-browser/src/test/unit/cdp/`, `entrypoint/stealth-browser/src/test/unit/chrome-manager/` | `guard.py tests-unit-core` |
| 8 | `tests-unit-data` | verify | work | test-automator (sonnet/medium) | `entrypoint/stealth-browser/src/test/unit/domains-storage/`, `entrypoint/stealth-browser/src/test/unit/queries/` | `guard.py tests-unit-data` |
| 6 | `tests-unit-extract` | verify | work | test-automator (sonnet/medium) | `entrypoint/stealth-browser/src/test/unit/capture-parsers/` | `guard.py tests-unit-extract` |
| 11 | `tests-unit-surface` | verify | work | test-automator (sonnet/medium) | `entrypoint/stealth-browser/src/test/unit/surface/` | `guard.py tests-unit-surface` |
| 13 | `tests-e2e` | verify | work | qa (sonnet/high) | `entrypoint/stealth-browser/src/test/e2e/` | `guard.py tests-e2e` |
| 14 | `tracing-namespace-proof` | verify | work | test-automator (sonnet/high) | `entrypoint/stealth-browser/src/test/unit/tracing/tracing-namespace.spec.ts` | `guard.py tracing-namespace-proof` |
| 15 | `gates-first` | verify | work | qa (sonnet/medium) | `docs/plan/stealth-browser/evidence/` | `guard.py gates-first` |
| 16 | `review-prep` | review | work | qa (sonnet/low) | `docs/plan/stealth-browser/review/migration.diff`, `docs/plan/stealth-browser/review/INPUT.sha256`, `docs/plan/stealth-browser/review/BRIEF.txt` | `guard.py review-prep` |
| 17 | `audit-migration-blind` | review | audit | code-reviewer (sonnet/high) | `docs/plan/stealth-browser/review/FINDINGS.json` | `guard.py audit-migration-blind` |
| 18 | `resolve-findings` | remediate | work | typescript-pro (sonnet/high) | `entrypoint/stealth-browser/`, `docs/plan/stealth-browser/review/RESOLUTION.json` | `guard.py resolve-findings` |
| 19 | `gates-rerun` | remediate | work | qa (sonnet/medium) | `docs/plan/stealth-browser/evidence/` | `guard.py gates-rerun` |
| 20 | `docs-marketing-run` | docs | work | doc-steward (sonnet/medium) | `entrypoint/stealth-browser/docs/`, `entrypoint/stealth-browser/AGENTS.md`, `entrypoint/stealth-browser/llms.txt` ... | `guard.py docs-marketing-run` |
| 21 | `readme-rewrite` | docs | work | content-marketer (sonnet/medium) | `entrypoint/stealth-browser/README.md` | `guard.py readme-rewrite` |
| 22 | `prod-publish-readiness` | release | work | platform-engineer (sonnet/medium) | `docs/plan/stealth-browser/evidence/publish-dry-run.txt`, `entrypoint/stealth-browser/package.json` | `guard.py prod-publish-readiness` |
| 23 | `audit-final` | release | audit | architect-reviewer (sonnet/high) | `docs/plan/stealth-browser/final-review.md` | `guard.py audit-final` |
| 24 | `merge-readiness` | release | work | dispatcher (human/dispatcher) | `docs/plan/stealth-browser/RELEASE-DECISION.md` | `guard.py merge-readiness` |
| 25 | `agent-search-cutover` | release | work | typescript-pro (sonnet/high) | `/Users/nix/dev/ai/scratch/agent-browser/adhd/`, `/Users/nix/dev/ai/scratch/agent-browser/cdp-query-client.ts`, `/Users/nix/dev/ai/scratch/agent-browser/search/queries/` ... | `guard.py agent-search-cutover` |

- Wave 0: `productization-hold`
- Wave 1: `scaffold`
- Wave 2: `entrypoint-parity`
- Wave 3: `deps-install`
- Wave 4: `mig-foundation`
- Wave 5: `mig-cdp`, `mig-capture-parsers`, `mig-docs`
- Wave 6: `mig-chrome-manager`, `mig-domains-storage`, `tests-unit-extract`
- Wave 7: `mig-queries`, `tests-unit-core`
- Wave 8: `surface-api`, `tests-unit-data`
- Wave 9: `prod-public-api`, `prod-errors`
- Wave 10: `surface-hosts`
- Wave 11: `tracing-plugin`, `tests-unit-surface`
- Wave 12: `prod-examples`
- Wave 13: `tests-e2e`
- Wave 14: `tracing-namespace-proof`
- Wave 15: `gates-first`
- Wave 16: `review-prep`
- Wave 17: `audit-migration-blind`
- Wave 18: `resolve-findings`
- Wave 19: `gates-rerun`
- Wave 20: `docs-marketing-run`
- Wave 21: `readme-rewrite`
- Wave 22: `prod-publish-readiness`
- Wave 23: `audit-final`
- Wave 24: `merge-readiness`
- Wave 25: `agent-search-cutover`

## Execution model

All agents work in the same worktree and branch (`stealth-browser`), in non-overlapping buckets declared in `scripts/ownership.json`; commits carry `[psm:<slug>]`. Every `node_modules` need is a symlink from the main checkout until `deps-install` replaces it with a real install (`[inv:node-modules]`, `[inv:worktree-required]`). Unit tests mock process spawn and third-party network libraries; the single e2e (`src/test/e2e/surfaces.e2e.test.ts`) drives library, CLI and MCP in one run with one shared setup/teardown, at least 5 s, on a dedicated port, never the developer's Chrome on 9222. The blind review input is the diff plus the single word `Review`; one implementer (`resolve-findings`) resolves every finding; `gates-rerun` re-runs lint, typecheck, build, test and e2e through nx.

## Acceptance mapping (ticket AC1-AC7)

AC ids are cited in specs with the ticket id `8468f7b1`; the per-state guard ids (`<slug>.N`) are the AC identifiers. Coverage: package exists and is structurally identical (`scaffold.*`, `entrypoint-parity.*`, dod.1); behavior preserved (`mig-*`, dod.4); six verbs on three surfaces (`surface-*`, `tests-e2e`, dod.2); tracing namespace (`tracing-*`, dod.3); source intact then cut over (`audit-final.5`, `agent-search-cutover`, dod.5, dod.9); review and remediation (dod.6); docs (dod.7); merge-readiness (dod.8).

## Productization hold point

`productization-hold` (executor `product`, phase `productization`) is the first state and a review hold point. Product reviewed SCOPE/DEMO/TOOLS and recorded its findings in `PRODUCT-REVIEW.md` (`STATUS: folded`, `INSERTED: prod-public-api, prod-errors, prod-examples, prod-publish-readiness`). The fold:

- New states: `prod-public-api` (P3: `./legacy` subpath, stable-six root, tier tags; after `surface-api`), `prod-errors` (P5: structured errors; after `surface-api`), `prod-examples` (P7: after `tracing-plugin`, before `tests-e2e`), `prod-publish-readiness` (P10: after `readme-rewrite`, before `audit-final`).
- Amended: `surface-api` (P1 input allowlist, P4 TSDoc, early evidence for the two claims product could not verify, D1 barrel criterion), `surface-hosts` (depends on `prod-public-api` and `prod-errors`; P1/P2/P3/P4/P5/P6 host work), `tracing-plugin` (P9 `--verbose`, namespace pinned to emitted keys, backlog 5152786d), `tests-unit-surface` (D4: depends on `surface-hosts`; host-level P1/P2 specs), `tests-e2e` (P2 live redaction, P9 stdout cleanliness), `docs-marketing-run` and `readme-rewrite` (P6/P8/P9 docs and the no-overclaim briefs, P10 stability policy), `merge-readiness` and `agent-search-cutover` (D3 main-checkout `dist/` build; D1 `./legacy` imports).
- `prod-publish-readiness` follows `readme-rewrite` because the tarball must contain the final README and CHANGELOG; it is a dependency of `audit-final`, a descendant of `gates-first` (`productization-hold.3` accepts a dependency of `gates-first` or of its descendants).
- Insertion recipe for later items: add a new state with `plan-scaffold.js add-state`, then `set-reservation`, `add-criterion`, extend `scripts/ownership.json`, and make the intended successor depend on it. Existing slugs and criterion ids are never renamed. Re-run `check-disjoint.py` and `check-guards-red.py` after every insertion.

## Step 1c risk checkpoint

Highest risks: (1) apigen extraction failing opaquely on the verb types (pinned export shapes in `surface-api`); (2) a test or guard killing the developer's Chrome on 9222 (`[inv:live-chrome]`, `tests-e2e.3/.5`); (3) the cutover breaking the live MCP (dispatcher-gated, probed by a real MCP client, restore path in the context); (4) `node:sqlite` needing Node >= 22.5 (`entrypoint-parity.7`); (5) the namespace silently reverting to `apigen` (mutation proof).

## Human action required before execution

1. `hb-deps-approval`: write `docs/plan/stealth-browser/APPROVALS.md` with `DEP-APPROVAL: granted` naming `node-html-parser`, `xpath`, `@xmldom/xmldom` (gates `deps-install`).
2. `hb-chrome-binary`: Google Chrome present at the default macOS path (gates `tests-e2e`, `gates-first`, `gates-rerun`).
3. `hb-release-decision`: dispatcher writes `RELEASE-DECISION.md` (`DECISION: publish|defer`, a `CONSUME:` line) per `PUBLISHING.md` (gates `merge-readiness`, `agent-search-cutover`).

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

- `[dod.2]` **The six chrome-runner verbs work from all three surfaces (library, CLI, MCP stdio) against a real Chrome (behavioral)** — The six chrome-runner verbs work from all three surfaces (library, CLI, MCP stdio) against a real Chrome.
  - given: a built package and a real Chrome launched on a dedicated port with a temp profile
  - when: one e2e run calls chromeStatus/launchChrome/listPageTargets/checkChromeActivity/getPageContext/shutdownChrome through the library, the stealth-browser CLI and the stealth-browser-mcp JSON-RPC server
  - then: each surface returns the same structured results and shutdown stops only the launched Chrome
  - entrypoint: `nx run stealth-browser:e2e`
  - observable: `vitest exit 0 with [surface:library], [surface:cli] and [surface:mcp] suites green and run duration >= 5 s`
  - negative-control: `nx run stealth-browser:e2e fails (vitest exit non-zero, no [surface:mcp] suite green) if dist/bin/mcp.js is absent or chromeStatus is pointed at an unused port while the suite expects running=true`
  - delivered-by: `surface-api, prod-public-api, prod-errors, surface-hosts, prod-examples, tests-e2e`

- `[dod.3]` **Tracing is namespaced adhd: a real verb call emits adhd.<op>.start/finish records and never apigen.* records (behavioral)** — Tracing is namespaced adhd: a real verb call emits adhd.<op>.start/finish records and never apigen.* records.
  - given: telemetry initialised against a temp file sink and the configured tracingPlugin mounted on the engine
  - when: a stealth-browser verb is invoked through the engine
  - then: every sink record event starts with adhd. and none starts with apigen.
  - entrypoint: `nx run stealth-browser:test -- entrypoint/stealth-browser/src/test/unit/tracing/tracing-namespace.spec.ts`
  - observable: `tracing-namespace.spec.ts passes and FAILS when src/tracing.ts serviceName is flipped to apigen (guard mutation)`
  - negative-control: `src/test/unit/tracing/tracing-namespace.spec.ts fails when src/tracing.ts serviceName is flipped to apigen or the package-level tracingPlugin singleton is mounted (guard mutation tracing-namespace-proof.4)`
  - delivered-by: `tracing-plugin, tracing-namespace-proof`

- `[dod.4]` **The migration is behavior-preserving: every manifest file keeps every export, stays >= 80% line-similar to its source, and keeps its stealth and read-only tokens (structural)** — The migration is behavior-preserving: every manifest file keeps every export, stays >= 80% line-similar to its source, and keeps its stealth and read-only tokens.
  - delivered-by: `mig-foundation, mig-cdp, mig-chrome-manager, mig-domains-storage, mig-capture-parsers, mig-queries, mig-docs, tests-unit-core, tests-unit-data, tests-unit-extract, tests-unit-surface`

- `[dod.5]` **The live agent-search source tree is byte-identical to its baseline until the guarded cutover (structural)** — The live agent-search source tree is byte-identical to its baseline until the guarded cutover.
  - delivered-by: `mig-foundation`

- `[dod.6]` **One blind review round ran on the diff plus the word Review, one implementer resolved every finding, and all gates were re-run green (structural)** — One blind review round ran on the diff plus the word Review, one implementer resolved every finding, and all gates were re-run green.
  - delivered-by: `gates-first, review-prep, audit-migration-blind, resolve-findings, gates-rerun`

- `[dod.7]` **The doc-steward marketing run passed review and the content-marketer README is receipts-backed (structural)** — The doc-steward marketing run passed review and the content-marketer README is receipts-backed.
  - delivered-by: `docs-marketing-run, readme-rewrite`

- `[dod.8]` **The branch is fully committed, main node_modules untouched, and ready to fast-forward with a recorded release decision (structural)** — The branch is fully committed, main node_modules untouched, and ready to fast-forward with a recorded release decision.
  - delivered-by: `prod-publish-readiness, audit-final, merge-readiness`

- `[dod.9]` **After the cutover the live agent-search MCP server still serves chrome_status and list_providers while consuming @adhd/stealth-browser (behavioral)** — After the cutover the live agent-search MCP server still serves chrome_status and list_providers while consuming @adhd/stealth-browser.
  - given: RELEASE-DECISION.md names a consumable @adhd/stealth-browser and agent-browser has it installed
  - when: a real MCP stdio client starts node server.mjs and calls chrome_status and list_providers
  - then: both calls return structured results and the runner implementation no longer exists under agent-browser
  - entrypoint: `python3 docs/plan/stealth-browser/scripts/guard.py agent-search-cutover`
  - observable: `guard exits 0: tools/list contains search, chrome_status returns a result, no class CdpSession/ChromeManager/IdleShutdown/HistoryClient definition remains`
  - negative-control: `docs/plan/stealth-browser/scripts/guard.py agent-search-cutover fails (agent-search-cutover.2) when the migrated runner adhd/ is restored under agent-browser`
  - delivered-by: `agent-search-cutover`
