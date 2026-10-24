# Single-pass lifecycle: service-proxy 0.6.0 + stealth-browser chrome-lifecycle (no interim code)

Run dispatch-2026-10-12-ca18 · plan 8468f7b1-8adc-4237-9986-21ea1e27c537 · agent `architect` (read-only; only this file written).
Labels: [FACT path:line] opened and read; [CMD] command run; [INFER] inference; [HYP] unverified, with the step that proves it.
Supersedes the phase-1/phase-3 split of service-proxy-extension-design.md section 6. Inputs honored: all 26 features F1-F26 kept (user: "features not legacy code & testing"); "no write-it-then-rewrite-it".

## 0. Verdicts and decisions

1. GROUP KILL is NOT a service-proxy feature and not a host-runtime dependency of stealth-browser. It stays in stealth-browser `cdp/browser.ts`, already in its final form there and pinned by `browser.spec.ts:315-446`; the only change is an extract-only export `killProcessGroup(pid)` so the detached reaper can reuse the tracked branch. File host-runtime `killAndVerify` post-exit group sweep as an independent LOW item (section 1.5).
2. PRESENCE needs no lease/presence registry in service-proxy. Presence = one held service-proxy connection per client; liveness = the kernel closing the socket; identity = `ctx.connectionId` (Feature A). The registry is a plain `Map<connectionId, ClientRecord>` inside stealth's own reaper host (section 3). ADR-0022 holds: connections never pin the reaper host (only Chrome liveness and activity do) and a connection with no recent activity pins nothing.
3. 0.6.0 = A (connection identity + hooks), B (pid-reuse-safe process identity + spawn lock), C (work-driven idle retirer), D (circuit-breaker state machine + `BreakerStore`), docs, `externalConsumers`. NO presence/lease primitive, NO group kill, NO file BreakerStore. U3 (3d5da8f2 dial recovery) is NOT a dependency: the presence connection is designed not to rely on `dialBackend` re-dial (section 3.4). It ships whenever its triage lands (0.5.1 or folded into 0.6.0 if ready first).
4. DEV INTEGRATION: stealth declares `"@adhd/sox-service-proxy": "~0.6.0"` from day one (one dependency edit, by new state `sp-link`). Until 0.6.0 is on the registry a root `pnpm.overrides` entry points it at a `pnpm pack` tarball; the switch (`sp-switch`) deletes one override line and re-installs: no source change.
5. The sox work is OFF the stealth critical path as long as the dev tarball lands by the end of round 3 (section 5.1). `chrome-lifecycle` has no DAG edge on the tarball: it checks an in-state precondition just before its first `@adhd/sox-service-proxy` import (step order 3.9), so a late tarball halts and resumes only the tail. Slack is 0 to 1 round, not more.
6. A real-process reaper launch check (`sp-reaper-smoke`, a gate script, not a test lane) runs on the built dist after `prod-errors` and before `gates-first`, because every unit test mocks the package and a wrong entry path would otherwise ship green with auto-reap silently permanently degraded (section 4.2, CL30).

Real decisions for the user (recommendation first):
- D1 Degraded mode when the reaper cannot start (`ensureBackend` returns `failed`, e.g. `E_UDS_DIR_UNSAFE`): recommend FAIL-SAFE DEFER: the idle timer never closes a Chrome (cannot see siblings, so F8/F15 "never close a sibling's Chrome" is preserved), `status().reaper=false`, one warning, retry of `ensure` on the next failure-retry; explicit `shutdown()` still works. Cost: automatic idle reaping is unavailable while degraded (before this change the heartbeat file still reaped). Alternatives: reap on page/history tiers only (violates F8/F15, rejected); keep a permanent file heartbeat fallback (a second presence mechanism, violates N7/no-interim, rejected). Veto only if you consider "auto-reap while the reaper cannot start" a required failsafe.
- D2 Publishing 0.6.0 is public and irreversible; npm login on this machine is `pseudosky` [CMD `npm whoami`, exit 0]. Recommend: dispatcher runs everything up to `release:prepared`, you give an explicit go for the publish. Also approve the cascade: if `changeset version` patch-bumps the `workspace:^` dependents (mcp-runtime, embedding-provider and their chain, section 4.4) those get republished too.
- D3 Test lane exception inside service-proxy only: one loopback-UDS spec and one spawn-and-SIGKILL spec (this lib's existing precedent: ensure-backend.spec.ts spawns real children). Recommend accept; everything else in both repos is pure/mocked.
Decided by me, vetoable: drop CL24 (legacy heartbeat reader: explicitly "removable at cutover" interim code; mitigation is cutover ordering, risk R5).

## 1. Group kill: evidence and verdict

### 1.1 Facts
- service-proxy has NO terminate path. `rg` shows only `process.kill(pid, 0)` liveness at `ensure-backend.ts:239` [FACT]. `ensureBackend` spawns `detached:true, stdio ignore, unref()` (`ensure-backend.ts:480-496`): on POSIX that is setsid, so the child is a session/group leader (pgid == pid) and its non-detached children share that group [FACT code; POSIX semantics].
- Retire/upgrade today lives in apps/sox: `restartProxyBackend` finds the backend by identity token and calls host-runtime `killAndVerify(m.pid, {graceMs:5000})` (`apps/sox/src/main.ts:2979-2989`) [FACT]. `killAndVerify` (`host-runtime/src/reaper.ts:112-138`) with `group` default true signals `-pid` then `pid` with SIGTERM, polls only the MAIN pid, SIGKILLs the group only if the main pid survives the grace, and returns `'already-dead'` without any signal if the main pid is gone even when group members live. So it lacks exactly the Chrome behavior: SIGKILL the group AFTER the main pid exited.
- Which service-proxy backends fork children? Only the embed host: the ONNX worker is forked `detached:false` with an IPC channel (`sharedFastembedProcess.ts:436-470`) and the child disconnects/exits on IPC close (`fastembedProcessHost.ts:556-587` `process.disconnect()` path, plus the embed host comment `embedHostMain.ts:327` "dies with us"). memory-server, mcp-runtime, apps/sox backends import no `child_process` outside tests [CMD rg, exit 0]. So no demonstrated orphan class among service-proxy users.
- macOS/Linux semantics: process groups behave identically; the group id stays addressable while any member lives; after the last member dies the pgid number can be reused (the unconditional post-exit `kill(-pid, SIGKILL)` in the Chrome source has a theoretical reuse exposure inside its 5 s window; not changed here, file as LOW hardening).
- The Chrome source group kill is two different branches (`agent-browser/adhd/cdp-connection/src/browser.ts:221-275`; identical in the port `src/lib/cdp/browser.ts`): tracked launch = SIGTERM group, wait main up to 5 s, SIGKILL group UNCONDITIONALLY (also after main exited); port-occupant (lsof, fuser fallback, `ps -o pgid`) = SIGTERM each pgid, wait up to 25x200 ms, SIGKILL `-pids[0]` ONLY if the listener exited (no SIGKILL on timeout). The guard tests pin both, including that asymmetry: `browser.spec.ts:316-370` (tracked, incl. group-signal fallback to single pid and 5 s give-up then SIGKILL) and `:373-446` (occupant, incl. `:436` "no SIGKILL" after 25 polls) [FACT].

### 1.2 Verdict
Not genuinely useful in service-proxy: the library never terminates anything and no service-proxy backend is shown to leak a group. A shared helper would also have to reproduce two pinned, intentionally different branches and the lsof discovery (Chrome/port specific). Placing it in host-runtime and having stealth depend on it would add a 929 KB supervisor dep ([evaluation 3b]) and still not match the pins. Therefore: it stays in stealth-browser, final form. The kill PRIMITIVES are unchanged. One deliberate, pinned strengthening (CL12): when the reaper holds a VALID owner record (`isSameProcess(pid, procStart)`), it uses the tracked branch (`killProcessGroup`, including the unconditional post-exit group SIGKILL and the SIGKILL after a 5 s timeout) even though today a non-launching process would take the lsof occupant branch (which never SIGKILLs on timeout, `browser.spec.ts:436`). With no valid record, scope `port-occupant` calls `killChrome(port)` unchanged (exact occupant branch); scope `launched-only` signals nothing. This matches the current plan's "recorded owner first, else occupant" rule and never kills a recycled pid.

### 1.3 Leaf-rule answer
Not applicable: nothing is added to service-proxy and service-proxy does not depend on host-runtime. The leaf rule (`index.ts` header: node builtins + listen-guard only) is untouched. (Feature B duplicates ~15 lines of `ps -o lstart` that host-runtime also has, `singleton.ts:206-217`; dedupe is a filed LOW item, D2-of-product recommendation (i) kept.)

### 1.4 The one stealth change (extract-only, ownership collision)
`cdp/browser.ts` is `read_only` for `chrome-lifecycle` today (contexts/chrome-lifecycle.md Reservations). The detached reaper process has no `launchedPid` (module state of the launching process), so `killChrome(port)` inside it would always take the lsof branch. Fix: amend the plan so `chrome-lifecycle` MUTATES `src/lib/cdp/browser.ts` limited to extracting the tracked branch body into `export async function killProcessGroup(pid: number): Promise<void>` and having `killChrome` call it with `launchedPid` (same signals, same order, same 200 ms poll, same 5 s cap, same unconditional group SIGKILL, then `launchedPid = null`). `browser.spec.ts` stays BYTE-IDENTICAL and green (gate). New `process-group.spec.ts` pins that `killProcessGroup(4242)` produces the identical `kill` call log as the tracked test. Ancestors owning the file: `mig-cdp` (complete), `port-fixes` (`src/lib/`), `tests-unit-core` (specs): allowed, listed. A duplicate under `lifecycle/` was rejected (two copies of the pinned kill).

### 1.5 Filed, off critical path
X1 (host-runtime, LOW): `killAndVerify` option `sweepGroup` (SIGKILL `-pid` after the main exits; also act when the main is dead but the group lives). Not used by stealth; no blocking edge. X2 (stealth, LOW): post-exit group SIGKILL pgid-reuse hardening (guard with `isSameProcess` before the post-exit sweep).

## 2. service-proxy 0.6.0 single-pass spec

### 2.1 Presence: why the lease/presence registry is unnecessary (and what it costs)
Requirement (F8): "never close a Chrome another LIVE process used within the idle window; dead processes are ignored" plus N1: kill -9 of a client leaves no Chrome. Design:
- Reaper host (one per port, spawned via `ensureBackend`, already the plan) keeps `Map<connectionId, {pid, checkHistory, lastActivityAt|null}>`.
- Each client holds one connection (dialBackend used as a one-shot connection, section 3.4). On connect it sends `hello{pid, checkHistory}` (registration; NOT activity). `bump()` sends a notification `activity` (the only writer of `lastActivityAt`, stamped with the HOST clock). `release()` sends `release` (unregisters; process may live on).
- Liveness: `onClientDisconnect(connectionId)` removes the record at once; kernel closes a killed process's fds, so kill -9 is detected immediately and pid reuse cannot fake liveness (no pid polling, no start-time compare for presence).
- ADR-0022: `connectionId`/connection count never feed any retire input; the reaper host's retirer (Feature C) is driven by `isBusy = chromeReachable` and by `touch()` on activity; a connected idle client pins nothing (SP19 compile-time test). Presence loss may RELEASE a Chrome (the client's activity stops counting); presence never pins it: a connected client with `lastActivityAt` older than the window is ignored.
- Cost/limit, stated up front: coordination exists only while the reaper host is reachable. When it is not, behavior is decision D1 (fail-safe defer). Checked against features in section 3.5. Conclusion: no registry in service-proxy; the claim holds with D1 explicit.
- `close-on-exec`: the held socket must not leak into Chrome or other children (kernel would then keep the "client" alive). libuv sets CLOEXEC [INFER]; proven by SP-K9 (spawned client with a spawned grandchild, SIGKILL client, disconnect still fires).

### 2.2 API (final signatures; all additive; semver minor 0.5.0 -> 0.6.0)

Feature A, `backend.ts` + new `connection-tracker.ts`
```ts
// BEFORE
export type BackendHandler = (request: JsonRpcRequest) => Promise<JsonRpcResponse | undefined> | JsonRpcResponse | undefined;
// AFTER
export interface ConnectionContext { readonly connectionId: string }   // opaque, unique per accepted connection within one serveBackend, counter-based ("c1","c2"), NOT a secret
export type ClientDisconnectReason = 'end' | 'error' | 'closed-by-backend';
export type BackendHandler = (request: JsonRpcRequest, ctx: ConnectionContext) => Promise<JsonRpcResponse | undefined> | JsonRpcResponse | undefined;
export interface ServeBackendOptions { /* unchanged fields, plus */
  onClientConnect?: (connectionId: string) => void;
  onClientDisconnect?: (connectionId: string, reason: ClientDisconnectReason) => void;
}
```
Order, derived from the CODE (not the sketch) [FACT backend.ts:138-157,225-233,265-275]:
- connect: `sockets.add; notifyClientCount(); tracker.connected(socket)` (count first, then `onClientConnect`).
- socket `close` handler: `decoder.reset(); tracker.disconnected(socket)` (emits `onClientDisconnect` once) THEN the existing `sockets.delete; notifyClientCount()` (disconnect first, then count).
- `handle.close()` is NOT restructured. Before each `s.destroy()` it only calls `tracker.markClosingByBackend(s)`. Existing behavior that must stay byte-identical: own-bind close does `sockets.clear(); opts.onClientCountChange?.(0)` UNGUARDED (a throwing hook rejects the close promise); inherited-fd close does `sockets.clear(); notifyClientCount()` (guarded); then every destroyed socket's async `close` handler emits one more `onClientCountChange(0)` (set already cleared). So `onClientDisconnect(id,'closed-by-backend')` fires per socket from the async close handler, after the sync close-time 0, and `await handle.close()` resolves only after all of them (server.close waits for sockets).
- frame-error path calls `tracker.markError(socket)` before `socket.destroy()`; a socket `error` event marks 'error'; otherwise 'end'. kill -9 of a peer normally yields 'end' (consumers must not rely on telling them apart).
- Hook exceptions: isolated via `diag` (`[service-proxy backend] onClientConnect threw: ...`), never break a connection.
- `onFrame` passes `ctx` as 2nd handler arg (frozen object cached per socket). One-arg handlers type-check and behave as before.
- Own-bind and inherited-fd paths both use the same tracker (separate close implementations, both covered).

Feature B, new `process-identity.ts`, edit `ensure-backend.ts`
```ts
export interface ProcessIdentityDeps { execFileSync?: (cmd: string, args: string[], o: { encoding: 'utf8'; timeout: number; env: NodeJS.ProcessEnv }) => string; pidAlive?: (pid: number) => boolean }
export function readProcessStartToken(pid: number, deps?: ProcessIdentityDeps): string | null   // `ps -o lstart= -p <pid>`, LC_ALL=C, 1000 ms timeout, trimmed, null on any failure/empty/non-POSIX; never throws
export function isSameProcess(pid: number, startToken: string | null | undefined, deps?: ProcessIdentityDeps): boolean
//   pid dead -> false; token null/undefined -> alive-only (0.5.0 behavior); alive + token equal -> true; alive + different -> false; ps failure at check time -> true (fail toward keeping the lock = 0.5.0)
// ensure-backend.ts: interface LockPayload gains `startToken?: string`; EnsureBackendOptions gains `processIdentity?: ProcessIdentityDeps` (tests only)
```
`tryAcquireLock` writes `startToken` (own token read once per process, cached, only on the spawn path); stale predicate becomes `payload===null || !pidAlive(pid) || ttl-exceeded || (payload.startToken !== undefined && !isSameProcess(payload.pid, payload.startToken))`. `ps` is never run on `already-live` or on an uncontended fast path other than the cached self read at spawn. The token format is `ps lstart` text, opaque equality, deliberately identical to host-runtime's input (it parses it to ms; we compare strings).
Consumed by stealth: ownership record `{pid, procStart}` (second in-code user, so B is not speculative).

Feature C, new `idle-retirer.ts`
```ts
export interface RetireStep { readonly name: string; run(): void | Promise<void> }
export type IdleRetirerEvent =
  | { type: 'armed'; dueInMs: number } | { type: 'fired'; reason: 'idle' } | { type: 'retire-begin'; reason: string }
  | { type: 'retire-step-failed'; step: string; error: unknown } | { type: 'retired'; reason: string; durationMs: number };
export interface IdleRetirerOptions { idleWindowMs: number /* NO default */; steps: readonly RetireStep[]; isBusy?: () => boolean; onEvent?: (e: IdleRetirerEvent) => void; now?: () => number; setTimer?: (fn: () => void, ms: number) => { unref(): void; clear(): void } }
export interface IdleRetirer { touch(): void; work<T>(fn: () => Promise<T> | T): Promise<T>; arm(): void; retire(reason: string): Promise<void>; readonly state: 'running' | 'retiring' | 'retired'; dueInMs(): number | null }
export function idleDueInMs(i: { busy: boolean; retiring: boolean; lastWorkAt: number; now: number; idleWindowMs: number }): number | null  // null if busy||retiring else max(0, lastWorkAt+idleWindowMs-now)
export function createIdleRetirer(o: IdleRetirerOptions): IdleRetirer
```
Rules: `touch()`/`work()` settle are the ONLY writers of `lastWorkAt`; the unref'd timer re-evaluates and re-arms WITHOUT writing it (livelock guard); `retire` idempotent, flips state once, holds the loop open with an interval until the last step ends (17a83623 lesson), runs every step even if one throws, no signal handlers, no `process.exit`, no env reads; no connection/presence parameter exists.

Feature D, new `circuit-breaker.ts`
```ts
export interface BreakerState { consecutive: number; recent: number[]; openedAt: number | null; probeStartedAt: number | null }
export interface BreakerStore { load(): BreakerState | null; save(state: BreakerState): void }   // sync, tiny; consumer-supplied
export type BreakerEvent = { type: 'opened'; retryAfterMs: number } | { type: 'half-open' } | { type: 'closed' } | { type: 'store-failed'; error: unknown };
export interface CircuitBreakerOptions { failureThreshold?: number /*3*/; cooldownMs?: number /*30_000*/; windowMs?: number /* omitted = CONSECUTIVE failures */; now?: () => number; store?: BreakerStore /* default in-memory */; onEvent?: (e: BreakerEvent) => void }
export interface CircuitBreaker { check(): { open: false; probe?: true } | { open: true; retryAfterMs: number }; recordSuccess(): void; recordFailure(): void }
export function createCircuitBreaker(o?: CircuitBreakerOptions): CircuitBreaker
```
Half-open: after cooldown exactly one caller gets `{open:false, probe:true}`; others stay open until that probe records a result; `probeStartedAt` expires after `cooldownMs` so a dead prober cannot wedge a shared store. A throwing store degrades to in-memory with `store-failed` (best-effort I/O). Funnel parity configuration: `{failureThreshold:3, cooldownMs:10_000}`, no window. Stealth: `{3, 30_000, windowMs: 60_000}`.

### 2.3 Acceptance criteria (SP ids; U3 SP29-31 are a separate release)
- A: SP1 ctx stable per connection, distinct across; SP2 one-arg handler compiles+runs (type test + untouched specs); SP3 connect/disconnect hooks fire once each in the documented order with correct reason for peer end, socket error, frame error, `handle.close()`; SP4 GOLDEN `onClientCountChange` sequence incl. the sync close-time 0 and the trailing per-socket 0s, own-bind AND inherited-fd, expectations RECORDED by running the pre-change 0.5.0 code first (scenario connect,connect,one disconnect,close with one live; expected shape from reading: `[1,2,1,0,0]`, to be confirmed empirically, not trusted) plus the unguarded-throw behavior of the own-bind close; SP5 throwing hook isolated + diagnostic, other hooks and connection continue; SP6 `E_LIVE_SOCKET` and 448f9d93 specs unmodified green; SP33 `ConnectionContext`/`ClientDisconnectReason` exported; SP-K9 spawned client SIGKILLed (with a spawned grandchild to prove CLOEXEC) produces `onClientDisconnect` within 2 s.
- B: SP7 `readProcessStartToken` table (injected ps: ok, trimmed, empty, throws, timeout, non-POSIX, LC_ALL=C passed); SP8 `isSameProcess` table; SP9 0.5.0 lock (no token) evaluated exactly as before; SP10 alive pid + different token reclaimed immediately (fake clock); SP11 no `ps` on `already-live` or uncontended path except the one cached self read; SP12 any token-read failure leaves dispositions identical to 0.5.0.
- C: SP13 `idleDueInMs` truth table; SP14 fires once at W after last touch/work, unref'd, re-arms after work; SP15 `work` bumps on resolve AND reject, busy while pending, an un-wrapped ping delays nothing; SP16 timer re-arm never writes `lastWorkAt` (two retirers deferring to each other still retire); SP17 retire idempotent, ordered, continues after a throwing step, hold-open cleared after the last step; SP18 five typed events; SP19 no connection/presence field (`@ts-expect-error` spec) and a fixture of 5 permanent idle fake connections still retires at W; SP20 static scan: no process listeners, no `process.exit`, no `process.env`.
- D: SP21 opens after exactly N consecutive failures, `retryAfterMs` counts down; SP22 window mode drops old failures; SP23 half-open one probe, success closes, failure re-opens with fresh cooldown, stale probe expires; SP24 funnel-parity golden table (constants copied, no embed import); SP25 default path touches no fs/net/child_process (static scan) and a throwing store degrades.
- Cross-cutting: SP26 `sox.externalConsumers` lists @adhd/stealth-browser (repo /Users/nix/dev/node/adhd, path entrypoint/stealth-browser) and `node tools/release-consumers.mjs @adhd/sox-service-proxy` exits 0 [baseline CMD: exit 0 today, section 4.4]; SP27 REGRESSION GATE (2.5); SP28 housekeeping: README "node builtins only" corrected, `dist/package.json` version/`workspace:^` mismatch fixed or asserted harmless (SP35), 72d980e5 resolved with evidence (`ensure-backend.ts:321-341`); SP32 docs (README "Lifecycle primitives" with the ADR-0022 rule box, api-stability.md tier note); SP34 export-surface golden: every 0.5.0 export from the published 0.5.0 tarball still exported + exactly the new names; SP35 pack assertion: `pnpm pack` tarball `package.json` has no `workspace:` specifier (listen-guard rewritten) and `require`/`import` of the unpacked tarball from a clean dir load, exit 0.

### 2.4 Unit scenarios simulating real use and how ADR-0009 is respected
Reading of ADR-0009: it is adhd's lane ADR (unit lane: no subprocess, no bound ports to real servers); the sox TEST-STRATEGY.md line 26 says "unit tests mock every library that spawns a process or touches a third-party network". service-proxy lives in sox, whose existing specs already bind UDS and spawn children. Rule applied: put ALL logic in pure modules tested with fakes, and quarantine wiring proofs.
- Pure (no `net`, no spawn, fake timers/clock/EventEmitter sockets): `connection-tracker.spec.ts` (two clients connect, one is destroyed abruptly -> exactly that id disconnects; throwing hook; backend close with three live; reason mapping), `process-identity.spec.ts` + `ensure-backend-stale-lock.spec.ts` (thundering herd of 5 against a stale lock with injected pid/ps/clock and mocked `child_process`; recycled pid; `ps` missing; old-format lock), `idle-retirer.spec.ts` (serve 3 requests then idle; request in flight at the window; failing request resets window; throwing step; host nobody uses retires at W), `circuit-breaker.spec.ts` (3 failed launches then fail-fast without invoking the launcher; cooldown then one probe; two managers sharing a fake store), `index-surface.spec.ts`.
- Quarantined wiring proofs (named so a future lane split is a glob): `connection-identity.loopback.spec.ts` (real UDS in a `mkdtemp` dir, no spawn, no third-party network: `serveBackend` passes ctx and fires hooks on both bind paths, golden count sequence) and `connection-identity.kill9.spec.ts` (spawns one node child, SIGKILL). Decision D3.
- stealth side (section 3.7) is 100% unit: `vi.mock` of the package through the single import site; no sockets, no spawn, ADR-0009 respected without exception.

### 2.5 Existing-consumer regression gate
1. The 15 existing spec files byte-identical to the base commit: `git diff --exit-code 54871159 -- <the 15 paths>` (list captured by INT with `git ls-files libs/service-proxy/src/*.spec.ts` at the base; base = main HEAD at worktree creation) and `nx run service-proxy:test`, `:typecheck`, `:build` exit 0; `rg -c "^\s*(it|test)\(" libs/service-proxy/src --glob '*.spec.ts'` >= 102 + new.
2. Golden `onClientCountChange` (SP4) and export-surface golden (SP34).
3. Consumer matrix (in the monorepo workspace the consumers resolve service-proxy through the workspace link, so their specs run against the NEW source after `nx build service-proxy`): embedding-provider (`embed-funnel.spec.ts`, `68a4bf68-reap-on-work.spec.ts`, `2fadb3cd-inflight-survives-host-death.spec.ts`, `dc73d9b6-2fe52b0f-protocol-v2-host-owned-init.spec.ts`, `17a83623-embed-host-lifecycle-telemetry.spec.ts`), memory-server `backend.spec.ts` (BL-170 E_LIVE_SOCKET), memory-cli `611a711e-scratch-socket-path.spec.ts`, mcp-runtime `transport.spec.ts`, apps/sox `4041c6e0-init-tighten-e2e.spec.ts`, plus a manual `soxe upgrade` respawn scenario on a scratch store [UNOPENED names from product design 4.3; QA resolves nx project names with `pnpm nx show projects`]. Isolated scratch stores only (release-flow section 4).
4. `changeset status --verbose` cascade report (4.4) reviewed.

### 2.6 Buckets (sox-ecosystem worktree), owned paths, executors, order
All paths under `/Users/nix/dev/ai/sox-ecosystem/.worktrees/sp-lifecycle/` (branch `feat/service-proxy-lifecycle-0-6`, created from main 54871159). Explicit-path commits only; tag `[sp-lifecycle:<bucket>]`.
| Bucket | Executor (model) | Owned paths (disjoint) | Depends on |
|---|---|---|---|
| S0 setup | git-manager + backlog-operator (haiku) | worktree; backlog items (4.5) | none |
| A | typescript-pro (sonnet) | `libs/service-proxy/src/{backend.ts, connection-tracker.ts, connection-tracker.spec.ts, backend-count-golden.spec.ts, connection-identity.loopback.spec.ts, connection-identity.kill9.spec.ts}` | S0 |
| B | typescript-pro (sonnet) | `.../src/{ensure-backend.ts, process-identity.ts, process-identity.spec.ts, ensure-backend-stale-lock.spec.ts}` | S0 |
| C | typescript-pro (sonnet) | `.../src/{idle-retirer.ts, idle-retirer.spec.ts}` | S0 |
| D | typescript-pro (sonnet) | `.../src/{circuit-breaker.ts, circuit-breaker.spec.ts}` | S0 |
| INT | typescript-pro (sonnet) | `.../src/{index.ts, index-surface.spec.ts}`, `libs/service-proxy/{package.json, README.md}`, `.changeset/service-proxy-lifecycle.md`, `docs/publishing/api-stability.md`; runs `changeset version`, build, `pnpm pack`, SP35 | A, B, C, D |
| QA | qa (sonnet) | none (reports only; never edits product code) | INT |
| REV | code-reviewer (blind: content only, task "Review") | none | INT |
| REL | devops (sonnet) | none in-tree; runs release steps (4.4) | QA, REV, user go (D2) |
Parallel plan: S0 -> {A,B,C,D} concurrently -> INT -> {QA, REV, and the dev tarball handoff to stealth} -> merge ff-only -> REL. A first action: record the 0.5.0 golden sequences BEFORE editing `backend.ts`. Critical path inside sox: 5 sequential steps (S0, A-D, INT, QA/REV, REL); tarball available after step 3.

## 3. chrome-lifecycle (stealth-browser) built directly on 0.6.0

Package root PKG = `/Users/nix/dev/node/adhd/.worktrees/stealth-browser/entrypoint/stealth-browser/`; paths below are relative to PKG. Executor `typescript-pro` (sonnet/high), as in the current plan.

### 3.1 File-level design (final form)
| Path | Change | Content |
|---|---|---|
| `src/lib/lifecycle/sp.ts` | create | the ONLY import site of `@adhd/sox-service-proxy`: re-exports exactly `ensureBackend, serveBackend, dialBackend, backendSocketPath, ensurePrivateSocketDir, readProcessStartToken, isSameProcess, createIdleRetirer, createCircuitBreaker` and the types used (auditable surface; unit tests `vi.mock` the package once) |
| `lifecycle/errors.ts` | create | `LifecycleError`, six codes (3.6) |
| `lifecycle/state-dir.ts` | create | `resolveStateDir(port, stateDir?)` = `<os.tmpdir()>/stealth-browser-<uid>-<port>` via `ensurePrivateSocketDir(dir,{create:true})` (0700, own uid, not a symlink); unsafe -> `{ok:false}` (becomes degraded mode, never a throw from `ready()`) |
| `lifecycle/page-tier.ts` | create | `isActiveWebTarget` moved here; `chrome-manager.ts` re-exports it (old export kept) |
| `lifecycle/reap-policy.ts` | create | pure `decideReap` carrying all three idle-safety tiers + grace + scope (3.2) |
| `lifecycle/ownership.ts` | create | single-writer launched-Chrome record `<stateDir>/chrome-<port>.json` = `{pid, procStart, port, profileDir, launchedAt}`, atomic rename, written by the launching process after `ensureChromeRunning` returns a non-null pid; `procStart` from `readProcessStartToken`; `isOwnerValid()` uses `isSameProcess` (pid-reuse-safe before any group signal) |
| `lifecycle/launch-breaker.ts` | create | `createCircuitBreaker({failureThreshold:3, windowMs:60_000, cooldownMs:30_000, store: FileBreakerStore})`; `FileBreakerStore` (stealth-owned, atomic rename, best-effort, `<stateDir>/breaker-<port>.json`); `LAUNCH_CIRCUIT_OPEN` with `retryAfterMs` |
| `lifecycle/reaper-host.ts` | create | pure `createReaperHost(deps)` -> `{ handler(req, ctx), onClientConnect, onClientDisconnect, tick(), status() }`: connection map, JSON-RPC methods, calls `decideReap`, performs ordered reap (3.3) |
| `lifecycle/reaper-entry.ts` | create | `runChromeReaper(cfg)`: `serveBackend({handler, onClientConnect, onClientDisconnect})` + `createIdleRetirer({idleWindowMs: cfg.orphanWindowMs, isBusy: () => chromeReachable, steps:[stop ticker, handle.close]})` + 5 s ticker; exported through the package `lifecycle` namespace (prod-errors A3) |
| `lifecycle/reaper-link.ts` | create | stealth-owned `ReaperLink` port + `createProxyReaperLink(cfg)` adapter over `sp.ts` (ensure, dial, hello, activity, release, reapIfIdle, status) |
| `lifecycle/isolated-page.ts` | create | `openIsolatedPage`, `withIsolatedPage` (unchanged design) |
| `lifecycle/exit-hooks.ts` | create | `installProcessExitHooks` (unchanged design) |
| `lifecycle/index.ts` | create | barrel (includes `runChromeReaper`) |
| `src/lib/chrome-manager.ts` | modify | compose the above; keep class and methods; delete heartbeat mechanism |
| `src/lib/cdp/targets.ts` | modify `createIsolatedPageTarget` only | G1 fix: close the browser CdpSession in `finally`, dispose created context on any later throw |
| `src/lib/cdp/browser.ts` | modify EXTRACT-ONLY | `killProcessGroup(pid)` (1.4) |
Files that do not exist and must not be created: any presence/lease store, any shared mutable file, any `process.env` read.

### 3.2 Policy engine that stays in-package (runs in the reaper host and, for force paths, locally)
```ts
export interface ClientView { id: string; pid: number | null; checkHistory: boolean; lastActivityAt: number | null }
export interface ReapInput {
  now: number; clients: ClientView[]; callerId?: string;           // callerId excluded from the client pin check
  idleTimeoutMs: number; graceMs: number;                           // explicit soft shutdown passes graceMs 0 (F15 exact); host tick passes shutdownGraceMs (N2)
  chromeUp: boolean; httpPageCount: number | 'unreachable';        // 'unreachable' => proceed (F12)
  historyRecent: boolean | 'unavailable'; checkHistoryDefault: boolean;  // tier on when ANY connected client enables it, else the reaper default (true)
  scope: 'launched-only' | 'port-occupant'; ownerValid: boolean; lastPinAt: number | null }
export type ReapDecision = { action: 'keep' | 'wait' | 'reap' | 'none'; pinnedBy?: 'client' | 'page' | 'history' | 'grace' }
export function decideReap(i: ReapInput): ReapDecision              // pure; deferral branches never write anything
```
Tier order: (1) another connected client with `lastActivityAt` within `idleTimeoutMs`; (2) http/https page via `isActiveWebTarget` (chrome://newtab, about:, devtools://, chrome-untrusted:// never pin); (3) history within 2 min via `HistoryClient.isRecentlyUsed(2)` when enabled; then grace; then reap. `scope 'launched-only'` with no valid owner record => `none` (never signals); `'port-occupant'` (DEFAULT, F19) => reap via the occupant path. Ban detection (`capture/bans.ts` `checkBans`), isolated pages, hide-windows, CDP launch bound and the `cdp/browser.ts` launch lock (O_EXCL, 15 s stale reclaim) are untouched.

### 3.3 Behavior
- Reaper host JSON-RPC (stealth-owned protocol, framed by service-proxy): `ping` (ensureBackend handshake), `hello{pid,checkHistory}` (register; not activity), `activity` (notification; the only writer of `lastActivityAt`, host clock), `release` (unregister + schedule evaluation), `reapIfIdle{}` (soft: evaluate with graceMs 0 and reap if `reap`), `status` -> `{clients, activeClients, httpPages, chromeUp, ownerValid}` (F25, `status()`).
- Host ordered reap (F16, each step non-fatal, logged): `closeAllPageTargets` (allSettled) -> kill: valid owner record => `killProcessGroup(record.pid)`; else scope `port-occupant` => `killChrome(port)` (launchedPid is null in the host, so the existing lsof/fuser/pgid occupant branch, exact); scope `launched-only` => no kill -> remove record. Host ticks every 5 s: `decideReap` with `graceMs = shutdownGraceMs`. Host retirer: `isBusy = () => chromeReachableCached` (the retirer's `isBusy` is synchronous, so the 5 s ticker performs the async `/json/version` probe and stores the flag; staleness bounded by one tick, `orphanWindowMs` >= 2 ticks); `touch()` on every `activity`; after Chrome is gone the host retires `orphanWindowMs` (default 30 s) later (N5: a host nobody uses must still retire); retire steps: stop ticker, `handle.close()`.
- Client (`ChromeManager`): `ready()`: breaker check -> `ensureChromeRunning` (unchanged lock/10 s bound) -> on fresh launch write ownership + hide windows (F5, never on the fast path) -> if Chrome reachable: `link.ensureAndHello()` (non-fatal). `bump()`: re-arm the unref'd idle timer (CL4 pinned arithmetic untouched) and `link.activity()` (fire-and-forget; reconnect attempt rate-limited to one per 2 s). Idle fire / `shutdownIfIdle()`: `link.release()` is NOT called on idle fire; soft = `link.reapIfIdle()` (3 s timeout) and if the answer is `keep`/`wait` the timer re-arms and NOTHING is written (F9). `shutdown()` (force, F14) is local: `closeAllPageTargets` -> `killChrome(port)` (tracked branch when this process launched it), remove record, `link.release()` best-effort, reset state (F17). `release()` = `link.release()` (the process may live on; its next `ready()` re-registers). `installProcessExitHooks`: release then soft shutdown once, bounded by `forceExitMs` 5000, codes 130/143/1 (F23).
- `LaunchBreaker`: failures = `ensureChromeRunning` rejections and "never reachable after launch"; 3 in 60 s opens 30 s, shared across processes through `FileBreakerStore` (a lost update only under-counts by one; not presence, not a lease).

### 3.4 Presence link rules (decouples from 3d5da8f2 and prevents respawn loops)
1. Each connection is one `dialBackend({socketPath, backoff:{giveUpAfterMs:2000}, onConnect: sendHello, onDisconnect: () => { conn.close(); conn = null }})`: the dial's re-dial/replay is never relied on (U3 irrelevant). Reconnect = a NEW dial created on the next activity (rate-limited 2 s) after a fresh `ensure`. Leak guards (`onDisconnect` fires only for an ESTABLISHED connection): the link holds at most one live dial (`current`); if the `hello` send resolves -32001 (never connected within 2 s) the link calls `conn.close()` and clears `current`, so a late connect cannot register the same pid twice; `release()`/process exit close it.
2. Re-ensure triggers: `ready()`, `bump()`/`withBrowser` settle when the link is down AND Chrome is reachable, and one retry of a previously FAILED ensure on idle fire. NEVER on disconnect. Therefore when the reaper retires while N idle clients stay connected (Chrome gone), no client re-ensures it: pinned by CL29 (`ensure` called zero times).
3. A client whose activity message did not land is invisible to the host. Safety: the host reaps only after `idleTimeoutMs` of silence from every connected client; any live client that calls `bump()` re-registers within one reconnect (<= 2 s) and the page/history tiers cover the rest. Residual: a client whose connection silently fails for longer than the idle window while still genuinely using Chrome (with no open page) could see Chrome reaped; the next `ready()` relaunches (F3 self-heal). Documented, accepted.
4. Reaper host kill -9 with no returning client: Chrome stays until any process calls `ready()` (adopts or reaps); no parent-death signal on darwin [INFER]. Unchanged residual.

### 3.5 Every F1-F26: preserved by which mechanism, pinned by which unit test (CL ids in 3.6)
| F | Mechanism | Pin |
|---|---|---|
| F1 F2 F4 | unchanged `ensureChromeRunning` (O_EXCL lock, 10 s bound, 15 s stale reclaim) in `cdp/browser.ts` | CL1 (+ existing `browser.spec.ts` untouched) |
| F3 F17 | `ready()` re-verify via `/json/version`; state reset after real shutdown | CL2 |
| F5 | hide windows only after a fresh launch | CL3 |
| F6 F7 | client idle timer (`IdleShutdown`, unref'd, re-arm), `withBrowser` bumps on success AND failure | CL4 |
| F8 | tier 1 over connected clients' activity; disconnected clients vanish immediately | CL5 |
| F9 | deferral/tick/`reapIfIdle` never write `lastActivityAt` | CL6 |
| F10 F11 F12 | page tier in host, unreachable => proceed | CL7 |
| F13 | history tier + `checkHistory` (default true, on if any connected client enables) | CL8 |
| F14 F15 | force local; soft = host `reapIfIdle` | CL9 |
| F16 | ordered close-then-kill, non-fatal steps | CL10 |
| F18 | group kill unchanged in `browser.ts`; reaper uses `killProcessGroup` | CL11 |
| F19 | scope default `port-occupant` via lsof; `launched-only` option; owner record pid-reuse-safe | CL12 |
| F20 F21 F22 | `openIsolatedPage`/`withIsolatedPage`, G1 fix | CL13 |
| F23 | exit hooks, 5 s force-exit | CL14 |
| F24 | out-of-process reaper (no detached killer script) | CL15 |
| F25 | `status().siblingWarning` from host `status` (never kills) | CL18 |
| F26 | ownership/breaker/state-dir I/O best-effort | CL21 |
Degraded mode (reaper unavailable or not launchable, decision D1) checked per feature: F1-F5, F7, F10-F13 (evaluated host-side only, so simply not run), F14, F16-F23, F26 unaffected; F6 timer still fires but defers; F8/F15 preserved by deferral; F9 vacuous; F24/N1/N5 (automatic reaping) unavailable while degraded; recorded in CL28.

### 3.6 Replacement acceptance criteria (CL ids) vs current CL1-CL27
| Current | Disposition | New text (delta) |
|---|---|---|
| CL1 launch | KEEP | as is |
| CL2 self-heal/reset | KEEP | as is |
| CL3 hide windows | KEEP | as is |
| CL4 idle timer | KEEP | as is (timer is client-side) |
| CL5 cross-process | REWRITE (feature kept) | `reaper-host.spec.ts`: A defers when B sent `activity` within window; reaps when B silent past it; B's `onClientDisconnect` (kill -9) drops B at once even if B's last activity was 1 s ago. Dropped: dead-pid/pid-reuse/TTL cases (mechanism) |
| CL6 livelock | REWRITE | defer paths, ticks and `reapIfIdle` leave every `lastActivityAt` unchanged; two idle clients, zero pages, history off => reaped within idle+grace |
| CL7 page tier | KEEP | host-side |
| CL8 history tier | KEEP | "any connected client enables" |
| CL9 shutdown modes | KEEP | soft goes through the link |
| CL10 ordered shutdown | KEEP | host and force path |
| CL11 group kill | REWRITE | `browser.spec.ts` byte-identical green AND `process-group.spec.ts` (`killProcessGroup` call log == tracked-branch log) |
| CL12 reaper scope | KEEP + | plus owner record valid only if `isSameProcess(pid, procStart)` |
| CL13 isolated pages | KEEP | as is |
| CL14 exit hooks | KEEP | release + soft via link |
| CL15 out-of-process reaper | REWRITE | `reaper-entry.spec.ts` + `reaper-link.spec.ts` with `vi.mock('@adhd/sox-service-proxy')`: dispositions spawned/already-live/adopted-after-wait => ok, `failed` (incl. `E_UDS_DIR_UNSAFE`) => degraded; hello on connect; activity; kill -9 bound as a rule |
| CL16 presence FilePresenceStore | DROP (mechanism-only) | replaced by CL16' `reaper-registry.spec.ts`: hello registers, activity updates, disconnect and release remove, host restart then next activity re-registers |
| CL17 breaker | KEEP + | built on `createCircuitBreaker` + `FileBreakerStore`; params 3/60 s/30 s; shared across managers |
| CL18 sibling diagnostic | KEEP | from host `status` |
| CL19 grace exit | KEEP | host tick + fake clock |
| CL20 typed errors | REWRITE | six codes: LAUNCH_FAILED, LAUNCH_LOCK_TIMEOUT, CHROME_UNREACHABLE_AFTER_LAUNCH, LAUNCH_CIRCUIT_OPEN, REAPER_UNAVAILABLE, ISOLATED_CONTEXT_FAILED (PRESENCE_DIR_INSECURE dropped: file-store only; `prod-errors` "33 codes" count must be re-derived) |
| CL21 best-effort I/O | KEEP | ownership/breaker/state-dir |
| CL22 seam | REWRITE | one port `ReaperLink` (real adapter + test fake); `lifecycle/sp.ts` is the only importer of the package; no `PresenceStore`, no `ReaperLauncher` |
| CL23 hygiene | KEEP | no `process.env`, no socket/spawn in lifecycle unit specs |
| CL24 legacy heartbeat reader | DROP (interim code) | cutover ordering instead (R5) |
| CL25 B-036..B-039 definitions | KEEP | as is |
| CL26 manager shape | REWRITE | `ChromeManagerOptions { cdpHost?; idleTimeoutMs?=120_000; checkHistory?=true; shutdownGraceMs?=30_000; orphanWindowMs?=30_000; stateDir?; reaperScope?='port-occupant'; link?: ReaperLink; logger? }`; removed: leaseDir, leaseTtlMs, reaper('detached'|'in-process-only'), presence, launcher, legacyHeartbeatPath; methods unchanged + `release()` + `status()` (`ChromeStatus` as before with `reaper:boolean`) |
| CL27 inventory pins | KEEP | as is |
| (new) CL28 | ADD | degraded mode: `ensure` failed or state dir unsafe => `ready()` succeeds, `status().reaper=false`, idle fire never closes Chrome, force `shutdown()` works, exactly one warning |
| (new) CL30 | ADD (gate script, not a unit test) | `sp-reaper-smoke`: built `dist`, scratch `stateDir`, a closed CDP port: `ensureBackend` returns `spawned`; `ping` ok; `hello`, `activity`, `status` answer; the host retires on its own after `orphanWindowMs` (set to 1 s) and the socket is removed. Proves the entry path, the `lifecycle` namespace export and the package externalization on real processes |
| (new) CL29 | ADD | no respawn: reaper retired with N idle connected clients and Chrome down => `ensure` calls == 0; re-ensure only on `ready`/activity-with-Chrome-reachable/failed-retry |
Criteria id range becomes `chrome-lifecycle.1-30` (CL30 is guarded by state `sp-reaper-smoke`; CL15 additionally requires `sp-link` complete). Test files cite `8468f7b1` and the id.

### 3.7 Test lane for stealth (ADR-0009 respected)
Unit lane only: `FakeCdpServer`, MemFs, FakeProc, mocked `node:child_process`, fake timers, `vi.mock('@adhd/sox-service-proxy')`; the host registry is tested by calling `createReaperHost(...).handler(req, {connectionId:'c1'})` and `onClientDisconnect('c1','end')` directly (no sockets). The real two-process kill -9 proof is covered at library level by SP-K9 in service-proxy; a stealth `*.e2e.test.ts` lane stays deferred per the earlier user decision (DEFERRED.md); residual: detached reaper loading built dist (3.9 / P0).

### 3.8 Owned paths and collisions (vs current chrome-lifecycle / surface-hosts / port-fixes ownership)
- `chrome-lifecycle` mutates: `src/lib/lifecycle/`, `src/lib/chrome-manager.ts`, `src/lib/cdp/targets.ts`, `src/lib/cdp/browser.ts` (NEW, extract-only), `src/test/unit/lifecycle/`, `src/test/unit/chrome-manager/`, `src/test/unit/cdp/targets.spec.ts`, `evidence/lifecycle-definitions.md`. `browser.spec.ts` is NOT edited.
- Collisions (all with ancestors, allowed, now listed): `browser.ts` <- mig-cdp, port-fixes; `chrome-manager.ts` <- mig-chrome-manager, port-fixes; `tests-unit-core` owns `src/test/unit/{cdp,chrome-manager}/`.
- Collisions to REMOVE by amendment: `port-fixes.12` currently adds `@adhd/sox-service-proxy ^0.5.0` and runs the install: strip the proxy part (keep store-adapter + `externalizeRealDeps`), because the proxy dependency is now edited exactly once by `sp-link`. `surface-hosts` (owns `package.json`, `src/server.ts`, `src/cli.ts`) keeps wiring `installProcessExitHooks`/`--idle-shutdown`/`--keep-alive`/`status()`; it reads only the stable public shape in CL26. `prod-errors` re-exports the `lifecycle` namespace (A3) and re-derives its code count. `guard.py` heartbeat assertions (lines 625-627, 1504, 2014) retarget to CL ids (A2).
- New states (plan amender): `sp-reaper-load-proof` (P0), `sp-link`, `sp-switch`, `sp-reaper-smoke` (4.2). DAG edges: `sp-link` <- `port-fixes`; `surface-hosts` += `sp-link` (serializes the stealth `package.json`/lockfile owners; check-disjoint would not catch an overlap between concurrent states); `chrome-lifecycle` += `sp-reaper-load-proof` only (the tarball is an in-state precondition before step `sp.ts`, 3.9, enforced by guard CL15 requiring `sp-link` complete); `sp-switch` <- `tracing-plugin`, `chrome-lifecycle`; `sp-reaper-smoke` <- `prod-errors`, `sp-link`; `gates-first` += `sp-switch`, `sp-reaper-smoke`.

### 3.9 Execution order inside chrome-lifecycle (weaker executor; sp-dependent modules last)
Read only: `chrome-manager.ts`, `cdp/browser.ts:130-275`, `cdp/shutdown.ts`, `cdp/targets.ts:150-330`, `storage/history.ts:60-80`, `browser.spec.ts:315-446`. Order: errors, page-tier, reap-policy (+CL5-9 host-side fakes), `browser.ts` extract + process-group.spec (+CL11), isolated-page + targets fix (+CL13), exit-hooks (+CL14), `sp.ts`, state-dir, ownership, launch-breaker (+CL17), reaper-host (+CL5,6,16'), reaper-entry + reaper-link (+CL15,28,29), chrome-manager composition (+CL1-4,19,21,26), definitions (+CL25). Everything before `sp.ts` compiles without the package. PRECONDITION before creating `sp.ts`: `sp-link` is complete (`state.json`) or the executor halts with a partial report and the dispatcher resumes it when `sp-link` completes; a late tarball therefore delays only the tail. NEVER: add an env toggle, write a shared file, let a deferral write activity, edit `browser.spec.ts`.

## 4. Dev/build integration, release, tracking

### 4.1 Consuming the unreleased 0.6.0 in stealth without rewriting anything
- Stealth's manifest is FINAL from day one: `entrypoint/stealth-browser/package.json` `dependencies["@adhd/sox-service-proxy"] = "~0.6.0"` (tilde: patch floats, 0.x minor does not; release-flow section 2). No `file:` ever appears in a published manifest (answers PROD-BREAK-SOXCLI-121 in the root release-script message).
- Until the registry has 0.6.0 the root `package.json` `pnpm.overrides` (the repo already uses this key: `@adhd/sox-store-adapter`, `@tursodatabase/database`) gets one extra entry: `"@adhd/sox-service-proxy": "file:/Users/nix/.cache/adhd-dev-tarballs/adhd-sox-service-proxy-0.6.0-<sha8>.tgz"`. The tarball is built by INT: `pnpm nx build service-proxy`, then `pnpm pack` in `libs/service-proxy` (NOT `npm pack`: `pnpm pack` rewrites `workspace:^` to a real `@adhd/sox-listen-guard` range; `npm pack` on source would leave a literal `workspace:^`), copied to the cache dir with the sha in the name (a new sha forces re-fetch). INT asserts SP35 on the tarball's `package.json`. Because INT runs `changeset version` last, the dev tarball IS the 0.6.0 artifact (version 0.6.0).
- [HYP] pnpm 8.15.9 accepts a `file:` tarball as an override value in a hoisted workspace; proven by `sp-link` step 1 in a scratch copy of the root manifest; fallback if rejected: put the same `file:` spec as the dependency value in the stealth manifest (still one line to change at the switch, no source change).
- SWITCH (exact step, no code change): `sp-switch`: precondition `npm view @adhd/sox-service-proxy@0.6.0 version` exits 0; delete the override entry; `pnpm install`; assert `rg "file:" package.json entrypoint/stealth-browser/package.json` empty, the lockfile entry for the package resolves to the registry, `git diff --stat -- entrypoint/stealth-browser/src` empty, `nx run stealth-browser:build` and `:test -- src/test/unit/lifecycle` exit 0. If 0.6.0 is already published when `sp-link` runs, `sp-link` skips the override and `sp-switch` is a verification-only no-op.
- Guard (gates-first and merge-readiness): no `file:`/`link:` specifier for any `@adhd/*` package in either manifest; lockfile resolves service-proxy from the registry.

### 4.2 New/changed stealth states (for the plan amender)
| State | Executor | Owned paths | Depends on |
|---|---|---|---|
| `sp-reaper-load-proof` (P0, run now) | typescript-pro (sonnet) | `docs/plan/stealth-browser/evidence/reaper-load-proof.md` + scratch only | none |
| `sp-link` | devops-engineer (sonnet) | `entrypoint/stealth-browser/package.json` (one dependency line), root `package.json` (`pnpm.overrides` entry), `pnpm-lock.yaml` | `port-fixes`, sox INT tarball |
| `chrome-lifecycle` (amended) | typescript-pro (sonnet/high) | section 3.8 | `cdp-test-harness`, `port-fixes`, `tests-unit-core`, `sp-reaper-load-proof` (+ in-state precondition: `sp-link` complete before `sp.ts`) |
| `sp-switch` | devops-engineer (sonnet) | root `package.json` (override entry), `pnpm-lock.yaml` | `chrome-lifecycle`, `tracing-plugin` (serializes the lockfile/package.json owners), sox release |
| `sp-reaper-smoke` | qa (sonnet) | `docs/plan/stealth-browser/scripts/reaper-smoke.mjs`, `docs/plan/stealth-browser/evidence/reaper-smoke.md` (gate script, runs as a guard; scratch dirs only; never touches port 9222) | `prod-errors`, `sp-link` |
`sp-reaper-load-proof` proves the riskiest unproven assumption (the detached reaper entry): `nx build stealth-browser`; from an unrelated cwd run `node -e "const m=require(process.argv[1]); console.log(typeof m)" <abs>/dist/index.js` (loads in a fresh CJS process with no top-level side effect: no CDP connection, no timers left, exit 0 on its own); then the exact spawn form `process.execPath ['-e', 'require(process.argv[1]).lifecycle.runChromeReaper(JSON.parse(process.argv[2]))', <abs dist/index.js>, <json>]` against a STUB `lifecycle.runChromeReaper` that prints and exits (adds only the namespace export in scratch). Failure forces the alternative (a `bin` entry owned by `surface-hosts`) BEFORE chrome-lifecycle is written; success pins the form used in `reaper-link.ts`. Flag: the bundler must keep `@adhd/sox-service-proxy` external (`externalizeRealDeps`).
`sp-link` amendment text for `port-fixes.12`: dependencies = store-adapter only (+ `externalizeRealDeps`); the proxy part moves to `sp-link`, where the "dist keeps a `require` of the package, not an inlined copy" check also lives.

### 4.3 sox-ecosystem worktree and branch
- Repo state [CMD `git status --short`, `git branch --show-current`]: branch `main` at `54871159`, tracked tree clean; two untracked entries only (`.opencode/artifacts/reports/f351a745-c8e5a575_implement_20261004T184314Z.json`, `.opencode/artifacts/research-skill/`) that are other agents' artifacts: never staged. Dozens of other worktrees exist under `.worktrees/` and `.claude/worktrees/` (`git worktree list`): another agent may merge to main at any time.
- Create (git-manager): `git worktree add /Users/nix/dev/ai/sox-ecosystem/.worktrees/sp-lifecycle -b feat/service-proxy-lifecycle-0-6 54871159`; `pnpm install --frozen-lockfile` inside it [HYP duration]. Explicit-path commits only (`git add <path>`; never `-A`, `.`, `-a`), message tag `[sp-lifecycle:<bucket>]`, no AI attribution lines in commit messages (user rule). Merge ff-only to main by the dispatcher after QA+REV; rebase the branch onto the current main first.
- Release runs from a SECOND clean worktree of main (`.worktrees/release-sp`) so `assert-release-tree-clean` is not defeated by other agents' untracked files.

### 4.4 Release sequence (from `docs/publishing/release-flow.md` and root `package.json` scripts; nothing run)
1. INT: write `.changeset/service-proxy-lifecycle.md` (`'@adhd/sox-service-proxy': minor`). Run `pnpm changeset status --verbose` (read-only) and report the cascade: `.changeset/config.json` has `updateInternalDependencies: "patch"`; dependents are `workspace:^` (mcp-runtime, embedding-provider -> memory-core, claim-verification, semantic, hybrid-search -> external @adhd/backlog [CMD `release-consumers.mjs @adhd/sox-service-proxy`]) and `workspace:*` (apps/sox, memory-cli, memory-server: source specifiers [FACT rg of package.json]). That they stay frozen at 0.5.0 is [HYP]: `release-consumers.mjs` printed no row for them and I did not open why (private package, devDependency, or bundled), and `release:prepared` runs `nx build sox`, so a republished sox-cli/memory-server could carry Feature B's lock change into `soxe upgrade` in this release. INT must answer "why are they not listed" (read their manifests) together with the cascade report BEFORE the regression story relies on it. Whether `changeset version` patch-bumps the `workspace:^` dependents is [HYP]; if it does they are republished onto 0.6.0 and the consumer matrix is a HARD gate, decision D2. Only then `pnpm changeset version` (version 0.6.0 + CHANGELOG), commit, build, pack.
2. `node tools/release-consumers.mjs @adhd/sox-service-proxy` must exit 0 and list stealth-browser (SP26). Baseline [CMD]: today `node tools/release-consumers.mjs` (all packages) exits 0; the tool exits 1 on any non-floating internal edge, which would block `release:prepared`.
3. QA matrix and REV pass; user go (D2).
4. In `.worktrees/release-sp`: `node tools/assert-release-tree-clean.mjs`; confirm `ls .changeset` holds no unrelated pending changesets (changeset publish publishes EVERYTHING unpublished); `pnpm release:prepared` (`pnpm release` is disabled: it exits 1). Who: devops executor on dispatcher instruction after the user's go; npm session is `pseudosky` [CMD `npm whoami`, exit 0]; OTP [HYP].
5. Verify the artifact and the running behavior (release-flow section 5): `npm view @adhd/sox-service-proxy@0.6.0` exit 0; fresh scratch install, SP34 export check against the registry tarball; later the stealth lifecycle unit suite on the registry build (sp-switch).
6. Follow-up bump items (release-flow section 3), filed not built: embed host -> C, funnel -> D, 9d963c4e -> B. api-stability.md: promote service-proxy to Tier 2 and mark A-D "experimental until 1.0" (INT).
Finding for the dispatcher: ADR-0001 D3 states releases use `nx release` (retire Changesets) but the live repo scripts and release-flow.md use changesets; this spec follows release-flow.md.

### 4.5 Tracking in sox (minimal ceremony)
Backlog items only, no plan dir (project a1e8f31c-8fa2-42ff-9a2e-9842b18e09bd; components 0d6556a3 ensure-backend, 4efc7e77 shim/upgrade). Via backlog-operator after dedupe by symbol (`onClientCountChange`, `connectionId`, `pidAlive`, `createIdleRetirer`, `createCircuitBreaker`): EPIC "service-proxy 0.6.0 lifecycle primitives"; children A, B, C, D, INT, REL (part_of EPIC; INT blocked_by A-D; REL blocked_by INT, QA, REV); cross-repo: stealth `chrome-lifecycle` item blocked_by INT (by title). Existing: 3d5da8f2 enrich (independent of this release, not a blocker), 72d980e5 resolve with `ensure-backend.ts:321-341` + `ensure-backend-await-survives.spec.ts` green on main, 9d963c4e relate to B, 19dfb641 AC4 per this design (one `decideReap` used by host tick, soft path and force path; no second implementation; connection-counted premise retired by ADR-0022); new LOW X1 (host-runtime `killAndVerify` sweepGroup), X2 (post-exit pgid-reuse hardening), DEDUPE (`ps lstart` helper duplicated in host-runtime). Every item carries a Citations block.

### 4.6 Which stealth states depend on the tarball (dispatcher hold list)
- Hard dependency on the tarball (or 0.6.0 on the registry): `sp-link` only. `chrome-lifecycle` depends on it through the in-state precondition at step `sp.ts` (3.9): dispatch it normally once `cdp-test-harness`, `port-fixes`, `tests-unit-core`, `sp-reaper-load-proof` are complete; if `sp-link` is not complete when the executor reaches `sp.ts` it halts with a partial report and is resumed. `surface-hosts` and `sp-reaper-smoke` wait for `sp-link` through DAG edges (3.8).
- Descendants of `chrome-lifecycle` (20 states [CMD DAG]: surface-hosts, tracing-plugin, tracing-namespace-proof, tests-unit-surface, prod-errors, prod-examples, tests-use-cases, agent-search-cutover, agent-search-relink, audit-pre-review, audit-fixes, gates-first, review-prep, audit-migration-blind, resolve-findings, gates-rerun, docs-marketing-run, readme-rewrite, audit-final, merge-readiness) are held only through it.
- Run NOW, no dependency on sox: failsafe-inventory (in progress), port-fixes (amended), cdp-test-harness, tests-unit-core, tests-unit-data, tests-unit-extract, capture-upgrade, surface-api, sp-reaper-load-proof (non-descendants of chrome-lifecycle [CMD DAG]; surface-api is pending and independent).

## 5. Shortest end-to-end critical path (both repos) and risks

### 5.1 Steps (one round = one dispatch round; items on a line run concurrently)
R1 (NOW): [plan amender: amend port-fixes.12, add sp-reaper-load-proof/sp-link/sp-switch/sp-reaper-smoke and their edges, rewrite the chrome-lifecycle context to CL1-CL30, browser.ts ownership, prod-errors code count, guard.py A2] ∥ [sox S0: worktree + backlog items] ∥ [sp-reaper-load-proof] ∥ [stealth: failsafe-inventory (running), surface-api, tests-unit-data, tests-unit-extract, capture-upgrade as their deps allow].
R2: sox A ∥ B ∥ C ∥ D (4 executors, disjoint files) ∥ stealth `port-fixes`.
R3: sox INT (barrel, docs, changeset, cascade report, version, build, `pnpm pack`, SP35) -> tarball in `~/.cache/adhd-dev-tarballs/` ∥ stealth `cdp-test-harness` ∥ `tests-unit-core`.
R4: sox QA ∥ REV ∥ stealth `sp-link` (needs tarball + port-fixes) ∥ stealth `chrome-lifecycle` starts (steps before `sp.ts` need nothing from sox).
R5: sox: merge ff-only, user go (D2), REL publish 0.6.0 ∥ stealth `chrome-lifecycle` finishes (resumes at `sp.ts` if it halted).
R6+: stealth chain `surface-hosts` -> `tracing-plugin` -> `prod-errors` -> (`prod-examples` -> `tests-use-cases` -> `agent-search-cutover` -> `audit-pre-review` -> `audit-fixes`) ∥ `sp-switch` (after tracing-plugin; needs the registry) ∥ `sp-reaper-smoke` (after prod-errors) -> `gates-first` -> `review-prep` -> `audit-migration-blind` -> `resolve-findings` -> `gates-rerun` -> `docs-marketing-run` -> `readme-rewrite` -> `audit-final` -> `merge-readiness`.
Longest stealth chain from dag.json with the new states inserted [CMD python, exit 0]: `port-fixes -> cdp-test-harness -> chrome-lifecycle -> surface-hosts -> tracing-plugin -> prod-errors -> prod-examples -> tests-use-cases -> agent-search-cutover -> audit-pre-review -> audit-fixes -> gates-first -> review-prep -> audit-migration-blind -> resolve-findings -> gates-rerun -> docs-marketing-run -> readme-rewrite -> audit-final -> merge-readiness` = 20 pending states, plus `failsafe-inventory` (in progress) in front. `sp-link`, `sp-switch`, `sp-reaper-smoke`, `sp-reaper-load-proof` are all parallel to that chain, so the critical path stays about 20-21 rounds. The sox side is 5 rounds; the tarball must exist by the end of R3 (when `chrome-lifecycle` starts in R4 and reaches `sp.ts` mid-state): slack is 0 to 1 round, and a slip costs at most the tail of one state, never a DAG round, because the dependency is an in-state precondition.

### 5.2 Risks
- R1 Degraded-mode regression (D1): auto-reap unavailable while the reaper cannot start. Mitigated by loud status, retry rule, force `shutdown()`.
- R2 Tarball slip: only `sp-link` and `chrome-lifecycle` steps from `sp.ts` onward wait; everything earlier in chrome-lifecycle (3.9) proceeds.
- R3 Changeset cascade (4.4): unexpected republish of dependents; hard QA gate + D2.
- R4 Detached reaper cannot load built dist (P0 proof first; alternative `bin` entry owned by surface-hosts).
- R5 Cutover coexistence: after CL24 is dropped, old agent-browser servers (heartbeat file, lsof kill) and new stealth processes do not see each other; mitigation is ordering: `agent-search-cutover` replaces old servers, no overlap window longer than one dev session; veto and restore a read-only reader if you run both concurrently.
- R6 Golden sequence wrong if transcribed from reading: SP4 must be recorded from the unmodified code first (executor A step 1).
- R7 Held-connection hazards: a silently failed activity path (3.4 item 3), CLOEXEC leak (SP-K9), reaper host kill -9 (unchanged residual).
- R8 `pnpm` versions differ (sox pnpm 10.11.1, adhd pnpm 8.15.9): tarball built with 10 is consumed by 8; the `file:` override acceptance is [HYP] until `sp-link` step 1.
- R10 Silent permanent degraded mode if the real reaper entry is wrong: unit tests mock the package, so only CL30 (`sp-reaper-smoke`, real processes on built dist) catches it; if you reject the smoke gate, treat that failure mode as decision D4.
- R9 3d5da8f2 remains open and separate: any other long-lived `dialBackend` consumer is unaffected by this release.

## 6. Evidence and claims needing proof
Files read: the three input specs (all lines of the evaluation and product design; capture-and-lifecycle-spec.md all); `libs/service-proxy/{package.json, project.json, vitest.config.ts, src/index.ts 1-73, src/backend.ts 28-335, src/dial.ts 1-420 excerpts, src/ensure-backend.ts 225-300, spec heads}`; `libs/host-runtime/src/{reaper.ts 1-150, singleton.ts 195-230}`; `apps/sox/src/main.ts 2905-3055`; `agent-browser/adhd/cdp-connection/src/browser.ts 100-275`; stealth `src/test/unit/cdp/browser.spec.ts 290-446`, `docs/plan/stealth-browser/contexts/chrome-lifecycle.md 20-94`, `dag.json`, `state.json`, `scripts/ownership.json`, `docs/decisions/0009-*.md`; sox `docs/publishing/release-flow.md`, `tools/release-consumers.mjs 1-230`, ADR-0001/0005/0013/0020/0022 heads, `docs/TEST-STRATEGY.md` lines 13-30, `.changeset/config.json`, root `package.json` scripts.
Commands (exit 0 unless noted): `git status --short`, `git branch`, `git worktree list`, `git log` in sox; `rg` for child_process/detached/pgid/killAndVerify; `adhd-backlog backlog get 3d5da8f2`; `node tools/release-consumers.mjs @adhd/sox-service-proxy` (printed consumers, exit status of the pipeline not captured) and `node tools/release-consumers.mjs` (all-exit=0); `npm whoami` (pseudosky); python DAG analysis (descendants and longest path). No code executed in either product repo; nothing written outside this file.
Claims needing proof (HYP): (1) golden onClientCountChange shapes (SP4, executor A step 1); (2) libuv CLOEXEC on the held socket (SP-K9); (3) pnpm 8.15.9 `file:` override acceptance (sp-link step 1); (4) detached reaper loading built dist via `node -e` (P0); (5) `changeset version` cascade behavior (INT step 1); (6) whether `release:prepared` needs an OTP; (7) Linux `ps -o lstart=` token equality across locales (LC_ALL=C passed; SP7); (8) that `workspace:*` consumers stay frozen at 0.5.0 and whether the changeset cascade reaches sox-cli/memory-server (INT answers, 4.4); (9) the real reaper launch path on built dist (CL30); (10) consumer spec file names for memory-cli/mcp-runtime/apps-sox are from the product design (UNOPENED here).
Note: the single-package `release-consumers.mjs @adhd/sox-service-proxy` exit status was not captured (the pipeline swallowed it); the all-package run exited 0.
Remaining: none of the five asks is unanswered; the plan-file rewrites (chrome-lifecycle context, dag.json, criteria, guard.py) are amender work, specified in 3.6/3.8/4.2.
