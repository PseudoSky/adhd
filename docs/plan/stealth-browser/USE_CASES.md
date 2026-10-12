# USE_CASES - @adhd/stealth-browser

Derived from `SCOPE.md`. Every case has concrete inputs and an observable outcome. `H` happy, `E` edge, `R` recovery. Each maps to the state/criterion that proves it and to a beat in `demo/DEMO.md`.

| # | Kind | Scenario (real inputs) | Observable outcome | Proven by |
|---|---|---|---|---|
| UC-01 | H | A maintainer runs `npx nx g @adhd/workspace-codegen-nx:entrypoint --name stealth-browser --nxLayer entrypoints --platform node --dry-run` | Output lists `CREATE entrypoint/stealth-browser/src/index.ts`, `project.json`, `package.json`, `tsconfig.json`, `README.md` and `UPDATE tsconfig.base.json`; nothing is written | scaffold.1 |
| UC-02 | H | Same command without `--dry-run` | `Scaffolding stealth-browser at entrypoint/stealth-browser (@adhd/stealth-browser)`; `package.json` name is `@adhd/stealth-browser` | scaffold.2, scaffold.3 |
| UC-03 | E | Someone passes `--name @adhd/stealth-browser` or a `--directory` override | The plan forbids it; guard `scaffold.3` fails if the name or directory differs | scaffold.3, scaffold.5 |
| UC-04 | H | Compare top-level files of the new package with `dispatch-cli`, `backlog`, `apigen-cli` | Every file common to the three siblings exists; tags superset of the common tag set | entrypoint-parity.1, .2 |
| UC-05 | H | `nx run stealth-browser:build-bin` after hosts exist | `dist/bin/cli.js` and `dist/bin/mcp.js` emitted, exit 0 | surface-hosts.3 |
| UC-06 | H | Library: `await chromeStatus()` with no Chrome on the configured port | Resolves `{ running: false, managed: false, ... }`; `managed` is always a boolean | surface-api.2, tests-unit-surface |
| UC-07 | H | Library: `launchChrome({ port: <free port>, userDataDir: <tmp> })` | Chrome is reachable at `http://127.0.0.1:<port>/json/version`; result names the PID | tests-use-cases.2 |
| UC-08 | H | `listPageTargets()` after launch | Array of page targets, each with `id`, `url`, `type: 'page'` | tests-use-cases.2 |
| UC-09 | H | `checkChromeActivity()` on an idle launched Chrome | `ChromeActivity` shape with zero in-use pages (about:blank/newtab not counted) | tests-use-cases.2, tests-unit-data |
| UC-10 | H | `getPageContext()` on a page that loaded a `data:` URL fixture | Returns title/url/cookies context for that page | tests-use-cases.2 |
| UC-11 | H | `shutdownChrome()` | Only the launched PID exits; port stops answering | tests-use-cases.2, .3 |
| UC-12 | H | CLI: `node dist/bin/cli.js --help` | Exit 0; lists all six verbs | surface-hosts.4 |
| UC-13 | H | CLI: `chromeStatus` against an unused port | Exit 0 and output contains `running` | surface-hosts.5 |
| UC-14 | H | MCP: JSON-RPC `initialize`, `tools/list`, `tools/call` over stdio against `dist/bin/mcp.js` | Six tools listed; `chromeStatus` returns structured content | tests-use-cases.2 |
| UC-15 | E | `decideRetry` with a 429/ban outcome and exhausted retries | Returns a stop decision; no infinite retry | tests-unit-extract |
| UC-16 | E | `HistoryClient` against a profile whose SQLite file is held open by Chrome | Open uses `mode=ro&immutable=1`; no lock error | mig-domains-storage.4, tests-unit-data |
| UC-17 | E | `parsers.ts` fed a malformed HTML fixture and an XPath that matches nothing | Empty result, no throw | tests-unit-extract |
| UC-18 | E | Two processes call `ChromeManager.ready()`; one idles out | Heartbeat file `/tmp/stealth-browser-heartbeat` keeps Chrome alive while the other is active; shutdown only after both idle | mig-chrome-manager.4, tests-unit-core |
| UC-19 | H | Tracing: one verb call with telemetry pointed at a temp file sink | Every record `event` starts with `adhd.`; none starts with `apigen.` | tracing-namespace-proof.1, .2 |
| UC-20 | E | Mutation: `serviceName` flipped to `apigen` in `src/tracing.ts` | The namespace spec FAILS; file restored byte-for-byte | tracing-namespace-proof.4, .5 |
| UC-21 | E | A developer's own Chrome is listening on 9222 while the full use-case lane runs | Same PID still listening on 9222 afterwards; the simulated lane never connects to a real port | tests-use-cases.3 |
| UC-22 | E | A test spec forgets the ticket id | Guard `tests-unit-*.2`/`tests-use-cases.4` fail naming the file | tests-unit-core.2 |
| UC-23 | E | An executor edits a path outside its bucket | `ownership_ok` fails on the `[psm:<slug>]` commit; `check-disjoint.py` proves concurrent buckets are disjoint | every `*.3`, check-disjoint |
| UC-24 | E | `pnpm add` run while `node_modules` is still the symlink to main | Guard `deps-install.6` fails (main `.modules.yaml` mtime changed) | deps-install.5, .6 |
| UC-25 | H | Blind review input: `review/migration.diff` + `BRIEF.txt` containing only `Review` | `INPUT.sha256` matches; BRIEF is exactly one word | review-prep.1-3 |
| UC-26 | E | Reviewer returns F1..F4 | Every finding resolved by ONE implementer: `fixed` with a commit touching the file, or `rejected` with reproduction | resolve-findings.1-3 |
| UC-27 | H | doc-steward run then README rewrite | `review.md` PASS; README has >= 5 receipts that resolve to shipped capabilities | docs-marketing-run.*, readme-rewrite.* |
| UC-28 | R | The first gates run fails on lint in a migrated file | Fix lands via the owning state's amendment; `gates-rerun` is green on the new tree sha | gates-first.*, gates-rerun.* |
| UC-29 | H | Dispatcher writes `RELEASE-DECISION.md` (`DECISION: defer`, `CONSUME: link:/Users/nix/dev/node/adhd/entrypoint/stealth-browser`) | `merge-readiness.2` passes; `git merge-base --is-ancestor main HEAD` holds | merge-readiness.1-3 |
| UC-30 | R | After the cutover, `node server.mjs` is probed by a real MCP stdio client | `tools/list` still contains the search tool; `chrome_status` and `list_providers` return results; `class CdpSession` no longer defined under agent-browser | agent-search-cutover.2, .4 |
| UC-31 | R | The cutover probe fails | Touched paths restored with `git restore` from the previous commit; live MCP source never left broken | agent-search-cutover notes |
