# SPEC: port agent-search into `entrypoint/stealth-search`; core becomes `@adhd/stealth-core-browser`

> Architect specification for the stealth-search split (dispatch dispatch-2026-10-12-ca18). The plan states cite this file as `[ref:stealth-search-spec]`. Where the plan's DAG differs from section 5 the plan wins; the differences are decisions, listed here once:
>
> | Spec | Plan |
> |---|---|
> | `split-approval` human gate | none: three packages are the user's own direction and the new dependencies (`turndown`, `pdfjs-dist`, `commander`) need no approval gate (user: sox and dependency choices never need approval); `APPROVAL-split.md` records the direction |
> | `search-log-validation` | `tracing-log-validation`: one validating agent, no tests, no phase of its own, observable-file criteria only |
> | `tests-unit-surface` renamed `tests-unit-core-api` | the slug `tests-unit-surface` is kept (slugs are never renamed), its scope is narrowed to the core |
> | `surface-hosts` halted by an `abort` transition | retired (`retire-state` amendment entries): the installed state machine has no abort status |
> | `NEW src/api.ts` composes the `stealth_*` flat namespace | unchanged; the host flags, tool names and `naming-decision.md` probe stay in `search-hosts` |
> | open probes U-REEXPORT, U-BOOL, U-PDF, O12 (commander) | first steps of the owning states (`search-verbs`, `search-hosts`, `search-port-fetch`), recorded as evidence |

Dispatch dispatch-2026-10-12-ca18 · plan `docs/plan/stealth-browser` (backlog 8468f7b1) · worktree `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` · read-only analysis, authored by `architect`.
Citations use `repo-relative:line` for adhd, `S:` = `/Users/nix/dev/ai/scratch/agent-browser/`, `PLAN:` = `docs/plan/stealth-browser/`.

## 0. Gate result and ADR check
- Accepted as architecture: two package identities, a state-machine rewrite, new cross-package contracts (3+ packages).
- ADRs read (`docs/decisions/0001-0009,0016`): no violation. Binding: 0001 no feature-switch env vars (every `SEARCH_*`/`SEARCH_MCP_*` env read becomes a typed option plus a host flag), 0002 correct the source (no aliases), 0003 CJS-only manifest (no `module`/`exports`; both new manifests), 0004 flat MCP payload (no `{result}` envelope), 0009 unit lane spawns no process (only the log-validation agent runs processes, and it is not a test).
- Debt flags: (a) `SCOPE.md` + `APPROVAL-tripwire.md` allow exactly TWO new packages; this spec makes THREE (tripwire, core, search). A new approval record is step 1 of the DAG. (b) `turndown`, `pdfjs-dist`, `commander` are new third-party deps for adhd: blocker `hb-deps-approval` must be extended.

## 1. Names, directories, generators, rename mechanics

### 1.1 Decisions
| | Core library | Search entrypoint |
|---|---|---|
| Convention | `packages/<domain>/<domain>-<tier>-<name>` (`docs/contributing/conventions/package-naming.md` Grammar); entrypoints are untiered (same file, "Entrypoints are not tiered") | `entrypoint/<name>` |
| Domain (group) | NEW `stealth` (`.adhd/workspace.json` `groups`; allowed today: apigen agent data decompile dispatch environment resilience ui-react workspace; none fits; `resilience` was added the same way by `tripwire-scaffold`) | n/a |
| Tier | `core` ("pure logic, no persistence"; precedent `resilience-core-tripwire` does file I/O and is `core`). The optional recording sink uses `@adhd/sox-store-adapter` as an injected sink, so the package persists nothing by itself. | n/a |
| Dir / package / nx project / alias | `packages/stealth/stealth-core-browser` / `@adhd/stealth-core-browser` / `stealth-core-browser` / `tsconfig.base.json` path `@adhd/stealth-core-browser` | `entrypoint/stealth-search` / `@adhd/stealth-search` / `stealth-search` / alias `@adhd/stealth-search` |
| Generator (bare names, never the package name) | `npx nx g @adhd/workspace-codegen-nx:core --name=browser --group=stealth --nxLayer=logic --platform=node --access public --publish true` (dry-run first, transcript to `evidence/split/core-dry-run.txt`). Expected tags: `domain:stealth, pkg-kind:core, pkg-class:foundation, layer:logic, platform:node, access:public, publish:npm`. If the dry-run rejects `logic` use `shared` (tripwire precedent). | `npx nx g @adhd/workspace-codegen-nx:entrypoint --name stealth-search --nxLayer entrypoints --platform node` (dry-run first, same shape as `PLAN:evidence/scaffold-dry-run.txt`) |
| Version / manifest | `0.1.0`, `main ./dist/index.js`, `types`, no `module/exports/bin`, `files [dist, CHANGELOG.md]`, engines `>=22.5`, deps unchanged (`@adhd/sox-service-proxy ~0.6.0`, `@adhd/sox-store-adapter`, `node-html-parser`, `xpath`, `@xmldom/xmldom`) | `0.1.0`, bins `stealth-search` -> `./dist/bin/cli.js`, `stealth-search-mcp` -> `./dist/bin/mcp.js`, no `exports`/`module`, engines `>=22.5` |
| Structure | library only: no `bin/`, no `build-bin`, no `verify-dist-load` bin check beyond library load | same top-level files/tags/targets as `entrypoint/dispatch-cli` and `entrypoint/backlog` (`bin/cli.ts`, `src/{api,index,server,cli}.ts`, `tsconfig.build-bin.json`, `vitest.e2e.config.ts`, `AGENTS.md`, `README.md`, `CHANGELOG.md`) |

Why a generated core and not `git mv` of the whole directory: `entrypoint/stealth-browser/project.json` carries entrypoint tags and `build-bin`/`verify-dist-load` targets (`entrypoint/stealth-browser/project.json:31-83`); moving it under `packages/` yields a library the generator never built (violates the standing "built with the generator" rule). The simplification that results: the "second module instance" problem (`PLAN:contexts/surface-hosts.md` note "One module instance") disappears, because search consumes the built core as a package and there is one core module graph.

### 1.2 Rename mechanics (state `core-scaffold`, one serialized owner)
1. Add group `stealth` ("Stealth browsing - CDP Chrome core library and the search entrypoint built on it") to `.adhd/workspace.json`; run the core generator (dry-run, then real). Generator side effects (tripwire-scaffold precedent): `git restore nx.json eslint.config.mjs`; commit the generated `tools/nx-plugins/build/executors/typecheck-spec/stealth-core-browser.baseline.json`; rename emitted `vite.config.mts` to `.ts`; apply the ADR-0003 manifest shape.
2. `git mv entrypoint/stealth-browser/src/lib packages/stealth/stealth-core-browser/src/lib`; same for `src/test/{unit,fixtures,support}`, `src/api.ts`, `src/index.ts` (overwrite the generated stubs), `docs/reference`, `CHANGELOG.md`, `LICENSE`, `AGENTS.md`. Keep `src/api.ts` (rename not needed; fix its header: verbs are projected by consumers, not mounted here).
3. Rewrite every `@adhd/stealth-browser` string: `[stealth-browser]` log prefixes in `src/lib/**` (`cdp/targets.ts:223`, `chrome-manager.ts`, `lifecycle/*.ts`, `recording/*.ts`) to `[@adhd/stealth-core-browser]`; error class `StealthBrowserError` -> `StealthCoreBrowserError` (created by `prod-errors`, so rename at its creation, not before); lifecycle state dir / heartbeat names that embed `stealth-browser` (`lifecycle/state-dir.ts`, `ownership.ts`, `/tmp/stealth-browser-heartbeat` default) keep their VALUES only if the failsafe-inventory rows pin them, else rename (decide per row; default: keep runtime artifact names that live agent Chrome processes already use, rename only identifiers).
4. Delete the old shell: `git rm -r entrypoint/stealth-browser` remnants (`project.json`, `tsconfig*.json`, `vitest.e2e.config.ts`, `eslint.config.mjs`, `README.md`; `dist/` is untracked build output, remove it).
5. `tsconfig.base.json:217` alias `@adhd/stealth-browser` is removed (the generators write the two new aliases); `pnpm install` rewrites the `pnpm-lock.yaml:768` importer key `entrypoint/stealth-browser:` -> `packages/stealth/stealth-core-browser:` (lock diff confined to the two new importers; run in the worktree install, [inv:node-modules]).
6. Plan machinery (state `split-plan-repair`, runs BEFORE any code move): `PLAN:scripts/ownership.json` (119 refs) gets the new paths ADDED next to the old ones (historical `[psm:*]` commits are still judged against the old paths; do not replace); `PLAN:scripts/guard.py` (110 refs) and `criteria.json` (401 refs): introduce constants `CORE_DIR`, `SEARCH_DIR`, `CORE_PROJECT`, `SEARCH_PROJECT`; every `nx run stealth-browser:` becomes `nx run stealth-core-browser:` for core criteria; `scaffold.5` and `tripwire-scaffold.5` ("exactly two project.json files added since main") become "exactly three" (tripwire, core, search; the old `entrypoint/stealth-browser/project.json` no longer exists at HEAD); `entrypoint-parity.*` retarget to `entrypoint/stealth-search`; `docs/plan/plan-index.json:3684-3693` and `APPROVALS.md` updated; `dag.json` per section 5. Ends with `check-disjoint.py` and `check-guards-red.py` green.

## 2. The stealth-search entrypoint

### 2.1 Layering
- `@adhd/stealth-core-browser` (library): `cdp`, `storage`, `capture`, `parsers`, `chromeManager`, `recording`, `lifecycle` namespaces, the six chrome verbs (`src/api.ts:176-257`), types, `StealthCoreBrowserError`. No hosts, no apigen dependency.
- `@adhd/stealth-search` (entrypoint): depends on core, `@adhd/resilience-core-tripwire`, apigen core-client/engine-runtime/engine-naming/plugin-mcp/plugin-cli-output/plugin-ir-cache/plugin-tracing, `@adhd/sox-telemetry`, `commander` (flag parsing for the human CLI), `turndown`, `pdfjs-dist` (approvals needed).
- Search is "built on the stealth core": it never opens a CDP socket itself except through `cdp.*`/`capture.*`.

### 2.2 `src/api.ts` (the only apigen-mounted file; both hosts read it)
Greenfield single-input-object verbs (matches core header rules `src/api.ts:1-20`: one JSON input object, no env, no optional-boolean property in any input or output).
```typescript
// NEW src/api.ts of @adhd/stealth-search
export async function search(input: SearchInput): Promise<SearchResponse>
export async function listProviders(): Promise<ProviderListHelp>            // replaces listProviders+help branch (S:search-mcp-source.ts:167-211)
export async function describeProvider(input: { provider: ProviderName }): Promise<ProviderHelp> // replaces providerUsage + empty-query help (S:222-242, 558)
export async function tripwireStatus(): Promise<Record<string, TripwireRecord>>   // string-keyed sparse record, NOT Record<ProviderName,...> (S:398-424)
export async function clearTripwire(input: { provider: ProviderName }): Promise<ClearTripwireResult> // agent-callable, clearPolicy 'open' (SPEC-tripwire D3)
export { chromeStatus, launchChrome, shutdownChrome, listPageTargets, checkChromeActivity } from '@adhd/stealth-core-browser'
export async function getPageContext(input: GetPageContextInput): Promise<PageContextResult> // core call + redactCookieValues (P2)
```
`SearchInput`: `{ provider: ProviderName; query: string; strategy?: 'auto'|'network'|'dom'|'fetch'; qualifier?: string; timeoutMs?: number; maxAttempts?: number; challengeWaitMs?: number; content?: 'none'|'full'; maxContentSize?: number; visibility?: 'offscreen'|'foreground'; pageDisposal?: 'dispose'|'keep'; host?: string; port?: number }`. Enums replace the old booleans `includeContent/foreground/keepPage` (S:`search-mcp-source.ts:153-165`) because an optional boolean extracts as a duplicated `oneOf` branch (S:`438-447`, core header). Defaults from the old signature: strategy `auto`, timeout 30000, maxAttempts 3, challengeWait 25000.
Not tools: `shutdownSearchChrome` (S:491-495) becomes the host exit path (`lifecycle.installProcessExitHooks(lifecycle.chromeExitTarget, ...)` -> soft `shutdownIfIdle`), `providerUsage` folds into `describeProvider`.
Composition decision: FLAT namespace. apigen namespace `stealth`, `dropFileSegment: true` (backlog precedent), tool names `stealth_search`, `stealth_listProviders`, `stealth_describeProvider`, `stealth_tripwireStatus`, `stealth_clearTripwire`, `stealth_chromeStatus`, `stealth_launchChrome`, `stealth_shutdownChrome`, `stealth_listPageTargets`, `stealth_checkChromeActivity`, `stealth_getPageContext`; CLI commands are the kebab or camel form chosen once in `evidence/naming-decision.md` (P4/U1/U2, probe the built `--help`/`tools/list`, default camelCase to match `PLAN:contexts/surface-hosts.md` P4 comparison). Rejected: object namespaces `chrome.*` (apigen shape 3 supports it, `packages/apigen/apigen-core-client/src/lib/extract.ts:261`) because it lengthens tool names for no discoverability gain; revisit only if probe U-REEXPORT fails.
Probe gates (record default if red): U-REEXPORT: extract `dist/api.d.ts` and assert the five re-exported tools keep their input properties (ADR-0004 cites `b6a04e7f`: imported optional object properties extracted as `{}`); default fallback = five thin local wrappers with the same signatures. U-BOOL: `--help` and `tools/list` do not crash on `SearchInput`.

### 2.3 Hosts (entrypoint structure; precedent `entrypoint/backlog/src/{server,cli}.ts`, `entrypoint/dispatch-cli/bin/cli.ts`)
- `src/server.ts`: `buildStealthSearchPackage()` = extract from built `dist/api.d.ts` (backlog path, `entrypoint/backlog/src/server.ts:1-40` comment) -> `dereferenceSchema` (port of S:`apigen-client-common.mjs:96-142`) -> `composeSchemas` -> live fns from the static `api.js` import; `mcpPlugin.run({ options:{ transport, port, host, usePlugins:[tracingPlugin] } })` (`entrypoint/backlog/src/server.ts:931` shape). Transports preserved: `--transport stdio|sse|streaming-http`; default stdio for the `stealth-search-mcp` bin (spawned by clients), `sse`/`streaming-http` for a daemon (old default was SSE at 127.0.0.1:3100: S:`server.mjs:93-95`; open question O3).
- `src/cli.ts`: same package builder, `cliPlugin.run({ options:{ usePlugins:[tracingPlugin] } })`; one command per op. Interactive human features live INSIDE the traced `search` verb through an injected `InteractionPort` (`configureSearch({ interaction })`): the CLI host passes the TTY prompter built on the tripwire package's `interactiveGate`/`confirmSolved` (SPEC-tripwire section 5.2 mapping of S:`cdp-search.ts:269-338`), the MCP host passes none. No hand-written commander path may bypass the apigen invoker (it would emit no spans); `commander` is used only to parse the host-level flags below before handing argv to `cliPlugin`.
- Host flags (both bins; all config is typed `SearchHostConfig`, zero env reads in `src/`/`bin/`): `--cdp-port` (CDP, default 9222; renamed from `--port` to avoid colliding with the listen port), `--cdp-host`, `--user-data-dir`, `--listen-port` (3100) and `--listen-host` (127.0.0.1) for sse/streaming-http, `--transport`, `--idle-shutdown <ms>` (120000), `--keep-alive`, `--restart-browser`, `--monitor`, `--pretty`, `--verbose` (stderr only), `--log-level/--log-format/--log-file` (S:`server.mjs:96-98`), `--log-dir` (telemetry sink dir), `--data-dir` (tripwire/guard state root, default `~/.adhd/reverse/data` so the shared `audit.log` and live locks survive), `--audit-path`, `--audit-max-bytes`, `--tripwire-ttl-ms` (7200000), `--cooldown-captcha-ms` (30000), `--cooldown-rate-ms` (20000), `--cooldown-banned-ms` (60000), `--max-concurrent` (2), `--max-siblings` (4), `--pid-file`, `--trace-file`. `--help` prints every default.
- Host projection (`src/host-projection.ts`): `redactCookieValues` (P2; used by the `getPageContext` verb so one site covers both hosts); input allowlist P1 is inherited because core `LaunchChromeInput` is `{port,userDataDir}` only (`src/api.ts:36-41`); acceptance re-proves it on search's built `tools/list`.
- Telemetry composition root `src/telemetry.ts`: exactly one `initTelemetry({ service:'stealth-search', role:'cli'|'live-service', logSink:'file', ...(logDir?{logDir}:{}) })` per bin, called before the first dispatch (backlog precedent `entrypoint/backlog/src/index.ts:294`, `serve.ts:289`). WITHOUT it the tracing plugin writes to the `unlabeled` no-op sink (sox-telemetry README "Calling any emitter before initTelemetry() is safe: it falls back to ... no-op"); the current plan's `tracing-plugin` never calls it. Failure is non-fatal and warned on stderr (backlog `serve.ts:297`).
- `src/tracing.ts`: `export const tracingPlugin = makeTracingPlugin({ serviceName: 'adhd' })`, the ONLY `serviceName` literal; never import the package singleton (`entrypoint/backlog/src/tracing.ts`). Records: `adhd.<operation.id>.start|finish|error`, attrs `adhd.op`, `adhd.transport`, `trace_id`, `duration_ms` (`packages/apigen/apigen-plugin-tracing/src/lib/plugin.ts:344-359`, README table lines 94-97). Namespace stays `adhd` (adhd product); `stealth-search` is the telemetry SERVICE (dir/file name), so the two are distinct and both confirmed in section 4.
- Boot behaviors ported from `server.mjs` (all kept, flag-driven): boot trace file (:55-71), pid registry + sibling warning (:103-136, max 4), `uncaughtException`/`unhandledRejection` -> soft Chrome shutdown then exit 1 (:138-156), bounded shutdown with 5 s forced exit (:167-188), stdin-EOF orphan detection with 1 s grace for stdio (:197-210).
- Preflight: Node >= 22.5 in both bins (NODE_TOO_OLD), one stderr line, non-zero exit.
- IR cache: extraction runs against the built `.d.ts`; carry the extract-stage cache as a BAKED artifact written by `build-bin` (backlog `ir-artifact.ts` precedent), not the `SEARCH_MCP_IR_CACHE` toggle (S:`apigen-client-common.mjs:32-57`; ADR-0001). `tsx` runtime import (S:65-87) is deleted.

### 2.4 Typed errors (100%)
`src/errors.ts`: `StealthSearchError extends StealthCoreBrowserError` (one `instanceof` for every package error), `SEARCH_ERROR_CODES`, `exitCodeFor`. Codes (replace S:`search-mcp-source.ts:219,385,422,434,468,479`, `search-providers.ts:454`, `search-dom.ts:445`, `cdp-search.ts:298,338`, `network-capture.ts:191,195`): `UNKNOWN_PROVIDER`, `SEARCH_FAILED`, `SELECTOR_TIMEOUT` (reuse core), `HITL_ABORTED`, `TRIPWIRE_STATE_UNREADABLE`, `TRIPWIRE_CLEAR_FAILED`, `PROVIDER_STATE_IO` (cooldown file), `FETCH_URL_REFUSED` (SSRF, today an `outcome:'error'` response at S:`search-fetch.ts:127-135`: stays a RESPONSE outcome, and ALSO has a code in the message), `PDF_EXTRACT_FAILED`, `HOST_FLAG_INVALID`, `HOST_TRANSPORT_UNSUPPORTED`, `HOST_BOOT_FAILED`, `NODE_TOO_OLD` (core-owned, preflight here). Outcomes (`success|empty|error|timeout|hitl|captcha|rate_limited|banned`, `search-types.ts:32`) remain DATA, not exceptions. CLI: `<CODE>: <message>` on stderr, `exitCodeFor`; MCP: `isError:true` with code+message. `docs/ERRORS.md`; one unit test per code through the real path; audit scan forbids bare `new Error(` in non-test `src/`+`bin/`.

### 2.5 Tripwire adoption
`src/lib/tripwire.ts` = `createTripwire<SearchTripContext>({ namespace:'agent-search'->'stealth-search', stateDir: config.dataDir, auditPath, maxAuditBytes, expiry:{ttlMs:config.tripwireTtlMs}, clearPolicy:'open', sessionId })`, config from `SearchHostConfig` (NOT env as in SPEC-tripwire section 5.2; flagged because ADR-0001). `namespace` must keep `agent-search` if live locks must survive the cutover (they expire in 2 h; default: switch to `stealth-search`, accepted). Keep agent-callable `clearTripwire` with `clearPolicy:'open'`, 2 h TTL (SPEC-tripwire F7, F16, D3); accepted behavior changes: corrupt lock blocks, expired locks hidden in status. Map: `fireTripwire`, `tripwireGate`+`gateBlocked` (block counting), `clearedTripwire`, `resolvedTripwire`, `readTripwire`, `isTripwireTripped`; `renderStatusText`/`statusJsonLine` for `--tripwire-status`-style output via the `tripwireStatus` command's pretty mode.

## 3. Search-side inventory to port (every feature/failsafe). Seed for `evidence/search-failsafe-inventory.json` (state `search-inventory`; each port batch cites row ids; the 209 rows in `PLAN:evidence/failsafe-inventory.json` cite only `adhd/` sources)

| Id | Source (S:) | Feature / failsafe | Destination |
|---|---|---|---|
| I-01 | search-mcp-source.ts:51-57 | Module ChromeManager: 120 s idle, `checkHistory:false` (B-034), stderr logger | core `configureManagers({idleTimeoutMs:120000,checkHistory:false,logger})` (seam gains `checkHistory`,`logger`) |
| I-02 | :71-94 | tripwire-locked fail-fast response: outcome `hitl`, attempts 0, no Chrome | `src/lib/search.ts` |
| I-03 | :107-130, :167-211, :223-242 | provider list + response-schema help; per-provider help | `listProviders`, `describeProvider` |
| I-04 | :213-220 | unknown provider -> typed error before any gate/Chrome | `UNKNOWN_PROVIDER` |
| I-05 | :250-255 | tripwire gate before ANY Chrome work, `gateBlocked` count | `search.ts` |
| I-06 | :261-275 | cooldown gate -> `rate_limited`, retry hint, no window | `search.ts` + guard |
| I-07 | :280-387 | bounded per-process FIFO concurrency (max 2) wraps the window-opening body | guard |
| I-08 | :285-286, :375 | `chrome.ready()`/`bump()` (heartbeat only on real activity) | core manager |
| I-09 | :290-296 | `fetch` provider route, no qualifier prepend, no strategy loop | fetch batch |
| I-10 | :299-302 | qualifier prepend; github `type:code` -> github-code | `utils.ts` (S:search/utils.ts:12-70) |
| I-11 | :305-318 | isolated off-screen context, dom vs network strategy select | engine batch |
| I-12 | :331-344 | Cloudflare managed-challenge recovery: reveal, poll provider ban markers (S:search-challenge.ts), retry once | `challenge.ts` |
| I-13 | :348, :351-366 | hostile outcomes arm cooldown (hitl excluded); HITL fires tripwire, reveals page, keeps context alive | `search.ts` |
| I-14 | :369-386 | finally: page.close, dispose unless keepPage/hitl; outer catch disposes leaked ctx | `search.ts` |
| I-15 | :408-424, :426-436 | sparse string-keyed tripwire status; clear returns false if not tripped | `tripwireStatus`,`clearTripwire` |
| I-16 | :448-481 | chromeStatus required `managed` boolean; launchChrome | core verbs (done) |
| I-17 | :491-495 | soft shutdown on every exit path | host exit hooks |
| I-18 | :497-559 | per-provider qualifier examples | `describeProvider` |
| I-19 | search-guard.ts:30-33,68-125 | cooldown 30/20/60 s, atomic tmp+rename file `<data>/guard/<provider>.json`, lazy cleanup, success/empty disarm | `guard.ts` |
| I-20 | search-guard.ts:135-160 | `SEARCH_MAX_CONCURRENT` (2; <=0 disables) FIFO queue, diagnostic snapshot | `guard.ts` |
| I-21 | search-tripwire.ts:26-284 | lock record, audit log (5 MiB cap, rotate), TTL 2 h lazy removal, blocked count, reverified/resolved | replaced by tripwire package; `TripwireRecord` stays a concrete non-generic interface (apigen) |
| I-22 | search-providers.ts:18-444 | 12 providers: duckduckgo(:20) google(:64) arxiv(:98) npm(:139) github(:174) maven(:215) wikipedia(:241) crates(:268) pypi(:307) mdn(:350) stackoverflow(:382) fetch(:420); `getProvider` throw :450-455 | `providers.ts` |
| I-23 | search-types.ts:14-239 | `SearchResultSource` -> `PageSource` (core), outcomes, `HitlInfo`, extractor configs | `types.ts` |
| I-24 | search-network.ts:14-130 | direct JSON-API fetch w/o browser, network capture search, `No network config` error outcome | engine batch |
| I-25 | search-dom.ts:26-518 | DOM extraction (pattern + structural), ban checks, selector wait with jittered 600-1800 ms retry (:436-445) | engine batch |
| I-26 | network-capture.ts:45-278 | duplicate capture with `#rso` preference | DELETE: use core `capture.captureNetworkResponse` with `select` (cutover A5) |
| I-27 | search-fetch.ts:28-309 | cookieless render -> Turndown markdown; PDF via Fetch-domain body (:48-76); 3000-char sparse-challenge heuristic (:112, :186); two-phase CF wait (:198-208); `FETCH_UA` (:28); readySignal | fetch batch |
| I-28 | fetch-policy.ts:1-128 | SSRF block: IP literals incl. IPv4-mapped IPv6 hex (:30-33), RFC1918, 169.254 (:20), loopback, single-label (:71), trailing dot (:59-66), non-http(s) (:56), embedded creds, 2000-char URL cap (:1) | fetch batch (security failsafe, own tests) |
| I-29 | fetch-markdown.ts:14-68 | 1 MiB Turndown input cap + truncation marker | fetch batch |
| I-30 | fetch-pdf.ts:15-42 | pdfjs legacy text extraction, per-page cap | fetch batch (U-PDF) |
| I-31 | search/queries/last-search.ts:22 | Google-history keyword recovery | `src/lib/queries/last-search.ts` (search-specific; reads core `storage.history`) |
| I-32 | search/queries/{activity,context}.ts | engine-agnostic | already core |
| I-33 | server.mjs:55-71,103-156,167-210 | boot trace, pid registry, crash handlers, 5 s forced exit, stdin-EOF orphan | hosts (section 2.3) |
| I-34 | server.mjs:93-100, 222-238 | SSE/stdio/streaming-http, host/port, logger level/format/file | hosts |
| I-35 | apigen-client-common.mjs:96-142,156-210 | `$ref` inlining, package build, IR cache | hosts (baked cache) |
| I-36 | search-cli.mjs:20-47 | one-shot apigen CLI, silent logs default | `cli.ts` |
| I-37 | cdp-search.ts:67-97 | human CLI flags: strategy, timeout, max-attempts, pretty, list-providers, tripwire-status, keep-alive, idle-shutdown, restart-browser, monitor, challenge-wait, foreground, include-content, max-content-size, qualifier, keep-page, verbose | verb inputs or host flags (2.3) |
| I-38 | cdp-search.ts:269-338, :432-455 | interactive tripwire gate prompt + HITL prompt (readline) | `InteractionPort` + tripwire `interactiveGate/confirmSolved` |
| I-39 | cdp-search.ts:521, :597-615 | `--restart-browser`; detached idle-kill process | `--restart-browser` -> `shutdownChrome`; idle kill = core reaper (chrome-lifecycle) |
| I-40 | e2e-test.ts, search-guard-test.ts, chrome-lifecycle-test.ts | scenarios | `src/test/use-cases/` unit scenarios (sections 5) |
| I-41 | docs/agent-search/{README,cli,lifecycle,mcp}.md (1382 lines), SEARCH.md, FETCH.md, FEATURES.md | docs | rewritten into `entrypoint/stealth-search/docs/` + README |
| I-42 | package.json:6-9 bins `scratch-agent-search{,-serve,-mcp-cli}` | three entry points | collapse to two bins |

Stays/changes in scratch after the port: nothing runs from `agent-browser/`. It is removed (no thin consumer remains: both bins ship from the package). Order inside `search-cutover`: capture `before` evidence, run the removal, delete `bin/scratch-agent-search`, `bin/scratch-agent-search-serve`, update `docs/GIT-POLICY.md:53,105,226-227` references; `INDEX.md` entry removal is DEFERRED (INDEX.md carries another agent's uncommitted edits) and `agent-browser/metrics.json` (uncommitted change by another agent, git status M) is left in place until its author commits; stage explicit paths, never push.

## 4. Log validation: ONE agent task (`search-log-validation`), no tests
- Executor `general-purpose`/sonnet, tools Bash, Read, Write (evidence file only). It adds no spec, edits no source. On FAIL it stops and reports root cause to the dispatcher (a separate implementer fixes), it does not patch.
- Steps: (1) `H=$(mktemp -d)`; build `nx run stealth-search:build-bin`. (2) Resolve the real sink dir from sox-telemetry dist source (do not trust the README default `~/.adhd/sox-ecosystem/<service>/logs`): expected `$H/.adhd/sox-ecosystem/stealth-search/logs/*.jsonl` when run with `HOME=$H`; also run once with `--log-dir $H/logs` to prove the flag. (3) CLI, every generated command at least once via `--help`, and these dispatching calls (no Chrome needed): `listProviders`, `describeProvider --provider duckduckgo`, `tripwireStatus --data-dir $H/data`, `chromeStatus --cdp-port 19999` (dead port, success `running:false`), forced error `describeProvider --provider nope` (typed `UNKNOWN_PROVIDER`). (4) MCP: write a throwaway stdio client under the scratchpad (MCP SDK `Client`+`StdioClientTransport`) that spawns `node dist/bin/mcp.js --transport stdio` with `HOME=$H`, lists tools, repeats the same five calls, closes stdin, waits for exit (also proves stdin-EOF shutdown). (5) Read all `*.jsonl`.
- Pass criteria (each recorded with verbatim sample lines in `evidence/search-log-validation.md`): the file(s) exist and are non-empty before process exit; for every dispatched call a `.start` plus `.finish` (or `.error` for the forced error) pair whose `event` matches `^adhd\..+\.(start|finish|error)$` (record the literal op-id string seen, assert no guessed id) with identical `trace_id`; attributes `adhd.op`, `adhd.transport` equals `cli` for CLI runs and `mcp` for MCP runs, `trace_id`, `duration_ms` (number, on finish/error), `session_id`, `role` (`cli` for CLI, `live-service` for MCP), `worktree`; zero events starting with `apigen.`; the error record carries `error`/`err` and the `.op.error` twin; MCP stdout lines all parse as JSON-RPC (stderr carries diagnostics); `--verbose` adds stderr only. Any CLI path that returns without a span is a FAIL naming the command.
- This replaces `tracing-namespace-proof` entirely (user: tracing logs get validated by an agent, not tests).

## 5. DAG changes (`PLAN:dag.json`, 51 nodes; state.json today: surface-hosts in_progress, tripwire-reverse-migrate in_progress)

### 5.1 Disposition of existing states
| State | Action |
|---|---|
| `surface-hosts` (in_progress) | HALT first (transition `abort`, commit); its P7/P8 seam work moves to `core-seam`; P1/P2/P4/P5/P6 + bins + host-projection move to `search-hosts`. |
| `tracing-plugin` | REMOVED -> `search-tracing` (adds `telemetry.ts`). |
| `tracing-namespace-proof` | REMOVED (replaced by `search-log-validation`, a non-test agent task). |
| `tests-unit-surface` | RENAMED `tests-unit-core-api`: core only (verbs delegate, root export snapshot incl. `lifecycle`, seam); host/P1/P2 specs move to `search-usecases`. Deps: `surface-api`, `core-seam`. |
| `prod-errors` | NARROWED to core (`StealthCoreBrowserError`, library/capture/lifecycle codes, criteria .1-.3,.5-.8 renamed; .4 host mapping + NODE_TOO_OLD preflight move to `search-hosts`). Deps: `core-seam` (was `tracing-plugin`). |
| `prod-examples`, `tests-use-cases` | NARROWED to core: library examples only; the "drive it from Claude over MCP" scenario moves to `search-usecases`. Deps swap `tracing-plugin` -> `core-seam`. |
| `sp-switch` | dep `tracing-plugin` -> `core-seam`. `sp-reaper-smoke`: unchanged logic, paths retargeted (built core `dist/index.js` spawns the reaper). |
| `agent-search-cutover` | REPLACED by `search-cutover`; `agent-search-relink` REPLACED by `consumer-relink`. |
| `gates-first`, `audit-pre-review`, `audit-fixes`, `docs-marketing-run`, `readme-rewrite`, `merge-readiness` | KEPT, scope = both packages, dependency lists updated (section 5.3). |
| `scaffold`, `entrypoint-parity`, `mig-*`, `port-fixes`, `failsafe-inventory`, `cdp-test-harness`, `capture-upgrade`, `chrome-lifecycle`, `tests-unit-core/data/extract`, `sp-link`, `sp-reaper-load-proof`, `tripwire-*`, review/remediate/audit-final chain, `tripwire-reverse-*` | SURVIVE (complete states keep status; paths remapped by `split-plan-repair`). `scaffold`/`entrypoint-parity` stay as history. |

### 5.2 New states (ids, owners, disjoint write scopes). Executors typescript-pro sonnet/high unless noted; commit tag `[psm:<id>]`
| Id | Depends on | Writes (disjoint) |
|---|---|---|
| `split-approval` (dispatcher + human) | `tripwire-pack` | `PLAN:APPROVAL-split.md` quoting the verbatim request + three-package decision; extends `hb-deps-approval` (turndown, pdfjs-dist, commander) |
| `split-plan-repair` | `split-approval` | `PLAN:scripts/*`, `PLAN:dag.json`, `PLAN:contexts/*`, `docs/plan/plan-index.json` |
| `core-scaffold` | `split-plan-repair` | `packages/stealth/stealth-core-browser/`, `entrypoint/stealth-browser/` (delete), `.adhd/workspace.json`, `tsconfig.base.json`, `pnpm-lock.yaml` (importers), `tools/nx-plugins/build/executors/typecheck-spec/*stealth*`, `PLAN:evidence/split/` |
| `core-seam` | `core-scaffold`, `chrome-lifecycle`, `sp-link` | core `src/lib/managers.ts`, `chrome-manager.ts`, `lifecycle/index.ts`, `src/index.ts`, `src/api.ts` header, `src/test/unit/seam/` |
| `search-scaffold` | `core-scaffold`, `tripwire-pack` | `entrypoint/stealth-search/` (generator output + manifest), `pnpm-lock.yaml` (importer), `tsconfig.base.json` alias, `PLAN:evidence/split/search-dry-run.txt` |
| `search-inventory` | `search-scaffold` | `PLAN:evidence/search-failsafe-inventory.json` |
| `search-errors` | `search-inventory`, `prod-errors` | `src/errors.ts`, `src/test/unit/errors/`, `docs/ERRORS.md` |
| `search-port-providers` | `search-errors` | `src/lib/{types,providers,utils}.ts`, `src/lib/queries/last-search.ts`, `src/test/unit/providers/` |
| `search-port-fetch` | `search-errors` | `src/lib/fetch/*`, `src/test/unit/fetch/` (SSRF matrix) |
| `search-port-engine` | `search-port-providers` | `src/lib/{network,dom,challenge}.ts`, `src/test/unit/engine/` |
| `search-port-guards` | `search-errors` | `src/lib/{guard,tripwire,config}.ts`, `src/test/unit/guards/` |
| `search-verbs` | all four `search-port-*` | `src/api.ts`, `src/lib/search.ts`, `src/host-projection.ts`, `src/index.ts`, `src/test/unit/verbs/` |
| `search-tracing` | `search-scaffold` (parallel with ports) | `src/tracing.ts`, `src/telemetry.ts` |
| `search-hosts` | `search-verbs`, `search-tracing`, `core-seam` | `src/server.ts`, `src/cli.ts`, `src/host-flags.ts`, `bin/*`, `evidence/naming-decision.md`, `src/test/unit/hosts/` |
| `search-usecases` | `search-hosts` | `src/test/use-cases/*.spec.ts` (ported e2e/guard/lifecycle scenarios, P1/P2, MCP-driven scenario) |
| `search-examples` | `search-hosts` | `entrypoint/stealth-search/examples/`, `src/test/unit/examples/` |
| `search-log-validation` (agent task, section 4) | `search-hosts` | `PLAN:evidence/search-log-validation.md` only |
| `search-cutover` | `search-usecases`, `search-examples`, `search-log-validation`, `tripwire-pack` | scratch consumer removal (section 3), `PLAN:evidence/cutover-*.json` |
| `consumer-relink` | `merge-readiness` + publish | agent definitions and host configs (section 6) |

### 5.3 Rewired edges
`gates-first` deps: [tests-unit-core, tests-unit-data, tests-unit-extract, tests-unit-core-api, tests-use-cases, search-usecases, search-examples, search-log-validation, search-cutover, mig-docs, audit-fixes, sp-switch, sp-reaper-smoke, tripwire-pack]; `audit-pre-review`: same minus gates, plus `search-hosts`; `merge-readiness`: [audit-final, tripwire-reverse-migrate]; `tests-use-cases` deps [prod-examples, capture-upgrade, chrome-lifecycle]; `prod-examples` deps [core-seam, prod-errors]. Cycle check by `check-disjoint.py`/`gap-check.js`.

### 5.4 Acceptance criteria (guard ids; each a deterministic check in guard.py; tests cite ticket 8468f7b1 and the id)
- `core-scaffold.1` generator transcript present, project `stealth-core-browser` tags exactly the expected set; `.2` ADR-0003 manifest (no module/exports/bin), version 0.1.0; `.3` `rg '@adhd/stealth-browser'` outside `PLAN:` and history returns no hits; `.4` `nx run stealth-core-browser:typecheck`, `:build`, `:test` exit 0; `.5` `entrypoint/stealth-browser` does not exist; `.6` exactly three `project.json` added since main.
- `core-seam.1` `managers.ts` exports `configureManagers({idleTimeoutMs,keepAlive,entryPath,checkHistory,logger})`, `managerFor`, `chromeExitTarget`; sole `new ChromeManager(`; `.2` `keepAlive:true` never arms the idle timer, `checkHistory:false` reaches the manager; `.3` built `dist/index.js` exposes `lifecycle.{configureManagers,managerFor,chromeExitTarget,installProcessExitHooks,runChromeReaper}`; `.4` no `process.env`, no proxy package name in `managers.ts`.
- `search-scaffold.1` entrypoint generator transcript, tags `domain:entrypoint,pkg-kind:entrypoint,pkg-class:entrypoint,layer:entrypoints,platform:node,access:domain`; `.2` top-level files/targets equal `dispatch-cli`/`backlog` (reuse `entrypoint-parity.*`); `.3` manifest bins and deps, no `link:`/`file:`.
- `search-inventory.1` every row has `file:line` that exists; `.2` rows cover every function exported by the S: files listed in section 3.
- `search-errors.1` registry and per-code tests; `.2` no bare `new Error(` in non-test `src/`+`bin/`.
- `search-port-*.N` each cites inventory rows; `search-port-fetch.2` SSRF matrix incl. `::ffff:169.254.169.254`, `localhost.`, creds, `file:`; `search-port-guards.2` cooldown tmp+rename atomic, lazy removal, hitl not cooled; concurrency FIFO max 2; tripwire `clearPolicy:'open'`, ttl 7200000; `.3` no env read.
- `search-verbs.1` the eleven tools; `.2` `launchChrome` schema has no `chromePath`/`extraArgs`; `.3` `getPageContext` output has cookie names/counts, no value strings (`SECRET123` fixture); `.4` U-REEXPORT and U-BOOL probes recorded.
- `search-tracing.1` only `tracing.ts` holds `serviceName` and it is `'adhd'`; no singleton import; `.2` exactly one `initTelemetry` call per bin, via `telemetry.ts`.
- `search-hosts.1` `nx run stealth-search:build-bin` exits 0; `.2` `cli --help` lists all 11 with defaults; `.3` built MCP `tools/list` names match `naming-decision.md`, descriptions >= 40 chars; `.4` Node preflight; `.5` extraArgs call rejected, nothing spawned, no profile dir; `.6` flags table of section 2.3 present with defaults in `--help`; `.7` no `process.env` in `src/`+`bin/`; `.8` transports stdio/sse/streaming-http boot (sse bind probe on an unused port).
- `search-usecases.1` scenarios: gated tripwire returns `hitl` with zero Chrome calls, cooldown fail-fast, concurrency cap 2, managed-challenge recovery then retry, fetch SSRF refusal, PDF branch, HITL fire + keep context, soft shutdown on exit; unit lane spawns no process (ADR-0009).
- `search-log-validation.1` evidence file exists with PASS for every check in section 4.
- `search-cutover.1` `before` captured before any scratch change (provider id list = 12, help keys, seeded legacy lock -> `hitl`, zero Chrome calls); `.2` `agent-browser/` authored files removed; scratch commits local-only, explicit paths.

## 6. Release, publish order, relink
1. Pre-merge: `search-cutover` proves the unreleased build via tarballs of the three packages packed from the worktree, installed as real directories into a scratch temp consumer (no committed link, no lockfile change), as `PLAN:contexts/agent-search-cutover.md` already requires for tripwire.
2. Publish (PUBLISHING.md, per-project nx tasks, publish-from-dist, `published-state.json` committed) in dependency order: `@adhd/resilience-core-tripwire@0.1.0` -> `@adhd/stealth-core-browser@0.1.0` (needs `@adhd/sox-service-proxy@0.6.0` on the registry: gate `sp-switch`) -> `@adhd/stealth-search@0.1.0` (dist-manifest resolves internal ranges from the workspace snapshot, so the two dependencies must already be on npm before consumers install). `merge-readiness` records `DECISION` for all three plus `nx affected -t lint typecheck test build` exit codes.
3. `consumer-relink` (after publish, dispatcher-gated): rewrite every consumer of the old tool names `mcp__search__agent_browser_search_mcp_source_*` (search found hits): `~/.claude/agents/{researcher,product,performance,doc-evangelist}.md`, `~/.config/opencode/agents/{researcher,doc-evangelist}.md`, `~/.config/opencode/DOC-TRIO.md`, sox-ecosystem `extensions/agents/{researcher,performance,product,doc-evangelist}/` (+ `researcher/agent.md`, `CHANGELOG.md`), `libs/host-registry/{README.md,src/agent-renderers.spec.ts,src/agent-manifests.shell-policy.spec.ts}`, `tools/test-c1b17653-researcher-single-definition.mjs`, and the opencode `search` server entry (currently the SSE URL `http://127.0.0.1:3100/sse`): new entry runs `npx -y @adhd/stealth-search stealth-search-mcp` (stdio) or the `--transport sse` daemon. New tool names `mcp__search__stealth_*`. Those repos are outside this worktree: dispatch per repo with their own gates.
4. Scratch: `bin/scratch-agent-search*` shims and `agent-browser/` removed (section 3); a new `INDEX.md` entry is not added (the package lives in adhd).

## 7. Risks and open questions (defaults stated; no user questions)
| Id | Risk / question | Default |
|---|---|---|
| O1 | Tool names change (greenfield) and break every agent allowlist | Accept; listed in `consumer-relink`; rename is one decision in `naming-decision.md` |
| O2 | Positional CLI form `scratch-agent-search <provider> <query>` is not expressible by `cliPlugin` | Verb flags (`search --provider X --query Y`); README shows it; a positional shim is a later backlog item |
| O3 | Old MCP default transport was SSE | `stealth-search-mcp` defaults to stdio; sse/streaming-http by `--transport` |
| O4 | `pdfjs-dist@4.10.38` is ESM-only (`main build/pdf.mjs`); `fetch-pdf.ts:22` uses `await import('pdfjs-dist/legacy/build/pdf.mjs')`; ADR-0003 CJS build or `tsc` module setting may rewrite it to `require()` | Probe U-PDF in `search-port-fetch`: built bin must extract a fixture PDF; if it fails keep the dynamic import in an `.mjs` helper copied to dist |
| O5 | Re-exported core verbs may extract badly (ADR-0004 `b6a04e7f`) | Probe U-REEXPORT; fallback thin wrappers |
| O6 | `getPageContext` redaction is applied in search only; the core library result stays raw | Intended (library parity); documented in `RESPONSIBLE-USE.md` |
| O7 | Tripwire/guard state root `~/.adhd/reverse/data` keeps a `reverse` path name | Kept (shared `audit.log` with reverse-apis; flag `--data-dir` overrides) |
| O8 | Tripwire namespace `agent-search` vs `stealth-search` | Switch; existing locks expire in 2 h |
| O9 | Running `surface-hosts` has uncommitted work? | git status shows none besides plan events; abort transition is clean |
| O10 | Layer `logic` rejected by generator or module-boundary lint | Use `shared` |
| O11 | `agent-browser/metrics.json` modified by another agent | Left untouched until committed |
| O12 | Search keeps `commander` only for host flag parsing; if `cliPlugin` parses all flags itself, drop the dependency and the approval request | Decide in `search-hosts`; default keep until probe proves otherwise |
| O13 | Real-time proof of live Chrome behavior is intentionally absent (user: unit scenarios, no e2e) | The only process-spawning checks are `sp-reaper-smoke` (existing) and the log-validation agent |

## RETURN
spec: `/private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/stealth-search-spec.md`
sections: 0 Gate and ADR check; 1 Names/directories/generators/rename mechanics; 2 stealth-search entrypoint (layering, api.ts, hosts, errors, tripwire); 3 Search-side inventory with file:line and scratch end state; 4 Log-validation agent task; 5 DAG changes (disposition, new states, edges, acceptance ids); 6 Release/publish order/relink; 7 Risks and open questions.
