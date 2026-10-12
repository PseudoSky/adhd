# @adhd/sox-service-proxy evaluation for `chrome-lifecycle`

Run dispatch-2026-10-12-ca18 · plan 8468f7b1-8adc-4237-9986-21ea1e27c537 · architect · read-only (only this file written).
Labels: [FACT path:line] read; [CMD] command run; [INFER] inference; [HYP] unverified. The earlier D1 rejection was treated as a hypothesis and tested.

## 0. Verdict in brief

1. The earlier rejection is re-tested on merit. Its stated reason ("a new process role") does not hold: the earlier design already added a detached long-lived process (the watchdog). Dependency cost is not a factor (the sox packages are owned and first-class); module format is not a problem (all CommonJS, proven in section 3b).
2. Service-proxy is the right tool for one piece and a credible tool for a second: hardened single-instance spawn of the out-of-process reaper (`ensureBackend`/`serveBackend`) and, in a later phase, kernel-backed client presence (a held UDS connection closes on `kill -9`). It is not a lifecycle policy engine: it contains no idle policy, breaker or reaper, so all 26 features below are in-package code under every option.
3. Decisive facts against making it the whole backbone (option B): (a) the policy rows are identical in every option, so a host adds a protocol without removing code; (b) when the host cannot start (unsafe socket dir, spawn failure) B loses F1 auto-start unless an in-process fallback exists, which re-creates A; (c) the connection-counted `armIfIdle` design that 19dfb641 asks to copy was retired by ADR-0022 because a permanent connection made the host immortal, so presence must not pin, activity must.
4. Recommendation: Option C with variant D's launcher as the default. Engine (`decideReap`, tiers, breaker, isolated pages, exit hooks) in-package behind two seams; `ReaperLauncher` default = `ServiceProxyReaperLauncher` (reuses `ensureBackend`; in-process-only degradation if it reports `failed`); `PresenceStore` default = in-package per-process records now, proxy-backed presence as phase 2 after upstream change U1. No feature is lost under any of these.

## 1. sox-service-proxy, fully characterized

| Attribute | Finding | Evidence |
|---|---|---|
| Name/version | `@adhd/sox-service-proxy` 0.5.0 latest; 9 versions 0.2.0 (2026-06-26) to 0.5.0 (2026-09-29) | [CMD] `npm view @adhd/sox-service-proxy --json` exit 0 |
| Source | `/Users/nix/dev/ai/sox-ecosystem/libs/service-proxy` (Nx lib, 7020 lines in src incl. specs); published from github PseudoSky/adhd | package.json; project.json; npm view `repository` |
| Purpose | stdio to UDS MCP front-shim so a backend upgrades without client reconnect. Not a lifecycle manager | README.md:1-12 |
| Public API | `runFrontShim`, `serveBackend`, `dialBackend`, `ensureBackend`, `probeSocketLive`, `handshakeBackend`, framing, schema-hash, socket-path/socket-dir, JSON-RPC types | src/index.ts; dist/index.js:15 [FACT tarball] |
| Transports | length-prefixed (4-byte BE, 16 MiB cap) JSON-RPC over UDS; optional HTTP `POST /mcp` on the shim; socket 0600 in a verified-private dir (not symlink, own uid, no group/other write; `/tmp/sox-<uid>` exactly 0700) | README.md:215-322; backend.ts:251-254 |
| Singleton | `ensureBackend`: probe, O_EXCL spawn lock keyed by FNV hash, stale-lock reclaim (pid dead via `kill 0`, or TTL 30 s), double-checked handshake, detached spawn with `stdio ignore`, child-exit monitoring, 10 s readiness. Lock staleness uses bare `kill(pid,0)` (no start-time: pid reuse blind) | ensure-backend.ts:270-308, 353-548 |
| Client counting | `serveBackend({onClientCountChange})` fires with `sockets.size` on connect/disconnect; count only, NO connection id; handler `(req)` gets no connection context. Kernel closes a killed client's socket, so the count drops on `kill -9` | backend.ts:57-68, 93-113, 138-157 |
| Self-reaping | NONE in the library. The embed host implements its own (`reapDueInMs`); client count is "diagnostics only, NEVER a reap input" | embedHostMain.ts:199, 411; ADR-0022 TL;DR |
| Crash/kill -9 | client kill -9: socket closes, count decrements. Backend kill -9: stale socket file is probe-checked and unlinked by next binder; `close()` unlinks only the inode it bound (448f9d93). No supervisor | backend.ts:191-217, 299-334 |
| Reconnect | `dialBackend` re-dials with backoff, queues up to 256 requests, replays unanswered requests to whatever answers, fast-fails -32001 after `giveUpAfterMs` 10 s; never spawns (the `ensure` hook belongs to the shim). Open HIGH bug 3d5da8f2: a long-lived shim did not recover after a backend restart | dial.ts:82-106, 386-393; ADR-0022 Context; [CMD] `adhd-backlog backlog get 3d5da8f2` |
| Concurrency | single-process event loop; per-connection frame decoder; handler may be async; no per-connection ordering guarantees beyond TCP-like stream | backend.ts:115-157 |
| Platform | POSIX UDS; no `process.getuid` throws `E_UDS_UNSUPPORTED_PLATFORM` on the tier-3 path; sun_path 104/108 handled by `backendSocketPath` | README.md:245-262 |
| Dependencies | ONE runtime dep `@adhd/sox-listen-guard` (workspace:^ rewritten to `^0.1.1` in the tarball; 0.1.1 is node-builtins-only CJS). README claims "node builtins only" which is slightly off | [CMD] `npm pack`, tarball package.json; listen-guard dist requires only `node:fs/net/path` |
| Module format | `"main": "./dist/index.js"`, `exports["."].require = ./dist/index.js`; dist is CommonJS (`"use strict"`, `exports.x`, `require(...)`); `engines.node >=20` (our floor >=22.5 is stricter). ADR-0003 compatible | [CMD] static read of extracted tarball (not executed); ADR-0003 D1 |
| License | MIT | package.json |
| Maturity | 46 commits since 2026-06-25; 102 spec cases in 15 spec files; most spec files bind real UDS sockets / spawn children (so they live in an e2e-like lane upstream). Versions 0.4.3 to 0.5.0 are correctness fixes: dial hang pinning the main thread 640 s (BL-6b4ff2b8), deleting a successor's socket (448f9d93), idle dial socket pinning CLIs forever, unsafe socket dirs | CHANGELOG.md:1-110; [CMD] rg/git log |
| Known gaps | ADR-0020 D2: no stale-client eviction (still true: no eviction in backend.ts); no spawn circuit breaker (embedding-provider's `funnelClient` has its own); 30-min orphan-shim watchdog (8aa43fb8 open). 72d980e5 (unref'd sleep) is STALE: fixed in 0.5.0 (`dist/ensure-backend.js:279-299` "REFERENCED on purpose") but still open. 3d5da8f2 open HIGH | CHANGELOG; ADR-0020; [CMD] backlog gets |
| Consumers | embedding funnel (`funnelClient.ts` uses `ensureBackend` + `dialBackend`, own breaker `:150,382,574`), memory-server shim, mcp-runtime, `apps/sox`. Each owns its own lifecycle policy | rg over sox-ecosystem package.json files; funnelClient.ts |
| ADRs | 0020 (peer-spawned self-reaping; D2 and D6 superseded), 0022 (work-driven drainer; connections are not a reap input), 0013 (no feature-switch env vars), 0004 (sockets under data root), 0012, 0015 | docs/decisions listing; ADR-0020, ADR-0022 read in full |
| Prior art on our exact problem | 9434902c: consumers orphaned to PPID 1 stayed ALIVE holding UDS connections and pinned hosts (connection count does not detect a live-but-orphaned client). Its fix was a consumer-side self-watchdog (parent-pid poll + 600 s cap); 9d963c4e (open LOW) notes that watchdog treats a recycled pid as alive | backlog 9434902c, 9d963c4e |

Stale premise in 19dfb641: it cites `embedHostMain.ts:131-143 armIfIdle` and "replaces heartbeat with authoritative connected-client count". [CMD] `rg armIfIdle` finds no definition; ADR-0022 (51d05766, 2026-09-25) superseded ADR-0020 D2 because connection counting made the host immortal (memory-server's permanent `:3099` shim connection). 19dfb641 was filed 2026-09-23. Proposed amended AC wording is in section 8.

## 2. Inventory of every feature and failsafe of the existing Chrome management

Source columns: CM = `entrypoint/stealth-browser/src/lib/chrome-manager.ts`, BR = `src/lib/cdp/browser.ts`, SH = `src/lib/cdp/shutdown.ts`, TG = `src/lib/cdp/targets.ts`, HI = `src/lib/storage/history.ts` (all in the worktree); AB = `/Users/nix/dev/ai/scratch/agent-browser`. The port's chrome-manager is a one-line-import copy of AB `adhd/chrome-manager.ts` [CMD diff]. Per the user's correction, MECHANISMS (heartbeat file, its path, `pid:ts` format, class layout, old tests) are not features. Each feature below is what must survive.

| # | Feature / failsafe | Evidence | Mechanism today (replaceable) |
|---|---|---|---|
| F1 | Auto-start Chrome on first use; one shared Chrome on 127.0.0.1:9222 by default | CM:69,100-106; BR:150-196,71-135 | `ensureChromeRunning` |
| F2 | Start is bounded: Chrome must expose CDP in 10 s or the call fails | BR:124-134 | poll loop |
| F3 | Stale-ready self-heal: if another process killed the shared Chrome, `ready()` re-verifies and relaunches | CM:81-99 | one GET `/json/version` |
| F4 | Race-free single launch across processes: exclusive per-port lock, loser waits bounded for the winner's Chrome, stale lock reclaimed at 15 s, reachability re-check under lock | BR:138-195 | O_EXCL lock file |
| F5 | Hide windows after a fresh launch; do NOT re-hide on the fast path (a HITL window revealed for a human stays visible) | CM:89-90,107-115; TG:284-301 | `hideAllWindows` |
| F6 | Activity-bumped idle timer; unref'd; re-arms after it fired (relaunched Chrome is monitored again) | SH:29-69; CM:119,124-128,237-244 | `IdleShutdown` |
| F7 | `withBrowser` bumps on success AND failure | CM:168-175 | try/finally |
| F8 | Cross-process coordination: never close a Chrome another LIVE process used within the idle window; dead processes are ignored | CM:202-233,249-252 | shared heartbeat file + `kill 0` |
| F9 | Livelock protection (90ed0315 facet 3): an idle process that merely defers must not advertise activity, so N idle processes cannot keep each other alive forever | CM:130-146,250,267,278 | `_rearmIdle` |
| F10 | Open http(s) page keeps Chrome alive (human captcha window, keepPage) | CM:262-270 | `listPageTargets` + filter |
| F11 | Browser-internal targets never pin (chrome://newtab etc, about:, devtools://, chrome-untrusted://) (90ed0315 facet 1) | CM:47-56 | `isActiveWebTarget` |
| F12 | If CDP is unreachable during the check, proceed (do not defer forever) | CM:270 | catch |
| F13 | History-recency tier: a visit within 2 min keeps Chrome; `checkHistory` option, default true; history DB unavailable means skip | CM:37-38,72,272-282; HI:72-76 | `HistoryClient.isRecentlyUsed(2)` |
| F14 | Force `shutdown()` bypasses all tiers | CM:148-152 | `_doShutdown(true)` |
| F15 | Soft `shutdownIfIdle()` for process-exit paths: closes Chrome only if genuinely idle; never closes a sibling's or human's Chrome | CM:154-165 | `_doShutdown(false)` |
| F16 | Ordered shutdown: close all page targets (allSettled, confirmation-based close) then kill Chrome; each failure logged, non-fatal | CM:285-297; TG:263-277 | sequence |
| F17 | After a real shutdown state resets so a later `ready()` relaunches and re-arms | CM:298-302 | `idle=null,_ready=false` |
| F18 | Kill the whole process GROUP: SIGTERM, wait up to 5 s, then SIGKILL the group so orphaned Helpers (renderer/GPU) die | BR:214-241 | `killGroup` |
| F19 | Reaper scope: when this process did not launch Chrome, still close the port occupant (lsof, fuser fallback, pgid lookup) so idle-shutdown works regardless of who started it | BR:244-274; docs/agent-search/lifecycle.md:257 | `lsof -ti` |
| F20 | Isolated page contexts: cookie-less partition, background+minimized by default, `reveal()` for HITL, `dispose()` closes the whole context | TG:153-241 | `createIsolatedPageTarget` |
| F21 | Isolated-create failure cleanup: target-missing after 3 s disposes the context before throwing | TG:243-254 | `await dispose()` at :252 |
| F22 | Consumer cleanup on every path (dispose in finally and in outer catch; keepPage/HITL skip dispose; tab leak B-034/B-035) | AB `search-mcp-source.ts:305,372-384` | consumer code |
| F23 | Shutdown on EVERY exit path of a hosting process: SIGINT, SIGTERM, stdin-EOF (orphan), uncaughtException, unhandledRejection, fatal main; soft; bounded by a 5 s force-exit | AB `server.mjs:139-209,256` | process handlers |
| F24 | CLI post-search delayed reaper: `--idle-shutdown <ms>` (default 120000) spawns a detached process that closes Chrome after N ms; `--keep-alive` opts out | AB `cdp-search.ts:85-86,255-256,606-625` | detached `node -e` killer |
| F25 | Sibling-instance diagnostic: warn loudly when many sibling servers are alive (8e5181a7 mitigation); never kills | AB `server.mjs:106-128,212-218` | pid registry file |
| F26 | Best-effort I/O: heartbeat/dir failures never break a call | CM:197; docs error table | try/catch |

Gaps found while inventorying (not features today):
- G1 [FACT TG:188-213] a throw at `Target.createBrowserContext` (:188) or `Target.createTarget` (:194) skips `browser.close()` (:214) so the browser CdpSession leaks and, on :194, so does the context. The earlier spec's claim that target-missing leaks was wrong (:252 disposes). B-035's lib hole is THIS.
- G2 [FACT] the port has no host/exit handlers yet: `rg 'SIGTERM|SIGINT|stdin|uncaught' src --glob '!src/test/**'` shows only the group-kill signals in `cdp/browser.ts`; `src/` holds only `index.ts`, `lib`, `test`. F23 and the F24/F25 wiring must be built by whoever owns `src/server.ts`/`src/cli.ts` (surface-hosts), consuming `installProcessExitHooks` from this state.
- G3 B-036..B-039: [CMD] `git show cffee3c` contains only the commit title "B-034 through B-039: Browser lifecycle + challenge detection + Wikipedia URLs + fetch standardization"; `rg 'B-03[6-9]' agent-browser/BACKLOG.md` is empty. No lifecycle definition exists for B-036..B-039; they are not in scope.
- G4 [FACT CM:196, cdp-search.ts:590-594] the shared heartbeat file is read-modify-written by every process without a lock, so concurrent writers can lose entries. This is a defect of the MECHANISM; the replacement must not share a single mutable file.
- G5 New in 19dfb641 (requirements, not features today): N1 `kill -9` of a caller leaves no Chrome after grace+watchdog; N2 Chrome exits within grace after last caller leaves; N3 stale-client eviction; N4 spawn circuit breaker; N5 bounded orphan backstop; N6 N concurrent callers produce exactly one Chrome tree; N7 no parallel lifecycle implementation.

## 3. Requirement-by-requirement fit of sox-service-proxy

Codes: AS covered as is; AD covered with an adapter (in-package code on top, no upstream change); UP requires an upstream change; NC not covered (must be built in-package under every option).

| Requirement | Code | How / smallest upstream change |
|---|---|---|
| Single shared Chrome on 9222 | NC (Chrome already is a per-port singleton) | The Chrome port itself is the singleton; the existing launch lock (F4) serializes spawn. The proxy would add a second singleton (the host) in front of one that already exists |
| Multi-process agents acquire/release | AD | Client holds a `dialBackend` connection (presence) and sends `chrome.activity{clientId}` RPCs (the handler sees requests, not connections). No upstream change |
| Authoritative client counting | AS for count, AD for attribution | `onClientCountChange` (backend.ts:68). Count only; per-client attribution needs client-supplied ids. Optional upstream U1 (connection id) only improves attribution |
| Idle shutdown with safety tiers (F8-F15) | NC | Pure policy plus Chrome/CDP/history access; the library has no idle policy. Host would run package code |
| Reaping on every exit path incl. kill -9 of a client | AD | Kernel closes the socket (strong signal, immune to pid reuse); activity ages out in idle window. kill -9 of the HOST/reaper: NC in every option (darwin has no parent-death signal); bound = "next `ready()` from any process adopts or reaps" |
| Launch lock / group kill | NC / AS-for-spawn | Chrome launch lock stays (BR:138-195); `ensureBackend` could host the reaper's single-instance spawn only |
| Isolated page contexts, cleanup | NC | CDP-level; no relation |
| Only closing a Chrome this system launched | NC | Conflicts with F19 as it exists today (BR:244-274). Decision D3 |
| Typed errors | NC | Library errors are string codes (`E_LIVE_SOCKET`, `E_UDS_DIR_UNSAFE`, -32001); wrapped into `LifecycleError` |
| Unit purity (no sockets/spawn) | AD | `vi.mock('@adhd/sox-service-proxy')` or inject a `ReaperLauncher`/`PresenceStore` fake; real UDS/host behavior is an e2e-lane concern (ADR-0009). The package's own tests are real-socket |
| Stale-client eviction (ADR-0020 D2 gap) | Moot under activity semantics | A live-but-idle client never pins (activity, not presence); a hung client that keeps bumping is out of scope. Presence-only pinning is exactly the ADR-0022 immortality bug |
| Spawn circuit breaker | NC | Not in the library; consumer-built (`funnelClient.ts:150`) |
| Bounded orphan backstop | AD | Out-of-process reaper polls; not a 30-min watchdog |

Upstream changes (the user owns the package; in scope, smallest first):
- None required for the launcher (variant D) or for a file-based presence store.
- U1 (needed only for proxy-backed presence, phase 2): `BackendHandler` receives `ctx.connectionId` and `serveBackend` gets `onClientConnect(id)`/`onClientDisconnect(id)`. Today `onClientCountChange` is count-only (backend.ts:68) and the handler gets no connection context (backend.ts:115-123), so a disconnect cannot be attributed to a client.
- U3 (only if clients hold long-lived dials): fix 3d5da8f2 (dial give-up path, dial.ts:386-393, does not recover after a backend restart).
- U2 housekeeping: close stale 72d980e5; README "node builtins only" vs listen-guard dependency; `dist/package.json` inside the 0.5.0 tarball still says version 0.4.4 and `workspace:^`.

## 3b. Module format (ADR-0003: stealth-browser publishes CommonJS-only)

| Package | Root package.json | `exports` | dist | Proof |
|---|---|---|---|---|
| `@adhd/sox-service-proxy` 0.5.0 | no `type` field; `main ./dist/index.js` | `"."`: `types`, `import ./dist/index.js`, `require ./dist/index.js` (one CJS file serves both conditions) | `dist/package.json` `{"type":"commonjs"}`; `"use strict"`, `exports.x`, `require(...)`; engines node>=20 | [CMD, node v24.11.1, run from an unrelated cwd on the extracted tarball] `require("@adhd/sox-service-proxy")` printed `require(name) ok function`, resolved to `dist/index.js`, exit 0; `require(path)` returned 23 exports incl. `serveBackend`/`ensureBackend`/`dialBackend`, exit 0; `import(path)` exposed named `serveBackend`, exit 0 |
| `@adhd/sox-listen-guard` 0.1.1 (transitive) | no `type`; same shape | same (`import`/`require` both `./dist/index.js`) | CJS, node builtins only | loaded transitively by the require above (exit 0) |
| `@adhd/sox-host-runtime` 0.6.3 (considered, not adopted) | same shape | same | CJS; unpacked 929 KB / 124 files | [CMD] `npm view`; `rg` shows `pidAlive`, `killAndVerify`, `findOrphansByIdentity` exported from `src/index.ts:138-147`. Not adopted: `killAndVerify` signals the group only while the main pid lives, but F18 requires a group SIGKILL AFTER the main exits (orphaned Helpers), and the 929 KB supervisor surface is far larger than the two helpers needed |

Bridge: none needed. A CJS TypeScript build uses a plain `import { ensureBackend } from '@adhd/sox-service-proxy'` (compiled to `require`); no dynamic `import()`, no `require(esm)` on the Node >=22.5 floor, no bundling required (keep it external). Bundler caveat [HYP]: if the package's vite build inlines dependencies, mark the sox packages external so `dist/index.js` keeps a `require`; verify with `verify-dist-load` (ADR-0003). Note a side effect: the reaper child process loads the package entry with `require`, which also loads these two modules.


## 4. Options scored per FEATURE (no legacy code/tests counted)

Options: A in-package presence registry + in-package detached reaper with its own lock/spawn code (earlier spec, reshaped); B service-proxy as lifecycle backbone (engine in a proxy-spawned host, clients hold dials, no in-process engine); C hybrid: in-package engine behind `PresenceStore` and `ReaperLauncher` seams with proxy-backed implementations pluggable; D variant: `ensureBackend` spawns and keeps the single in-package reaper which only answers `ping` via `serveBackend`; presence stays per-process records; no long-lived dials.

Legend: P = preserved (same mechanism class); E(tests) = preserved by an equivalent mechanism proven by the cited new feature-level test (ids from section 6); LOST = lost unless the named addition is made.

| Feature | A | B | C | D |
|---|---|---|---|---|
| F1 auto-start | P | LOST when the host cannot start (honest-failure ADR-0020 D5) unless an in-process launch fallback is added (duplicates engine) | P | P |
| F2 10 s CDP bound | P | E(CL2) in host; client sees host timeout | P | P |
| F3 stale-ready self-heal | P | needs re-ensure of host on every ready (E, CL3) | P | P |
| F4 race-free launch | P (CL1) | E: `ensureBackend` serializes host spawn, host serializes Chrome launch; Chrome lock still needed for non-host launchers (CLI/library users) | P | P |
| F5 hide windows once | P (CL4) | P in host | P | P |
| F6 idle timer + re-arm | P (CL5) | E (host timer, clients send bumps) | P | P |
| F7 withBrowser | P | E (RPC) | P | P |
| F8 cross-process coordination | E(CL6) per-process record files replace the shared heartbeat | E(CL6) per-client activity RPC | E(CL6) | E(CL6) |
| F9 livelock protection | E(CL7) by construction (deferral writes nothing) | E(CL7) host is the only decider, no mutual deferral | E(CL7) | E(CL7) |
| F10-F12 page tier | P (CL8) | P in host | P | P |
| F13 history tier + `checkHistory` | P (CL9); policy carried in each client's record (tier on if ANY live client enables it) | E(CL9) policy in `acquire` params | P | P |
| F14-F15 force/soft shutdown | P (CL10) | E: soft = RPC `releaseAndReapIfIdle`; fails if host absent unless fallback | P | P |
| F16-F17 ordered shutdown, reset | P (CL11) | P in host | P | P |
| F18 group kill | P (CL12) | P (host owns the launched pid) | P | P |
| F19 reaper scope (port occupant) | P if D3 keeps it (CL13) | P | P | P |
| F20-F22 isolated pages | P (CL14) | P (client side; CDP direct) | P | P |
| F23 exit-path shutdown | P (CL15) `installProcessExitHooks` | E: exit closes the dial; host reaps on count 0 plus idle. Soft-shutdown-on-crash still needs hooks (CL15) | P | P |
| F24 CLI delayed reaper | E(CL16) out-of-process reaper subsumes it | E host subsumes | E | E |
| F25 sibling diagnostic | E(CL19) `status()` counts live records | E (host count) | E | E |
| F26 best-effort I/O | P | P | P | P |
| N1 kill -9 client | E(CL16): dead-pid detected within a reaper poll (5 s), pid reuse by start-time token; TTL backstop | E(CL16) kernel EOF immediate; strongest | A-grade by default, B-grade when proxy store plugged | A-grade |
| N2 exit within grace of last release | E(CL20) | E(CL20) | E | E |
| N3/N5 stale eviction, bounded backstop | E(CL17) | E (activity semantics) | E | E |
| N4 breaker | E(CL18) | E | E | E |
| N6 one Chrome tree | P (CL1/CL20) | P | P | P |
| Host/reaper killed -9, no client ever returns | residual (bound: next `ready()` adopts) | residual, same | residual | residual |
| Moving parts | 1 reaper process (own lock, own spawn code) | host + UDS RPC protocol + client dial lifecycle | as A (default launcher reused from service-proxy as in D) | 1 reaper process spawned by hardened `ensureBackend`, ping socket |
| Failure if host/launcher unavailable | n/a | Chrome auto-start unavailable (LOST F1) unless fallback | reaper not started: in-process timers keep every feature; `status().reaper=false` | same as C |
| Unit purity | fakes for fs/proc/spawn | `vi.mock` + fake transport; host behavior only in e2e | fakes | `vi.mock` of `ensureBackend`; ping socket e2e only |
| Effort / risk | M / low | L / high (new protocol, 3d5da8f2 exposure, ADR-0022 semantics churn, fallback duplication) | M / low | M+0.5d / low-medium |

Result: B loses F1 (and degrades F14, F23) without an in-process fallback, and with the fallback it contains A. A, C and D lose no feature. Every row that differs between options is a mechanism row (presence, spawn, kill -9 latency), never a policy row.

### What reuse buys, judged on merit
- Launcher (D): replaces about 60 lines of hand-rolled single-instance lock, stale reclaim, detached no-fd-inherit spawn, readiness handshake and child-exit monitoring with the hardened owned implementation (ensure-backend.ts:270-548). Our own memory/DRY rule favors reusing it. Costs on merit: a socket whose only job is a liveness probe; the singleton property is provable only in the e2e lane (unit tests `vi.mock` it); its lock staleness is blind to pid reuse (ensure-backend.ts:286-289), which matters only during the few-second spawn window and is fixed upstream if wanted. Verdict: reuse it.
- Presence (phase 2): a held connection is a kernel-closed death signal, immune to pid reuse, replacing a 5 s poll with immediate EOF. Costs on merit: needs U1, an activity RPC protocol, and per-process long-lived dials (exposure to 3d5da8f2 until U3). The file store already satisfies N1 within one poll, so this is an improvement, not a requirement. Verdict: schedule after U1/U3, behind the existing seam and contract suite (CL22).
- Policy and Chrome access: nothing to reuse; the library has none.

## 5. Recommendation: Option C, with variant D's launcher as default

Evidence that decides it:
1. Policy is 100% in-package under every option (section 4 shows identical policy rows). The proxy can replace only presence and spawn.
2. B is the only option that can lose a feature (F1 when the host cannot start) and its fallback re-creates A. ADR-0020 D5 (no silent fallback) is right for an embedding host and wrong for a browser library that works with no daemon today.
3. The connection-count premise of 19dfb641 is retired upstream (ADR-0022; embedHostMain.ts:199,411). Presence must not pin; activity must. That is already how F6/F8/F9 behave.
4. On the one place the proxy is better in kind (client `kill -9`), the file-based store meets N1 within one reaper poll (5 s) using pid + start-time token; the kernel signal becomes a phase-2 upgrade through the same seam.
5. Reusing `ensureBackend` for the reaper's singleton is better than duplicating it, so the default launcher is the proxy-backed one; its failure degrades gracefully (no feature lost).

## 6. Replacement spec for `chrome-lifecycle` (Option C + D launcher)

Executor `typescript-pro` (sonnet/high). Depends on `cdp-test-harness`, `port-fixes`, `tests-unit-core`, and the dependency install state; blocks `gates-first`, `prod-errors`, `prod-public-api`. Every unit test cites `8468f7b1` and its AC id. Tests are NEW feature-level tests; legacy specs are deleted, not ported.

### 6.1 Owned paths (relative to `entrypoint/stealth-browser/`)
`src/lib/lifecycle/` (new), `src/lib/chrome-manager.ts`, `src/lib/cdp/targets.ts` (ONLY `createIsolatedPageTarget`), `src/test/unit/lifecycle/` (new), `src/test/unit/chrome-manager/`, `src/test/unit/cdp/targets.spec.ts`. Harness additions (`src/test/support/mem-fs.ts`, `fake-proc.ts`, `fake-history.ts`) are owned by `cdp-test-harness`.
Collisions: with ancestors only (allowed): `mig-chrome-manager` (chrome-manager.ts), `mig-cdp` (targets.ts), `tests-unit-core`, `port-fixes`. Cross-owner work this state needs but does NOT own: `src/server.ts`/`src/cli.ts`/`bin/` (surface-hosts) must call `installProcessExitHooks`, map `--idle-shutdown`/`--keep-alive` to `ChromeManager` options and print `status()`; `tests-e2e` owns the real-Chrome and real-reaper-process lane; `scripts/guard.py` lines 625-627, 1504, 2014 assert the old heartbeat path (plan amender must retarget them to the feature tests); `agent-search-cutover` rewires `search-mcp-source.ts`. `package.json` still has `"module": "./dist/index.mjs"` which ADR-0003 D1 forbids (owned by surface-hosts; reported, not changed). Adding `@adhd/sox-service-proxy` to `dependencies` is a `package.json`/lockfile edit owned by the dependency-install state (surface-hosts also owns `package.json`): the plan amender must route it there; no approval is needed (owned package).

### 6.2 Files
| Path | Change |
|---|---|
| `lifecycle/errors.ts` | create `LifecycleError` |
| `lifecycle/presence.ts` | create `PresenceStore` interface, `FilePresenceStore` (one record file per process, atomic write, no shared mutable file), `ProcLike`, `FsLike` |
| `lifecycle/reap-policy.ts` | create pure `decideReap` carrying all three tiers, owned/occupant scope, grace |
| `lifecycle/reaper.ts` | create `runReaper(deps)` (used in-process for soft shutdown and out-of-process), `ReaperLauncher` interface, `runChromeReaper(cfg)` entry for the child process |
| `lifecycle/proxy-launcher.ts` | create `ServiceProxyReaperLauncher` (default `ReaperLauncher`, section 7) |
| `lifecycle/ownership.ts` | create launched-Chrome record `{pid, procStart, port, launchedAt}` (atomic) |
| `lifecycle/launch-breaker.ts` | create |
| `lifecycle/isolated-page.ts` | create `openIsolatedPage`, `withIsolatedPage` |
| `lifecycle/exit-hooks.ts` | create `installProcessExitHooks` |
| `lifecycle/index.ts` | create barrel |
| `chrome-manager.ts` | modify: compose the above; keep class name and methods; remove shared-file heartbeat |
| `cdp/targets.ts` | modify `createIsolatedPageTarget` only: wrap :188-:213 so any throw closes the browser session and disposes any created context |

### 6.3 Interfaces
```ts
// lifecycle/presence.ts
export interface PresenceRecord { id: string; pid: number; procStart: string; startedAt: number;
  lastBeatAt: number; lastActivityAt: number; checkHistory: boolean }
export interface PresenceStore {            // seam: alternates (proxy-backed) must pass the CL23 contract suite
  register(rec: Omit<PresenceRecord,'id'|'lastBeatAt'|'lastActivityAt'>): PresenceHandle;
  list(): PresenceRecord[];                 // live only: dead pid, start-time mismatch (pid reuse) and TTL-expired are evicted
  sweep(): PresenceRecord[];                // evicted ones
}
export interface PresenceHandle { readonly id: string; beat(): void; activity(): void; release(): void }
export class FilePresenceStore implements PresenceStore { constructor(o: { dir: string; ttlMs?: number /*30_000*/; fs?: FsLike; proc?: ProcLike; now?: () => number }) }
// lifecycle/reap-policy.ts
export interface ReapInput { now: number; others: PresenceRecord[]; selfId?: string; idleTimeoutMs: number;
  httpPageCount: number | 'unreachable'; historyRecent: boolean | 'unavailable'; checkHistory: boolean;
  chromeKnownLaunched: boolean; scope: 'launched-only' | 'port-occupant'; lastPinAt: number | null; graceMs: number }
export type ReapDecision = { action: 'keep' | 'wait' | 'reap'; pinnedBy?: 'process' | 'page' | 'history' | 'grace' }
export function decideReap(i: ReapInput): ReapDecision          // pure; defer branches never mutate presence
// lifecycle/reaper.ts
export interface ReaperLauncher { ensure(cfg: ReaperConfig): Promise<'started' | 'already-running' | 'unavailable'> }
export function runReaper(deps: ReaperDeps): { stop(): void; tick(): Promise<ReapDecision> }
// chrome-manager.ts  (BEFORE -> AFTER)
// BEFORE: ChromeManagerOptions { cdpHost?; idleTimeoutMs?; heartbeatPath?; checkHistory?; logger? }
// AFTER:  ChromeManagerOptions { cdpHost?; idleTimeoutMs?=120_000; checkHistory?=true; shutdownGraceMs?=30_000; leaseDir?; leaseTtlMs?=30_000;
//          reaperScope?: 'launched-only'|'port-occupant' (default 'port-occupant' pending D3); reaper?: 'detached'|'in-process-only' (default 'detached');
//          presence?: PresenceStore; launcher?: ReaperLauncher; logger? }
// methods unchanged: ready bump shutdown shutdownIfIdle withBrowser isReady; NEW: release(); status(): Promise<ChromeStatus>
export interface ChromeStatus { ready: boolean; owned: boolean; processes: number; activeProcesses: number; httpPages: number | null; reaper: boolean; breaker: 'closed' | 'open'; siblingWarning: boolean }
// lifecycle/errors.ts
export type LifecycleErrorCode = 'LAUNCH_FAILED' | 'LAUNCH_LOCK_TIMEOUT' | 'CHROME_UNREACHABLE_AFTER_LAUNCH' | 'LAUNCH_CIRCUIT_OPEN' | 'PRESENCE_DIR_INSECURE' | 'REAPER_UNAVAILABLE' | 'ISOLATED_CONTEXT_FAILED'
export class LifecycleError extends Error { readonly code: LifecycleErrorCode; readonly cause?: unknown; readonly detail?: { retryAfterMs?: number; port?: number; path?: string } }
// lifecycle/exit-hooks.ts
export function installProcessExitHooks(m: ChromeManager, o?: { forceExitMs?: number /*5000*/; stdinEof?: boolean; exit?: (code: number) => void }): () => void
// lifecycle/isolated-page.ts
export interface IsolatedPage { page: CdpSession; targetId: string; browserContextId: string; reveal(): Promise<void>; dispose(): Promise<void> }
export function openIsolatedPage(cdpHost: string, o?: { foreground?: boolean }): Promise<IsolatedPage>
export function withIsolatedPage<T>(cdpHost: string, o: { foreground?: boolean } | undefined, fn: (p: IsolatedPage) => Promise<T>): Promise<T>
```
`reaper:'in-process-only'` skips the launcher; it is an explicit constructor option for hosts that must not spawn a process (library embedding), not an environment variable; ADR-0013 is respected.

### 6.4 Behavior
- `ready()`: if previously ready, re-verify reachability (F3); breaker check; `ensureChromeRunning` (lock and 10 s bound unchanged, BR:138-196); on a fresh launch record ownership, hide windows (F5); register presence, start `beat()` every ttl/3 on an unref'd timer; `launcher.ensure()` once per port (failure is non-fatal: `status().reaper=false`, in-process timers still apply).
- `bump()`: `handle.activity()` and re-arm the unref'd idle timer. The ONLY writer of `lastActivityAt`. The deferral branches re-arm the timer and write nothing (F9).
- Idle fire / `shutdownIfIdle()`: `decideReap` over `others` (live, active within `idleTimeoutMs`), page tier (http/https only; unreachable means proceed), history tier (when this or any live process has `checkHistory`; unavailable means proceed), grace. Reap = `closeAllPageTargets` then `killChrome` (group SIGTERM, 5 s, group SIGKILL), each step non-fatal. `shutdown()` bypasses the tiers (F14).
- Scope (F19): `reaperScope:'port-occupant'` keeps today's behavior (recorded owner first; else lsof/fuser/pgid). The out-of-process reaper signals ONLY the recorded pid whose start-time token matches. Decision D3.
- Out-of-process reaper (F24, N1, N5): `node -e` loading the package entry, detached, `stdio ignore`, unref'd; single instance via `ensureBackend` (spawn lock + readiness handshake); the reaper serves `ping` on a socket under `<leaseDir>` and polls the presence dir; ticks every 5 s: `sweep()`, then `decideReap`; exits when Chrome is gone twice or after reaping. Same `decideReap` and same page/history probes as in-process, so there is one policy.
- `FilePresenceStore`: record dir mode 0700, own uid, else `PRESENCE_DIR_INSECURE`; each process writes only its own file (no shared RMW, fixing G4); a reader treats an unparsable file as dead.
- `LaunchBreaker`: 3 failures in 60 s opens for 30 s; success resets; state in a file shared across processes.
- `installProcessExitHooks`: on `exit`, SIGINT, SIGTERM, uncaughtException, unhandledRejection, and (opt-in) stdin end: run `release()` then `shutdownIfIdle()` once, bounded by `forceExitMs`, then exit code 130/143/1 (F23).
- `createIsolatedPageTarget` fix (G1): the browser session is closed in `finally`; if `createTarget` throws after `createBrowserContext` the context is disposed; existing :252 behavior kept.

### 6.5 Acceptance criteria (ticket 8468f7b1 + id); every feature has a pin
| AC | Feature pins | Test (new, unit lane, fakes: MemFs, FakeProc, mocked `node:child_process`, `FakeCdpServer`, fake timers, fake history) |
|---|---|---|
| CL1 | F1 F2 F4 | 8 managers over one MemFs: exactly one spawn; default host 127.0.0.1:9222; CDP never ready within 10 s gives `CHROME_UNREACHABLE_AFTER_LAUNCH`; loser waits bounded; lock older than 15 s reclaimed |
| CL2 | F3 F17 | killed-under-us Chrome: next `ready()` relaunches; after real shutdown a later `ready()` relaunches and a fresh idle timer fires again |
| CL3 | F5 | fresh launch hides windows; fast path does not re-hide |
| CL4 | F6 F7 | `bump()` re-arms (299 ms no fire, 300 ms fire); re-arm after fire; `withBrowser` bumps when `fn` throws; timers unref'd |
| CL5 | F8 | process B bumped within window: A defers; B silent past window: A reaps; B dead or pid reused (start-time mismatch): ignored |
| CL6 | F9 | two idle managers, zero http pages, history off: deferral writes nothing and Chrome is reaped within idle + grace |
| CL7 | F10 F11 F12 | https and http page pin; `chrome://newtab/`, `about:blank`, `devtools://`, `chrome-untrusted://` do not; CDP unreachable proceeds |
| CL8 | F13 | recent visit pins; `checkHistory:false` ignores; history DB error proceeds; default is on; tier on if any live process enables it |
| CL9 | F14 F15 | `shutdown()` ignores tiers; `shutdownIfIdle()` defers to a sibling, to a page, and to history |
| CL10 | F16 | order is close-all-pages then kill; a failing close or kill is logged and the rest runs |
| CL11 | F18 | group SIGTERM, wait, group SIGKILL; falls back to single pid when the group signal fails (FakeProc log) |
| CL12 | F19 | scope `port-occupant`: with no recorded owner the occupant (lsof, then fuser, with pgid) is signalled; with an owner record only the matching pid+start-time is signalled; scope `launched-only` never signals an unrecorded process |
| CL13 | F20 F21 F22 | isolated page: no shared context, background by default, `reveal` unminimizes, `dispose` disposes the context; failure at createBrowserContext, createTarget, window-bounds, connect or target-missing leaves zero open sockets and zero undisposed contexts; `withIsolatedPage` disposes on throw |
| CL14 | F23 | each exit event runs release then soft shutdown once, force-exits after 5 s, codes 130/143/1; stdin end handled when enabled; uninstall removes listeners |
| CL15 | F24 N1 N5 | all clients gone (kill -9: never released): reaper tick reaps within TTL + grace, signals only the recorded pid+start-time, none when the record is missing or mismatched; reaper launch is single-instance (mocked `ensureBackend` dispositions `spawned`/`already-live`/`adopted-after-wait`; real two-process proof in e2e); launcher `unavailable` (incl. `failed`/`E_UDS_DIR_UNSAFE`) leaves `ready()` successful with `status().reaper=false`; the bound statement "next `ready()` of any process adopts or reaps" is tested as a rule, not a promise of every exit path |
| CL16 | N3 | evicts dead, pid-reused and TTL-expired presence; a beating process survives |
| CL17 | N4 | breaker opens after 3 failures, throws `LAUNCH_CIRCUIT_OPEN` with `retryAfterMs` without spawning, closes after cool-off, shared across managers |
| CL18 | F25 | `status().siblingWarning` true at the threshold; never kills |
| CL19 | N2 N6 | N managers share one Chrome; last `release()` then Chrome exits within `shutdownGraceMs` (fake clock) |
| CL20 | typed errors | every `LifecycleErrorCode` reachable with `cause`/`detail` and a one-line message naming the fix |
| CL21 | F26 | presence/ownership write failures never fail a call |
| CL22 | seam | contract suite (`presence-contract.ts`) runs against `FilePresenceStore` and any alternate `PresenceStore`; `ReaperLauncher` fake substitutable |
| CL23 | hygiene | `rg "process\.env" src/lib/lifecycle` empty; no unit test opens a socket or spawns; only owned paths changed (ADR-0009, `[inv:live-chrome]`: nothing touches a real 9222) |

### 6.6 Execution order and prohibitions (for a weaker executor)
Read only: `chrome-manager.ts`, `cdp/browser.ts:130-275`, `cdp/shutdown.ts`, `cdp/targets.ts:150-330`, `storage/history.ts:60-80`. Order: errors, presence (+CL5,16,22), reap-policy (+CL6-9), ownership, launch-breaker, reaper (+CL12,15), isolated-page and targets fix (+CL13), exit-hooks (+CL14), chrome-manager (+rest). NEVER add an env-var toggle; NEVER edit `cdp/browser.ts` (owned by `mig-cdp`; the launch lock and group kill already satisfy F4/F18, only wrap them); NEVER write a file shared by several processes; NEVER let a deferral path write presence.

## 7. `ServiceProxyReaperLauncher` (default launcher) and phase-2 presence
Phase 1 (this state): `lifecycle/proxy-launcher.ts` implements `ReaperLauncher`: `ensureBackend({socketPath: backendSocketPath(socketDir, key), singletonKey: 'stealth-browser-reaper:'+port, command: process.execPath, args: ['-e', 'require(process.argv[1]).runChromeReaper(JSON.parse(process.argv[2]))', distEntry, json], stderrLogPath})`; the child calls `serveBackend({handler: ping})` then `runReaper`. Dispositions `spawned`/`already-live`/`adopted-after-wait` map to started/already-running; `failed` (incl. `errorCode E_UDS_DIR_UNSAFE`) maps to `unavailable`. `socketDir` is a private dir under `leaseDir`; path length handled by `backendSocketPath`. [HYP] `distEntry` resolves from `__filename` of the built entry; needs the e2e proof owned by `tests-e2e`.
Phase 2 (separate state, after U1/U3): `ServiceProxyPresenceStore implements PresenceStore`: the reaper host serves `chrome.activity{clientId}` RPCs and uses connection close (via U1 ids) as immediate presence loss; clients hold one `dialBackend` connection. It must pass the same contract suite (CL22) and the same feature tests.

## 8. Decisions the user must make, with recommendations

D1 Reuse scope. Recommend: reuse `@adhd/sox-service-proxy` now for the reaper launcher (phase 1, section 7) and schedule proxy-backed presence (phase 2) after U1/U3; do not make it the whole backbone (B). Decision: confirm, or direct B/phase 2 immediately (B then requires the in-process fallback anyway).
D2 Presence mechanism: per-process record files (recommended; the shared heartbeat file is a mechanism with lost-update races, G4) vs keep a shared file. Recommend per-process records.
D3 Reaper scope. Today's idle path can close a Chrome it did not launch via lsof (F19, BR:244-274) which is what keeps `--idle-shutdown` working on a Chrome started elsewhere; the brief's "only close a Chrome this system launched" is stricter and would lose that. Recommend default `port-occupant` (feature preserved) with `launched-only` as an explicit option; the NEW out-of-process reaper signals only a recorded pid+start-time (additive). Related open risk 7f881aa7.
D4 Transitional safety (optional, mechanism only): while old agent-browser servers still run until cutover they defer only to the old heartbeat file and kill via lsof (90ed0315 OPERATIONAL note). A ~20-line read-only reader of the old file as one more "other process" input, removed at cutover, prevents the two systems reaping each other. Recommend yes, removable.
D5 Amend 19dfb641 AC4 (propose, do not edit): replace "heartbeat file, IdleShutdown, _doShutdown removed" with "no second lifecycle implementation: one policy function (`decideReap`) is used by both the in-process idle path and the out-of-process reaper; every pre-existing feature is pinned by a feature-level test". Also record that its connection-counted premise was retired by ADR-0022.
D6 Upstream tickets in the owned repo (title/body only, not filed; U1 and U3 gate phase 2, U2 is housekeeping):
- U1 "service-proxy: pass a connection id to BackendHandler and add onClientConnect/onClientDisconnect(id)". Body: `onClientCountChange` (backend.ts:68) is count-only and the handler gets no connection context, so a host cannot attribute a disconnect to a client; add `ctx.connectionId` and per-connection hooks. Needed only if a proxy-backed `PresenceStore` is built.
- U2 "service-proxy housekeeping: close stale 72d980e5 (fixed in 0.5.0, dist/ensure-backend.js:279-299); README says 'node builtins only' but depends on listen-guard; dist/package.json in the 0.5.0 tarball says 0.4.4; ensureBackend lock staleness uses bare kill(pid,0) (ensure-backend.ts:286-289) so a recycled pid keeps a lock alive until the 30 s TTL".
- U3 "service-proxy: dialBackend does not recover a long-lived connection after a backend restart (3d5da8f2)": already filed; needed before any client holds a long-lived dial.
Plan amendments needed (outside owned paths): retarget `guard.py` heartbeat assertions (lines 625-627, 1504, 2014) to the CL ids; surface-hosts to wire `installProcessExitHooks`, `--idle-shutdown/--keep-alive`, `status()` sibling warning; `package.json` `module` field conflicts with ADR-0003.

## 9. Evidence log
Files read: libs/service-proxy README.md, CHANGELOG.md (1-120), package.json, project.json, src/{index,backend,ensure-backend,dial(1-60,grep)}.ts; docs/decisions 0020 and 0022; embedding-provider embedHostMain.ts (1-330, grep 411), funnelClient.ts (grep); worktree src/lib/{chrome-manager (all), cdp/browser (100-275), cdp/shutdown (all), cdp/targets (150-302), storage/history (60-97)}.ts; AB server.mjs 136-262, search-mcp-source.ts 48-58,300-312,368-384, cdp-search.ts 85-86,255-256,590-625, docs/agent-search/lifecycle.md, adhd/docs/chrome-manager.md; adhd ADR-0003, ADR-0009; spec capture-and-lifecycle-spec.md; plan _shared.md invariants.
Commands (exit 0 unless noted): `npm view @adhd/sox-service-proxy --json`; `npm pack` of service-proxy 0.5.0 and listen-guard 0.1.1 into separate scratch dirs, `tar -x`, static `rg` only (no code executed); `adhd-backlog backlog get` on 19dfb641, 90ed0315, 9d963c4e, 9434902c, 3d5da8f2, 72d980e5; `adhd-backlog search` x4; `git show cffee3c`; `diff` of AB vs port chrome-manager; `rg` for armIfIdle, signal handlers in the port. One failed call: `adhd-backlog get <uid>` positional (exit 0 with summary only, fields need `backlog get --input`); `sed -i` without `''` failed once and was redone.
Claims needing proof (HYP): the detached reaper can load the package entry via `node -e` from the built `dist/` (needs an e2e under tests-e2e; alternative is a third bin owned by surface-hosts); 5 s poll is adequate for N1; "kill -9 of the last reaper with no returning client orphans Chrome" has no darwin parent-death mitigation (macOS lacks PR_SET_PDEATHSIG) [INFER].
Module-format commands (exit 0): `node -v` (v24.11.1); `require("@adhd/sox-service-proxy")` via a symlinked node_modules in an unrelated cwd; `require(path)`; `import(path)`; `npm view @adhd/sox-host-runtime version dependencies dist.unpackedSize`. The tarballs are owned packages; they were loaded read-only from the scratchpad; side effects of loading were not audited.
