# TOOLS - @adhd/stealth-browser

valid-as-of: 2026-10-12T00:00:00Z (re-validate if the plan is resumed after 14 days or after main moves past c6011647 in `entrypoint/`, `packages/apigen/`, or `packages/workspace/workspace-codegen-nx/`).

Backlog plan item: `8468f7b1-8adc-4237-9986-21ea1e27c537`.

## 1. Capability list

| # | Capability (verb-noun) |
|---|---|
| C1 | scaffold an entrypoint package |
| C2 | launch and kill a quiet Chrome |
| C3 | speak CDP over a websocket |
| C4 | share one Chrome across processes (heartbeat, idle shutdown) |
| C5 | read Chrome profile history/cookies without locking (read-only SQLite) |
| C6 | parse HTML/XML/XPath from captured DOM |
| C7 | query activity and page context |
| C8 | project verbs onto MCP and CLI hosts |
| C9 | trace every verb under the `adhd` namespace |
| C10 | run a real-Chrome e2e across all surfaces in one run |
| C11 | verify ownership, port parity and gates mechanically |
| C12 | publish or link the package for agent-search |

## 2. Existing inventory

| Cap | Provider | Evidence it is live |
|---|---|---|
| C1 | `@adhd/workspace-codegen-nx:entrypoint` generator (`packages/workspace/workspace-codegen-nx/src/generators/entrypoint/`) | dry-run captured at `evidence/scaffold-dry-run.txt` by the `scaffold` state; sibling packages `entrypoint/{dispatch-cli,backlog,apigen-cli}` were produced by it |
| C2-C5, C7 | `/Users/nix/dev/ai/scratch/agent-browser/adhd/` (`cdp-connection/src/{browser,monitor,session,settle,shutdown,targets}.ts`, `chrome-manager.ts`, `storage/*`, `domains/*`, `helpers.ts`, `search/queries/{activity,context}.ts`) | served daily by the live agent-search MCP; `agent-browser/package.json` script `test:lifecycle` |
| C6 | `adhd/parsers.ts` over `node-html-parser`, `xpath`, `@xmldom/xmldom` (imports at `parsers.ts:17-26`) | same |
| C8 | apigen engine plus `@adhd/apigen-plugin-*` host plugins, used by `entrypoint/backlog/src/server.ts` | backlog MCP in daily use |
| C9 | `makeTracingPlugin` from `@adhd/apigen-plugin-tracing`, reference `entrypoint/backlog/src/tracing.ts` | `entrypoint/backlog/src/server.tracing-six-tags.spec.ts` |
| C10 | `defineE2eConfig` (`vitest.e2e.config.ts` in siblings), `entrypoint/dispatch-cli/src/test/cli-smoke.e2e.test.ts` shape | nx target `e2e` on siblings |
| C11 | `docs/plan/stealth-browser/scripts/{guard.py,check-disjoint.py,port-manifest.json,ownership.json}` (authored by this plan) | `check-disjoint.py` exits 0 |
| C12 | `PUBLISHING.md` release procedure; nx target `nx-release-publish` | siblings carry the target |

## 3. Gap analysis

| Gap | Detail |
|---|---|
| G1 | No package at `entrypoint/stealth-browser` (C1 target) |
| G2 | The chrome verbs exist only inside `search-mcp-source.ts:454-495`, not as a standalone typed API (C8 input) |
| G3 | The runner's three parser dependencies are not in the workspace dependency set |
| G4 | The runner uses `.ts` import specifiers; the workspace needs `.js` ESM specifiers |
| G5 | No tracing configuration for this package (C9) |
| G6 | No e2e covering all three surfaces in one run (C10) |
| G7 | Nested `@adhd/cdp-connection` package and committed `.js` twins in the source; only one new package is approved |
| G8 | Runner uses `node:sqlite`, which needs Node >= 22.5 and may not be declared in sibling `engines` |

## 4. Build-vs-reuse verdicts

Ladder: reuse-as-is, extend/wrap, buy/import, build, prototype-first, build-with-hedge.

| Gap | Verdict | Rationale |
|---|---|---|
| G1 | reuse-as-is (generator, bare name, dry-run first) | request mandates the generator; hand-built packages drift from siblings |
| G2 | build (thin extraction of six verbs into `src/api.ts`) | the verbs are 40 lines delegating to `ChromeManager`/clients; no existing standalone API |
| G3 | buy/import (`node-html-parser`, `xpath`, `@xmldom/xmldom`) | commodity parsers already used by the source; human approval gate `hb-deps-approval` |
| G4 | extend/wrap (mechanical specifier rewrite, verified by `rel_imports_resolve`) | zero behavior change |
| G5 | reuse-as-is (`makeTracingPlugin({serviceName:'adhd'})`, pattern of `backlog/src/tracing.ts`) | never the apigen-namespaced singleton |
| G6 | build (one `surfaces.e2e.test.ts`, single beforeAll/afterAll) | no sibling covers library, CLI and MCP in one run |
| G7 | extend/wrap (collapse into `src/lib/cdp/`, drop `.js` twins) | one-package approval |
| G8 | reuse-as-is (declare `engines.node >= 22.5`; guard `entrypoint-parity.7`) | `@types/node` 25.9.5 already includes `node:sqlite`; Node v24.11.1 present |
| C12 | prototype-first for the `link:` consumption path, publish decided by the dispatcher | release is out of the plan's authority |

## 5. Interface contracts

Resolve-at-dispatch: exact option types are read from the ported source, not restated here.

| Tool | Contract |
|---|---|
| Generator | `npx nx g @adhd/workspace-codegen-nx:entrypoint --name stealth-browser --nxLayer entrypoints --platform node [--dry-run]`. Logs `Scaffolding stealth-browser at entrypoint/stealth-browser (@adhd/stealth-browser)`. Errors on a name collision. Quirk: bare name only, no scope, no `--directory`. |
| `src/api.ts` verbs | Six async functions: `chromeStatus`, `launchChrome`, `shutdownChrome`, `listPageTargets`, `checkChromeActivity`, `getPageContext`; JSON-serializable inputs and outputs; `ChromeStatus.managed` is always a boolean. Quirk: apigen extraction fails opaquely on non-serializable types. |
| Tracing | `src/tracing.ts` exports one `tracingPlugin = makeTracingPlugin({serviceName:'adhd'})`, imported by every host; sink records are `adhd.<op>.start|finish|error`. |
| Hosts | `bin/cli.ts` and `bin/mcp.ts` compiled by `build-bin` into `dist/bin/{cli,mcp}.js`; MCP is stdio JSON-RPC. Tool names are snake-cased verb names (U2 in `demo/UNRESOLVED.md`). |
| `guard.py` | `python3 docs/plan/stealth-browser/scripts/guard.py <slug> [--only slug.N]`; exit status is the failed-check count; `--list` dumps the criteria as JSON. |
| nx | `./node_modules/.bin/nx run stealth-browser:{lint,typecheck,typecheck-spec,build,build-bin,test,e2e,verify-dist-load}`; never raw `tsc`. |

## 6. Dependency graph

C1 -> {C2-C7 migration, C8} ; C8 -> C9 ; C9 -> C10 ; C2-C7 -> C10 ; C10 and C11 -> gates -> blind review -> C12. Matches `dag.json` (`python3 docs/plan/stealth-browser/scripts/check-disjoint.py --matrix` prints concurrency).

## 7. Validation method

| Tool | Smoke check | Last validated |
|---|---|---|
| Generator | `scaffold.1` dry-run lists only `entrypoint/stealth-browser/` paths | runs at execution time (2026-10-12 authoring: command shape confirmed against schema.json) |
| Guard and manifests | `python3 scripts/check-disjoint.py` exits 0 (30 states, 54 concurrent pairs, 0 overlaps) | 2026-10-12 |
| Ported runner | `port-manifest.json` entries resolve against the source tree | 2026-10-12 (47 entries) |
| Tracing | `tracing-namespace-proof.4` mutation | runs at execution time |
| Chrome | `test -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` (`hb-chrome-binary`) | runs at execution time |
