STATUS: folded
INSERTED: prod-errors, prod-examples, tests-use-cases, capture-upgrade, chrome-lifecycle, cdp-test-harness
RETIRED: prod-public-api (greenfield API: no legacy subpath, root namespaces + flat verbs), prod-publish-readiness (publish metadata and the tarball dry-run moved to gates-first.7-9)

# PRODUCT-REVIEW - @adhd/stealth-browser (plan 8468f7b1-8adc-4237-9986-21ea1e27c537)

## DECISIONS (dispatcher and user)

- D1 (P3, greenfield): the package is new and public, so no consumer exists and there is no legacy, compatibility or deprecation surface. The root exports the library areas as namespaces (`cdp`, `storage`, `capture`, `parsers`, `chromeManager`, plus `recording` and `lifecycle`) and the six flat verbs. Source is corrected, never aliased (ADR-0002); `SearchResultSource` becomes `PageSource`, `getSearchSessionId` is dropped, `getLastSearchFromHistory` stays in agent-search. `prod-public-api` is retired; the export snapshot is `tests-unit-surface` and `prod-errors.7`.
- D2 (P11): NOT added to the DAG. It becomes a backlog follow-up.
- D3 (defect 3): `merge-readiness.4` builds `dist/` in the merged main checkout before any `link:` consumption; the required cutover runs earlier against a tarball (`agent-search-cutover`) and `agent-search-relink` consumes the release after merge.
- D4 (defect 5): `tests-unit-surface` depends on `surface-hosts`; host-level P1/P2 tests live in its owned spec dir.
- D5: the out-of-scope candidates stay out of the DAG, are filed in the backlog and are listed in `DEFERRED.md`.
- User decisions (see `PRODUCTIZATION-CATALOG.md`): product's verdict is the default per item. Overrides: unit tests that simulate real use cases replace e2e (`tests-e2e` and `hb-chrome-binary` removed, `tests-use-cases` added); the agent-search migration substitutes for e2e and runs before the audit; typed errors cover 100% of failures (29 design-neutral codes plus design-added ones); examples cover every verb and namespace plus genuine use cases; the Chrome lifecycle (19dfb641) is built now as `chrome-lifecycle`, with `capture-upgrade` and the shared `cdp-test-harness`.

## Constraints honored

- dod.4 and port-manifest.json require every export to stay exported and each file >=80% line-similar, except where the manifest records an allowed rename or drop (`SearchResultSource` to `PageSource`, `getSearchSessionId`) and the two rewrites with `min_similarity` 0 (`capture/network.ts`, `chrome-manager.ts`).
- Only one new package is allowed.
- surface-api.5 forbids env reads in api.ts: config stays typed options at library level, flags at the CLI/MCP host layer.
- productization-hold.3: every inserted prod-* state must be an ancestor of gates-first.

## TASKS

### P1. Host input allowlist: no arbitrary exec over MCP/CLI [P0]
- Why: ported LaunchChromeOptions (adhd/cdp-connection/src/browser.ts:19-31) exposes chromePath and extraArgs; if apigen projects them onto the MCP tool, any agent can run an arbitrary binary with arbitrary args.
- Placement: amend surface-api (verb input types) and surface-hosts (host wiring). No new state.
- Owned paths: existing paths of those states (src/api.ts, src/server.ts, src/cli.ts, bin/). Tests in tests-unit-surface's src/test/unit/surface/.
- Acceptance:
  - PA1.1: launchChrome's host-exposed input schema contains only port and userDataDir (confirm option names against U3). chromePath and extraArgs stay library-only.
  - PA1.2: an MCP tools/call for launchChrome with extraArgs is rejected with an error and no process is spawned.
  - PA1.3: a unit test asserts the tools/list input schema for launchChrome has no chromePath or extraArgs property.
- Executor: typescript-pro.

### P2. Redact cookie values from getPageContext on the hosts [P0]
- Why: getPageContext returns cookie context (queries/context.ts, storage/cookies.ts); over MCP, cookie values land in an agent transcript.
- Placement: amend surface-api; library result unchanged for parity, redact at host projection.
- Owned paths: same as P1.
- Acceptance:
  - PA2.1: MCP and CLI getPageContext output contains cookie names and counts but no cookie value strings.
  - PA2.2: a unit test with fixture cookie value SECRET123 asserts it is absent from the MCP JSON and the CLI stdout.
  - PA2.3: the library result is unchanged, so port-manifest.json parity holds.
- Executor: typescript-pro.

### P3. Public API surface and stability tiers [P0] - RETIRED by D1 (greenfield); intent carried by surface-api.3, surface-api.10, tests-unit-surface and prod-errors.7
- Why: search/Google leftovers in the generic layer: SearchResultSource (types.ts:201), searchDepth (types.ts:242), getSearchSessionId (session.ts:24), Google-specific capture/dom.ts and parsers.
- Decisions: KEEP capture/dom.ts (manifest/dod.4). Remove Google and search-named symbols from the root barrel; export them from a `./legacy` subpath marked @deprecated (D1). Add neutral aliases (e.g. PageSource for SearchResultSource). searchDepth field name stays (frozen shape), documented. getSearchSessionId stays as the alias required by mig-foundation.4. Root exposes only the six verbs and their types as stable; everything else is @experimental.
- Placement: new state prod-public-api after surface-api; surface-hosts depends on it. exports["./legacy"] is a one-line package.json edit made by surface-hosts. The src/index.ts edit is an amendment to surface-api's paths (sequential).
- Owned paths: entrypoint/stealth-browser/src/legacy.ts, entrypoint/stealth-browser/src/test/unit/public-api/.
- Acceptance:
  - PA3.1: a public-API export snapshot test lists the root exports and fails on drift.
  - PA3.2: the root index.d.ts contains no Google- or Search-named export outside ./legacy.
  - PA3.3: import { SearchResultSource } from '@adhd/stealth-browser/legacy' resolves after build.
  - PA3.4: nx run stealth-browser:verify-dist-load exits 0.
  - PA3.5: @deprecated and @experimental TSDoc tags are present on the tiered exports.
- Executor: typescript-pro.

### P4. MCP/CLI ergonomics: tool descriptions, naming, help [P1]
- Why: agents choose tools from tools/list descriptions; names are still guesses (U1, U2).
- Placement: amend surface-api and surface-hosts. Owned paths: existing.
- Acceptance:
  - PA4.1: every one of the six verbs has TSDoc and tools/list returns a description of at least 40 characters for each tool.
  - PA4.2: cli --help and cli <verb> --help show a description and the default port.
  - PA4.3: CLI verb style (camelCase vs kebab) is decided against sibling convention and recorded in the surface-hosts context (resolves U1, U2).
  - PA4.4: MCP tool names match the demo and UNRESOLVED.md after the decision.
- Executor: typescript-pro.

### P5. Structured errors with remediation text [P1]
- Why: first-run failures (Chrome missing, port busy, Node < 22.5 for node:sqlite, Chrome not running) must not be raw stack traces.
- Placement: new state prod-errors after surface-api, before surface-hosts.
- Owned paths: entrypoint/stealth-browser/src/errors.ts, entrypoint/stealth-browser/src/test/unit/errors/. Hosts map errors in surface-hosts.
- Acceptance:
  - PA5.1: an error class with a stable code field covers at least CHROME_NOT_FOUND, PORT_IN_USE, NODE_TOO_OLD, CHROME_NOT_RUNNING, each with a message naming the fix.
  - PA5.2: the CLI exits non-zero with the message on stderr and no stack trace by default.
  - PA5.3: the MCP returns isError: true with the code in the content.
  - PA5.4: a unit test per code.
  - PA5.5: a startup preflight in the bin shims checks Node >= 22.5 and fails with a one-line message.
- Executor: typescript-pro.

### P6. Configuration story (typed options plus host flags) [P1]
- Why: defaults are 9222, ~/Library/Application Support/Google/Chrome-CDP and /tmp/stealth-browser-heartbeat: macOS-specific and colliding with a developer's own Chrome. Library defaults stay (parity, agent-search); document and make overridable.
- Placement: amend surface-hosts (flags); docs in docs-marketing-run. Owned paths: existing.
- Acceptance:
  - PA6.1: CLI and MCP bin accept --port and --user-data-dir; --help prints defaults.
  - PA6.2: docs/CONFIGURATION.md lists every default; a guard asserts each default value appears verbatim.
  - PA6.3: docs state macOS-first support and which behaviors are untested elsewhere.
- Executor: typescript-pro (flags), doc-steward (docs).

### P7. First-run and install experience: examples [P1]
- Why: the consumer needs a working quickstart.
- Placement: new state prod-examples after tracing-plugin; tests-e2e or gates-first depends on it.
- Owned paths: entrypoint/stealth-browser/examples/, entrypoint/stealth-browser/src/test/unit/examples/.
- Acceptance:
  - PA7.1: examples/library.ts, examples/cli.md and examples/mcp-config.json (Claude Code mcpServers snippet using the stealth-browser-mcp bin) exist.
  - PA7.2: the library example typechecks under nx run stealth-browser:typecheck-spec.
  - PA7.3: the MCP config snippet JSON-parses and names the stealth-browser-mcp bin from package.json.
  - PA7.4: the examples use an explicit non-9222 port.
- Executor: typescript-pro.

### P8. Responsible-use and honest positioning (stealth/ToS) [P1]
- Why: "stealth" means no --enable-automation and no Runtime.evaluate, not undetectable; the content-marketer step ("more exciting") risks over-claiming.
- Placement: amend docs-marketing-run and readme-rewrite. No new path (docs-marketing-run owns entrypoint/stealth-browser/docs/).
- Acceptance:
  - PA8.1: docs/RESPONSIBLE-USE.md exists: site terms of service and robots.txt, rate limits, no CAPTCHA/ban evasion, cookie and profile reads are read-only on the user's own profile.
  - PA8.2: README and docs define "stealth" as the two concrete flags.
  - PA8.3: a guard rejects "undetectable", "bypass", "evade", "anti-bot" in README.md and docs/.
  - PA8.4: README links to RESPONSIBLE-USE.md.
- Executor: doc-steward, content-marketer (no-overclaim brief added to contexts).

### P9. Observability: tracing docs and stderr diagnostics [P2]
- Why: tracing under adhd is planned; operators need to know where records go and how to read diagnostics.
- Placement: amend tracing-plugin and docs-marketing-run.
- Acceptance:
  - PA9.1: docs/OBSERVABILITY.md documents adhd.<op>.start|finish|error, how to enable the sink, and that the MCP bin writes only JSON-RPC to stdout.
  - PA9.2: a --verbose flag sends diagnostics to stderr only; a unit test asserts stdout stays JSON-RPC-clean.
- Executor: typescript-pro, then doc-steward.

### P10. Publish readiness and versioning [P1] - state retired; checks live in gates-first.7-9, audit-final.9 and readme-rewrite
- Why: PUBLISHING.md is publish-from-dist; README, CHANGELOG and manifest must exist in dist/.
- Placement: new state prod-publish-readiness after readme-rewrite, before audit-final. Release decision stays with the dispatcher at merge-readiness.
- Owned paths: docs/plan/stealth-browser/evidence/publish-dry-run.txt, plus metadata fields in entrypoint/stealth-browser/package.json (earlier states are done; no concurrency).
- Acceptance:
  - PA10.1: package.json has description, keywords, license, publishConfig.access = public (matching dispatch-cli, backlog), files, engines.node >=22.5.
  - PA10.2: initial version is 0.x; stability policy stated in the README.
  - PA10.3: npm pack --dry-run against the dist output lists README.md, CHANGELOG.md, dist/bin/*.js and the exports targets.
  - PA10.4: bin files have a shebang and are executable.
  - PA10.5: no @adhd/* dependency is unpublished or private.
- Executor: platform-engineer.

### P11. Feedback loop: learnings after cutover [P2] - NOT IN DAG (D2)
- Becomes a backlog follow-up. Content: LEARNINGS.md answering whether the cutover caused any live-MCP regression, whether tool names were adopted, which out-of-scope candidates were hit. Executor: product.

## OUT-OF-SCOPE-CANDIDATES (D5: stay out of the DAG; dispatcher files in backlog)
1. A doctor/preflight verb (7th verb); changes the six-verb scope.
2. Changing the default port/profile away from 9222 and Chrome-CDP; breaks parity and agent-search; needs its own migration epic.
3. Linux/Windows support for profile paths, history, cookies (helpers.ts is macOS-path based); needs a cross-platform epic and CI.
4. Headless mode and profile-isolation option on launchChrome; a feature, not a migration.
5. Extracting search-specific parsers/capture (Google SERP) into agent-search; needs a second package or cutover work.
6. sox-service-proxy self-reaping singleton (19dfb641) and FEAT-AGENT-TRACING dashboard (5b98d3b2); already excluded by the plan.
7. Publishing to npm; the dispatcher's call at merge-readiness.
8. CI without Chrome (the e2e lane needs a Chrome binary).

## RECOMMENDED ORDER
P1, P2 (safety) and P3 (naming) first, since they change types before hosts are built. Then P4, P5 with the surface work. Then P6, P7. Then P8, P9 with the docs states. Then P10 before audit-final.

## PLAN-STRUCTURE DEFECTS / RISKS
1. Cycles: none seen (checked by eye; gap-check.js not run).
2. surface-api "every old barrel name resolves from root" conflicts with P3 - resolved by D1.
3. agent-search-cutover with CONSUME: link: points into the main checkout and the plan does not say who builds dist/ there - resolved by D3.
4. docs-marketing-run and readme-rewrite both own README.md; sequential so safe, the later overwrite should be intentional.
5. tests-unit-surface depended only on surface-api, so hosts/tracing were verified only by tests-e2e - resolved by D4.
6. check-disjoint.py must be re-run after the insertions (not run during this review).

## FOLD MAP (task -> state -> criterion ids)

| Task | State(s) | Criteria (PA id carried in the criterion text) |
|---|---|---|
| P1 host input allowlist | surface-api, surface-hosts, tests-unit-surface, tests-use-cases | surface-api.7 (PA1.1), surface-hosts.7 (PA1.2, PA1.3), tests-unit-surface.4 (PA1.2, PA1.3) |
| P2 cookie redaction | surface-api, surface-hosts, tests-unit-surface, tests-use-cases | surface-api.8 (claim evidence), surface-hosts.8 (PA2.1), tests-unit-surface.4 (PA2.2), tests-use-cases scenarios (PA2.1 simulated); PA2.3 held by dod.4 parity |
| P3 public API (greenfield) | surface-api, tests-unit-surface, prod-errors | surface-api.3, surface-api.10, prod-errors.7 (root exports snapshot) |
| P4 ergonomics | surface-api, surface-hosts | surface-api.9 (PA4.1), surface-hosts.10 (PA4.1, PA4.2), surface-hosts.11 (PA4.3, PA4.4) |
| P5 structured errors (100%) | prod-errors (new), surface-hosts | prod-errors.1-.8 (29 design-neutral codes plus design-added ones: PA5.1, PA5.4 and the capture and lifecycle codes), surface-hosts.12 (PA5.2, PA5.3, PA5.5) |
| P6 configuration | surface-hosts, docs-marketing-run | surface-hosts.13 (PA6.1), docs-marketing-run.6 (PA6.2, PA6.3) |
| P7 examples (every verb and namespace) | prod-examples (new) | prod-examples.1-.6 (PA7.1-PA7.4) |
| P8 responsible use | docs-marketing-run, readme-rewrite | docs-marketing-run.7 (PA8.1, PA8.2), docs-marketing-run.8 and readme-rewrite.7 (PA8.3), readme-rewrite.6 (PA8.2, PA8.4) |
| P9 observability | tracing-plugin, tests-use-cases, docs-marketing-run | tracing-plugin.7 (PA9.2), tests-use-cases scenarios (PA9.2), docs-marketing-run.9 (PA9.1) |
| P10 publish readiness | gates-first, audit-final, readme-rewrite | gates-first.7-9 (PA10.1-PA10.5), audit-final.9 (PA10.3 re-check on the final docs), readme-rewrite.8 (PA10.2 README policy) |
| D3 main-checkout dist | merge-readiness, agent-search-relink | merge-readiness.4, agent-search-relink.1-4 |
| User: simulated use cases instead of e2e | cdp-test-harness, tests-use-cases | cdp-test-harness.1-6, tests-use-cases.1-6 |
| User: capture upgrade | capture-upgrade | capture-upgrade.1-28 (CU1-CU27 plus inventory pins) |
| User: Chrome lifecycle (19dfb641) | chrome-lifecycle | chrome-lifecycle.1-27 (CL1-CL25 plus manager shape and inventory pins) |
| D4 | tests-unit-surface depends on surface-hosts | tests-unit-surface.4 |
| Unverified claims | surface-api.8 (evidence file), surface-hosts.7 and .12 (built-bin probes) | `evidence/product-claims.json` records whether launchChrome options reach the MCP schema and whether getPageContext returns cookie values, with file:line citations |
| Namespace pin (backlog 5152786d) | tracing-plugin, tracing-namespace-proof | tracing-plugin.8, tracing-namespace-proof.6 |

P11 is not in the DAG (D2). The D5 candidates stay out of the DAG and are listed in `DEFERRED.md`.
The word scan (PA8.3) covers README.md and docs/ except the ported `docs/reference/` protocol reference (CDP method names such as `setBypassCSP`) and generated `.catalog/` data.
Placement of P10: the package metadata, version, engines, bins and first tarball dry-run are `gates-first.7-9` (an ancestor of the review chain); the tarball is re-checked against the final README and CHANGELOG by `audit-final.9`, and the README stability policy is `readme-rewrite.8`.
