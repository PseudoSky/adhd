# Tripwire package: implementation specification

Dispatch dispatch-2026-10-12-ca18, plan/ticket 8468f7b1-8adc-4237-9986-21ea1e27c537. Author: architect (read-only; nothing was run, nothing was edited except this file).
Reading of the request: ONE package serving the three consumers (reverse request-builder gate, reverse unlock tool, agent-search tripwire). The other plausible reading (the three FOLLOWUP options: stay / extract now / build on service-proxy BreakerStore) is answered inside: extract now, independent of the proxy.

Evidence base (all read): adhd worktree `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` (HEAD 097412a5, branch stealth-browser, 1 dirty file: events.ndjson); reverse-apis `/Users/nix/dev/projects/reverse-apis` (main, d959c6a); agent-browser `/Users/nix/dev/ai/scratch/agent-browser`. Citation form `file:line`; search-tripwire.ts = `ST`, reverse tripwire.ts = `RT`, send.ts = `SEND`, unlock-tripwire.ts = `UT` (paths in section 1).

## 0. Verdict in brief

1. Build `@adhd/resilience-core-tripwire` (tier core, new domain `resilience`, access public, publish true, CJS-only per ADR-0003, ZERO runtime dependencies, no `@adhd/environment` dependency, no service-proxy dependency). Path/dir config is injected (`stateDir`, `auditPath`); a pure helper resolves `ADHD_HOME`.
2. It is a latch, not a breaker: first trip wins, stays tripped until a human (or an explicitly open policy) clears it, forensic record + audit trail. Service-proxy feature D (`createCircuitBreaker`, `BreakerState {consecutive, recent, openedAt, probeStartedAt}`) auto half-opens after a cooldown; a tripwire must never auto-retry (REARCHITECTURE 12.9). Evidence: single-pass-lifecycle-spec.md lines 101-108. Do not build on D; consequence: no wait on service-proxy 0.6.0.
3. Both policies seen in the wild become typed per-instance policy, safe by default: `expiry` (absent = never; agent-search passes 2 h) and `clearPolicy` (`'confirm-token'` default; agent-search passes `'open'`).
4. Library-only. CLIs stay in consumers (one package approved; repo rule: CLIs live in `entrypoint/`). The package exports in-process command functions with injected IO so every CLI/HITL behavior is unit-testable without spawning (ADR-0009).
5. agent-search consumes it inside the existing `agent-search-cutover` state (same pass, nothing written twice). reverse-apis migrates in a new state in its own worktree.
6. Needs user decisions: domain approval (D1) and ADR-0001 classification confirmation (D2); section 6.

## 1. FEATURE INVENTORY (preserve every feature and failsafe; legacy names/paths are not constraints)

Files: ST=`/Users/nix/dev/ai/scratch/agent-browser/search-tripwire.ts` (284 lines); RT=`/Users/nix/dev/projects/reverse-apis/packages/system/request-builder/src/lib/tripwire.ts` (82); SEND=`.../request-builder/src/lib/send.ts`; TYPES=`.../request-builder/src/lib/types.ts`; UT=`/Users/nix/dev/projects/reverse-apis/tools/unlock-tripwire/unlock-tripwire.ts` (117); CS=`agent-browser/cdp-search.ts`; MCP=`agent-browser/search-mcp-source.ts`; SG=`agent-browser/search-guard.ts`; SPEC=`reverse-apis/REARCHITECTURE.md` section 12 (lines 563-715; intended design, partly unimplemented).

### 1.1 Features and how the unified package carries each

| # | Feature / failsafe | Where (file:line) | Unified treatment |
|---|---|---|---|
| F1 | One lock file per key (client/provider); presence = tripped; JSON forensic inside | ST:96-98,102-109; RT:33-35,37-44; RT doc 1-7 | Keep: `<stateDir>/tripwire/<key>.lock`; layout identical to both existing ones so live locks survive (TW4) |
| F2 | Atomic write via tmp+rename | ST:111-118; RT:46-52 | Keep, FIX: tmp name is a fixed `<lock>.tmp` in both, so two processes collide. Unique tmp (`pid.rand`) (TW2) |
| F3 | Pre-network gate; blocked calls do zero IO | SEND:88-98; MCP:250-255; CS:269-311 | Keep as `gate`/`assertOpen`; order contract: tripwire is evaluated BEFORE sequencing, pacing, cooldown, concurrency (SEND:88 then 100,106; MCP:250 then cooldown 261 then semaphore 280) |
| F4 | Trip reasons: reverse `http-4xx` (any 4xx, 400-499 inclusive, 5xx never trips); search `captcha|banned|rate_limited|login_required` (ban signals) | SEND:189-209; ST:27; HITL types | `reason: string`; exported `KnownTripReason` union as documentation only; the 4xx classification stays in request-builder (package has no HTTP knowledge) |
| F5 | Forensic fields | reverse: reason, trippedAt, lastStatus, lastOperationId (TYPES:53-58). search: reason, provider, query, searchSessionId, browserSessionId, pageUrl, strategy, trippedAt, reverifiedAt, resolvedAt, blockedCount, lastOperation (ST:26-44) | Unified record = common core (key, namespace, reason, trippedAt, trippedBy{pid, sessionId}, blockedCount, priorClear) + typed `context` carrying consumer fields (TW8). Legacy flat shapes are readable (TW4) |
| F6 | Typed error with client/reason/trippedAt/forensic; adapters read `responseStatus`/`responseBody` through unsafe casts | RT:14-25; SEND:196-205; adapters tinder/bumble/airbnb/rappi `auth-config.ts` (`instanceof TripwireTrippedError`, `(e as ...).responseStatus`, tinder:25-27) | `TripwireTrippedError` with stable `code`, brand, typed in-memory `responseStatus`/`responseBody` (never persisted) (TW10, TW32, TW33) |
| F7 | TTL: a lock older than TTL no longer gates, is lazily removed on gate (search only). Default 2 h, env `SEARCH_TRIPWIRE_TTL_MS` read at call time | ST:88-94,124-129,146-154; search-guard-test.ts:112-119 | Typed `expiry?: {ttlMs}`; absent = never expires (reverse semantics, the safe default). Removal now audited (it is silent today) (TW13) |
| F8 | blockedCount incremented per gated attempt; audited as `tripwire-gate-blocked` | ST:157-162,249-259; CS:272; MCP:252; search-guard-test.ts:109 asserts count == 1 | Keep, for reverse too (SPEC 12.3 `blockedAttempts`). FIX: read-modify-write loses increments and can resurrect a just-cleared lock. Use an O_APPEND sidecar `<key>.blocked` (size = count) (TW11, TW12) |
| F9 | `reverifiedAt` / `resolvedAt` fields | ST:164-179,273-284; CS:446,306,462 | Dead writes today: each is written then the lock is unlinked on the next line, so no reader can ever observe them. Preserve the INFORMATION in the `tripwire-cleared` (reverified flag) and `tripwire-resolved` (trippedAt, durationMs, blockedCount) audit events; drop the dead lock write (TW18). Deliberate, flagged change |
| F10 | Audit log: NDJSON, events `tripwire-fired`, `tripwire-gate-blocked`, `tripwire-cleared`, `tripwire-resolved`; fields ts, event, provider, searchSessionId, browserSessionId?, reason?, blockedCount?, pageUrl? (no query text, by design) | ST:46-61,206-284; live file: 223 lines, keys `event ts provider searchSessionId browserSessionId reason pageUrl blockedCount`, events 155 fired / 63 blocked / 5 cleared (key names only read) | Keep all four events + add `tripwire-expired`, `tripwire-retripped`; field `provider` becomes `key` (+ `namespace`); never log the query; reverse finally writes the log SPEC 12.6 promised and never implemented (TW19) |
| F11 | Audit cap: 5 MB (`SEARCH_AUDIT_MAX_SIZE`), on exceed keep newest ~50% from a line boundary | ST:65,187-204 | Keep (`maxAuditBytes`, 5 MiB default, byte-accurate). FIX: non-atomic whole-file rewrite drops concurrent appends and splits multibyte chars (`content.length` is chars); write unique tmp + rename (TW20) |
| F12 | Best-effort audit: failures never break the gate | ST:206-212 | Keep + surface via `onWarning` (TW22) |
| F13 | Audit path/default dir | ST:66,183-185 | FIX: dir creation uses `homedir()` regardless of `SEARCH_AUDIT_PATH`; `AUDIT_PATH` is a module constant that ignores `SEARCH_ADHD_DATA_DIR`, so search-guard-test.ts writes to the REAL audit.log (found: ST:66 vs ST:74-76). Default `auditPath = <stateDir>/audit.log`, dir from `dirname(auditPath)` (TW21) |
| F14 | Data root override for tests (`SEARCH_ADHD_DATA_DIR`), `ADHD_HOME`/`ADHD_REVERSE_HOME` for reverse | ST:68-76; RT:27-31; e2e harness `readTripwireLock` (harness.ts:353-366) isolates via `ADHD_HOME` in an MCP subprocess | Package takes `stateDir`; `adhdDataDir(...segments)` helper honors `ADHD_HOME` (path config, read at call time, env injectable). Each consumer keeps its own env names in its thin wrapper (TW37) |
| F15 | Programmatic unlock needs literal `I-UNDERSTAND-THE-RISK`; wrong string throws; ENOENT swallowed | RT:60-75; request-builder.spec test 5; `reverse-auth.ts` 187-189,283-285 clears programmatically after re-auth | `clear(key,{method,confirm,actor})`; with `clearPolicy:'confirm-token'` wrong/missing token throws `TripwireConfirmError`; ENOENT = `{cleared:false}` (TW14, TW16) |
| F16 | Search clear is agent-callable with no token (MCP `clearTripwire`), returns boolean | MCP:426-436; docs/agent-search/mcp.md:174-194 | `clearPolicy:'open'` instance; audited `method:'mcp-clear'`. This directly contradicts SPEC 12.4 ("no programmatic clear"); preserved per instance, decision D3 (TW15) |
| F17 | Interactive unlock CLI: prints reason/trippedAt/lastStatus/lastOperationId (`(none)` when missing); warns when lock unparseable but still offers unlock; TTY prompt `Type 'I-UNDERSTAND-THE-RISK' to confirm`; `CONFIRM` env for scripts; no-TTY and no CONFIRM refuses; mismatch keeps lock; exit codes 0 ok/none, 1 usage/confirm, 2 I/O; "no tripwire to unlock for X"; custom lock path env `TRIPWIRE_PATH` for tests | UT:17-21,27,29-46,49-60,62-78,80-108 | `runUnlockCli(argv, io, tw)` returning the exit code; same strings (the existing spawn spec asserts `unlocked tripwire for testclient`, `no tripwire to unlock for testclient`, `No TTY|Confirmation mismatch`, `Usage:`); `TRIPWIRE_PATH` becomes `TRIPWIRE_DIR` (state dir) in the reverse bin (TW27) |
| F18 | HITL gate loop: while tripped -> count block, print banner (provider, reason, tripped at, blocked-by count, page), prompt `[retry/clear/abort]`; abort throws and keeps lock; `clear` clears and proceeds; retry/Enter/anything else marks reverified, clears, proceeds | CS:269-311 | `interactiveGate(tw,key,io)`; unknown input still = retry (preserve); closed stdin/non-TTY = abort, fail closed (the current loop would hang on EOF) (TW24, TW25) |
| F19 | Post-fire HITL prompt: banner (provider, query, reason, strategy, page, session id), "ENTER to retry or abort"; abort -> lock stays for next invocation; ENTER -> reverified + cleared | CS:315-340,433-457 | `confirmSolved(tw,key,info,io)` (TW26) |
| F20 | After a later success, if still tripped: `resolvedTripwire` (audit + clear) | CS:459-465 | `resolve(key)` (TW18) |
| F21 | Locked response without touching Chrome: returns `hitl` outcome with the existing record, no window, no `chrome.ready()`; the captcha window from the original trip stays open (page not disposed) | MCP:66-84,244-255,350-366 | Stays in agent-search; package supplies `gate()` result carrying the record (TW10) |
| F22 | Status: CLI prints per-provider block (`reason, trippedAt, blockedCount, query, pageUrl, reverifiedAt?, resolvedAt?`), `No tripwires tripped.`, and ALWAYS a final JSON line `{"type":"tripwireStatus","status":{...}}`; list-providers prints `TRIPPED: reason at ts` | CS:180-181,187-214 | `renderStatusText`, `statusJsonLine` pure functions (TW28) |
| F23 | MCP `tripwireStatus()` returns a SPARSE `Record<string, TripwireRecord>` (plain string key on purpose, apigen extractor quirk; comment MCP:398-407) and hides expired | MCP:408-424 | `status(keys?)` sparse plain-string record; FIX inconsistency: CLI status shows expired locks as tripped while MCP hides them (CS:190 uses `readTripwire`, MCP:412 uses `isTripwireTripped`). One rule: hide expired unless `includeExpired` (TW13). agent-search keeps a concrete non-generic `TripwireRecord` interface in its wrapper so apigen still extracts it (risk R5) |
| F24 | Session correlation: `searchSessionId` (UUID per invocation) + `browserSessionId` (CDP targetId) | ST:227-228,256; adhd/session.ts (deleted by cutover) | `sessionId?: () => string|undefined` option -> `trippedBy.sessionId`; targetId rides in `context` |
| F25 | Corrupt/unreadable lock handling | RT:37-44 and ST:102-109 return null on ANY error => a corrupt or EACCES lock is treated as CLEAR (fail-open) | FIX, fail closed: present-but-unreadable = tripped (`state:'unreadable'`/`'corrupt'`); only ENOENT = clear (TW3). Behavior change flagged D3 |
| F26 | Key safety | `${provider}.lock` / `${client}.lock` interpolated into a path with no validation (ST:96-98, RT:33-35) | FIX: key regex `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, `TripwireKeyError` (TW5) |
| F27 | Races | `tripTripwire` and `fireTripwire` overwrite an existing lock: a second trip erases the first forensic record and resets blockedCount (ST:111-118,214-247; RT:77-82) | FIX: create-if-absent via `link()`; second trip returns `created:false`, first cause kept, audit `tripwire-retripped` (TW1) |
| F28 | Failure to persist a trip | SEND:190 awaits `tripTripwire` unguarded: an fs error masks the 4xx and nothing is latched | FIX: in-memory latch first, then persist; never throw on IO; `TripResult.persisted=false` + `onWarning` (TW23) |
| F29 | File modes | default 0644 files / 0755 dirs although records carry URLs/queries | FIX: 0600 / 0700 (TW6) |
| F30 | Redaction | none; reverse stashes raw response body on the error only (SEND:203) | `redact` hook, default denylist (TW7). Body never persisted |
| F31 | "previously cleared" annotation, `by`/`method` on clears | SPEC 12.4, 12.6 (unimplemented) | `<key>.cleared` marker -> `priorClear` on the next trip; every clear audited with `method`+`actor` (TW17) |

Interplay notes (not tripwire features, must stay correct): pacing floor `recordSend` happens at SEND:151, i.e. only AFTER the tripwire passed; a trip never rewrites pacing/sequencing state and a clear does not reset them. Search cooldown (`SG:36-130`) deliberately skips the `hitl` outcome because the tripwire is the durable gate (SG:11-14,120-122); it keeps its own state in `<root>/guard/` and is NOT moved into this package (different semantics: auto-expiring, outcome-mapped).

### 1.2 Not carried (spec-only, implemented by none of the three; recorded, not built)
SPEC 12.1 body matchers/classifier, 12.5 per-process ParityViolation breaker, 12.2 per-user sidecar `<client>/<user>.tripwire.json`. They are not features of any current implementation; the key model (`key` is any string) lets reverse use `tinder/me`-style keys later only if the key regex is widened. Backlog candidate, not scope.

### 1.3 Live state check
`~/.adhd/reverse/data/tripwire/` exists and is EMPTY (listed, 0 entries); audit.log 78,382 bytes. So no live lock is at risk today; nevertheless AC TW4 keeps legacy-shaped locks honored because a stranded lock after an upgrade would silently un-trip a client.

### 1.4 Research result (delegated to researcher; zero third-party dependencies)
Verdict BUILD, no runtime deps: write-file-atomic saves ~15 lines; proper-lockfile (stale takeover) is the opposite of a latch; steno/atomically are ESM-only; rotating-file-stream is single-process. memfs only as optional devDependency (needs human OK; NOT used: a ~80-line injectable fs port + Map fake replaces it). Adopted recipes: create-if-absent = unique tmp (`wx`, 0600, fsync) then `link(tmp, lock)` (EEXIST = lost race; fall back to `open 'wx'` where hard links are unsupported); atomic replace = `<p>.<pid>.<rand>.tmp` + fsync + rename; counters in an O_APPEND sidecar so increments can never create or modify the lock; clear = rename lock to a unique tombstone then unlink (preserves forensics until removed); fail closed (only ENOENT = clear); keep audit lines under 4 KB; chmod pre-existing dirs. Caveats: O_EXCL unreliable on NFS (keep stateDir on local disk, documented), macOS fsync does not flush drive cache. Trace: /Users/nix/dev/ai/scratch/.research-trace/2026-10-12-file-latch.md. Fowler CircuitBreaker bliki: a breaker with no half-open "needs external intervention to reset" = our latch.

## 2. PACKAGE PLACEMENT

### 2.1 Decision table

| Option | Verdict | Evidence |
|---|---|---|
| Own package `resilience-core-tripwire` (RECOMMENDED) | yes | two ESM consumers in two repos, one of which (reverse-apis) has no `@adhd/*` runtime dependency today (root package.json deps list); a latch must not depend on a heavy config library |
| Inside `@adhd/environment` | no | environment-core-node depends on `@adhd/environment-builder` (`yaml`, `ajv`) (package.json deps); it is tier core/domain environment/`access:domain` (project.json tags), and its job is config resolution, not persistence of ban state. Its `env.paths` would only supply two directory strings, which the consumer can pass in (adoption survey `docs/environment/adoption-survey/scratch/scratch-agent-search.md` proposes `env.paths.tripwire` / `env.files.auditLog` as a LATER migration, orthogonal) |
| Inside service-proxy | no | auto-half-open breaker semantics, sync `BreakerStore {load,save}`, no forensic/audit/human clear (single-pass-lifecycle-spec.md:101-108); 0.6.0 is unreleased and being specified |
| Built ON service-proxy D `BreakerStore` | no | would force the latch through a state machine whose half-open probe is exactly what REARCHITECTURE 12.9 forbids; adds a release dependency. Independent => zero sequencing wait |
| Stay in agent-search | no | two live duplicates already; reverse cannot import scratch |

Relationship to stealth-browser: none at runtime. SCOPE.md:26 keeps tripwire out of the stealth-browser package; its ban signals (`checkBans` -> `BanSignal`, `capture/bans.ts:113-126`) are mapped to `trip({reason})` by agent-search, as today. The planned `LaunchBreaker` (chrome-lifecycle, SPEC-capture-and-lifecycle.md:344) is an auto-recovering breaker and stays on service-proxy D; it is a different mode, not a fourth tripwire consumer.

### 2.2 Name, domain, tier, generator
- Package `@adhd/resilience-core-tripwire`, dir `packages/resilience/resilience-core-tripwire`, project name `resilience-core-tripwire`. The convention requires dir == package name == tsconfig alias == import specifier (package-naming.md). FOLLOWUP's `@adhd/tripwire` does not satisfy it (the only alias precedent is `@adhd/environment` for environment-core-node); do not add an alias.
- Domain: `resilience` is not in `.adhd/workspace.json` (groups today: apigen agent data decompile dispatch environment ui-react workspace). The generator rejects unknown groups (`workspace-config.ts:37-41`). Fallback if D1 is declined: `--group=agent` => `agent-core-tripwire` (zero workspace.json edit, weaker fit: that domain is the AI-agent runtime).
- Required workspace.json edit (in `groups`, same shape as siblings):
  `"resilience": { "description": "Fail-safe primitives - persistent kill-switches and guards that protect callers and upstream services from compounding failures" }`
  Owner/approval: the edit is a repo-wide config change; it is made by `tripwire-scaffold` ONLY after `docs/plan/stealth-browser/APPROVAL-tripwire.md` exists recording the user's verbatim message and decision D1 (guard `tripwire-scaffold.1`). CLAUDE.md line 23 (no new package without recorded human approval) is satisfied by the dispatcher-recorded message: "Implement tripwire package in this plan covering all 3".
- Invocation (dry-run first, read the CREATE list, then without `--dry-run`):
  `npx nx g @adhd/workspace-codegen-nx:core --name=tripwire --group=resilience --nxLayer=shared --platform=node --access public --publish true --dry-run`
  Bare name rule: `--name=tripwire`, never `resilience-core-tripwire`. Expected tags: domain:resilience, pkg-kind:core, pkg-class:foundation, layer:shared, platform:node, access:public. Tier core is "pure logic, depends on base" (CLAUDE.md tier table); this package has no dependencies, persistence is behind the `TripwireStorage` seam with a bundled node:fs implementation (precedent: environment-core-node uses node:fs at tier core).
- After generation (owned by `tripwire-scaffold`): set `version` 0.1.0 (so `^0.1.0` floats patch releases; `^0.0.x` pins exactly); apply ADR-0003 D1: `main ./dist/index.js`, `type` unset, no `module`, no `exports`, CJS-only vite output (the generated template may still emit `.mjs`/`module`: environment-core-node's package.json still carries `"module"`), `engines.node >=20`, `publishConfig.access public`, `files [dist, CHANGELOG.md]`, `keywords`, `repository.directory`. No `bin` (CLI = entrypoint rule; a standalone `tripwire` bin would be a second new package, NOT approved; revisit only with approval).
- Publish: PUBLISHING.md model: `pnpm release` = build + `version` + `publish` (publish-from-dist, README/CHANGELOG copied by the `assets` target, published-state.json backfill for a new package). New package + zero deps => topological order is trivial; it publishes in the same `pnpm release` as `@adhd/stealth-browser` (D4).
- ADR-0001 stance (D2): the tripwire is a kill-switch file protocol whose contract is "presence of a human-readable file = stopped; `rm` is the break-glass", not a record store. The plan already treats file-backed breaker/ownership state this way (SPEC-capture-and-lifecycle.md:268,344). It must also work when a native-binding database cannot load (a latch that fails open if the Turso binding is missing is wrong). ADR-0001 D7 bans application locks REPLACING engine multiprocess support; here there is no engine, and multi-process safety comes from atomic primitives (link, rename, O_APPEND) proven by TW36. The `TripwireStorage` seam lets an adapter-backed storage pass the same contract suite later (TW38) with no API change. No env toggles anywhere in the package (ADR-0001 D3 spirit).
- ADR-0002: defects found in the three sources are corrected in the one implementation, never wrapped. ADR-0009: unit lane spawns nothing.

## 3. API (TypeScript)

Single entry `src/index.ts`; no subpath exports (ADR-0003). All operations async (agent-search call sites are already inside async functions; its top-level `--tripwire-status` code runs under ESM top-level await, agent-browser is `type: module`).

```typescript
// types.ts
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type TripContext = Record<string, JsonValue>;
export const CONFIRM_TOKEN = 'I-UNDERSTAND-THE-RISK' as const;
export type ClearMethod = 'unlock-cli-tty' | 'unlock-cli-env' | 'programmatic-confirm' | 'hitl-clear' | 'hitl-retry' | 'mcp-clear' | 'resolved' | 'expired';
export type TripwireStatus = 'tripped' | 'expired' | 'unreadable';

export interface TripwireRecord<C extends TripContext = TripContext> {
  schema: 1;
  key: string;
  namespace: string;                       // 'request-builder' | 'agent-search' ...
  reason: string;
  trippedAt: string;                       // ISO
  trippedBy: { pid: number; sessionId?: string; actor?: string };
  blockedCount: number;                    // legacy in-record count + sidecar size
  lastBlockedAt?: string;                  // sidecar mtime
  priorClear?: { clearedAt: string; method: ClearMethod; actor?: string };
  recoveryHint?: string;
  context: C;                              // consumer forensic fields (redacted)
}
export interface TripwireSnapshot<C extends TripContext = TripContext> {
  status: TripwireStatus | 'clear';
  record: TripwireRecord<C> | null;        // null when clear; best-effort synthesized when unreadable
  expired: boolean;
}
export type Redactor = (context: TripContext) => TripContext;

export interface TripwireOptions {
  namespace: string;
  stateDir: string;                        // locks at <stateDir>/tripwire/<key>.lock
  auditPath?: string;                      // default <stateDir>/audit.log
  maxAuditBytes?: number;                  // default 5 * 1024 * 1024; min 100_000
  expiry?: { ttlMs: number };              // absent = never expires
  clearPolicy?: 'confirm-token' | 'open';  // default 'confirm-token'
  sessionId?: () => string | undefined;
  actor?: string;                          // default os username
  redact?: Redactor;                       // composed AFTER defaultRedactor
  storage?: TripwireStorage;               // default createFileStorage({ fs })
  fs?: FsPort;                             // injected for tests
  clock?: () => number;
  onWarning?: (w: TripwireWarning) => void;
}
export interface TripInput<C extends TripContext> { reason: string; context: C; recoveryHint?: string }
export interface TripResult<C extends TripContext> { record: TripwireRecord<C>; created: boolean; persisted: boolean }
export interface GateResult<C extends TripContext> { open: boolean; snapshot: TripwireSnapshot<C> }
export interface ClearOptions { method: ClearMethod; confirm?: string; actor?: string; reverified?: boolean }

export interface Tripwire<C extends TripContext = TripContext> {
  read(key: string): Promise<TripwireSnapshot<C>>;                 // no side effects
  gate(key: string): Promise<GateResult<C>>;                       // counts + audits a block; lazily removes + audits expired
  assertOpen(key: string): Promise<void>;                          // throws TripwireTrippedError
  trip(key: string, input: TripInput<C>): Promise<TripResult<C>>;  // never throws on IO
  clear(key: string, opts: ClearOptions): Promise<{ cleared: boolean }>;
  resolve(key: string, opts?: { actor?: string }): Promise<void>;  // audit 'tripwire-resolved' then clear
  status(opts?: { keys?: readonly string[]; includeExpired?: boolean }): Promise<Record<string, TripwireRecord<C>>>; // SPARSE, plain string keys
}
export function createTripwire<C extends TripContext = TripContext>(o: TripwireOptions): Tripwire<C>;
export function adhdDataDir(segments: readonly string[], env?: Record<string, string | undefined>, home?: string): string; // ADHD_HOME ?? ~/.adhd

// storage seam (storage.ts)
export interface TripwireStorage {
  readLock(key: string): Promise<{ raw: string; mtimeMs: number } | 'absent' | { error: Error }>;
  createLockIfAbsent(key: string, raw: string): Promise<boolean>;  // true = created
  removeLock(key: string): Promise<{ tombstone: string | null }>;
  incrementBlocked(key: string): Promise<void>;
  blocked(key: string): Promise<{ count: number; lastAt?: number }>;
  writeClearedMarker(key: string, raw: string): Promise<void>;
  takeClearedMarker(key: string): Promise<string | null>;
  listKeys(): Promise<string[]>;
  appendAudit(line: string): Promise<void>;
}
export function createFileStorage(o: { stateDir: string; auditPath: string; maxAuditBytes: number; fs: FsPort; clock: () => number }): TripwireStorage;
export function createMemoryStorage(): TripwireStorage;             // reference implementation of the contract
export interface FsPort { /* mkdir, open(wx|a), write, fsync, close, link, rename, unlink, readFile, stat, readdir, chmod */ }
export function createMemoryFs(): FsPort & { /* inspection + deterministic interleaving hooks */ };

// errors.ts - every error: stable `code`, brand Symbol.for('adhd.tripwire.error'), name
export type TripwireErrorCode = 'TRIPWIRE_TRIPPED' | 'TRIPWIRE_CONFIRM_REQUIRED' | 'TRIPWIRE_INVALID_KEY' | 'TRIPWIRE_IO' | 'TRIPWIRE_ABORTED';
export class TripwireError extends Error { readonly code: TripwireErrorCode }
export class TripwireTrippedError extends TripwireError {           // BEFORE (RT:14-25): (client, reason, trippedAt: Date, forensic?)
  readonly key: string; readonly reason: string; readonly trippedAt: Date; readonly record?: TripwireRecord;
  readonly recoveryHint: string;
  responseStatus?: number; responseBody?: unknown;                  // memory-only, never persisted
  static fromRecord(r: TripwireRecord, extra?: { responseStatus?: number; responseBody?: unknown }): TripwireTrippedError;
}
export class TripwireConfirmError extends TripwireError {}          // wrong/missing confirm token
export class TripwireKeyError extends TripwireError {}
export class TripwireIoError extends TripwireError { readonly cause: unknown }
export class TripwireAbortedError extends TripwireError {}          // HITL abort, no TTY
export function isTripwireError(e: unknown): e is TripwireError;    // code/brand check, safe across duplicate copies
export function isTripwireTrippedError(e: unknown): e is TripwireTrippedError;

// interactive.ts + cli.ts - injected IO, no process access
export interface TripwireIo { isTTY: boolean; env: Record<string, string | undefined>; question(prompt: string): Promise<string | null>; /* null = EOF/closed */ out(line: string): void; err(line: string): void }
export function nodeTripwireIo(): TripwireIo;
export function interactiveGate<C extends TripContext>(tw: Tripwire<C>, key: string, io: TripwireIo): Promise<void>;   // F18; throws TripwireAbortedError
export function confirmSolved(tw: Tripwire, key: string, info: HitlInfo, io: TripwireIo): Promise<void>;               // F19
export function runUnlockCli(argv: readonly string[], io: TripwireIo, tw: Tripwire): Promise<0 | 1 | 2>;               // F17
export function renderStatusText(map: Record<string, TripwireRecord>): string;                                          // F22
export function statusJsonLine(map: Record<string, TripwireRecord>): string;                                            // '{"type":"tripwireStatus","status":{...}}'
export function defaultRedactor(): Redactor;  // drops values for keys matching /authorization|cookie|set-cookie|token|secret|password|x-auth/i, strips secret-looking URL query params, truncates strings > 2048 chars
```

### 3.1 Behavior rules (normative)
- Key regex `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` checked before any fs call.
- `read`: ENOENT => clear. Any other read error, empty file, JSON failure, wrong shape => `status:'unreadable'`, synthesized record `{reason:'unreadable-lock'}`; counts as tripped (fail closed). Legacy flat shapes: unknown top-level fields move into `context`; `blockedCount` from the legacy field is added to the sidecar count.
- `trip`: in-memory latch set first; build record (redact context; `trippedBy.pid`, `sessionId()`); consume `<key>.cleared` marker into `priorClear`; persist via create-if-absent; if the lock already existed => keep the first record, audit `tripwire-retripped {reason}`, return `created:false`; if persist throws => `persisted:false`, `onWarning({code:'TRIPWIRE_IO'})`, in-memory latch still blocks this process; audit `tripwire-fired` on creation.
- `gate`: expired (when `expiry` set and `now - trippedAt > ttlMs`) => remove lock (tombstone), audit `tripwire-expired`, return open. Tripped => `incrementBlocked`, audit `tripwire-gate-blocked {blockedCount}`, return closed. The in-memory latch is consulted too. `assertOpen` throws `TripwireTrippedError` with `recoveryHint` (default text names the clear method for the instance's policy).
- `clear`: policy `confirm-token` requires `opts.confirm === CONFIRM_TOKEN` else `TripwireConfirmError` with no state change; absent lock => `{cleared:false}`, no audit; success => write `<key>.cleared` marker, tombstone-rename then unlink lock and `.blocked`, audit `tripwire-cleared {method, actor, reverified}`.
- `resolve`: audit `tripwire-resolved {trippedAt, durationMs, blockedCount}` then clear with `method:'resolved'` (no token needed: it is the success path, available under both policies).
- `status` hides expired unless `includeExpired`; sparse plain-string-keyed record (MCP:398-407 constraint).
- Audit line: `{ts, event, key, namespace, sessionId?, actor?, reason?, method?, blockedCount?, pageUrl?, durationMs?, reverified?, priorClear?}`; < 4 KB; `context` is NOT audited except `pageUrl` (redacted); the query text is never audited.
- Files 0600, directories 0700 (chmod pre-existing); fsync file before rename/link.
- The package reads no environment variables; `adhdDataDir` takes `env` as a parameter.

## 4. Test plan and acceptance criteria

Test standard: unit lane only (ADR-0009): no child_process, no network; storage tests run on `createMemoryFs` (deterministic interleaving hooks) AND a real `mkdtemp` directory through the same contract suite (TW38); clocks injected; IO for prompts injected. File naming `src/test/unit/<area>.spec.ts`; every spec cites `8468f7b1` and at least one `TWn`. Simulated real use = scenario suites named per consumer: `scenario-request-builder.spec.ts` (4xx -> trip -> 3 blocked sends -> confirm-token unlock -> next send open), `scenario-agent-search.spec.ts` (captcha -> trip -> locked responses -> HITL retry/clear/abort -> success resolves), `scenario-unlock-cli.spec.ts`.

| ID | Criterion | Test file / method |
|---|---|---|
| TW1 | Second `trip` on a tripped key returns `created:false`, first record untouched (reason, trippedAt, context), audit `tripwire-retripped`; under interleaved concurrent trips exactly one `created:true` | tripwire.spec.ts, interleave harness |
| TW2 | Writes use unique tmp names (pid+random); two interleaved writers never share a tmp; a reader at any interleaving point sees complete JSON or ENOENT | storage.spec.ts (memfs hooks) |
| TW3 | Fail closed: ENOENT=clear; EACCES, EIO, empty file, garbage JSON, wrong schema => tripped with `status:'unreadable'`; `assertOpen` throws | tripwire.spec.ts |
| TW4 | Legacy reverse-shaped lock `{reason,trippedAt,lastStatus,lastOperationId}` and legacy search-shaped lock (incl. in-record blockedCount, reverifiedAt) are read, honored, extra fields land in `context`, counts add | legacy.spec.ts |
| TW5 | Keys `..`, `a/b`, empty, 65 chars, leading dot rejected with `TRIPWIRE_INVALID_KEY`, zero fs calls | tripwire.spec.ts |
| TW6 | Lock, sidecars, audit file 0600; dirs 0700 incl. pre-existing dirs | storage.spec.ts |
| TW7 | Redaction: denylisted header/cookie/token keys dropped, URL query secrets stripped, long strings truncated, custom redactor composed after default; `responseBody` never written; audit never contains query text | redact.spec.ts |
| TW8 | Context round-trips both consumers' fields (`lastStatus,lastOperationId` / `query,pageUrl,strategy,browserSessionId,lastOperation`); `sessionId()` lands in `trippedBy` | tripwire.spec.ts |
| TW9 | `gate` on a clear key: open, zero writes, zero audit lines | tripwire.spec.ts |
| TW10 | `gate` on tripped: closed, count +1, audit `tripwire-gate-blocked`; `assertOpen` throws `TripwireTrippedError` (key, reason, trippedAt Date, record, recoveryHint, code) | tripwire.spec.ts |
| TW11 | N interleaved gates => `blockedCount === N` exactly (no lost updates) | interleave harness |
| TW12 | A block racing a clear never recreates the lock; after clear the lock is absent | interleave harness |
| TW13 | With `expiry`: older-than-TTL lock is open, lazily removed, one `tripwire-expired` audit; without `expiry` never expires; `status` hides expired unless `includeExpired` (one rule for CLI and MCP) | expiry.spec.ts |
| TW14 | `confirm-token` policy: missing/wrong token throws `TripwireConfirmError`, lock intact, no cleared audit; correct token clears, audit has method+actor | clear.spec.ts |
| TW15 | `open` policy clears without token; audit `method:'mcp-clear'` | clear.spec.ts |
| TW16 | Clear on absent lock: `{cleared:false}`, no throw, no audit | clear.spec.ts |
| TW17 | Clear writes marker; next trip carries `priorClear`; marker consumed once | clear.spec.ts |
| TW18 | `resolve` audits `tripwire-resolved {durationMs, blockedCount}` then removes; `reverified` flag appears on the cleared audit event | clear.spec.ts |
| TW19 | Audit: one valid NDJSON line per event with `ts,event,key,namespace`; events fired/gate-blocked/cleared/resolved/expired/retripped all emitted; < 4 KB | audit.spec.ts |
| TW20 | Cap: at >= `maxAuditBytes` oldest ~50% dropped at a line boundary, byte-accurate with multibyte lines, newest kept, replace is atomic; log never exceeds cap after an append; interleaved append during rotation loses no complete line other than the dropped half | audit.spec.ts |
| TW21 | Audit dir = `dirname(auditPath)`; default under `stateDir`; an `auditPath` outside stateDir works; nothing written under the real home | audit.spec.ts |
| TW22 | Audit write failure never throws from `gate/trip/clear`; `onWarning` called | audit.spec.ts |
| TW23 | Persist failure on `trip`: `persisted:false`, warning, same-process `gate` still closed | tripwire.spec.ts |
| TW24 | `interactiveGate`: banner content; `retry`/Enter/other => reverified+clear (`hitl-retry`) and returns; `clear` => `hitl-clear`; `abort` => `TripwireAbortedError`, lock stays; block counted per loop | interactive.spec.ts |
| TW25 | Non-TTY or `question` returns null (EOF) => abort, lock stays, no hang | interactive.spec.ts |
| TW26 | `confirmSolved`: Enter => reverified + cleared; `abort` => `TripwireAbortedError('HITL aborted by user')`, lock stays | interactive.spec.ts |
| TW27 | `runUnlockCli`: no client => usage, 1; no lock => "no tripwire to unlock for X", 0; prints reason/trippedAt/lastStatus/lastOperationId with `(none)` fallbacks; unparseable lock warns and proceeds; TTY confirm path; `CONFIRM` env path; mismatch => 1 lock kept; no TTY and no CONFIRM => 1 with "No TTY"; storage error => 2; audit method `unlock-cli-tty`/`unlock-cli-env` | cli.spec.ts + scenario-unlock-cli.spec.ts |
| TW28 | `renderStatusText` layout per provider + `No tripwires tripped.`; `statusJsonLine` is exactly `{"type":"tripwireStatus","status":{...}}` and is the last line; map is sparse with plain string keys | render.spec.ts |
| TW29 | Package shape: `main ./dist/index.js`, `type` unset, no `module`/`exports`, no `.mjs` emitted, zero `dependencies`, `files` = dist+CHANGELOG, access public; `nx run resilience-core-tripwire:verify-dist-load` exits 0 (executes the entry) | `tripwire-pack` guard |
| TW30 | Public surface = the exports in section 3 only; no consumer-specific names (`provider`, `client`) in exported types | api-surface.spec.ts (snapshot of `Object.keys(require index)`) |
| TW31 | No `process.env`, `process.stdin`, `child_process`, `console.*` read inside `src/` except `nodeTripwireIo` and the default `adhdDataDir` home lookup | lint rule or `rg` guard |
| TW32 | Every error has stable `code` + brand; `isTripwireTrippedError` true for an instance from a duplicate module copy (simulated by a structural clone) | errors.spec.ts |
| TW33 | `TripwireTrippedError.fromRecord(r,{responseStatus,responseBody})` exposes typed fields; neither is serialized by `trip` | errors.spec.ts |
| TW34 | Docs exist and are consistent: README (3 consumer recipes), docs/ERRORS.md (codes), docs/RECOVERY.md (operator runbook incl. break-glass `rm` and audit reading), CHANGELOG.md | `tripwire-docs` guard |
| TW35 | Every spec cites `8468f7b1` + a TW id; no spec imports `child_process`/`net`/`http` | guard (`rg`) |
| TW36 | Interleaving suite over memfs hooks: trip/trip, gate/gate, gate/clear, clear/clear, trip/clear, audit rotate/append hold their invariants (TW1, TW11, TW12, TW20) | interleave.spec.ts |
| TW37 | `adhdDataDir(['reverse','data'], {ADHD_HOME:'/x'})` = `/x/reverse/data`; absent env => `<home>/.adhd/reverse/data`; pure | paths.spec.ts |
| TW38 | Storage contract suite runs identically on `createMemoryStorage`, `createFileStorage(memfs)` and `createFileStorage(mkdtemp)` | storage-contract.spec.ts |

Open item OD-TW1 (honest gap): real two-OS-process contention is not proven in the unit lane (ADR-0009 puts spawning in `e2e`; the stealth plan declares no e2e lane). TW36 proves the logic under adversarial interleavings of the exact fs operations; add one `*.e2e.test.ts` two-process test later if an e2e lane is opened. Also unverified: `link()` behavior on the user's volume (APFS: supported); fallback to `wx` is unit-tested via a memfs that rejects `link`.

Docs: README (install, 3 recipes: gate in a request pipeline; HITL gate in a CLI; unlock bin in 5 lines; stateDir/ADHD_HOME; policies; redaction), docs/ERRORS.md, docs/RECOVERY.md, CHANGELOG.md (`0.1.0`), JSDoc on every export. apigen/tracing: none for the package. The only apigen interaction is in agent-search (R5): its wrapper must keep a concrete non-generic `TripwireRecord` interface for the MCP `tripwireStatus` return type.

## 5. THE THREE CONSUMER MIGRATIONS

Common: lines below are current positions read on 2026-10-12; executors re-read before editing. Wrappers keep consumer env names (consumer config, not package toggles).

### 5.1 Consumer 1 + 2: reverse-apis (request-builder gate + unlock tool; also reverse-auth and tests)

Repo `/Users/nix/dev/projects/reverse-apis`: branch main, HEAD d959c6a, NO git remote (local only), dirty tree (8 lines: ` M AGENTS.md`, untracked `.claude/worktrees/ .obsidian/ .opencode/ captures.db fatal.csv identity/ packages/system/wingman-bridge/docs/`), two locked worktrees under `.claude/worktrees/`. Plan: worktree `/Users/nix/dev/projects/reverse-apis/.worktrees/tripwire-adopt` on branch `feat/tripwire-adopt` (`.worktrees` is not git-ignored: first append `.worktrees/` to `.git/info/exclude`, a local untracked file). Explicit-path commits only; never touch the dirty files; never `git add -A`.

Package setup (root, single pnpm project resolved through tsconfig paths; no pnpm-workspace.yaml): add dependency `@adhd/resilience-core-tripwire` `^0.1.0` to root `package.json`; add the package name to the `external` array in `packages/system/request-builder/vite.config.ts` (list at lines ~19-34); `pnpm-lock.yaml` changes only at relink (5.4).

Files (owned set for state `tripwire-reverse-migrate`, all under the worktree):
| File | Change |
|---|---|
| `packages/system/request-builder/src/lib/tripwire.ts` | delete |
| `packages/system/request-builder/src/lib/request-tripwire.ts` | create: `createRequestTripwire(opts?: {tripwireDir?: string}): Tripwire<RequestTripContext>`; namespace `request-builder`; stateDir = `opts.tripwireDir ?? ADHD_REVERSE_HOME-data ?? adhdDataDir(['reverse','data'], process.env)` (keeps the layout `<root>/tripwire/<client>.lock` and shared `audit.log`, and the e2e harness's `ADHD_HOME` isolation); no expiry; `clearPolicy:'confirm-token'`; `RequestTripContext {lastStatus:number; lastOperationId:string; method?:string; host?:string}` |
| `.../src/lib/send.ts` | imports 24-30; gate 88-98 -> `await tw.assertOpen(opts.client)`; trip 189-205 -> `const r = await tw.trip(opts.client,{reason:'http-4xx',context:{lastStatus:status,lastOperationId:opts.operationId,method,host}})` then `throw TripwireTrippedError.fromRecord(r.record,{responseStatus:status,responseBody:parsedBody})`; 5xx path and `recordSend` order unchanged (151, 207-209) |
| `.../src/lib/types.ts` | `tripwirePath?` (28-29) -> `tripwireDir?: string`; delete `TripwireLockFile` (53-58) |
| `.../src/index.ts` | lines 16-22: re-export `TripwireTrippedError`, `isTripwireTrippedError` from the package; export `createRequestTripwire`; drop `isTripwireTripped/unlockTripwire/defaultTripwirePath` |
| `.../src/lib/request-builder.spec.ts` | tests 2,3,4,5,6 (lines ~99-180), 18 (~491-519): use `createRequestTripwire({tripwireDir})`; test 6 asserts the `<root>/tripwire/tinder.lock` layout; add: block count + audit assertion, corrupt lock blocks |
| `packages/system/request-builder/{vite.config.ts,README.md}` | external list; tripwire section (README lines 15,20,29-31,74-79) |
| `tools/unlock-tripwire/unlock-tripwire.ts` | becomes ~15 lines: `process.exit(await runUnlockCli(process.argv.slice(2), nodeTripwireIo(), createRequestTripwire({tripwireDir: process.env.TRIPWIRE_DIR})))`; `TRIPWIRE_PATH` (full lock path) is replaced by `TRIPWIRE_DIR` (state dir) |
| `tools/unlock-tripwire/unlock-tripwire.spec.ts` | update fixture to `TRIPWIRE_DIR` + `<dir>/tripwire/testclient.lock`; keep the 4 spawn assertions and exit codes unchanged (this is the real-bin regression proof; reverse has no ADR-0009 lane rule) |
| `tools/unlock-tripwire/README.md` | env var + audit note |
| `tools/reverse-auth/reverse-auth.ts` | import 24-26; 160,170 `isTripwireTripped` -> `(await tw.read(api)).status !== 'clear'`; 187-189 and 283-285 -> `tw.clear(api,{method:'programmatic-confirm',confirm:CONFIRM_TOKEN,actor:'reverse-auth'})`; 216 |
| `packages/apis/{tinder,rappi}/src/lib/utils/build-request.ts` (tinder:103,182; rappi:41,84) | `tripwirePath` -> `tripwireDir` |
| `packages/apis/{tinder,bumble,airbnb,rappi}/src/lib/auth-config.ts` | `instanceof TripwireTrippedError` unchanged (re-export); replace the `(e as unknown as {responseStatus?})` cast with the typed field (tinder:25-27) |
| `tools/generators/api-package/generator.ts` (comment 559 + any emitted `tripwirePath`) | rename to `tripwireDir` (`rg tripwirePath` for the full list; instagram/airbnb/bumble build-request.ts mention only comments) |
| `packages/system/e2e-tests/src/lib/harness.ts:353-366` | `readTripwireLock` returns `{reason, lastStatus: record.context.lastStatus}`; path unchanged; `src/lib/scenario-template.ts:185` unchanged if it only reads those two fields |
| `packages/system/e2e-tests/src/scenarios/{pacing,sequencing}.spec.ts` (48/83/109; 58/104/140/177) | `tripwirePath` -> `tripwireDir: tmpDir` |
| `REARCHITECTURE.md` section 12 (12.2, 12.3, 12.4, 12.6) | rewrite to describe the shipped design (key/lock layout, blocked count, audit events, clear policies); no historical commentary |
| `package.json` (root) | dependency line |

Behavior changes reverse users will see (all deliberate, flagged D3): blocked sends now increment `blockedCount` and write `tripwire-gate-blocked` audit lines (SPEC 12.3 promised this); every trip/clear is audited (12.6 promised this); corrupt or unreadable locks now block instead of being ignored; a second 4xx no longer overwrites the first forensic record.

Verification (commands to run later; none were run): `pnpm nx test request-builder`; `pnpm nx run-many -t lint,test,build` (CI order, workflow .github/workflows/*.yml); `pnpm nx e2e e2e-tests` (mock-server + MCP subprocess; strongest regression proof: it trips through the real MCP and reads the lock via `ADHD_HOME`); `pnpm vitest run --config tools/unlock-tripwire/vite.config.ts` (unverified: `tools/unlock-tripwire` has no project.json, so `nx run-many -t test` very likely never runs its spec: file as a backlog bug and, in this state, add a minimal `project.json` or run it explicitly in the state's guard). Regression bar: request-builder.spec 21 tests green (README line 117), unlock spec 4 green, e2e-tests green, `rg "TripwireLockFile|defaultTripwirePath|isTripwireTripped|unlockTripwire|tripwirePath"` over `*.ts` returns nothing.

### 5.2 Consumer 3: agent-search (folded into `agent-search-cutover`)

Repo `/Users/nix/dev/ai/scratch` branch main, edited in place per the existing cutover decision ([inv:scratch-local-only]); repo-wide dirty (INDEX.md, other projects), `agent-browser/` subtree dirty only in `metrics.json`; explicit-path commits, never push. Why fold: the cutover already owns every file below and `inv:source-untouched` forbids touching them earlier; the cutover also deletes `agent-browser/adhd/session.ts` (source of `getSearchSessionId`), so tripwire migration must happen in the same pass or it would be rewritten twice.

Files (all already in the cutover's owned list in `ownership.json`): 
| File | Change |
|---|---|
| `search-tripwire.ts` (284 lines) | rewrite as thin adapter (~60 lines): `const tw = () => createTripwire<SearchTripContext>({namespace:'agent-search', stateDir: process.env.SEARCH_ADHD_DATA_DIR ?? adhdDataDir(['reverse','data']), auditPath: process.env.SEARCH_AUDIT_PATH, maxAuditBytes: Number(process.env.SEARCH_AUDIT_MAX_SIZE) \|\| undefined, expiry:{ttlMs: Number(process.env.SEARCH_TRIPWIRE_TTL_MS) \|\| 7_200_000}, clearPolicy:'open', sessionId: getSearchSessionId})` (env read at call time, as today; `getSearchSessionId` imported from `@adhd/stealth-browser` after cutover; keep the same state root so the shared `audit.log` and any lock survive). Exports kept as async: `fireTripwire`, `tripwireGate`, `gateBlocked`, `clearedTripwire`, `resolvedTripwire`, `readTripwire`, `isTripwireTripped`, plus a concrete non-generic `interface TripwireRecord` (apigen, R5) |
| `cdp-search.ts` | imports 35-44; status block 180-214 (await; keep text and last JSON line via `renderStatusText`/`statusJsonLine`); `checkTripwireGate` 269-311 -> `interactiveGate`; `promptHitl` 315-340 -> `confirmSolved`; 433-465 awaits |
| `search-mcp-source.ts` | imports 43-44; gate 250-255; fire 351-366 (still `hitlPreventDispose`); `tripwireStatus` 408-424 and `clearTripwire` 426-436 awaited, return types unchanged (`Record<string, TripwireRecord>`, `boolean`); the apigen comment 398-407 stays |
| `search-guard-test.ts` (85-125) | awaits; assertions kept (count == 1, TTL lazy removal, lock cleared); fixture dir via `SEARCH_ADHD_DATA_DIR` AND now `audit.log` lands in that dir |
| `package.json` | dependency `@adhd/resilience-core-tripwire` `^0.1.0` (range only, recorded) |
| `AGENTS.md`, `SEARCH.md`, `docs/agent-search/{README,cli,mcp}.md` | tripwire sections (README:202-207; cli.md:193-198,262,287; mcp.md:148-194,317): TTL, policy, audit events, last-line JSON |

Pre-publication consumption: a tarball `npm pack`ed from the built `dist` of THIS worktree, installed as a real directory in `agent-browser/node_modules/@adhd/resilience-core-tripwire` exactly like the stealth-browser tarball ([inv:cutover-live-vs-recorded]); lockfile untouched until relink. Verification: `pnpm run build` (tsc --noEmit), `pnpm run test` (= `tsx chrome-lifecycle-test.ts && tsx search-guard-test.ts`), `pnpm run lint`, plus the parity evidence extension below (new cutover criteria .10-.13).

### 5.3 Sequencing and the cutover
- The cutover depends on `tests-use-cases`; the tripwire chain (section 6) finishes long before (it only waits on `port-fixes` for the lockfile step), so the cutover consumes the tarball directly, nothing is written once and rewritten.
- The cutover must keep search's tripwire working at every commit: wrapper first, then call sites, `pnpm run test` green before the delete of `adhd/`.
- stealth-browser itself does not depend on the tripwire package (inv:one-implementer unaffected).

### 5.4 Version / publish / relink sequence (nothing run)
1. `tripwire-pack` produces `/…/tripwire-0.1.0.tgz` OUTSIDE every `.worktrees/` and records sha256 + packed_from_head in `evidence/tripwire/tripwire-tarball.json`.
2. Consumers verify against the tarball (reverse worktree: extract into its `node_modules/@adhd/resilience-core-tripwire` as a real directory; `package.json` records `^0.1.0`; `pnpm-lock.yaml` NOT committed).
3. Dispatcher-gated release (`merge-readiness` -> `hb-release-decision`): ff-only merge of branch `stealth-browser`, then `pnpm release` (PUBLISHING.md) publishes `@adhd/resilience-core-tripwire` and `@adhd/stealth-browser`; `pnpm release:commit` with explicit pathspecs (published-state.json etc.).
4. `agent-search-relink` (existing, amended) and new `tripwire-reverse-relink`: `pnpm add @adhd/resilience-core-tripwire@^0.1.0`, commit package.json + pnpm-lock.yaml, rerun the verification commands, then ff-only merge of `feat/tripwire-adopt` into reverse main and remove the worktree and branch. Reverse CI uses `--frozen-lockfile`, which is why the reverse branch only merges after relink.

## 6. PLAN STRUCTURE (for plan-builder; mechanical)

### 6.1 Amendments to existing plan artifacts (apply BEFORE any new state runs)
1. `scripts/guard.py` `scaffold.5` (lines 417-421): `added == [f"{P}/project.json"]` -> `sorted(added) == sorted([f"{P}/project.json", "packages/resilience/resilience-core-tripwire/project.json"])`; docstring "Exactly TWO new project.json files". Without this, completed state `scaffold` turns red the moment `tripwire-scaffold` commits.
2. `contexts/_shared.md` `[inv:one-new-package]`: now two approved packages (stealth-browser, and the tripwire package approved by the user's message "Implement tripwire package in this plan covering all 3"); add `[def:tripwire-pkg]`; `HYGIENE_FORBIDDEN` unaffected (agent-search imports from the package are in agent-browser, not in the stealth package).
3. New file `docs/plan/stealth-browser/APPROVAL-tripwire.md` (verbatim request, approver, date, domain decision D1). Add `human-blockers.json` entry `hb-tripwire-domain` (resolved by D1).
4. `SCOPE.md`/`README.md`: add the tripwire package to the plan scope (SCOPE.md:26 currently says tripwire stays in agent-search; it still does at runtime, but the package is extracted).
5. `DEFERRED.md` FU-4 row stays (entity graph etc.); tripwire is no longer deferred.
6. Record all of the above in `state.json` `amendment_log` through the repair path (state.json is claimed by orchestrator plan-orchestrator-1791849512-12227; do not hand-edit while it runs).

### 6.2 New states (ids, executors from the roster used by the plan: typescript-pro sonnet)

| State | Phase | Executor | depends_on | Owned paths (ownership.json) | Goal / criteria ids | Guard hints |
|---|---|---|---|---|---|---|
| `tripwire-scaffold` | scaffold | typescript-pro sonnet/medium | `scaffold`, `productization-hold` (D1 recorded in APPROVAL-tripwire.md) | `packages/resilience/resilience-core-tripwire/`, `tsconfig.base.json`, `.adhd/workspace.json`, `docs/plan/stealth-browser/evidence/tripwire/` | tripwire-scaffold.1 approval file exists + `resilience` group present; .2 generator output tags exactly domain:resilience pkg-kind:core pkg-class:foundation layer:shared platform:node access:public; .3 package.json ADR-0003 shape + version 0.1.0 + zero dependencies + publishConfig public; .4 `nx run resilience-core-tripwire:typecheck` and `:build` exit 0 on the empty skeleton; .5 dry-run transcript saved to `evidence/tripwire/scaffold-dry-run.txt` | `git diff --name-only --diff-filter=A base..HEAD` contains exactly the two project.json; `jread` package.json; run nx targets |
| `tripwire-core` | migrate | typescript-pro sonnet/high | `tripwire-scaffold` | `.../src/index.ts`, `.../src/lib/{types,errors,redact,paths,storage,memory-fs,audit,tripwire}.ts`, `.../src/test/unit/{tripwire,storage,storage-contract,legacy,redact,expiry,clear,audit,errors,paths,interleave,api-surface}.spec.ts`, `.../src/test/support/` | tripwire-core.1..N map TW1-TW13, TW14-TW23, TW30-TW33, TW36-TW38 (one criterion id per TW id, same numbering `tripwire-core.TWn`) | `nx test resilience-core-tripwire --testFile` per spec; `rg` guard TW31/TW35 |
| `tripwire-interactive` | migrate | typescript-pro sonnet/high | `tripwire-core` | `.../src/lib/{interactive,cli,render,node-io}.ts`, `.../src/test/unit/{interactive,cli,render}.spec.ts`, `.../src/test/unit/scenario-*.spec.ts`, `.../src/index.ts` (export lines only) | TW24-TW28 plus scenario suites | same |
| `tripwire-docs` | docs | typescript-pro sonnet/medium | `tripwire-interactive` | `.../README.md`, `.../CHANGELOG.md`, `.../docs/` | TW34; README examples type-check by being copied into `src/test/unit/readme-examples.spec.ts` (owned) | doc/example compile check |
| `tripwire-pack` | verify | typescript-pro sonnet/medium | `tripwire-docs`, `port-fixes` | `pnpm-lock.yaml`, `docs/plan/stealth-browser/evidence/tripwire/` | tripwire-pack.1 `nx run resilience-core-tripwire:lint,typecheck,typecheck-spec,test,build,verify-dist-load` all exit 0 (TW29); .2 tarball packed outside `.worktrees/`, sha256 + packed_from_head recorded, lists `package/dist/index.js` and `package/dist/index.d.ts`; .3 smoke: a throwaway ESM project (type: module) installs the tarball and `import { createTripwire } from '@adhd/resilience-core-tripwire'` + `createRequire` both succeed (named-export detection, R3); .4 pnpm-lock.yaml diff is only the importer block (or empty) | the executor runs these (spawning is allowed for the guard, not for unit tests) |
| `tripwire-reverse-migrate` | migrate (cross-repo) | typescript-pro sonnet/high | `tripwire-pack` | `/Users/nix/dev/projects/reverse-apis/.worktrees/tripwire-adopt/` (subtree), `/Users/nix/dev/projects/reverse-apis/.git/info/exclude`, `docs/plan/stealth-browser/evidence/tripwire/` | tripwire-reverse-migrate.1 worktree on `feat/tripwire-adopt`, main's dirty files untouched (`git status` of main identical before/after); .2 section 5.1 file list done, `rg` of legacy names empty; .3 `pnpm nx test request-builder` exit 0; .4 `pnpm nx run-many -t lint,test,build` exit 0; .5 `pnpm nx e2e e2e-tests` exit 0; .6 unlock spec 4 tests pass; .7 specs cite 8468f7b1 + TW/RV ids | guard reads recorded command exit codes in `evidence/tripwire/reverse-verify.json` |
| `tripwire-reverse-relink` | release | typescript-pro sonnet/medium | `merge-readiness`, `tripwire-reverse-migrate` | reverse worktree `package.json`, `pnpm-lock.yaml` | .1 dependency `^0.1.0` resolves from the registry (lockfile resolution is not a file:/tarball); .2 verification re-run green; .3 ff-only merge, worktree + branch removed | dispatcher-gated like `agent-search-relink` |

Naming for test ids: executors cite `8468f7b1 tripwire-core.TW11` style.

### 6.3 Amendments to existing states
| State | Amendment |
|---|---|
| `agent-search-cutover` | `depends_on` += `tripwire-pack`. Reservations unchanged (every file is already owned). New criteria: `.10` the live agent-browser install of `@adhd/resilience-core-tripwire` is a real directory whose `dist/index.js` is byte-identical to the tarball member (same style as .2); `.11` `search-tripwire.ts` imports the package, contains no `renameSync`/`writeFileSync`/`appendFileSync` and no `homedir()`, and exports the async wrapper names of section 5.2; `.12` parity evidence: `evidence/cutover-parity.json` gains `tripwire` with before/after for (a) `--tripwire-status` stdout including the last JSON line against an empty and a seeded fixture `SEARCH_ADHD_DATA_DIR`, (b) the MCP `tripwireStatus`/`clearTripwire` tool names and output schemas through `node server.mjs --transport stdio` (identical before/after; guards R5), (c) a seeded legacy-shaped lock blocks a search with outcome `hitl` and zero Chrome calls; `.13` `pnpm run test` (includes `search-guard-test.ts`) exit 0 and the audit file is created under the fixture dir (F13). Criterion `.3` (live-vs-recorded) must also name the tripwire tarball sha256 and the `^0.1.0` recorded range; `.7` allowed-files list unchanged. Update `contexts/agent-search-cutover.md` Delta Spec step (1)/(3) accordingly |
| `agent-search-relink` | `depends_on` unchanged (`merge-readiness`); also switches the tripwire dependency from tarball to the registry range |
| `review-prep` | diff input must include `packages/resilience/resilience-core-tripwire/` (otherwise it merges without the single blind review, [inv:blind-review]) and the plan-recorded consumer diffs are NOT included (other repos) |
| `gates-first`, `gates-rerun` | add `nx run resilience-core-tripwire:{lint,typecheck,typecheck-spec,test,build,verify-dist-load}` exit 0; depends_on += `tripwire-pack` |
| `docs-marketing-run`, `audit-final` | include the new package in the doc and final checks (README exists, CHANGELOG, no AI attribution); `audit-final` adds a `[ref:tripwire-core]` conformance rule: `src/` has no process/env/child_process access (TW31) |
| `merge-readiness` | release decision lists both packages; `depends_on` += `tripwire-reverse-migrate` (so the release note covers the consumer) |
| `ownership.json` | add the 7 entries above; run `check-disjoint.py`. Collision analysis: `evidence/tripwire/` is a new subtree, but `agent-search-cutover`, `gates-first`, `gates-rerun`, `agent-search-relink` own `evidence/` as a TREE; they are all descendants of `tripwire-pack` (via the cutover/gates chain), so not concurrent. `tripwire-scaffold` owns `tsconfig.base.json` (only the completed `scaffold` owned it). `tripwire-pack` owns `pnpm-lock.yaml` and is a descendant of `port-fixes`. If check-disjoint reports `tripwire-reverse-migrate` concurrent with a state owning `evidence/` as a tree, move its evidence to `docs/plan/stealth-browser/evidence/tripwire-reverse/` and keep it out of tree owners by making them ancestors/descendants |

### 6.4 Fastest order
```
now:        port-fixes (in progress) -> cdp-test-harness -> capture-upgrade / chrome-lifecycle -> ... -> tests-use-cases -> agent-search-cutover -> ...
parallel:   [plan amendments] -> tripwire-scaffold -> tripwire-core -> tripwire-interactive -> tripwire-docs -> tripwire-pack(also waits port-fixes) -> tripwire-reverse-migrate
join:       agent-search-cutover waits for tripwire-pack; merge-readiness waits for tripwire-reverse-migrate
post-release: agent-search-relink || tripwire-reverse-relink
```
The tripwire chain is five states deep against a stealth chain of roughly fifteen to the cutover, so it is off the critical path. It starts immediately (does not wait for port-fixes) because the scaffold touches only `tsconfig.base.json`, `.adhd/workspace.json` and the new directory; only `tripwire-pack` waits for `port-fixes` (shared `pnpm-lock.yaml`). Cross-repo parts: `tripwire-reverse-migrate`, `tripwire-reverse-relink` (reverse-apis), and the amended `agent-search-cutover`/`agent-search-relink` (scratch). All commits tagged `[psm:<state>]`, explicit paths only.

## 7. Decisions for the user, risks, bugs

### 7.1 Decisions (real ones)
- D1 Domain: add new group `resilience` to `.adhd/workspace.json` (RECOMMENDED; `@adhd/resilience-core-tripwire`; room for FOLLOWUP's rate-limiter/cache) versus reuse `agent` (`@adhd/agent-core-tripwire`, no config edit, poor fit). Everything else in this spec is unchanged by the choice except names/paths.
- D2 ADR-0001 classification: confirm the tripwire is a kill-switch file protocol, not a store (section 2.2). RECOMMEND yes, with the `TripwireStorage` seam as the path to an adapter-backed variant if you later want one.
- D3 Behavior changes to accept: fail-closed on corrupt/unreadable lock; reverse gains block counting + audit; dead `reverifiedAt/resolvedAt` lock writes become audit fields; search keeps agent-callable `clearTripwire` (policy `open`) even though reverse SPEC 12.4 forbids programmatic clear. RECOMMEND accept all; search's open clear is the documented HITL flow (mcp.md:317).
- D4 Publish cadence: same branch and same `pnpm release` as stealth-browser (as you said), versus splitting the tripwire commits to a separate branch for an earlier publish. RECOMMEND same branch; the cost is reverse-apis' merge waits for the stealth release.

### 7.2 Risks
- R1 pnpm-lock/importer: a new workspace member may add an importer entry to `pnpm-lock.yaml` (unverified; owned only by `tripwire-pack`). 
- R2 `link()` unsupported on some volumes (exFAT/network); fallback `wx` covered by tests; NFS makes `O_EXCL` unreliable: keep stateDir local (documented).
- R3 CJS package imported from two `type: module` consumers (agent-browser via tsx, reverse via vitest): named-export detection depends on the emitted `exports.x =` shape; proven by `tripwire-pack.3` and by each consumer's own test run.
- R4 Async API: search call sites gain `await` (about 14 sites); the `--tripwire-status` block relies on top-level await.
- R5 apigen schema drift: moving `TripwireRecord` into a package `.d.ts` could render as `{}` in the MCP output schema; mitigated by the concrete wrapper interface and parity criterion `agent-search-cutover.12`.
- R6 Guard drift: `scaffold.5` and `inv:one-new-package` must be amended first; state.json is claimed by a running orchestrator, so amendments go through the repair path.
- R7 Unit lane cannot prove real two-process races (OD-TW1).
- R8 Not queried: the memory-server (no memory tool in this role); prior art came from the researcher only. No ADR is violated; no ADR file is proposed (the ADR-0001 classification is recorded in the README and the plan's EVALUATIONS, not as a new ADR).

### 7.3 Bugs / debt found (for backlog-operator filing by the dispatcher; I filed nothing)
1. ST:66 audit path ignores `SEARCH_ADHD_DATA_DIR`; `search-guard-test.ts` writes the real `~/.adhd/reverse/data/audit.log`; ST:183-185 mkdir uses `homedir()` regardless of `SEARCH_AUDIT_PATH`.
2. CLI `--tripwire-status` (CS:190) lists expired locks as tripped; MCP `tripwireStatus` hides them (MCP:412).
3. Fixed `.tmp` name in both writers (ST:115, RT:49): cross-process collision.
4. `incrementBlockedCount` read-modify-write loses increments and can resurrect a cleared lock (ST:157-162).
5. Audit cap rewrite is non-atomic and char-indexed (ST:187-204).
6. TTL expiry removal is silent (ST:149-152).
7. Corrupt/unreadable lock treated as clear in both (ST:102-109, RT:37-44).
8. Overwrite-on-retrip erases first-cause forensics (ST:214-247, RT:77-82).
9. Lock/audit files created with default modes despite URLs/queries (ST:116, RT:50).
10. Reverse writes no audit log despite REARCHITECTURE 12.6.
11. `cdp-search.ts` HITL prompts hang on closed stdin (CS:274-295,333-336).
12. `tools/unlock-tripwire` has no `project.json`; its spec probably never runs under `nx run-many -t test` (unverified).
13. Dead writes `setResolved`/`setReverified` immediately before `clearTripwire` (ST:273-284; CS:446-447).

### 7.4 Claims needing proof (not verified by running anything)
- pnpm-lock importer behavior for a dependency-free new package (R1); `link()` on the target volume; the exact flag spelling `--access public --publish true` of the `core` generator (taken from CLAUDE.md, dry-run required); the generated template's module format (ADR-0003 conformance asserted by `tripwire-scaffold.3`); whether `nx run-many -t test` covers `tools/unlock-tripwire`; that the agent-browser tsx ESM runtime resolves named imports from the CJS dist (R3); the `reverse-apis` root `package.json` is the only dependency manifest used by vitest (no pnpm-workspace.yaml found).
