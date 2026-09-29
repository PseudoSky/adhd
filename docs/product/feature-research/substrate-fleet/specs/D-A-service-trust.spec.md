# D-A — Trustworthy service layer: readiness, config-drift, and verified writes

> **Ticket:** `4503046c-91fe-4bd5-948d-bc594e7f6598` (HIGH) · absorbs `433e940a`, `2742c0be`, `6619af05`, `2d89e154`, `8dff910a`
> **Design:** `../DESIGN.md` §2 D1/D2 (incl. Findings 1–3), §3 refusals, §5; `../SOX-REQUIREMENTS.md` SR-8, SR-15
> **Cross-plane:** adhd (`entrypoint/backlog`, `apigen-plugin-mcp`) + sox (`libs/memory-core`) + host configs (`.mcp.json`, `opencode.json`, `.codex/config.toml`)
> **ADRs read:** ADR-0001 (store atomicity; typed config, never env-as-feature-toggle), ADR-0002 (correct the source), ADR-0003 (CJS-only publish), ADR-0004 (flat MCP `content`).
> **Scope guard:** D-A is **host / config / process lifecycle**. It adds **no** backlog verb and no graph write.

## DoR

- **Owner repo:** **cross-plane** — adhd (`entrypoint/backlog`, `apigen-plugin-mcp`) + sox (`libs/memory-core`) + host configs (`.mcp.json`, `opencode.json`, `.codex/config.toml`). · **Wave:** unstated (substrate pass-2 has no wave assignment — a gap, not an assumption). · **Dependencies:** none for the adhd-side work. · **Evidence requirement:** default-running lifecycle/readiness/resilience e2e tests (latches + injected virtual clock; never `sleep`) for AC1–AC4/AC6. **AC5 is a `libs/memory-core` provider requirement and is NOT satisfiable from adhd** — its test can only run where the sox repo is present; the adhd side files it as a cross-repo request (adhd ADR-0002 D4) and must not claim it closes here.

## Summary

Make "the tools exist" a **provable** claim instead of a hopeful one. A long-lived local service silently becomes absent or unusable while adjacent clients stay healthy because *reported state is decoupled from real state*: a handshake success is treated as "serving", a config key that a host silently ignores still starts a server, a dropped field still returns `{ok:true}`. D-A fixes the three seams — **process** (a `starting / live / ready` trichotomy, readiness exercised on the **serving path**, and a watchdog for the hung-but-alive loop), **config** (a stated total precedence, absolute paths only, unknown key = hard error, and a load-time path-exists + identity-drift check), and **resilience** (one composed retry + full-jitter + bounded budget + breaker around connect/handshake, plus the `server/discover` / `-32022` era fall-forward) — and, on the substrate side, **verify-after-write** so a success envelope implies persistence.

## Premise corrections (read before implementing)

1. **There is no lifecycle today.** `serve.ts` wires `SIGTERM/SIGINT → AbortController` and calls `startBacklogServer`; `startBacklogServer` resolves env, opens the store, mounts transports, and returns `Promise<void>` on close (in `server.ts`). No state, no readiness, no watchdog. The trichotomy is entirely new — do not claim it exists. (Cited by symbol; line anchors rot on every edit.)
2. **Precedence already exists; validation does not.** `@adhd/environment`'s `FieldSpec` cascade (code defaults → system → global → project → local → env vars; `environment-base-spec` `ProvenanceSource`) and `resolveBacklogDbPath` (in `env.ts`) implement precedence. What is missing is (a) **unknown-key rejection** and (b) **absolute-path enforcement**. D-A does **not** reinvent the cascade; it validates the resolved result. `EnvironmentSpec` has no unknown-key concept today (`environment-base-spec`'s index) — so scope the strict check to the `service.*` subtree plus the wholly-owned host entry (below), never a blanket rejection of every `config.yaml` key.
3. **"Not more retries" and "retry + jitter + breaker" are reconcilable only in one order.** The measured cause is the host's ~5 s per-request deadline vs a ~14 s cold start. Fix it by **extending the deadline first** (`connect.graceMs`), then retry **within a bounded budget** — never by multiplying the deadline per attempt. The composed policy must be bounded in wall-clock, not in attempt count alone.
4. **The repo's own `.mcp.json` is a live instance of the drift D-A must catch.** It points the backlog server at a **git worktree** path (in `.mcp.json`) — a directory that can be removed. The load-time check must refuse to start on a missing resolved path and name it.
5. **Verify-after-write (SR-8, ticket Change 7 / AC5) is a provider requirement in the sox repo** (`libs/memory-core`'s `memory_write_batch`), not the adhd repo. If `libs/memory-core` is not present on the executing machine, the accepter files it as a cross-repo request per ADR-0002 D4; **it cannot be satisfied from `entrypoint/backlog`** — AC5 is a sox-side requirement.
6. **Do not add `cockatiel` without approval.** The design names it; repo AGENTS.md requires human approval for external tools. The required behaviour (full jitter + bounded budget + a three-state breaker) is ~60 lines of dependency-free TypeScript; implement `retry-policy.ts` and treat adopting `cockatiel` as a separate, approval-gated decision. **Do not gate any of this behind an env var** — the behaviours are default-on (AGENTS.md: an env var that *enables* a feature is itself the debt).

## Files

| Package / Repo | Path | Change | Read tokens | Output tokens |
|----------------|------|--------|-------------|---------------|
| entrypoint/backlog | `src/service-config.ts` | create | 0 | 500 |
| entrypoint/backlog | `src/lifecycle.ts` | create | 0 | 240 |
| entrypoint/backlog | `src/watchdog.ts` | create | 0 | 200 |
| entrypoint/backlog | `src/readiness.ts` | create | 0 | 220 |
| entrypoint/backlog | `src/retry-policy.ts` | create | 0 | 260 |
| entrypoint/backlog | `src/errors.ts` (or colocated) | modify (5 typed errors) | 120 | 160 |
| entrypoint/backlog | `src/server.ts` | modify (handle + states + drift check + resilience) | 260 | 380 |
| entrypoint/backlog | `src/serve.ts` | modify (handle, `--ready-file`/`--probe`, supervisor) | 120 | 220 |
| entrypoint/backlog | `src/env.ts` | modify (`service.*` fields on the spec) | 90 | 120 |
| entrypoint/backlog | `src/cli.ts` | modify (route `--probe`) | 60 | 40 |
| entrypoint/backlog | `src/install.ts` | modify (validate the written entry; record identity) | 120 | 120 |
| entrypoint/backlog | `src/index.ts` | modify (export the handle + report types) | 30 | 30 |
| entrypoint/backlog | `.mcp.json` (repo root) | modify (stable path + identity) | 0 | 20 |
| packages/apigen/apigen-plugin-mcp | `src/lib/discover.ts` | create | 0 | 220 |
| packages/apigen/apigen-plugin-mcp | `src/lib/run.ts` | modify (register discover + fall-forward) | 120 | 120 |
| **sox** `libs/memory-core` | `memory_write_batch` handler | modify (**provider requirement**, SR-8) | — | — |
| entrypoint/backlog | `src/service-config.spec.ts`, `src/lifecycle.spec.ts`, `src/readiness.spec.ts`, `src/retry-policy.spec.ts`, `src/server.lifecycle.e2e.ts`, `src/serve.readiness.e2e.ts` | create | 0 | 1 800 |

## Config schema

### `src/service-config.ts` (NEW)

```typescript
export type IServiceTransport = 'mcp' | 'http' | 'both';

export interface IArtifactIdentity {
  kind: 'path' | 'package';
  /** kind:'path' — sha256 hex of the resolved entry file. */
  sha256?: string;
  /** kind:'package' — the published name + version to match. */
  name?: string;
  version?: string;
}

export interface IServiceConfig {
  transport: IServiceTransport;
  port: number;
  host: string;
  scope: Scope;
  namespace: string;
  /** MUST be absolute (or the literal ':memory:' test path). */
  dbPath: string;
  busyTimeoutMs: number;
  server: {
    /** Absolute path, or a PATH-resolvable bin (`npx`/`node`). */
    command: string;
    args: string[];
    identity: IArtifactIdentity;
  };
  readiness: { timeoutMs: number; intervalMs: number; maxMissedTicks: number };
  connect: {
    /** Pre-connect deadline extension — the cold-start grace window. */
    graceMs: number;
    /** Total wall-clock budget across all attempts (bounded, never unbounded). */
    budgetMs: number;
    maxAttempts: number;
    baseMs: number;
    maxMs: number;
    breakerFailureThreshold: number;
    breakerResetMs: number;
  };
}

/**
 * TOTAL precedence (highest first), stated and tested:
 *   1. explicit StartOpts fields,
 *   2. `ADHD_BACKLOG_*` env vars (via the existing `@adhd/environment` FieldSpec cascade),
 *   3. the `service.*` subtree of the scope `config.yaml` layer files
 *      (`backlogConfigLayerFiles` in `embedding-config.ts` — reused, never re-derived),
 *   4. code defaults below.
 * An UNKNOWN key under `service.*` in any layer file → UnknownConfigKeyError{key,file}.
 * A non-absolute path for `dbPath`/`server.command` (when a path) → NonAbsolutePathError{field,value}.
 */
export function resolveServiceConfig(opts: StartOpts, env: Environment<BacklogConfig>): IServiceConfig;

/** The schema owner for the `service.*` subtree — the allow-list unknown keys are checked against. */
export const SERVICE_CONFIG_KEYS: readonly string[];

/**
 * Validates ONE host MCP server entry the tool writes/reads. Unknown keys are a
 * HARD ERROR (the recorded `environment` vs `env` silent no-op is the exact
 * failure): a key outside the entry's own schema (`type/command/args/env/url`)
 * → UnknownMcpConfigKeyError{entry,key,suggestion?}; a relative `command` path
 * that is not a PATH-resolvable bin → NonAbsolutePathError.
 */
export function assertMcpEntryValid(entry: unknown, hostPath: string): asserts entry is IMcpServerEntry;
```

### `src/env.ts` — `service.*` fields on the spec

Add a `service.*` family to `backlogEnvironmentSpec.config` (in `env.ts`) so the cascade resolves it: `service.transport`, `service.port`, `service.host`, `service.namespace`, `service.serverCommand`, `service.serverArgs` (array), `service.connectGraceMs`, `service.connectBudgetMs`, `service.readinessTimeoutMs`, `service.readinessIntervalMs`, `service.readinessMaxMissedTicks`. These are legitimate configuration (paths, ports, timeouts) — **not** feature toggles. `SERVICE_CONFIG_KEYS` is the frozen mirror of this list; a unit test asserts the two cannot drift.

### Typed errors (`src/errors.ts`)

```typescript
export class UnknownConfigKeyError extends BacklogWriteError { code='E_VALIDATION'; key; file; }
export class NonAbsolutePathError extends BacklogWriteError { code='E_VALIDATION'; field; value; }
export class UnknownMcpConfigKeyError extends BacklogWriteError { code='E_VALIDATION'; entry; key; suggestion?; }
export class ArtifactDriftError extends BacklogWriteError { code='E_VALIDATION'; expected; actual; resolvedPath; }
export class ServiceNotReadyError extends BacklogWriteError { code='E_VALIDATION'; state; failure; }
```

## Readiness contract

### `src/lifecycle.ts` (NEW)

```typescript
/** Exactly the three states DESIGN §2 D1 names. Failure/stop are transitions, not states. */
export type IServiceState = 'starting' | 'live' | 'ready';

export interface IServiceFailure { kind: 'liveness' | 'readiness'; code: string; message: string; subject?: string; }

export interface IServiceReport {
  state: IServiceState;
  since: string;
  /** Present on a failure. A liveness failure means RESTART; a readiness failure means REPORT ONLY, no restart. */
  failure?: IServiceFailure;
  lastTickAt?: string;
  degraded: boolean;
}

export interface IServiceLifecycle {
  state(): IServiceState;
  report(): IServiceReport;
  /** starting → live (transport accepting). */
  markLive(): void;
  /** live → ready (the serving-path probe passed). Idempotent. */
  markReady(): void;
  /** Record a failure WITHOUT changing the state; returns the action the supervisor must take. */
  fail(f: IServiceFailure): { action: 'restart' | 'report' };
  whenReady(): Promise<void>;
}
export function createLifecycle(): IServiceLifecycle;
```

- **`starting`**: env resolved, store opening, `buildBacklogApigenPackage` running (the ~14 s cold-start window), transports not yet accepting.
- **`live`**: the transport accepts connections (stdio connected / HTTP socket bound).
- **`ready`**: `probeReadiness` has exercised the **serving path**.
- **liveness failure → restart**; **readiness failure → `state` unchanged, `failure.kind='readiness'`, NO restart.**

### `src/readiness.ts` (NEW)

```typescript
/**
 * Ready iff the SERVING path answers — NOT a ping and NOT a socket accept.
 * Drives a real trivial op through the SAME composed invoker the tools use
 * (e.g. `embedding-status`, which opens no write transaction and needs no
 * semantic backend). Returns a typed refusal on timeout; never throws raw.
 */
export async function probeReadiness(
  handle: { pkg; operations; store },
  opts: { timeoutMs: number }
): Promise<{ ready: boolean; failure?: IServiceFailure }>;
```

### `src/watchdog.ts` (NEW)

```typescript
export interface IWatchdog {
  /** The serving loop calls this each interval. */
  tick(): void;
  start(): void;
  stop(): void;
  /** Fired when ≥ maxMissedTicks intervals pass with no tick (frozen event loop). */
  onHung(cb: (missedTicks: number) => void): void;
}

export interface ITimer { now(): number; setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void; }
export function createWatchdog(opts: { intervalMs: number; maxMissedTicks: number; timer?: ITimer }): IWatchdog;
```

**A frozen loop cannot run its own timer to detect itself** — detection is driven by a **separate monitor** (the `serve` supervisor, or the host process manager); `watchdog.ts` exposes `tick()`/`lastTickAt` and the supervisor compares. A hung-but-alive process is a **liveness** failure → restart. **Platform gap, stated not papered over:** macOS/launchd has no `WatchdogSec`/`WATCHDOG=1` equivalent, so on macOS the supervisor is the `serve` wrapper or the host; systemd hosts get the native watchdog.

### `server.ts` / `serve.ts` wiring

```typescript
export interface IBacklogServerHandle {
  report(): IServiceReport;
  whenReady(): Promise<void>;
  close(): Promise<void>;
}
/** NEW entry: returns the handle. */
export async function createBacklogServer(opts: StartOpts & { onStateChange?: (r: IServiceReport) => void }): Promise<IBacklogServerHandle>;
/** UNCHANGED signature (`Promise<void>`, resolves on close) — a thin wrapper over createBacklogServer for existing callers. */
export async function startBacklogServer(opts: StartOpts): Promise<void>;
```

`serve.ts` uses `createBacklogServer`; adds `--ready-file <path>` (write the `IServiceReport` once `ready`, atomically rewritten on state change) and a hidden `--probe` mode (run `probeReadiness` once, print the report, exit 0/1) — both host-carved-out like `serve` (`server.ts`'s host-carve-out set, `cli.ts`). A state transition is logged once with the failure reason.

## Load-time drift check

```typescript
/**
 * Resolve `server.command` to an absolute path (or a PATH-resolvable bin
 * recorded with its resolved path), assert it EXISTS, is EXECUTABLE, and its
 * content identity matches `server.identity`:
 *   kind:'path'    → sha256(resolved file) === identity.sha256
 *   kind:'package' → the resolved package's package.json version === identity.version
 * On missing/drift → ArtifactDriftError{expected, actual, resolvedPath} — refuse to
 * start and NAME the resolved absolute path. Pure read; mutates nothing.
 */
export function assertServerArtifact(server: IServiceConfig['server']): void;
```

## Resilience (retry + jitter + breaker)

### `src/retry-policy.ts` (NEW)

```typescript
export interface IResiliencePolicy {
  maxAttempts: number; baseMs: number; maxMs: number; budgetMs: number;
  breakerFailureThreshold: number; breakerResetMs: number;
}
/** Full jitter: rand() * min(maxMs, baseMs * 2**attempt). Deterministic under an injected rand(). */
export function fullJitterDelay(attempt: number, p: IResiliencePolicy, rand: () => number): number;

export type IBreakerState = 'closed' | 'open' | 'half-open';
export class CircuitBreaker {
  constructor(p: { failureThreshold: number; resetMs: number; now?: () => number });
  state(): IBreakerState;
  tryPass(): boolean;     // open → refuse (no attempt)
  onSuccess(): void;      // → closed
  onFailure(): void;      // → open after threshold
}

/**
 * Wrap the connect/handshake of ONE call. Applies `graceMs` to the FIRST
 * attempt's deadline (the cold-start window) BEFORE any retry, then retries
 * with full jitter inside a total `budgetMs`; refuses immediately when the
 * breaker is open. `deps.rand/now/sleep` are injectable so tests use a virtual
 * clock and a seeded rand — NEVER a real sleep.
 */
export async function withResilience<T>(
  fn: (attempt: number, deadlineMs: number) => Promise<T>,
  p: IResiliencePolicy,
  breaker: CircuitBreaker,
  deps: { graceMs: number; rand: () => number; now: () => number; sleep: (ms: number) => Promise<void> }
): Promise<T>;
```

Bound: `sum(delays) + attempts' duration ≤ p.budgetMs`, else `ServiceNotReadyError`. A mid-session drop surfaces a typed reason (`liveness`) and the next call recovers after reconnect with no hang (AC6).

## MCP era — `server/discover` + `-32022` fall-forward

### `packages/apigen/apigen-plugin-mcp/src/lib/discover.ts` (NEW)

```typescript
/** Advertises the negotiated era so a modern host can discover before initialize. */
export function registerDiscover(server: Server, info: { name: string; version: string; eras: string[] }): void;
/** Negotiation: on `-32022` (era mismatch / method unavailable), fall forward to the legacy
 *  initialize+tools/list path and retry the connection ONCE. Never silent. */
export async function withEraFallback<T>(connect: () => Promise<T>, report: (reason: string) => void): Promise<T>;
```

`run.ts`'s `createMcpServer()` calls `registerDiscover(...)`; the connect path wraps the first connect in `withEraFallback`. Additive — an older host that never calls `server/discover` keeps the legacy path unchanged. (Confirm the exact `-32022` spelling against `@modelcontextprotocol/sdk@1.29.0` at implementation; if the SDK uses a different era error code, use that constant and cite it.)

## Verify-after-write (provider — sox `libs/memory-core`)

`memory_write_batch` must, before returning `{ok:true}`, **read every supplied structured field back** (`topic`/`tags`/`importance`/`summary`) from the fresh persisted row; if any is absent, **fail naming the field** — never a success with a partial record. The adhd side has no code for this; it is the SR-8 provider requirement and blocks AC5.

## Migration

1. **`.mcp.json` (repo root)** — repoint `backlog` from the worktree path to a stable absolute path (or the `npx @adhd/backlog@latest` form) and record its `identity`; the load-time check will otherwise refuse to start on the next worktree cleanup. `.mcp.json.bak-20260922T214041Z` is a dead artifact — leave it.
2. **Config** — new `service.*` keys default; existing invocations are unchanged **except** that a previously-silently-ignored unknown `service.*` key or an unknown host-entry key now fails loudly. That is the deliberate break; document it and fix any in-repo configs it surfaces.
3. **No store/schema migration.** No data backfill. `startBacklogServer`'s public signature is unchanged; `createBacklogServer` is additive.
4. **`opencode.json`/`.codex/config.toml`** written by `install.ts` gain the validated shape; `install` runs `assertMcpEntryValid` on what it writes (write-time) and a `--check` read pass validates existing files.

## Test list (each AC → a test + its negative control)

| AC | Test (real components, no mocks on the thing under test) | Negative control (must go RED) |
|----|-----------------------------------------------------------|-------------------------------|
| AC1 | `resolveServiceConfig` on a layer file with an unknown `service.*` key **and** on a host entry with `environment` (not `env`) → `UnknownConfigKeyError`/`UnknownMcpConfigKeyError` naming key+file; a relative `server.command` → `NonAbsolutePathError` | A validator that only checks required keys are **present** (not that unknown keys are absent) → the `environment` case passes → red |
| AC2 | `assertServerArtifact` on a path that no longer exists → refuses, `ArtifactDriftError.resolvedPath` is the absolute path; and on a file whose sha256 ≠ identity → drift | A launcher that starts anyway (phantom) → the missing-path case starts → red |
| AC3 | `withResilience` wrapped around a fake connect that blocks on a **latch**, released only after `> oldDeadline`, with an injected virtual clock + seeded rand → succeeds inside `graceMs`; assert total wall-clock `< budgetMs` and **no real sleep** in the harness | Poll without a grace window (single hard deadline) → the slow start fails → red |
| AC4 | `probeReadiness` against a transport that accepts the socket but returns an error for the probe op → `ready:false`, `failure.kind==='readiness'`, lifecycle stays `live`, **no restart** requested; a hung loop (missed ticks) → `failure.kind==='liveness'` + restart | A socket-only readiness check (accepts ⇒ ready) → the not-serving case reports ready → red |
| AC5 | `memory_write_batch` with `topic`/`tags`/`importance`/`summary` on a **fresh process**: every field re-read equal; an injected field-drop → the call **fails** naming the field — **provider requirement, NOT closable from adhd; runs in `libs/memory-core` only** | The current silent-drop path → the round-trip assertion fails → red (runs in the sox repo) |
| AC6 | Force a mid-session transport drop → a typed `liveness` failure is surfaced; the next call reconnects (breaker half-open) and succeeds within budget, no hang (bounded deadline, latch-driven) | Swallow the drop (call hangs to the caller deadline) → the "no silent hang" assertion fails → red |

**Concurrency / timing discipline.** AC3/AC6 use latches + an injected virtual clock; assert bounded deadlines, never `sleep`. All lifecycle tests run default (no env gate); only AC5 (if it needs a real LLM/paid service — it does **not**) would qualify for a gate, and it does not, so it runs by default. Trust runner exit codes, not stdout.

## Blast radius (gitnexus)

> `gitnexus` is not exposed in this agent's tool set — **read-derived**. Run `gx impact startBacklogServer`, `gx impact runBacklogCli`, `gx impact installSkillToHosts`, `gx impact run` (apigen-plugin-mcp) before editing.

- **`startBacklogServer`** — exported from `index.ts`; callers: `serve.ts`, `server.spec.ts`, `server.e2e.ts`, `server.published-layout.e2e.ts`, `serve.spec/e2e.ts`, `test/fixtures/mcp-stdio-entry.js`. Keeping its `Promise<void>` signature (wrapper over the new handle) keeps all callers compiling — **do not change it**; add `createBacklogServer`. **HIGH** attention on the wrapper's semantics (resolve-on-close preserved).
- **`runBacklogCli`/`cli.ts`** — `--probe` must be added to the host-carve-out set (`BACKLOG_HOST_COMMANDS`, `server.ts:159-163`) and special-cased before the apigen mount, or `assertHostCarveOut` fails the mount. **MEDIUM**.
- **`install.ts` `registerMcp*`** — now validates the entry it writes; a previously-accepted hand-edit shape could be rejected. **MEDIUM**; `install.spec.ts`/`install.mocked.spec.ts` updated.
- **`env.ts` `backlogEnvironmentSpec`** — adding `service.*` fields widens the generated `fieldSchema`; `env.spec.ts` covers it. **LOW**.
- **`apigen-plugin-mcp` `run.ts`** — shared by **every** apigen MCP host; `registerDiscover`/`withEraFallback` must be additive or every host regresses. `nx affected -t test` for the plugin (it has dependents). **MEDIUM**.
- **sox `memory_write_batch`** — other repo; independent blast radius there; the adhd-side AC5 test can only run where `libs/memory-core` is present.

## Independent segments (execution order)

### Segment A — Config + errors
- **Files:** `src/service-config.ts` (create), `src/errors.ts`, `src/env.ts`.
- **Deps:** none. **Read:** `env.ts`'s spec + `resolveBacklogDbPath`, `install.ts`'s entry writers, `embedding-config.ts`'s `backlogConfigLayerFiles` (~250 tok). **Out** ~700.
- Strict check scoped to `service.*` + the host entry; absolute paths; `SERVICE_CONFIG_KEYS` frozen + drift test.

### Segment B — Lifecycle + watchdog + readiness
- **Files:** `src/lifecycle.ts`, `src/watchdog.ts`, `src/readiness.ts`.
- **Deps:** none (pure + injected timer). **Read:** `server.ts`'s `startBacklogServer` region (~180 tok). **Out** ~660.

### Segment C — Resilience
- **Files:** `src/retry-policy.ts`.
- **Deps:** none. **Read:** 0. **Out** ~260.
- Full jitter, bounded budget, three-state breaker; injected clock/rand/sleep only.

### Segment D — Server/serve wiring + drift check
- **Files:** `src/server.ts`, `src/serve.ts`, `src/cli.ts`, `src/index.ts`, `.mcp.json`.
- **Deps:** A, B, C. **Read:** `server.ts`'s `startBacklogServer`, `serve.ts`, `cli.ts` (~320 tok). **Out** ~600.
- `createBacklogServer` additive; `startBacklogServer` keeps its signature; host-carve-out for `--probe`.

### Segment E — MCP era
- **Files:** `apigen-plugin-mcp/src/lib/discover.ts` (create), `run.ts`.
- **Deps:** none. **Read:** `apigen-plugin-mcp`'s `run.ts` (~120 tok). **Out** ~340.
- Additive; confirm `-32022` against the installed SDK.

### Segment F — Provider request (sox)
- **Files:** `libs/memory-core` (`libs/memory-core`). **Deps:** none adhd-side. Cross-repo per ADR-0002 D4; blocks the adhd-side AC5 test only.

### Segment G — Tests
- **Files:** the six spec/e2e files. **Deps:** all. **Read** ~200. **Out** ~1 800.

## Documentation

- `entrypoint/backlog/README.md` + `skill/SKILL.md`: the `starting/live/ready` contract, `--probe`/`--ready-file`, the `service.*` config keys + precedence, `install --check`.
- Root `AGENTS.md` / `PUBLISHING.md`: the load-time drift check (`.mcp.json` must carry a stable absolute path + identity).
- `apigen-plugin-mcp/README.md`: `server/discover` + `-32022` fall-forward.
- State the **platform gap** (no macOS launchd watchdog analogue) wherever the watchdog is described — do not paper it over.
