# Pre-review audit (non-blind, static)

- Auditor: code-reviewer. Blind: false. Static: true.
- Head: `f7339e2093890e021c0272ea1e341045bbed624d`
- Code tree (core + search): `0eb3dc0bd92999d72884c67606392f7eaae222099e629cc7b5dcdacf04cf8ca5`
- Scope: diff `e21558fc1..HEAD` of `packages/stealth/stealth-core-browser`, `packages/resilience/resilience-core-tripwire`, `entrypoint/stealth-search`; scratch cutover `ca1f94d84`.
- Inventory: 209 failsafe rows, 0 unpinned; search inventory unpinned: none.

## audit_dod

Command: `python3 docs/plan/stealth-browser/scripts/audit_dod.py --phase pre-review`
Exit status: 0

```text
[dod.2] PASS use-case unit suites (library scenarios in the core, CLI and MCP scenarios in the search entrypoint, against the in-process fake CDP server) pass
[dod.3] PASS tracing namespace is adhd, never apigen (configuration pins + the validating agent's read of the logs written by the built CLI and MCP hosts)
[dod.4] PASS behavior-preserving port (exports, similarity, tokens)
[dod.5] PASS agent-search source untouched up to the first cutover commit
```

## Summary

blocker: 0, major: 5, minor: 28, nit: 10 (total 43).

## Findings

### P1 [major] packages/stealth/stealth-core-browser/src/lib/parsers.ts:353

extractSnippet reads a forward 5000-character window that is not bounded at the next result card, so a card without its own snippet takes the next card's snippet (known).

Evidence: parsers.ts:353 `const ctx = body.slice(matchIndex, Math.min(body.length, matchIndex + 5000))` then :355-356 first `re.exec(ctx)` wins; no cut at the next title match. Callers at :275, :287, :312, :340 pass only match.index.

### P2 [minor] entrypoint/stealth-search/src/lib/providers.ts:346

pypi `version` selector (span.package-snippet__version) matches nothing; upstream emits span.package-snippet__created, so the `version` meta is always absent (known). Same selector in the dom config at :358.

Evidence: providers.ts:346 `meta: { version: 'span.package-snippet__version' }` and :358 `version: { tag: 'SPAN', attrs: { class: 'package-snippet__version' } }`; the plan fixture transcribed from the warehouse template uses __created.

### P3 [major] entrypoint/stealth-search/src/server.ts:686

A StealthSearchError reaches MCP clients as a JSON-RPC error (-32603) with no machine-readable code; an isError tool result carrying the code is required (known).

Evidence: errors.ts:116-119 documents that StealthSearchError is not an apigen ApiError so mcpPlugin re-throws it; docs/ERRORS.md:47 states `the code is not a separate field`; server.ts:685-692 runMcp is mcpPlugin.run with no error mapping layer; only tracingPlugin is mounted (:679). Every typed code (UNKNOWN_PROVIDER, HITL_ABORTED, ...) is lost to MCP callers.

### P4 [major] entrypoint/stealth-search/src/lib/fetch/policy.ts:15

SSRF check resolves the host once in Node and the browser resolves again at connect time (resolve-then-connect race / DNS rebinding); no resolve-and-pin before credential tiers (known).

Evidence: policy.ts:15-18 states `The browser resolves again at connect time`; fetch.ts:375 `await resolveAndCheck(verdict.url.hostname, deps.resolveHost)` then :409 `deps.settle(session, { navigate: target ...})` navigates by name; pdfBytesDirect fetch.ts:311-312 resolves then `fetchImpl(current)` resolves again. A rebinding name passes the check and reaches loopback or metadata.

### P5 [minor] entrypoint/stealth-search/src/server.ts:367

dist/operations.baked.json is produced with file mode 0600 (nodeHostFs.writeFile mode 0o600) and the npm tarball carries it as 0600 while every other dist file is 0644 (known; verified in the tarball). A 0600 file extracted by a tool that keeps tar modes is unreadable by other users of a shared install and the host then silently falls back to the ~13 s extraction.

Evidence: server.ts:367 `writeFileSync(p, d, { mode: 0o600 })` used by writeOperationsCache for the baked file (bakeOperations :277). `npm pack` of entrypoint/stealth-search then `tar -xzf` gives -rw------- for package/dist/operations.baked.json; `npm pack --dry-run --json` lists mode 0o600 for it and 0o644 for the other dist files. Not verified: whether npm's own installer re-adds read bits (pacote extract could not be run offline). server.ts:243-249: an unreadable file makes present=false, so no onStale warning is emitted either. Fix: write the baked file 0644 (it holds no secrets) or chmod in bake-operations.mjs.

### P6 [nit] entrypoint/stealth-search/test/unit/providers/pypi-dom.spec.ts:27

pypi-dom.spec.ts has three no-non-null-assertion lint warnings at lines 27, 32 and 43 (known).

Evidence: pypi-dom.spec.ts:27 `dom!.extract`, :32 `pypi.dom!.extract`, :43 `pypi.dom!.extract`.

### P7 [nit] AGENTS.md:37

Shared doc: the pre-push gate command uses `--base=origin/main`; reported only, not edited (known; AGENTS.md is a shared doc).

Evidence: AGENTS.md:37 `npx nx affected --base=origin/main --head=HEAD $(node .githooks/lib/pre-push-flags.mjs)`.

### P8 [major] entrypoint/stealth-search/src/lib/fetch/fetch.ts:395

SSRF policy is applied only to the requested URL: browser redirects (HTTP, meta, script) to a private or loopback address are followed and their content returned, because finalUrl is never re-validated.

Evidence: fetch.ts:370-379 validate + resolveAndCheck only `url`; :395-406 the responseReceived handler assigns `finalUrl = u` for any http(s) Document with no forbiddenTargetReason/resolveAndCheck; :509-514 returns markdown of whatever loaded. Only the PDF direct-fetch path re-validates each hop (:307-311).

### P9 [major] packages/stealth/stealth-core-browser/src/api.ts:131

The `host` input of every chrome verb and of search is an unrestricted string: an MCP caller (or prompt-injected agent) can point the server at any host:port; the debugger WebSocket URL returned by that host is then connected to without checking it points back to the same host, and `@ ? # :` are not rejected.

Evidence: api.ts:131-141 resolveEndpoint only rejects whitespace and `/`; identical copy in entrypoint/stealth-search/src/lib/search.ts:384-392. targets.ts:48-51 `fetch(`http://${cdpHost}${path}`)` then :76-95 getChromeInfo returns v.webSocketDebuggerUrl and :137-138 `browser.connect(info.browserWsUrl)` dials it. chrome-manager.ts:163 derives the port with cdpHost.split(':')[1]. Default should be loopback-only with an explicit opt-in flag.

### P10 [minor] packages/stealth/stealth-core-browser/src/lib/cdp/session.ts:73

The WebSocket message listener calls JSON.parse with no guard: one malformed frame from a hostile or broken endpoint throws inside the listener, which the host exit hooks turn into a process exit 1.

Evidence: session.ts:72-73 `const msg = JSON.parse(String(ev.data)) as CdpMessage` inside addEventListener('message'); exit-hooks.ts:121-124 uncaughtException -> run(..., 1). Related to the unrestricted host (see the host finding).

### P11 [minor] packages/stealth/stealth-core-browser/src/lib/cdp/targets.ts:51

cdpFetch has no timeout or abort signal: a host that accepts and never answers hangs chromeStatus, listPageTargets and the launch poll.

Evidence: targets.ts:51 `res = await fetch(`http://${cdpHost}${path}`)` with no signal; browser.ts:262-270 polls isChromeReachable every 200 ms without bounding a single probe.

### P12 [minor] packages/stealth/stealth-core-browser/src/lib/cdp/targets.ts:114

[inv:typed-errors] listPageTargets returns `(await res.json()) as PageTargetInfo[]` unguarded: a non-JSON or non-array answer throws a bare SyntaxError or a TypeError in `.filter`, unlike getChromeInfo which wraps the parse as CDP_BAD_RESPONSE.

Evidence: targets.ts:112-115 vs :84-89 (guarded parse in getChromeInfo); targets.ts:120 `all.filter(...)` assumes an array.

### P13 [minor] packages/stealth/stealth-core-browser/src/lib/cdp/targets.ts:136

createPageTarget leaks its browser session when Target.createTarget throws (no try/finally) and leaves the created page open when the 3 s poll gives up.

Evidence: targets.ts:136-146 `const browser = new CdpSession(); await browser.connect(...); const result = await browser.send(...Target.createTarget...); browser.close()` with close only on the success path; :158-159 throws TARGET_NOT_FOUND without closing targetId. createIsolatedPageTarget (:206-249) does use finally.

### P14 [minor] packages/stealth/stealth-core-browser/src/lib/cdp/browser.ts:417

killChrome ignores its `port` argument whenever this process has launched any Chrome: the module-global launchedPid group is killed regardless of the port asked for, and a recycled pid is signalled without a start-token check.

Evidence: browser.ts:191 `let launchedPid` is module-global; :417-421 `if (launchedPid !== null) { await killProcessGroup(launchedPid); launchedPid = null; return }` runs before the port/profile checks at :423-436. chrome-manager.ts:337 calls killChrome(this.port, ...) for a manager of any port.

### P15 [minor] packages/stealth/stealth-core-browser/src/lib/cdp/browser.ts:331

Stale launch-lock reclaim races: two waiters both unlink and re-create the lock, a fresh winner's lock can be unlinked, and a loser with fd=null proceeds to launch without any lock (duplicate Chrome trees).

Evidence: browser.ts:331-332 `try { unlinkSync(launchLockPath(port)) } catch {}; try { fd = openSync(launchLockPath(port), 'wx') } catch { fd = null }` followed by :335-342 launching with fd possibly null.

### P16 [minor] packages/stealth/stealth-core-browser/src/lib/cdp/browser.ts:262

A launch that never answers CDP within 10 s rejects CHROME_START_TIMEOUT but leaves the spawned detached Chrome running and recorded as launchedPid, with no kill and no owner record.

Evidence: browser.ts:252-270 spawn(detached) then `reject(CHROME_START_TIMEOUT)` at :268 with no killGroup(child.pid); the manager (chrome-manager.ts:271-279) only records the failure with the breaker.

### P17 [minor] packages/stealth/stealth-core-browser/src/lib/cdp/browser.ts:224

Remediation text points at facilities that do not exist: `Set CHROME_PATH env var` (the library reads no environment, ADR-0001) and `pass chromePath` (deliberately not part of any verb input).

Evidence: browser.ts:224-226 message `Set CHROME_PATH env var or install Chrome.`; errors.ts:72 `pass the path of an existing Chrome binary`, errors.ts:98 `Install Chrome or pass chromePath`; api.ts:15-17 states chromePath/extraArgs are NOT part of any verb input.

### P18 [minor] entrypoint/stealth-search/src/host-flags.ts:153

--max-siblings help (and SearchHostConfig.maxSiblings doc) promises that launching is refused above the threshold; the code only warns.

Evidence: host-flags.ts:153 `Sibling processes tolerated before a warning (and before launching is refused)`; lib/config.ts:42 `tolerated before launching is refused`; the only consumer is server.ts:458-464 registerPid, which calls warn() and never refuses (rg maxSiblings shows no other reader).

### P19 [minor] entrypoint/stealth-search/docs/ERRORS.md:13

ERRORS.md contradicts itself: it says an error is thrown for `a refused URL`, then says a refused fetch URL is reported as an outcome `error`.

Evidence: ERRORS.md:12-14 `An error is thrown only for a failure ... (an unknown provider, a refused URL, a bad flag). A fetch whose URL is refused is reported as an outcome `error``; fetch.ts:367-373 returns failure() as a result and never throws.

### P20 [minor] entrypoint/stealth-search/src/lib/fetch/fetch.ts:433

Challenge detection passes a hard-coded `status: 200` to checkBans, so status-based ban rules (429 rate limit, 403) never fire on the fetch route even though the real main status is known.

Evidence: fetch.ts:433 `deps.checkBans(provider.bans, { url: target, status: 200, body: outerHTML })` while mainStatus is captured at :403; core capture/bans.ts:126 `if (rule.checkStatus?.includes(ctx.status))`.

### P21 [minor] entrypoint/stealth-search/src/lib/fetch/fetch.ts:417

Only 404 and 410 end a fetch as an error: a 401, 403 (non-sparse), 429 or 5xx page with content is returned as outcome `success`.

Evidence: fetch.ts:417 `if (mainStatus === 404 || mainStatus === 410)`; no other status is examined before :513-514 `outcome: has ? 'success' : 'empty'`; status is only echoed in meta().

### P22 [minor] entrypoint/stealth-search/src/lib/search.ts:491

The fetch route records its outcome under the single provider id `fetch`, so one banned or rate-limited site arms a cooldown that blocks fetches of every other site for the cooldown window.

Evidence: search.ts:491 `await guard.recordSearchOutcome(p.id, res.outcome, query)` with p.id === 'fetch'; guard.ts:179 setProviderCooldown writes <dataDir>/guard/fetch.json; search.ts:675-689 returns rate_limited for any URL while it lasts.

### P23 [minor] entrypoint/stealth-search/src/lib/search.ts:589

With maxAttempts 1 (or on the last attempt) a human solving a captcha and confirming is wasted: the lock is cleared but the loop ends and the stale `hitl` result is returned.

Evidence: search.ts:519 `for (let attempt = 0; attempt < maxAttempts; attempt++)`; :587-590 after `solved` does `tripwire.cleared(...)`, `carried = page`, `continue`, which exits the loop when attempt+1 === maxAttempts; :605-606 disposes carried and returns `last` (the hitl response).

### P24 [minor] packages/stealth/stealth-core-browser/src/lib/lifecycle/reaper-entry.ts:78

The reaper host and getPageContext read Chrome history and cookies from the default Chrome-CDP profile only, ignoring a custom userDataDir: for a custom profile the history safety tier silently reads a missing DB (treated as unavailable, so the reap proceeds).

Evidence: reaper-entry.ts:78 `const history = new HistoryClient()` although cfg.profileDir exists (:47); history.ts:22-24 default profile; reaper-host.ts:213-219 a throw becomes 'unavailable' which proceeds to reap; queries/context.ts:24,30 `new CookieClient()` / `new HistoryClient()` with no profile.

### P25 [minor] packages/stealth/stealth-core-browser/src/lib/queries/context.ts:26

getPageContext counts cookies with `c.host.includes(hostname)`: example.com also matches notexample.com and example.com.evil.net, inflating cookieCount.

Evidence: context.ts:26 `cookieCount = cookies.filter((c) => c.host.includes(hostname)).length`.

### P26 [minor] packages/stealth/stealth-core-browser/src/lib/recording/redact.ts:5

Network recordings persist cookie and authorization headers in clear by default (identity redaction) and the store sink opens the database with default file permissions (no 0600), so credentials land world-readable under a 022 umask.

Evidence: redact.ts:4-5 `Identity is the recorder default`; capture/network.ts:137 passes options.redact through unchanged; open-store-sink.ts:41 `createStoreAdapter({ dbPath })` with no mode or chmod. DEFAULT_REDACTED_HEADERS (redact.ts:13) is opt-in and does not mask URL query tokens.

### P27 [minor] packages/stealth/stealth-core-browser/src/lib/parsers.ts:415

normalizeUrl calls decodeURIComponent on page-supplied text: a malformed %-escape throws URIError and aborts the whole parse of a results page.

Evidence: parsers.ts:415 `if (ddg) return decodeURIComponent(ddg[1])` and :417 `decodeURIComponent(ggl[1])`; the callers (:271, :284, :307, :328) have no try/catch.

### P28 [minor] entrypoint/stealth-search/src/lib/fetch/policy.ts:38

The forbidden-address table is incomplete: 192.0.0.0/24, 198.18.0.0/15, multicast 224/4, reserved 240/4 and 255.255.255.255, plus IPv6 NAT64 64:ff9b::/96 and 6to4 2002::/16 embedding private v4, are allowed.

Evidence: policy.ts:38-49 isForbiddenV4 lists 10/8, 127/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 0/8 only; :59-81 isForbiddenIp handles ::1, ::, fc/fd, fe80, ::ffff and ::a:b only.

### P29 [minor] entrypoint/stealth-search/src/lib/fetch/fetch.ts:315

The direct PDF byte fetch buffers the whole response with no size cap or timeout (`res.arrayBuffer()`), so a large or endless body exhausts memory.

Evidence: fetch.ts:303 `deps.fetchImpl(current, {... redirect: 'manual' })` with no AbortSignal; :315 `return new Uint8Array(await res.arrayBuffer())`; pdf.ts caps pages (PDF_MAX_PAGES) but not bytes.

### P30 [minor] entrypoint/stealth-search/src/host-flags.ts:133

The MCP sse and streaming-http transports bind whatever --listen-host is given with no authentication and no warning, exposing launchChrome/shutdownChrome and arbitrary-host fetch to the network.

Evidence: host-flags.ts:133 `--listen-host <addr>` parse: nonEmpty only; server.ts:671-683 passes host: settings.listenHost straight to mcpPlugin.run with no auth option; the README MCP section does not mention the exposure.

### P31 [minor] entrypoint/stealth-search/bin/cli.ts:22

The CLI bin discards the runCli promise (`void runCli(...)`): a throw from the output sink or exit path becomes an unhandled rejection with a stack instead of the one-line typed error.

Evidence: bin/cli.ts:22 `void runCli(process.argv.slice(2), { initTelemetry: initSearchTelemetry })` vs bin/mcp.ts:22 which chains .then; cli.ts:581-596 finish() awaits sink.write and closeHandles outside any catch for the failure() path (called from the catch at :687-689).

### P32 [nit] packages/stealth/stealth-core-browser/src/lib/storage/profile.ts:81

Dead and stub code ships in the public surface: ProfileClient.getOpenTabs calls notYet() (console.warn) and returns []; helpers.ts openDb duplicates storage/helpers.ts openDb and has no caller; getAutofillData returns autofill values unredacted.

Evidence: profile.ts:81-83 `notYet('getOpenTabs'); return []`; helpers.ts:52 `export function openDb` (rg shows no importer outside storage/ and storage/ imports ./helpers.js); profile.ts:47-63 returns r.value.

### P33 [nit] packages/stealth/stealth-core-browser/AGENTS.md:16

AGENTS.md lists an `e2e` target via vitest.e2e.config.ts; neither the target nor the config exists in the package.

Evidence: AGENTS.md:16 `e2e` (subprocess lane via `vitest.e2e.config.ts`); the package directory has no vitest.e2e.config.ts and rg e2e over project.json and package.json finds nothing.

### P34 [nit] packages/stealth/stealth-core-browser/src/lib/chrome-manager.ts:291

Dead error path and fragile port parse: the hideAllWindows catch can never run (hideAllWindows swallows internally), and the port is parsed with cdpHost.split(':')[1], wrong for IPv6 or host:port-shaped hosts.

Evidence: chrome-manager.ts:291-295 `catch (err) { this.log(...); throw err }` around hideAllWindows (targets.ts:324-341 catches everything); :163 `parseInt(this.cdpHost.split(':')[1] ?? '9222', 10) || 9222`.

### P35 [minor] entrypoint/stealth-search/src/lib/fetch/pdf.ts:53

pdf.ts builds its dynamic import with `new Function(...)`, which blocks under a strict CSP or --disallow-code-generation-from-strings and is flagged by security linters.

Evidence: pdf.ts:53 `const nativeImport = new Function('specifier', 'return import(specifier)')`; the specifier is a constant (:55), so it is not injectable, but the pattern is eval-class.

### P36 [nit] packages/stealth/stealth-core-browser/src/api.ts:206

shutdownChrome swallows every error and always returns ok:true, so `ok` carries no information.

Evidence: api.ts:209-213 `try { await shutdownIdleAt(host, port) } catch { /* best effort */ } return { ok: true, running: ... }`; ShutdownChromeResult.ok (api.ts:88-91).

### P37 [nit] entrypoint/stealth-search/src/server.ts:365

The boot trace file is appended with default permissions (not 0600) although it records exception messages, unlike the other state files.

Evidence: server.ts:365 `appendFile: (p, d) => appendFileSync(p, d)` vs :367 writeFile mode 0o600; createBootTrace :398 writes uncaughtException messages.

### P38 [nit] packages/stealth/stealth-core-browser/src/lib/cdp/session.ts:90

Event-subscriber exceptions are swallowed with an empty catch, so a failing capture handler leaves no trace.

Evidence: session.ts:90 `try { handler(event.params) } catch { /* a bad subscriber isn't the session's problem */ }`.

### P39 [minor] packages/resilience/resilience-core-tripwire/src/lib/tripwire.ts:448

Open product defect from the README findings list: the tripwire expiry audit line carries only trippedAt and not the original trip reason, so the audit log cannot say why a lock lapsed.

Evidence: tripwire.ts:446-454 audit({event:'tripwire-expired', reason: EXPIRY_AUDIT_REASON, trippedAt: r.trippedAt, ...}) replaces r.reason; README.md:270 lists it as `for filing`.

### P40 [nit] packages/stealth/stealth-core-browser/src/lib/capture/dom.ts:218

README findings list: Google anchors without an H2/H3 heading are skipped, so those results never reach the caller. The skip is deliberate (comment at dom.ts:215-217) and has no counter or warning, so a Google layout change that drops headings returns an empty page silently.

Evidence: dom.ts:218-219 `const title = findHeadingText(node)` / `if (!title) continue`; comment dom.ts:215-217 `An anchor without a heading is not a result`; findHeadingText :236-246 accepts only H2/H3.

### P41 [minor] entrypoint/stealth-search/README.md:27

Documentation gap: SearchOutput.omitted / maxResultBytes apply only to engine providers and are in neither the package README nor SPEC-stealth-search.md (README findings list).

Evidence: plan README.md:280 lists it; api.ts:83-84 documents maxResultBytes; entrypoint/stealth-search/README.md has no mention (rg maxResultBytes returns nothing there); search.ts:329-358 shapeFetch does not call boundResults.

### P42 [nit] entrypoint/stealth-search/src/server.ts:6

The module header says buildStealthSearchPackage "inlines $ref", but no code inlines anything: the composed schemas keep `$ref` (the getPageContext output schema holds {"$ref":"#/definitions/CookieSummary"} with definitions present, so it is self-contained, but the comment and the unit coverage claim are wrong).

Evidence: server.ts:5-7 `inlines `$ref` (run-mode dispatch cannot resolve them)`; server.ts:303-345 buildStealthSearchPackage calls buildApigenPackage and requireExplicitInput only; building the package from dist shows getPageContext schema refs = "#/definitions/CookieSummary"; plan README.md:282 notes package.spec.ts has no $ref tests.

### P43 [minor] /Users/nix/dev/ai/scratch/INDEX.md:18

Scratch cutover left INDEX.md describing the retired agent-browser project (21 mentions: cdp-search.ts, server.mjs, search-cli.mjs, fetch-*.ts, docs/cdp ...) as live tools whose files ca1f94d84 deleted; the scratch rule requires INDEX.md updated after every folder change. A tracked agent-browser/metrics.json and untracked dist/ and node_modules/ remain.

Evidence: git -C /Users/nix/dev/ai/scratch show ca1f94d84 --stat: 111 files, 5 insertions and 24712 deletions, INDEX.md not in the list; INDEX.md:18-43 still lists agent-browser rows; bin/scratch-agent-search and bin/scratch-agent-search-serve were removed in the same commit; `ls agent-browser` = dist, metrics.json, node_modules.

## Checked and not a defect

- reaper-link.ts no longer uses @ts-ignore or import.meta (rg finds no ts-ignore/ts-expect-error/eslint-disable in the three src trees; currentModuleUrl uses __filename and a stack frame): the scheduled item is already resolved.
- tracing: entrypoint/stealth-search/src/tracing.ts:10 is the only makeTracingPlugin call and uses serviceName "adhd"; cli.ts:679 and server.ts:679 mount it.
- No process.env reads in entrypoint/stealth-search/src or packages/stealth/stealth-core-browser/src outside the tripwire node-io default (node-io.ts:43).
- State-file modes: guard.ts, ownership.ts, tripwire storage.ts/audit.ts all create files 0600 and directories 0700.
