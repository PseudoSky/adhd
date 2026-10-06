# SPEC — Provider failure: typed taxonomy, retry/failover policy, propagation up the dispatch chain, top-of-chain behavior

> **Provenance.** Source: architect analysis for backlog `40fde12c` (verdict: **SPEC**, necessity established).
> Dispatch: `dispatch-2026-10-06-48dc`. Written: 2026-10-06 against `feat/dg1-provider-registry-48dc` (includes D-G(1)+(2)).
> Status: **DRAFT for adversarial review** (AC2 of `40fde12c`). Research: memory episodes `01M49GMYVDWX8ZFXW3V9VB5H9A`, `01M49GN4R7WVR848M7JXPY6G75`, `01M49GPDJ62VDRWCY6Z7DF1SNV`, `01M49GPDSRJ96FA8RGTCE4F3SW`, `01M49GPF2X2QCS42PGFVKRD02K`, `01M49GPGGJKBX6QS4RZ6PP27V8`, `01M49GPY4QTBT212GYZ69S82C5`, `01M49GQ6X90E6RE50WXWZ0XEZ6` (tag `provider-failure`).
> Related: `caebab15` (D-G(4), **absorbed** here), umbrella `5b632a6b`, `ea70022a`, `fc466f0b` (climb-to-root), tracing `docs/plan/agent-tracing/SPEC.md` (`5b98d3b2`).
> Constraints honoured: ADR-0002 (fix at source; no consumer shims), ADR-0004 (flat `content` payload; no envelope), ADR-0008 D6, ADR-0012 / AGENTS.md parallel-process invariant, no env feature toggles (ADR-0001 / sox ADR-0013).

## VERDICT — NECESSITY ESTABLISHED (REFUTE rejected)

Evidence that handling is not merely "partial" but wrong in ways that cost money and lose information (all in this worktree):

1. **Retry retries everything.** `providers/anthropic.ts:~320-338` and `openai.ts:~219-231` wrap `run` in `pRetry` whose `onFailedAttempt` aborts only on `signal.aborted` (and 401 on Anthropic). A 400/402/403/context-length error is retried `retries` times. Opt-in: only when `retryConfig` is set.
2. **Retry stacks multiplicatively.** The SDK clients are built with no `maxRetries` (`anthropic.ts:107,113`, `openai.ts:147`); both SDKs retry 408/409/429/>=500 by default (2x, Retry-After honored up to a cap). Any `retryConfig` therefore multiplies SDK retries x p-retry retries, and a billing-class 429 is retried by status alone (research gotcha 8).
3. **Classification is string/status matching in the engine.** `engine/orchestrator.ts:~541-586` maps 401 / 429 / `rate limit` substring / `context_length_exceeded` substring. No billing (402, Anthropic `billing_error`, OpenAI `credit_balance_exhausted`/`*_spend_limit_exceeded` which arrive as **429**), no overloaded (Anthropic 529, OpenAI/OpenRouter 503), no `retry-after`, no headers read at all.
4. **Information is flattened to a string at every hop.** `ToolError` already has `data?` (`validation/errors.ts:31`) but is never given any; the task row stores `error: "[CODE] message"` (`orchestrator.ts:~1503-1520`); the synchronous `task`/`task_run` output returns `{task_id,status,result,usage}` with **no `error` field** (`tools/task.ts:~296-305, 514-520`) — a delegating parent sees `status:'failed'` and nothing else; dispatch `poll()` gets only `error?: string` (`dispatch-orchestrator/src/lib/agent-runner.ts:~153-165`).
5. **No failover and no attempt record.** `PartialBinding.models` exists (`agent-base-types/src/provider-binding.ts`, "consumed by D-G(4)") and is read by nothing.
6. **No top-of-chain definition.** `dispatchUnit` treats any non-`completed`, non-`awaiting_input` status as `failed`/ops failed (`dispatch-orchestrator/src/lib/orchestrator.ts:~1414-1437`); `dispatch-cli run` prints JSON and exits 0 on unit failure, exits 1 only on a thrown error (`entrypoint/dispatch-cli/bin/cli.ts:~54-58`). A 402 on unit 1 of N lets units 2..N burn identical failing calls; a top-up has no resume path.
7. **claudecli carries no machine-readable failure.** `providers/claudecli.ts:~455-480` throws `Error("PROVIDER_ERROR: claude CLI returned error: <text>")`; the ONLY signal is text.

HITL suspension (`task_resume`) is **in-memory** (`hitlResolvers`, `tools/task.ts:~884-897`: process restart => task failed `TASK_NOT_RESUMABLE`). Any "wait for a top-up" design must therefore not depend on a live process (PF-6).

## SUMMARY

One typed value, `ProviderFailure`, produced by ONE deterministic classifier per provider from (status, error type/code, headers, transport), carried on `ToolError.data` -> persisted on the task row/event -> returned by `task_read`/`task_run`/`tasks_batch` -> read by dispatch `poll()` -> recorded on the `dispatch_log` entry -> mapped to a CLI exit code + JSON payload at the root. ONE retry owner (a per-call attempt engine in the orchestrator; SDK `maxRetries: 0`; `p-retry` removed) applies a per-class policy (retry-same with full-jitter backoff honoring `retry-after`; failover to next `models[]` entry; terminal; suspendable). D-G(4) is absorbed as that engine's failover loop. Propagation is **fail-up (typed terminal status), not ask-escalation**: ADR-0008 D6's `escalate` routes a *decision* a parent can make; a billing/auth failure is a credential-scoped fact no ancestor can cure, so only the *carrier* (park in `awaiting_input` with a resume token) is reused, and only for suspension. The root either suspends durably (billing/auth, resumable) or exits with a distinct code and a resume recipe.

## OWNERSHIP / DEP DIRECTION

`agent-base-types` (types: `ProviderFailure`, error codes, hook payloads) <- `agent-core-provider` (pure `classifyProviderError`, backoff math; DATA/pure, no SDK imports) <- `agent-engine-orchestrator` (SDK-error extraction, attempt engine, persistence calls) <- `entrypoint/agent-mcp`. `agent-store-runtime` gains `tasks.failure`. `dispatch-base-spec` (types only: `DispatchLogEntry.provider_failure`) <- `dispatch-orchestrator` <- `entrypoint/dispatch-cli`. Verify direction with `npx nx graph`/`rg` (boundary lint is dead, `DEBT-WORKSPACE-LINT-BOUNDARIES-001`). No new package: the classifier is a module in `agent-core-provider` (Two-Use rule: it is reused by orchestrator providers, claudecli, and any future gateway host).

## 1. FAILURE TAXONOMY

```ts
// agent-base-types/src/provider-failure.ts (new)
export type ProviderFailureClass =
  | 'rate_limited'      // transient quota: 429 w/ retry-after, OpenAI rate_limit / slow_down, OpenRouter 429
  | 'overloaded'        // Anthropic 529, OpenAI/OpenRouter 503 provider_overloaded
  | 'unavailable'       // 500/502/503(no-route excluded), network reset, OpenRouter provider_unavailable
  | 'timeout'           // 408/504, client AbortSignal.timeout (selection.timeoutMs)
  | 'billing'           // 402; Anthropic billing_error + enforced_spend_limit_reached; OpenAI credit_balance_exhausted, *_spend_limit_exceeded, insufficient_quota; OpenRouter limit_source credits/key_limit
  | 'auth'              // 401
  | 'permission'        // 403 non-moderation (incl. OpenAI unsupported region)
  | 'invalid_request'   // 400/404/413/422 (non-context)
  | 'context_length'    // context_length_exceeded, "prompt is too long", OpenRouter max_tokens/context types
  | 'content_policy'    // OpenRouter 403 moderation, content_policy_violation, refusal
  | 'cancelled'         // caller abort (never retried, never a "failure" to report upward as provider fault)
  | 'unknown';
export type FailureScope = 'request' | 'model' | 'credential';   // credential => every sibling/ancestor sharing credentialKey fails the same way
export interface ProviderFailure {
  readonly v: 1;
  class: ProviderFailureClass;
  scope: FailureScope;
  retryable: boolean;            // would a LATER identical call plausibly succeed without human action
  resumable: boolean;            // succeeds after a human/time action (billing top-up, window reset)
  retryAfterMs?: number;         // parsed per §2.3, uncapped raw value
  providerType: 'anthropic'|'openai'|'claudecli';
  status?: number;
  providerErrorType?: string;    // Anthropic error.type / OpenAI error.type / OpenRouter metadata.error_type
  providerErrorCode?: string;    // OpenAI error.code / Anthropic details.error_code
  requestId?: string;
  modelRef: string; wireModel: string; credentialKey: string; // credentialKey = sha256(providerType|baseURL|secretEnvName) truncated; never a secret
  message: string;               // provider message, truncated 500
  source: 'http' | 'stream-event' | 'cli-text' | 'transport';
  attempts: AttemptSummary[];    // capped 20, see §5
  hops: FailureHop[];            // §4
  classifierVersion: number;
}
```

### 1.1 Deterministic classifier

`classifyProviderError(raw: RawProviderError): Omit<ProviderFailure,'attempts'|'hops'|...>` — pure, total (never throws), no regex over free text on the `http`/`stream-event` path. `RawProviderError = { providerType, baseURL?, status?, headers?: Record<string,string>, body?: unknown, errorName?, transport: 'http'|'stream-event'|'cli-text'|'transport', text? }`. Rules applied in order; first match wins; the table is data in `agent-core-provider/src/failure/rules.ts` with one fixture file per provider.

| # | Match | class / scope / retryable / resumable |
|---|---|---|
| 1 | caller `signal.aborted` | cancelled / request / false / false |
| 2 | OpenRouter (baseURL host `openrouter.ai`): switch on `body.error.metadata.error_type`, then 402 `limit_source`: `openrouter_in_flight_budget` => rate_limited(RA); `openrouter_credits`/`openrouter_key_limit` => billing | per research table |
| 3 | Anthropic: `body.error.type` `billing_error` (402) | billing / credential / false / true |
| 4 | Anthropic 429 with structured `details.error_code==='enforced_spend_limit_reached'` (no message matching) | billing / credential / false / true |
| 5 | Anthropic 400 `invalid_request_error` whose message equals the documented "You have reached your specified API usage limits" | billing / credential / false / true (the single sanctioned message-match, pinned by fixture, because the provider emits no code; marked `LOW-CONFIDENCE` in rules.ts) |
| 6 | OpenAI `error.code` in {`credit_balance_exhausted`,`organization_spend_limit_exceeded`,`project_spend_limit_exceeded`,`organization_usage_limit_exceeded`} or `error.type==='insufficient_quota'` (all 429) | billing / credential / false / true |
| 7 | 429 (remaining) | rate_limited / model / true / false |
| 8 | Anthropic 529 `overloaded_error`; 503 `server_is_overloaded`/`service_unavailable_error`/`provider_overloaded` | overloaded / model / true / false |
| 9 | 401 | auth / credential / false / true (a rotated key fixes it) |
| 10 | 403 + moderation metadata / `content_policy_violation` / `refusal` | content_policy / request / false / false |
| 11 | 403 | permission / credential / false / true |
| 12 | context-length markers: OpenAI/OpenRouter `error.code`/`error_type` in {`context_length_exceeded`,`max_tokens_exceeded`,`token_limit_exceeded`}; Anthropic 400 message prefix `prompt is too long` (second sanctioned message-match, fixture-pinned) | context_length / request / false / false |
| 13 | 408, 504, `AbortError`/`TimeoutError` from the SDK timeout, ETIMEDOUT | timeout / model / true / false |
| 14 | 409 | unavailable / model / true / false |
| 15 | 500, 502, 503 (no-route variant: OpenRouter 503 without `provider_overloaded` => invalid_request), ECONNRESET/ENOTFOUND/ECONNREFUSED | unavailable / model / true / false |
| 16 | 400, 404, 413, 422 | invalid_request / request / false / false |
| 17 | `stream-event` error events: same table keyed on `error.type` (Anthropic `{type:error,error:{type}}`, OpenRouter `finish_reason:"error"`); a 200 whose body is only an `error` object likewise | via rows 3-16 |
| 18 | `cli-text` (claudecli, no status/headers): ordered, anchored, fixture-pinned patterns for `Credit balance is too low`, `Invalid API key`/`authentication`, `rate limit`, `overloaded`, `usage limit reached` => billing/auth/rate_limited/overloaded/rate_limited(resumable window); anything else | unknown / request / false / false |
| 19 | anything else | `status>=500` => unavailable; else unknown / request / false / false (**unknown 4xx is terminal**: never retry what we do not understand) |

claudecli is the weakest link by construction; PF-2 captures real `claude -p --output-format stream-json` error fixtures (Open question Q5) and the classifier row 18 is derived from those, not from memory. If the CLI exposes a structured status/`api_error_status` in the `result` event, row 18 is replaced by the structured rules (ADR-0002: correct the source — if a gap in the CLI's output is the cause, record it upstream rather than growing regexes).

### 1.2 Error codes (wire compat)

`ErrorCode` union (`agent-base-types/src/errors.ts` + `validation/errors.ts` `errorCodeSchema`) gains `PROVIDER_BILLING`, `PROVIDER_OVERLOADED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_INVALID_REQUEST`, `PROVIDER_CONTENT_POLICY`. Mapping: rate_limited->`PROVIDER_RATE_LIMITED`, auth->`PROVIDER_AUTH_ERROR`, timeout->`PROVIDER_TIMEOUT`, context_length->`CONTEXT_WINDOW_EXCEEDED`, permission/unknown->`PROVIDER_ERROR` (unchanged for existing consumers). The `[CODE] message` text convention is kept byte-for-byte for existing readers; the structure rides `ToolError.data = ProviderFailure`.

## 2. POLICY PER CLASS

One owner: `agent-engine-orchestrator/src/providers/call-policy.ts` (`callWithPolicy`), wrapping `provider.chat`. Providers become single-shot: SDK clients `maxRetries: 0`, `pRetry` deleted from `anthropic.ts`/`openai.ts` (remove the dependency if unused). `retryConfig` (existing typed field on `PartialBinding`) now means "this policy's knobs"; its absence no longer disables retry — defaults are designed-in (no opt-in switch): `retries:2, minTimeout:500, maxTimeout:8000, factor:2, deadlineMs:120_000`, jitter = Full Jitter `random(0, min(cap, base*2^n))`.

### 2.1 Table

| class | same-model retry | failover to next `models[]` | after exhaustion at root of the call | breaker |
|---|---|---|---|---|
| rate_limited | yes, wait `max(retryAfter, jitterBackoff)`; honor `retry-after` up to 60s cap, above => treat as exhausted | yes (after retries; or immediately if `retryAfterMs>60s`) | `PROVIDER_RATE_LIMITED`, retryable | open for `retryAfterMs` (min 5s) per (credentialKey,wireModel) |
| overloaded | yes (RA if present) | yes | `PROVIDER_OVERLOADED`, retryable | open 15s |
| unavailable / timeout | yes | yes | `PROVIDER_UNAVAILABLE`/`PROVIDER_TIMEOUT`, retryable | open 15s |
| billing | **never** | only entries whose `credentialKey` differs | `PROVIDER_BILLING`, resumable, scope=credential | credential open until process end or half-open probe every 60s |
| auth / permission | never | only entries with different `credentialKey` | `PROVIDER_AUTH_ERROR`/`PROVIDER_ERROR`, resumable | as billing |
| invalid_request | never | never (the same request is invalid everywhere; see context_length) | `PROVIDER_INVALID_REQUEST` | none |
| context_length | never | yes **only** to an entry with a strictly larger declared context window (registry); else no | `CONTEXT_WINDOW_EXCEEDED` | none |
| content_policy | never | yes, once | `PROVIDER_CONTENT_POLICY` | none |
| cancelled | never | never | existing cancel path | none |
| unknown | never | never | `PROVIDER_ERROR` | none |

### 2.2 Guards

- **Total attempt bound:** <= 6 attempts per call across retry+failover (LiteLLM `ROUTER_MAX_FALLBACKS=5` analogue); <= `deadlineMs` wall total. Whichever first.
- **Inherited retry budget (anti-storm):** `ExecutionContext.retryBudget {deadlineAt, attemptsRemaining}`; a delegated child receives the parent's remaining budget, so N nested levels cannot multiply retries (the SDK-x-p-retry stacking bug, one level up). Child never retries past `deadlineAt`.
- **Idempotency:** an attempt is retryable only if it committed no side effect. API providers (`anthropic`, `openai`): `chat()` is pure until it returns (tool execution happens in the orchestrator after a complete response) — safe; mid-stream failure discards the partial. `claudecli`: the CLI executes tools itself during the call; retry/failover only if the attempt emitted **zero** `tool_use` events (tracked in the stream loop); otherwise the failure is terminal for the call and the partial turn is surfaced. Server-side tools (web_search) are billed-only, retry allowed. The OpenAI SDK idempotency header is NOT relied upon (single-shot SDK now; research gotcha 11).
- **Budget:** each attempt emits `provider:attempt` (§5) so `agent-plugin-budget` call/error counts see retries; failed attempts with no usage are counted as calls (cost unknown, bounded by the attempt bound). `BUDGET_EXCEEDED` is checked before every attempt, not once per turn.
- **Failover is per call, not persisted:** `session.model` / `selection.modelRef` are never mutated (D-G(2) soft-swap semantics intact); the next turn starts at `modelRef` again unless its breaker is open (then it skips to the next entry directly, still recorded as an attempt with outcome `skipped_breaker`).
- **Breakers are an optimization, not correctness:** per-process in-memory maps (parallel-process invariant: other processes keep their own; no claim of a single process, and no correctness depends on sharing). Half-open: one probe call after cooldown.
- **Mixed-provider `models[]`:** each entry is resolved with `registry.resolveModelRef(ref, platform)` into its own (providerType, wireModel, credentialKey); tool-format differences are handled by existing `toolFormatLookup` at provider construction. Messages are provider-neutral already (`Message`), so a mid-conversation provider change is legal.

### 2.3 Retry-After parse (pure, in `agent-core-provider/src/failure/retry-after.ts`)
Order: `x-should-retry` (false => `retryable:false`, true => keep) -> `retry-after-ms` -> `retry-after` float seconds -> `retry-after` HTTP-date (`max(0,date-now)`) -> provider reset headers (hint only) -> none. Value is a **floor**; add jitter; cap at 60s for waiting (the raw value is kept in `ProviderFailure.retryAfterMs` so the root can report "retry at T"). A 429/402 with **no** `retry-after` AND a billing marker is terminal (never a wait).

## 3. COMPOSITION WITH D-G(4)

D-G(4) (`caebab15`: `models=['claude_sonnet_4_6','claude_opus_4_8']`, first 429s, retries second, both attempts in `task_events`; NC remove loop => RED; absence-of-sort AC) is **absorbed**: PF-3 implements its failover loop and attempt trace; the D-G(4) AC is reproduced verbatim as `PF-3.AC-DG4` and `caebab15` is resolved by PF-3's merge (no separate implementation). D-G(4)'s phrase "first 429s" is refined: a 429 retries per §2 first, then fails over (so the original AC is satisfied with a fake server returning 429 + `retry-after` > cap, or `retries:0`). `absence-of-sort`: the engine NEVER reorders `models[]` (no cost/latency sort — OpenRouter's `sort`/`order` interplay is deliberately not replicated; ordering is the caller's).

Seam retained: `resolveSelection` (D-G(2), unchanged) yields `selection.models`; `callWithPolicy(selectionChain: ResolvedAttemptTarget[])` receives targets already resolved to wire models. No change to the selection chain `task ?? session ?? agent ?? global`.

## 4. PROPAGATION — hop by hop

Principle: **fail-up with a typed value**; each hop may *retry*, *failover*, *surface*, or *suspend*, per the matrix; none may re-stringify.

```ts
export interface FailureHop { taskId: string; agentName?: string; role: 'origin'|'child-of'|'unit'|'root'; at: string }
// origin appended by the task that made the provider call; each ancestor appends 'child-of'
```

| Hop | Receives | May do | MUST NOT |
|---|---|---|---|
| H0 provider call -> orchestrator | raw SDK/CLI error | classify; retry-same; failover (§2) | leak SDK error objects past this boundary |
| H1 orchestrator -> own task | `ProviderFailure` | persist on task row + `TASK_FAILED`/`PROVIDER_ATTEMPT` events; **suspend** (billing/auth, iff `nativeTooling.hitl!==false`, §6); else **fail** | retry beyond the call-policy bound |
| H2 child task -> parent (delegation via `task`/`tasks_batch`) | `{status:'failed', error, failure}` in the tool result (isError JSON payload, ADR-0004 flat) | parent *engine* (not model) rule below | auto-retry the delegation (budget already spent) |
| H3 dispatch unit (poll) | `failure` from `task_read` | map to unit disposition (§7) | treat as guard failure / inject a correction milestone |
| H4 dispatch-cli root | cycle result with `providerBlocked` | exit code + payload (§8) | exit 0 on provider-blocked work |

**H2 engine rule.** When a delegated child result carries `failure`:
1. `failure.scope==='credential'` AND `failure.credentialKey === parent selection credentialKey` => the parent would fail identically: the parent engine **does not give the model another turn**; it terminates itself with the same `ProviderFailure` (hops appended) — or suspends per §6.
2. Otherwise (different credential, or `request`/`model` scope) => the failure is returned to the parent model as a normal tool error carrying the structured summary (`class`, `retryable`, `message`); the parent model may choose. The engine does not retry.
3. A `cancelled` child never produces `failure`.

**Relation to ADR-0008 D6 / `fc466f0b`.** D6 `escalate` carries a *permission decision* one hop to the parent, which can approve/deny it. A provider failure has no decision for a parent to make, so it is not an `ask` and not bound by `escalationMaxDepth`. Propagation depth is unbounded by design (it is just terminal-status cascade, bounded by task-tree depth, itself bounded by `MAX_DEPTH_EXCEEDED`). Reused from D6: only the carrier (`awaiting_input` + `resumeToken` + `task_resume`) for suspension. `fc466f0b` (climb-to-root for asks) is independent and not a prerequisite. **ADR candidate A (do not create here):** "Provider failures propagate fail-up as a typed value; ask-escalation is for decisions only" (supplements ADR-0008 D6).

## 5. ATTEMPT TRACE & OBSERVABILITY

- **`task_events` `PROVIDER_ATTEMPT`** (one per attempt, success included): `{n, modelRef, wireModel, providerType, credentialKey, outcome:'ok'|ProviderFailureClass|'skipped_breaker', status?, providerErrorType?, retryAfterMs?, backoffMs?, durationMs, requestId?, usage?, failoverFrom?: n}`. `ProviderFailure.attempts` = the same records (last 20).
- **Hooks (additive at source, ADR-0002), `agent-base-types/src/hooks.ts`:** `provider:attempt` (payload = the record + executionContext), `provider:failure` (final `ProviderFailure`), `provider:blocked` (credential-scoped failure parked/suspended — also the notification seam, §8). Observational; handlers try/catch-isolated like TRACE-1.
- **Tracing (ties to `docs/plan/agent-tracing/SPEC.md`):** `agent-plugin-tracing` maps `provider:attempt` to child spans `agent.model_call.attempt` under `agent.model_call` (attrs: n, outcome, status, backoff_ms, failover_from, credential_key), `provider:failure` to `agent.task.error` enrichment, `provider:blocked` to `agent.hitl.suspend{kind:'provider_blocked'}` (extends the `HitlSuspendPayload.kind` union: `'provider_blocked'`). Metrics (counters; rates derived by reader, never stored): `provider_attempts`, `provider_retries`, `provider_failovers`, `provider_failures_by_class`, `provider_breaker_open`, `provider_blocked`. Sequencing: PF-9 depends on TRACE-1 (hook surface) landing; if absent, PF-9 ships the hooks and the plugin mapping becomes a TRACE follow-up item (no env toggle either way; tracing stays default-on).
- **Dispatch side:** `dispatch_log` entry gains `provider_failure` and per-unit `attempts` summary; `turns` unaffected.

## 6. TOP-OF-AGENT BEHAVIOR (task root inside agent-mcp)

- `billing`/`auth`/`permission` (resumable, credential-scoped) AND `nativeTooling.hitl !== false` => task transitions to `awaiting_input` with `resumeToken` and a persisted `suspension {kind:'provider_blocked', failure}`; `task_resume {userInput:'retry'|'cancel'}`. `hitl:false` => fail (typed). `rate_limited`/`overloaded`/`unavailable`/`timeout` exhausted => **fail**, retryable (no suspension: waiting is the caller's/dispatcher's policy).
- **Durable resume.** Today HITL resolvers are in-memory. Provider suspension must survive the process: on `task_resume` with no live resolver and `suspension.kind==='provider_blocked'`, the engine re-enqueues the task through the existing `enqueueExistingTask` path rebuilding the message list from the session store (assistant turns are appended before each next call, `orchestrator.ts:~589`), then the failed call is simply made again — valid because the chat call committed nothing (§2.2). Other suspension kinds keep today's `TASK_NOT_RESUMABLE` behavior. Verified-first: PF-6's first red test proves continuation from persisted messages produces the same next-call input.
- **Partial results:** all committed turns already persist (session store). On any terminal provider failure the task row also records `failure` and `partial {turns, lastAssistantText?}` (new nullable columns/JSON on `tasks`) so a consumer never has to scrape events.

## 7. DISPATCH-ORCHESTRATOR HOP (unit level)

`IDispatchAgentRunner.poll()` returns `failure?: ProviderFailure` alongside `error` (`agent-runner.ts` poll result + `AgentMcpRunner` read of `task_read.failure`). In `dispatchUnit` (`orchestrator.ts:~1414`) a `failure` maps to a unit disposition (never a guard failure, never a correction injection):

| failure | disposition |
|---|---|
| billing / auth / permission (credential) | **provider hold**: unit ops `skipped`, log entry `provider_failure`, `suspension` unaffected; milestone derived status `blocked_provider`; **all other pending units whose resolved `credentialKey` equals the held key are not dispatched this cycle or later until the hold clears** (prevents N units x attempts burning a dead credential); cycle result `terminalReason:'provider-blocked'`. |
| rate_limited / overloaded / unavailable / timeout (exhausted) | **deferred retry**: unit stays pending with `notBefore = now + max(retryAfterMs, 30s)`, `unit.providerAttempts++`; after 3 cycles => `failed` with failure attached. |
| invalid_request / context_length / content_policy / unknown | `failed` (ops failed), failure attached; surfaced, no auto-correction (a correction agent cannot cure a bad request; `context_length` remedy = operator picks a larger-context model — future). |

Hold clearing: next `dispatch-cli run` re-fires a held unit as a new task (unit work is guard-verified and artifacts persist on disk; same-task continuation via PF-6 is an optimization the runner uses when the parked `taskId` still has `suspension.kind==='provider_blocked'`). A held credential is *probed* by the first re-fired unit; success clears it for the rest. **Verify-first (PF-7.AC0):** today's behavior of a `failed` milestone across cycles (`no-eligible-work` vs re-eligible) is characterized by a red/green test before changing it; this spec assumes `failed` is not re-fired and `blocked_provider` is the only re-firable terminal-ish state.

## 8. TOP OF CHAIN — `dispatch-cli` root

**Decision: provider-blocked work SUSPENDS (is held and resumable), it does not "fail"; exhausted transient work FAILS retryably; both exit non-zero with distinct codes.** Never exit 0 when `providerBlocked` or a provider-failed unit exists.

| Situation | Exit | stdout JSON (existing `printAndExit` convention) | stderr |
|---|---|---|---|
| all complete / normal | 0 | unchanged | - |
| billing/auth/permission hold | 69 (`EX_UNAVAILABLE`) billing; 77 (`EX_NOPERM`) auth/permission | `{ok:false, providerBlocked:{class,scope,resumable:true,credentialKey,units:[...],taskIds:[...],message,retryAt?:iso}, partial:{completed:[...],held:[...],pending:[...],failed:[...]}, resume:{command:"dispatch-cli run --dag-path <p> --no-dry-run"}}` | one line: `provider blocked (billing): top up / fix credential then re-run: <command>` |
| transient exhausted (deferred past cap) | 75 (`EX_TEMPFAIL`) | same shape, `resumable:false, retryable:true, retryAt` | one line |
| invalid_request / context_length | 65 (`EX_DATAERR`) | `providerFailure` per failed unit | one line |
| other thrown error | 1 (unchanged) | - | message |

Cycle semantics: `run` still executes exactly one cycle (existing contract); exit code reflects that cycle's result. The loop caller (human/CI) uses the code: 75 => retry later; 69/77 => stop, human action, then re-run; resume is idempotent (completed units stay complete). **Notification:** v1 notification = the `dispatch_log` entry + stdout payload + stderr line + the `provider:blocked` hook (observational seam for a future webhook/pager). No push channel is built here (Open question Q3); no env switch.
**Resumability after a top-up:** nothing is lost: completed units are in `dag.json`, held units are re-fired, parked agent-mcp tasks (if the DB persists) continue via PF-6. `status` shows held units with the failure class and "resume" hint.
**ADR candidate B (do not create here):** "Single retry owner: SDK `maxRetries:0`, one policy engine; adhd exit-code vocabulary for dispatch-cli (sysexits)".

## INDEPENDENT ITEMS

Order: PF-1 -> {PF-2} -> PF-3 -> {PF-4} -> {PF-5, PF-6, PF-7 -> PF-8, PF-9} -> PF-10. PF-1 and the claudecli fixture capture (PF-2b) start immediately and in parallel. Each item: scaffold nothing (no new packages); lint + `nx affected -t test` + `verify-dist-load` per AGENTS.md. Tests drive REAL components; the only mock is the external boundary, a local HTTP fake provider server (`tmp/agent-engine-orchestrator/fake-provider-*`) speaking the real Anthropic/OpenAI/OpenRouter wire shapes (status, headers, JSON bodies, SSE error events) that the real SDKs talk to via `baseURL`. These run by default (no env gate: fake server is local, not a paid service). Every behavioural AC has a named negative control (NC) that must go RED when the fix is reverted.

### PF-1 — types + deterministic classifier (no deps)
Scope: `agent-base-types/src/{provider-failure.ts(new),errors.ts,index.ts}`; `agent-core-provider/src/failure/{classify.ts,rules.ts,retry-after.ts,index.ts}(new)` + `src/__tests__/failure/*.fixtures.ts`.
- PF-1.AC1 every row of §1.1 is a fixture (>=3 per provider incl. OpenRouter) asserting full `{class,scope,retryable,resumable}`; classifier is total (fuzz: random status/body never throws).
- PF-1.AC2 OpenAI 429 `credit_balance_exhausted` => billing, 429 plain => rate_limited; Anthropic 429+`enforced_spend_limit_reached` => billing, 429+`retry-after` => rate_limited. NC: classify by status only => these 4 go RED.
- PF-1.AC3 retry-after parse order incl. HTTP-date, `retry-after-ms`, `x-should-retry:false`, >60s raw preserved. NC: drop HTTP-date branch => RED.
- PF-1.AC4 no module under `agent-core-provider` imports an SDK (`rg` assertion in the test).

### PF-2 — provider adapters single-shot + raw extraction (dep PF-1)
Scope: `providers/anthropic.ts`, `openai.ts`, `claudecli.ts`, `construct.ts`, new `providers/raw-error.ts`; `package.json` (drop `p-retry` if unused).
- PF-2.AC1 against the fake server, a 529 on the real `AnthropicProvider` produces exactly ONE HTTP request (SDK `maxRetries:0`) and a thrown `ProviderCallError` carrying status+headers+body (observable: server request counter). NC: remove `maxRetries:0` => 3 requests => RED. Same for OpenAI.
- PF-2.AC2 401/402/400 are never re-requested even when `retryConfig.retries=3` (the old pRetry bug): server counter == 1.
- PF-2.AC3 SSE mid-stream `error` event (Anthropic `overloaded_error`) surfaces as `source:'stream-event'` raw error.
- PF-2.AC4 (PF-2b) claudecli: fixtures captured from the real CLI for auth/billing/rate-limit/overloaded into `__tests__/fixtures/claudecli-errors/`; stream loop reports `toolUseEmitted:boolean` on the raw error.

### PF-3 — attempt engine: retry/backoff/failover/breaker + D-G(4) (deps PF-1, PF-2)
Scope: `providers/call-policy.ts(new)`, `engine/orchestrator.ts` (replace the catch classification ~L505-586 + the `chat` call site), `validation/errors.ts`, `agent-base-types/src/errors.ts` (codes), `validation/agent.ts` (retryConfig `deadlineMs`), `interfaces.ts` (budget in `ExecutionContext`).
- PF-3.AC-DG4 (verbatim from D-G(4), `caebab15`): `models=['claude_sonnet_4_6','claude_opus_4_8']`, first 429s (with `retries:0` or `retry-after`>60s), the engine calls the second, both attempts present in `task_events` (`PROVIDER_ATTEMPT` n=1 rate_limited, n=2 ok, `failoverFrom:1`); NC remove the failover loop => RED; AC: `models[]` order is never changed (absence-of-sort).
- PF-3.AC1 529,529,200 => success on attempt 3, backoff gaps respect `retry-after` (use an injected clock/`sleep`, never wall time), events recorded.
- PF-3.AC2 402 => ONE attempt, terminal `PROVIDER_BILLING`, `ToolError.data.class==='billing'`; with `models[]` where entry 2 shares the credential => entry 2 is NOT called (server counter), entry 2 on a different credential IS called.
- PF-3.AC3 attempt/deadline bounds: always-503 server => stops at 6 attempts / `deadlineMs`; NC remove bound => RED.
- PF-3.AC4 claudecli with a fake `claude` binary that emits a `tool_use` then errors => no retry (idempotency guard); without tool_use => retried.
- PF-3.AC5 breaker: after exhaustion, next turn skips the open entry (recorded `skipped_breaker`); half-open probe closes it.
- PF-3.AC6 existing codes unchanged for existing causes (401=>`PROVIDER_AUTH_ERROR`, context=>`CONTEXT_WINDOW_EXCEEDED`); the `error.message?.includes('429')` string-matching is gone (`rg` assertion).

### PF-4 — persistence + wire (deps PF-1, PF-3)
Scope: `agent-store-runtime/src/db/schema.ts` + task store (`tasks.failure TEXT NULL`, `tasks.partial TEXT NULL`, migration), `tools/task.ts` (`task`/`task_run`, `tasks_batch` items, `task_read`/`result` + projection fields), `validation/task.ts` schemas, `entrypoint/agent-mcp/src/server.ts` schemas, docs (agent-mcp README/AGENTS/USAGE_GUIDE).
- PF-4.AC1 through the LOADED MCP `task_run` tool (real stdio client against the built server, AGENTS.md "drive the real tools") against the fake provider returning 402: payload has `status:'failed'`, `error:'[PROVIDER_BILLING] ...'`, `failure.class:'billing'`. NC: drop the `failure` field => RED. (Fixes: sync output previously had no `error`.)
- PF-4.AC2 reopen-persistence: close and reopen the store; `task_read` still returns the same `failure` + `partial`.
- PF-4.AC3 `tasks_batch`: one item billing-failed, one ok => per-item `failure`; batch not aborted.
- PF-4.AC4 isError text for thrown errors stays `[CODE] message` (ADR-0004: no envelope added); old clients unaffected (existing contract tests green).

### PF-5 — delegation propagation (deps PF-3, PF-4)
Scope: `engine/orchestrator.ts` delegation tool-result path + `ExecutionContext.retryBudget` plumbing in `tools/task.ts`.
- PF-5.AC1 parent->child, child hits 402 on the SAME credential: parent task ends `failed` with `failure.hops` = [origin child, child-of parent], no extra parent model turn (server counter for parent model == turns before delegation). NC: always give the model a turn => counter RED.
- PF-5.AC2 child on a different credential fails 402, parent continues: tool result contains structured failure (parsed JSON), parent completes.
- PF-5.AC3 retry budget: parent with `deadlineMs` small; child never retries past `deadlineAt` (injected clock). Three-level nest with always-503 => total attempts <= bound, not 6^3.

### PF-6 — provider-blocked suspension + durable resume (deps PF-3, PF-4)
Scope: `engine/orchestrator.ts` (suspension branch), `tools/task.ts` (`taskResume` fallback), task store `suspension` JSON, `agent-base-types` hook kinds.
- PF-6.AC1 billing with HITL on: task `awaiting_input`, `suspension.kind==='provider_blocked'`; fake server flips from 402 to 200 ("top-up"); `task_resume{retry}` => task completes. NC: `hitl:false` => task `failed` instead.
- PF-6.AC2 **process-death resume**: kill the agent-mcp process while suspended, restart on the same DB, `task_resume` => completes (not `TASK_NOT_RESUMABLE`); the replayed call's request body equals the pre-failure one (server compares). NC: revert fallback => RED.
- PF-6.AC3 `cancel` choice => task `cancelled`, resumeToken dead.
- PF-6.AC4 non-provider suspension kinds still return `TASK_NOT_RESUMABLE` after restart (unchanged contract).

### PF-7 — dispatch hop (dep PF-4; PF-6 for continuation optimization only)
Scope: `dispatch-orchestrator/src/lib/{agent-runner.ts,orchestrator.ts}`, `dispatch-base-spec` types (`DispatchLogEntry.provider_failure`, milestone derived status `blocked_provider`, unit `notBefore/providerAttempts`), `dispatch-core-optimizer` eligibility (credential hold).
- PF-7.AC0 characterize today: failed unit across cycles (red/green, committed first).
- PF-7.AC1 two units sharing a credential, fake server 402 on first: second unit's task is NOT created (counter), cycle `terminalReason:'provider-blocked'`, log entry carries `provider_failure.class`. NC: remove hold => second unit dispatched => RED.
- PF-7.AC2 top-up (server flips) then next cycle: held unit re-fired and completes; other pending units dispatched.
- PF-7.AC3 transient exhausted: unit deferred with `notBefore`; third strike => `failed` with failure attached; no correction milestone injected in any provider case (NC: guard-failure path still injects).
- PF-7.AC4 `AgentMcpRunner.poll` parses `failure` from the real agent-mcp `task_read` (real child process).

### PF-8 — dispatch-cli root (dep PF-7)
Scope: `entrypoint/dispatch-cli/{bin/cli.ts,src/api.ts,src/lib/core.ts}`, docs (README/AGENTS, `docs-contract.spec`).
- PF-8.AC1 spawned built CLI (real process) against fake provider: billing => exit 69 + JSON `providerBlocked` + stderr line; auth => 77; always-503 for 3 cycles => 75; invalid => 65; success => 0; thrown => 1. Assertions key on exit code, not stdout grep.
- PF-8.AC2 resume: after fake server flips, same command exits 0 and completed units are not re-run (turn counter).
- PF-8.AC3 `status` lists held units with class + resume command.

### PF-9 — observability (deps PF-3; TRACE-1)
Scope: `agent-base-types/src/hooks.ts`, `engine/orchestrator.ts` emit sites, `agent-plugin-tracing` mapping (after TRACE-2).
- PF-9.AC1 `provider:attempt` fires once per attempt incl. success, handler throw does not alter outcome. NC: plugin absent => zero `agent.model_call.attempt` records.
- PF-9.AC2 metrics snapshot has `provider_failures_by_class.billing==1` after the PF-3.AC2 scenario.

### PF-10 — end-to-end + docs (deps all)
Scope: `entrypoint/dispatch-cli/src/test/integration/`, CHANGELOGs (`agent-engine-orchestrator`, `agent-mcp`, `dispatch-orchestrator`, `dispatch-cli`), READMEs/AGENTS/USAGE_GUIDE, `docs/plan/provider-failure/` status.
- PF-10.AC1 one scenario through the real chain: dispatch-cli -> dispatch-orchestrator -> real agent-mcp child -> sub-agent -> fake provider: 402 propagates unflattened to the root (`failure.hops.length===3`), root exits 69, top-up, re-run completes. NC for each hop (revert PF-4/5/7) => RED.
- PF-10.AC2 docs name every new exit code and error code (docs-contract tests).

## OPEN QUESTIONS (human decision)

- Q1 Exit-code vocabulary: adopt sysexits (69/75/77/65) as proposed, or a project-specific 2..5 range? (ADR candidate B.)
- Q2 Should rate_limited/overloaded exhaustion at an interactive agent-mcp root ever suspend (wait N minutes) rather than fail? Spec says fail.
- Q3 Notification channel for provider-blocked at the dispatch root (webhook/Slack/none): v1 ships a hook seam only.
- Q4 Billing detection of Anthropic self-set spend limit (400, message-matched, row 5) is the only message-based rule besides context-length (row 12); accept, or require upstream structured code first (ADR-0002)?
- Q5 claudecli: does the CLI expose a structured API status? Needs a real capture (PF-2b); until then claudecli classification is the weakest link.
- Q6 Mixed-provider `models[]` means a mid-conversation provider change; confirm acceptable for tool-heavy sessions (no per-provider message-shape divergence expected, unverified for server-side tool results).
- Q7 `ADR-0004`: structured failure on the `isError` channel is deliberately NOT added; confirm consumers must read `task_read` for structure.

## RISKS / NOT VERIFIED

OpenAI `context_length_exceeded`/`content_filter` codes and TS-SDK retry defaults are not primary-confirmed (research gaps); PF-2.AC1 asserts SDK behavior empirically. Portkey not researched (LiteLLM + OpenRouter used for gateway comparison). `.research-trace/2026-10-06-llm-provider-failure-taxonomy.md` was written by the researcher into the REPO ROOT checkout (untracked, outside this worktree) — not committed here.
