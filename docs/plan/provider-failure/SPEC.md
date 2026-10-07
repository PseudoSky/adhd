# SPEC — Provider failure: typed taxonomy, retry/failover, system-wide provider tripwire, propagation up the dispatch chain, top-of-chain behavior

> **Provenance.** Backlog `40fde12c` (verdict **SPEC**, necessity established). Dispatch `dispatch-2026-10-06-48dc`. Branch `feat/dg1-provider-registry-48dc` (includes D-G(1)+(2)).
> **Status: REVISED (review-1 addressed).** Draft `91fae10a`; adversarial blind review in `REVIEW-1.md` (5 blocking, 7 significant, minor + 3 verified-first gaps), all dispositioned in the *Review-1 disposition* table below. Owner decisions Q1-Q4 are folded in as locked design (see *Owner decisions*). Line citations were refreshed 2026-10-06 against this worktree; a bare `~` is gone, a citation without it was opened and confirmed.
> Research: memory episodes `01M49GMYVDWX8ZFXW3V9VB5H9A`, `01M49GN4R7WVR848M7JXPY6G75`, `01M49GPDJ62VDRWCY6Z7DF1SNV`, `01M49GPDSRJ96FA8RGTCE4F3SW`, `01M49GPF2X2QCS42PGFVKRD02K`, `01M49GPGGJKBX6QS4RZ6PP27V8`, `01M49GPY4QTBT212GYZ69S82C5`, `01M49GQ6X90E6RE50WXWZ0XEZ6` (tag `provider-failure`). Circuit-breaker prior art: Nygard *Release It!* (closed/open/half-open), Resilience4j/Polly semantics, LiteLLM router cooldowns.
> Related: `caebab15` (D-G(4), **absorbed**), umbrella `5b632a6b`, `ea70022a`, `fc466f0b`, tracing `docs/plan/agent-tracing/SPEC.md` (`5b98d3b2`; TRACE-1 hooks at branch `feat/agent-tracing-48dc` @ `b0ad7219`).
> Constraints honoured: adhd ADR-0001 (stores on the sox store adapter; locking contract D3 `busy_timeout` + `BEGIN IMMEDIATE` + busy-only bounded retry; multiprocess mandatory), ADR-0002 (fix at source), ADR-0004 (flat `content` payload), ADR-0008 D6, AGENTS.md parallel-process invariant (`sox ADR-0012`; the in-repo catalog holds 0001-0008 only, so the bare `ADR-0012` of AGENTS.md is the sox one), no env feature toggles.

## Owner decisions (locked)

| Q | Decision | Where realised |
|---|---|---|
| Q1 | Exit codes: sysexits. | §8 table + precedence |
| Q2 | Rate-limit/overload exhaustion marks the provider **system-wide** for a period, then rechecks (tripwire); the dispatcher **pauses** instead of failing units; the controlling session can **clear the trip and/or switch provider**. | §9 (first-class), §7, §8 |
| Q3 | "Is that a scalable event key format, or special-cased?" **Not special-cased.** `provider:blocked` is dropped. One typed failure-event family `<domain>:<verb>` over a closed verb vocabulary. | §5.2 |
| Q4 | Keep ONE documented, fixture-pinned message rule (+ upstream request for a structured code); unknown errors are classified best-effort. | §1.1 row 5, §1.3 |

## VERDICT — NECESSITY ESTABLISHED (REFUTE rejected)

Evidence (this worktree, re-verified): 

1. **Retry retries everything.** `providers/anthropic.ts:322` and `openai.ts:220` wrap `run` in `pRetry`; abort only on `signal.aborted` (+401 on Anthropic). 400/402/403/context errors are retried. Opt-in on `retryConfig` (`anthropic.ts:230,321`).
2. **Retry stacks multiplicatively.** SDK clients are built without `maxRetries` (`anthropic.ts:107,113`, `openai.ts:147`); both SDKs retry 408/409/429/>=500 by default, so any `retryConfig` multiplies SDK x p-retry, and a billing-class 429 is retried by status alone.
3. **Classification is string/status matching in the engine.** `engine/orchestrator.ts:543` (401), `:555-560` (`'rate limit'`, `includes('429')` at `:556`), `:567-568` (`context_length_exceeded`). No billing, no overloaded, no headers read.
4. **Information is flattened at every hop.** `ToolError` has `data?` (`validation/errors.ts:33`) never populated; task row stores `"[CODE] message"`; sync `task`/`task_run` output returns `{task_id,status,result,usage}` with no `error` (`tools/task.ts:298-304, 514-519`); dispatch `poll()` yields `error?: string` only (`dispatch-orchestrator/src/lib/agent-runner.ts:159-165, 606-617`).
5. **No failover, no attempt record.** `PartialBinding.models` (`agent-base-types/src/provider-binding.ts:26`) is read by nothing.
6. **No top-of-chain definition.** `dispatchUnit` (`dispatch-orchestrator/src/lib/orchestrator.ts:1350`) treats any non-`completed`/non-`awaiting_input` status as ops-failed (`:1405-1437`); the terminal poll set is at `:945-947`; `dispatch-cli run` exits 1 only on a thrown error (`bin/cli.ts:50-57`, `run` at `:142`). A 402 on unit 1 of N lets units 2..N burn identical failing calls.
7. **claudecli carries no machine-readable failure.** `providers/claudecli.ts:466,479` throw `Error("PROVIDER_ERROR: claude CLI ...")`; the only signal is text.
8. **No shared memory of a failing provider.** Nothing records "this credential is out of money / rate-limited" outside the failing call, so N tasks and N processes each rediscover it.

HITL suspension is **in-memory** (`hitlResolvers`, `engine/orchestrator.ts:196`, resolve/delete logic ~L199-L738; `tools/task.ts:870` `taskResume` reads the store): a process restart fails the task `TASK_NOT_RESUMABLE`. Any "wait for top-up" design must not depend on a live process (PF-7).

## SUMMARY

One typed value, `ProviderFailure`, from ONE deterministic classifier (with a bounded best-effort heuristic path for the unknown), carried on `ToolError.data` -> persisted on the task row -> returned by `task_read`/`task_run`/`tasks_batch` -> read by dispatch `poll()` -> summarized on the `dispatch_log` entry -> mapped to a sysexits code at the root. ONE retry owner (`callWithPolicy`; SDK `maxRetries:0`; `p-retry` removed) applies a per-class policy. D-G(4) failover is absorbed as that engine's loop. A **system-wide provider tripwire** (circuit breaker keyed by provider + credential scope, stored in the shared operational DB under the ADR-0001 locking contract) turns the first exhaustion into shared knowledge: every task in every process stops calling a tripped target, the dispatcher pauses instead of failing units, and the controlling session can clear the trip or switch provider. Failures and trip transitions are announced through one uniform `<domain>:<verb>` failure-event family. Propagation is **fail-up (typed terminal status), not ask-escalation** (ADR-0008 D6 carries decisions; a credential fact has none for an ancestor to make); only the *carrier* (`awaiting_input` + resume token) is reused for suspension.

## OWNERSHIP / DEP DIRECTION

`agent-base-types` (types: `ProviderFailure`, failure events, trip views, `billingScope`) <- `agent-core-provider` (pure `classifyProviderError`, heuristics, retry-after, backoff and cooldown math; no SDK imports) <- `agent-store-runtime` (new `provider_trips` store; uses the `agent-core-env` locking helpers) <- `agent-engine-orchestrator` (SDK-error extraction, `callWithPolicy`, trip consult/transition, host-tool handlers) <- `entrypoint/agent-mcp` (tool registration). `dispatch-base-spec` (types only) <- `dispatch-orchestrator` <- `entrypoint/dispatch-cli`. **Dispatch gains no registry or store dependency**: it learns trip state and credential scope only through agent-mcp tools (§9.5). Verify direction with `npx nx graph`/`rg` (boundary lint is dead, `DEBT-WORKSPACE-LINT-BOUNDARIES-001`). No new package: classifier in `agent-core-provider`, trip store in `agent-store-runtime` (Two-Use rule; AGENTS.md "reuse packages").

## 1. FAILURE TAXONOMY

```ts
// agent-base-types/src/provider-failure.ts (new)
export type ProviderFailureClass =
  | 'rate_limited' | 'overloaded' | 'unavailable' | 'timeout'
  | 'billing' | 'auth' | 'permission'
  | 'invalid_request' | 'context_length' | 'content_policy'
  | 'cancelled' | 'unknown';
export type FailureScope = 'request' | 'model' | 'credential';
export type Confidence = 'certain' | 'high' | 'medium' | 'low';   // 'certain' for every deterministic rule

export interface ProviderFailure {
  readonly v: 1;
  class: ProviderFailureClass;
  scope: FailureScope;
  retryable: boolean;            // a LATER identical call plausibly succeeds without human action
  resumable: boolean;            // succeeds after a human/time action (top-up, key rotation, window reset)
  confidence: Confidence;
  suspectedClass?: ProviderFailureClass;   // only when class==='unknown' (§1.3)
  evidence?: FailureEvidence;              // only when class==='unknown'
  retryAfterMs?: number;         // raw, uncapped (§2.3)
  providerType: 'anthropic' | 'openai' | 'claudecli';
  status?: number; providerErrorType?: string; providerErrorCode?: string; requestId?: string;
  modelRef: string; wireModel: string;
  credentialKey: string;         // sha256(providerType|baseURL|secretEnvName) truncated; never a secret
  credentialScope: string;       // §9.2: billingScope ?? credentialKey (the unit that shares spend/auth fate)
  message: string;               // truncated 500, secrets scrubbed
  source: 'http' | 'stream-event' | 'cli-text' | 'transport' | 'trip';  // 'trip' = refused locally, no provider call made
  toolUseEmitted?: boolean;      // claudecli / side-effect guard (§2.2)
  attempts: AttemptSummary[];    // on the task row: last 8; full list lives in task_events
  hops: FailureHop[];            // §4
  trip?: TripRef;                // §9: the trip this failure opened or was refused by
  classifierVersion: number;
}
export interface FailureEvidence { matchedTokens: string[]; status?: number; errorName?: string; bodySnippet?: string /* <=300, scrubbed */; }
export interface TripRef { key: string; generation: number; recheckAt: string /* ISO */; state: 'open' | 'half_open'; }
/** Bounded copy for dispatch_log / list views (review S2). */
export interface ProviderFailureSummary {
  class: ProviderFailureClass; scope: FailureScope; retryable: boolean; resumable: boolean; confidence: Confidence;
  status?: number; providerErrorType?: string; requestId?: string; retryAfterMs?: number;
  credentialScope: string; message: string /* <=200 */; attemptCount: number; lastAttempt?: AttemptSummary; hopCount: number; trip?: TripRef;
}
```

### 1.1 Deterministic classifier

`classifyProviderError(raw: RawProviderError): ClassifiedFailure` — pure, total (never throws), no regex over free text on the `http`/`stream-event` path except the ONE pinned rule below. Rules in order, first match wins; the table is data in `agent-core-provider/src/failure/rules.ts`, one fixture file per provider. Every rule below yields `confidence:'certain'`.

| # | Match | class / scope / retryable / resumable |
|---|---|---|
| 1 | caller `signal.aborted` | cancelled / request / false / false |
| 2 | OpenRouter (host `openrouter.ai`): `body.error.metadata.error_type`, then 402 `limit_source`: `openrouter_in_flight_budget` => rate_limited(RA); `openrouter_credits`/`openrouter_key_limit` => billing | per research table |
| 3 | Anthropic `body.error.type==='billing_error'` (402) | billing / credential / false / true |
| 4 | Anthropic 429 with structured `details.error_code==='enforced_spend_limit_reached'` | billing / credential / false / true |
| 5 | **The single pinned message rule.** Anthropic 400 `invalid_request_error` whose `message` equals the documented "You have reached your specified API usage limits" (exact, anchored). Provider emits no code. Marked `PINNED_MESSAGE_RULE` in rules.ts; fixture-pinned; an upstream request for a structured code is filed (ADR-0002: correct the source). | billing / credential / false / true |
| 6 | OpenAI `error.code` in {`credit_balance_exhausted`,`organization_spend_limit_exceeded`,`project_spend_limit_exceeded`,`organization_usage_limit_exceeded`} or `error.type==='insufficient_quota'` (all 429) | billing / credential / false / true |
| 7 | 429 (remaining) | rate_limited / model / true / false |
| 8 | Anthropic 529 `overloaded_error`; 503 `server_is_overloaded`/`service_unavailable_error`/`provider_overloaded` | overloaded / model / true / false |
| 9 | 401 | auth / credential / false / true |
| 10 | 403 + moderation metadata / `content_policy_violation` / `refusal` | content_policy / request / false / false |
| 11 | 403 | permission / credential / false / true |
| 12 | OpenAI/OpenRouter `error.code`/`error_type` in {`context_length_exceeded`,`max_tokens_exceeded`,`token_limit_exceeded`} | context_length / request / false / false |
| 13 | 408, 504, SDK `AbortError`/`TimeoutError`, ETIMEDOUT | timeout / model / true / false |
| 14 | 409 | unavailable / model / true / false |
| 15 | 500, 502, 503 (OpenRouter 503 without `provider_overloaded` => invalid_request), ECONNRESET/ENOTFOUND/ECONNREFUSED | unavailable / model / true / false |
| 16 | `stream-event` error events and 200-with-only-`error` bodies: same table keyed on `error.type` / `finish_reason:"error"` | via rows 3-15 |
| 17 | `cli-text` (claudecli): ordered, anchored, fixture-pinned patterns derived from PF-2.AC4 captures; if the CLI exposes a structured status in its `result` event they are replaced by structured rules | per capture |
| 18 | 400, 404, 413, 422 **and no heuristic fired** (§1.3) | invalid_request / request / false / false |
| 19 | anything else with `status>=500` => unavailable; else §1.3 heuristics => `unknown` | unknown / request / false / false |

Anthropic "prompt is too long" is **no longer a second pinned message rule** (the owner's decision keeps one). It is recognised by the §1.3 heuristic as `suspectedClass:'context_length'` and treated as terminal `unknown`; it keeps today's behaviour (the engine matches only `context_length_exceeded` today, `orchestrator.ts:567`). Open question Q8 asks whether to promote it to a second pinned rule.

**Precedence guards (review S1).** Row 5 runs before the heuristic and before row 18, and matches only the exact string; fixture `anthropic-400-prompt-too-long` proves a 400 `prompt is too long` is not swallowed by row 5, and fixture `anthropic-400-usage-limit-reworded` (a plausible reworded copy) proves a copy change **fails safe**: it is not `invalid_request` but `unknown` with `suspectedClass:'billing'`, `confidence:'medium'` (§1.3), so drift is visible in metrics (`provider_failures_by_class{class=unknown,suspected=billing} > 0` is the drift canary).

### 1.2 Error codes (wire compat)

`ErrorCode` (`agent-base-types/src/errors.ts` + `validation/errors.ts` `errorCodeSchema`) gains `PROVIDER_BILLING`, `PROVIDER_OVERLOADED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_INVALID_REQUEST`, `PROVIDER_CONTENT_POLICY`, `PROVIDER_PERMISSION` (review S3). rate_limited->`PROVIDER_RATE_LIMITED`, auth->`PROVIDER_AUTH_ERROR`, timeout->`PROVIDER_TIMEOUT`, context_length->`CONTEXT_WINDOW_EXCEEDED`, unknown->`PROVIDER_ERROR` (unchanged). `failure.class` is the source of truth; codes are a compatibility projection. The `[CODE] message` text convention is unchanged byte-for-byte; structure rides `ToolError.data = ProviderFailure`.

### 1.3 Best-effort path for unknown errors (Q4)

Runs only when no deterministic row matched. Pure, in `agent-core-provider/src/failure/heuristics.ts`; a scored token matcher over {status class, `errorName`, `providerErrorType`, scrubbed body text, `cli-text`}:

- Output: `class:'unknown'` (never promoted), `suspectedClass` (best-scoring class among billing/auth/rate_limited/overloaded/unavailable/context_length/timeout), `confidence` in `high|medium|low` (`high` = >=2 independent signals e.g. status+token; `medium` = one strong token; `low` = otherwise), and `evidence` = the matched tokens + scrubbed body snippet (<=300). The raw evidence is always attached so a human or a future rule author sees exactly what was seen.
- **Retry policy for `unknown` (conservative, bounded):** never fails over; never suspends; never opens a trip on its own first occurrence. One exception-bounded behaviour: if `suspectedClass` is transient (rate_limited/overloaded/unavailable/timeout) and `confidence>=medium`, ONE same-target retry with full-jitter backoff, then terminal. `suspectedClass` in {billing,auth,permission} is **never acted on** (no hold, no suspension): it is surfaced in `failure` and the CLI payload only. **Unknown storm guard:** >=3 `unknown` failures on one (credentialScope, wireModel) within 5 minutes open a model-scoped trip of class `unknown` (cooldown 60s, §9) so a novel failure mode cannot burn a fleet; it clears like any trip.
- Each unknown increments `provider_failures_by_class{class=unknown,suspected=<c>}` and writes the evidence to the `PROVIDER_ATTEMPT` event, which is the feed for authoring the next deterministic rule. Rule authoring replaces the heuristic hit; it does not widen the heuristic.
- ADR-0002 note: this path is not a consumer-side workaround for a provider gap. It is the classifier's declared fallback, bounded to refuse to act on what it does not understand.

## 2. POLICY PER CLASS

One owner: `agent-engine-orchestrator/src/providers/call-policy.ts` (`callWithPolicy`) wrapping `provider.chat`. Providers become single-shot (`maxRetries:0`, `pRetry` deleted, dependency removed if unused). `retryConfig` (typed, `PartialBinding`) now parameterizes this policy; absence no longer disables retry. Designed-in defaults (no opt-in switch): `retries:2, minTimeout:500, maxTimeout:8000, factor:2, retryWindowMs:120_000`; jitter = Full Jitter `random(0, min(cap, base*2^n))`. `retryConfig` gains `retryWindowMs` (renamed from the draft's `deadlineMs`; see B2).

### 2.1 Table

| class | same-target retry | failover to next `models[]` | exhaustion result | trip (§9) |
|---|---|---|---|---|
| rate_limited | yes: wait `max(retryAfter, jitter)`; honour RA up to 60s, above => exhausted | yes (after retries, or at once if RA>60s) | `PROVIDER_RATE_LIMITED`, retryable | open (credentialScope, wireModel), cooldown `max(RA,5s)` |
| overloaded | yes (RA honoured, also on 529: review gap 3) | yes | `PROVIDER_OVERLOADED`, retryable | open (credentialScope, wireModel), 15s |
| unavailable / timeout | yes | yes | `PROVIDER_UNAVAILABLE`/`PROVIDER_TIMEOUT`, retryable | open (credentialScope, wireModel), 15s |
| billing | **never** | only targets with a different `credentialScope` | `PROVIDER_BILLING`, resumable | open (credentialScope), probe cadence 60s |
| auth / permission | never | only different `credentialScope` | `PROVIDER_AUTH_ERROR` / `PROVIDER_PERMISSION`, resumable | open (credentialScope), 60s |
| invalid_request | never | never | `PROVIDER_INVALID_REQUEST` | none |
| context_length | never | only to a target with a strictly larger declared window (registry) | `CONTEXT_WINDOW_EXCEEDED` | none |
| content_policy | never | once | `PROVIDER_CONTENT_POLICY` | none |
| cancelled | never | never | existing cancel path | none |
| unknown | §1.3 | never | `PROVIDER_ERROR` | only the storm guard |

A trip opens when a class marked "open" **exhausts** the target (retries spent and, where applicable, failover found nothing), or immediately for billing/auth/permission (they never retry).

### 2.2 Guards

- **Per-call attempt bound:** <= 6 attempts across retry+failover (LiteLLM `ROUTER_MAX_FALLBACKS=5` analogue). `callWithPolicy` consults the trip store **before every attempt** (§9.4): an attempt against a tripped target is not made and is recorded `skipped_trip`.
- **Retry window, not a call deadline (B2).** `retryWindowMs` bounds only *starting a new attempt* and *backoff sleeps*: `windowEndsAt = firstAttemptStart + retryWindowMs`; no new attempt starts at or after it; a sleep is truncated to it. An **in-flight healthy attempt is never aborted** by the window (a long stream may run far past 120s); in-flight attempts are bounded only by the existing `selection.timeoutMs`/SDK timeout.
- **Inherited window, not inherited counts (B1).** `ExecutionContext.retryWindowEndsAt?: number` (epoch ms). The window is **reset on each model call of a task** (`windowEndsAt` is computed per call in `callWithPolicy`; a task's later turns are never starved by earlier ones). A delegated child receives the parent's value *as it stood at delegation* and uses `min(inherited, own)`, so a child never keeps retrying after an ancestor's window closed. There is **no inherited attempt counter**: attempts are bounded per call (6). Cross-level anti-storm is provided by (a) the engine never auto-retrying a delegation (H2) and (b) the system-wide trip (§9): after the first exhaustion every sibling and descendant fails fast. (The draft's `attemptsRemaining` was dropped: it had no consumption rule and starved long tasks; see disposition B1.)
- **Side-effect guard (idempotency; B4, S6).** An attempt is retryable/failover-able/resumable only if it committed **no side effect**: (a) API providers: `chat()` is pure until it returns; *verified-first* PF-2.AC5 characterizes that no incremental model text reaches a live consumer (SSE) before `chat()` resolves; if any does, a `outputEmitted` flag joins the guard and retry is refused after the first delivered chunk. (b) claudecli: the CLI runs tools itself; retry, failover, **suspension and durable resume** are allowed only when `toolUseEmitted===false`; otherwise the failure is terminal for the call and the partial turn is surfaced in `partial`. Server-side tools (web_search) are billed-only; retry allowed.
- **Budget:** each attempt emits an event and a `PROVIDER_ATTEMPT` row so `agent-plugin-budget` sees retries; `BUDGET_EXCEEDED` is checked before every attempt.
- **Failover is per call, not persisted:** `session.model`/`selection.modelRef` are never mutated (D-G(2)). The next turn starts at `modelRef` again unless its trip is open (then it is skipped, recorded `skipped_trip`).
- **Mixed-provider `models[]`:** each entry resolves via `registry.resolveModelRef(ref, platform)` to its own (providerType, wireModel, credentialKey, credentialScope). Messages are provider-neutral (`Message`). Q6 stays open.

### 2.3 Retry-After parse (pure, `agent-core-provider/src/failure/retry-after.ts`)
Order: `x-should-retry` (false => `retryable:false`) -> `retry-after-ms` -> `retry-after` seconds (float) -> `retry-after` HTTP-date (`max(0,date-now)`) -> provider reset headers (hint) -> none. The value is a **floor**; add jitter; cap waiting at 60s (raw kept in `retryAfterMs` so the root reports "retry at T"). A 429/402 with a billing marker and no `retry-after` is terminal.

## 3. COMPOSITION WITH D-G(4)

D-G(4) (`caebab15`) is **absorbed**: PF-4 implements its failover loop and attempt trace. Its acceptance criterion is **adapted** (not verbatim; review minor): "first 429s" becomes "exhausts per §2" (satisfied with a fake server returning 429 + `retry-after` > 60s, or `retries:0`). `absence-of-sort` is kept: the engine NEVER reorders `models[]`. `caebab15` is resolved by PF-4's merge. Seam retained: `resolveSelection` (unchanged) yields `selection.models`; `callWithPolicy` takes targets already resolved to wire models.

## 4. PROPAGATION — hop by hop

Principle: **fail-up with a typed value**; each hop may *retry*, *failover*, *surface*, *suspend*, or *hold*; none may re-stringify.

```ts
export interface FailureHop { taskId: string; agentName?: string; role: 'origin' | 'child-of' | 'unit' | 'root'; at: string }
```

| Hop | Receives | May do | MUST NOT |
|---|---|---|---|
| H0 provider call -> orchestrator | raw SDK/CLI error | classify; retry; failover; consult/open trip | leak SDK error objects |
| H1 orchestrator -> own task | `ProviderFailure` | persist on task row + events; **suspend** (credential-scoped, hitl on, side-effect guard clear, §6); else **fail** | retry beyond the policy bound |
| H2 child -> parent (`task`/`tasks_batch`) | `{status:'failed', error, failure}` in the flat payload (ADR-0004) | parent *engine* rule below | auto-retry the delegation |
| H3 dispatch unit | `failure` via `task_read` + trip state via host tools | unit disposition (§7) | guard failure / correction injection |
| H4 dispatch-cli root | cycle result | exit code + payload (§8) | exit 0 on provider-affected work |

**H2 engine rule (S5).** When a child result carries `failure`, let `T` = the set of `credentialScope`s of **every target in the parent's selection chain** (`models[]` or the single selection):
1. If `failure.scope==='credential'` (or a trip is open) for **every** scope in `T` => the parent would fail identically: no model turn; it terminates with the same failure (hops appended), or suspends per §6.
2. Otherwise (some chain entry has an untripped, different scope; or the failure is `request`/`model` scoped) => the structured summary is returned to the parent model as a normal tool error; the parent may continue (its own failover may succeed). The engine never retries.
3. A `cancelled` child never produces `failure`.

**Relation to ADR-0008 D6 / `fc466f0b`.** D6 `escalate` carries a *permission decision* a parent can approve/deny. A provider failure has no decision for an ancestor, so it is not an `ask` and not bound by `escalationMaxDepth`; depth is bounded by `MAX_DEPTH_EXCEEDED`. Only the carrier is reused for suspension. See ADR candidate A.

## 5. ATTEMPT TRACE & FAILURE EVENTS

### 5.1 Persisted trace
`task_events` `PROVIDER_ATTEMPT` (one per attempt, success included): `{n, modelRef, wireModel, providerType, credentialKey, credentialScope, outcome:'ok'|ProviderFailureClass|'skipped_trip', status?, providerErrorType?, retryAfterMs?, backoffMs?, durationMs, requestId?, usage?, failoverFrom?, evidence?}`. `ProviderFailure.attempts` = the last 8 of these on the task row. `dispatch_log` carries `ProviderFailureSummary` only.

### 5.2 One failure-event family (Q3: answer)

**Answer to the owner's question.** The key format is already uniform, so nothing is special-cased. `HookEventMap` (`agent-base-types/src/hooks.ts:96-129`; TRACE-1 adds `permission:decision`, `hitl:suspend`, `hitl:resume`, `session:closed` at `b0ad7219`) names events `<domain>:<verb>` (`task:failed`, `budget:block`, `agent:mutated`, `hitl:suspend`) with a legacy `pre:`/`post:`/`transform:` phase family for interceptable steps. Failures join that scheme: **domain = the thing that failed; verb = one of a closed failure vocabulary.** `provider:blocked` (draft) is withdrawn: "blocked" is a *disposition* of a failure, not a new kind of event. The existing `task:failed` is already the `task` domain's `failed` verb and conforms unchanged.

```ts
// agent-base-types/src/failure-events.ts (new)
export const FAILURE_VERBS = ['attempt_failed', 'failed', 'tripped', 'recovered'] as const;
export type FailureVerb = (typeof FAILURE_VERBS)[number];
/** Open registry: a domain registers by declaration-merging this interface with its typed failure value. */
export interface FailureDomainMap { provider: ProviderFailure }
export type FailureDomain = keyof FailureDomainMap;
export type FailureEventKey = `${FailureDomain}:${FailureVerb}`;
export function isFailureEventKey(k: string): k is FailureEventKey;   // pure; membership in FAILURE_VERBS x registered domains

export interface FailureEventBase<D extends FailureDomain> {
  domain: D; failure: FailureDomainMap[D]; correlationId: string /* the taskId, or the trip key for tripped/recovered */; at: string;
  executionContext?: ExecutionContext;   // absent for events with no task (clear-from-host-tool)
}
export interface AttemptFailedPayload<D extends FailureDomain> extends FailureEventBase<D> { attempt: number; disposition: 'retrying' | 'failed_over' }
export interface FailedPayload<D extends FailureDomain> extends FailureEventBase<D> { disposition: 'terminal' | 'suspended' | 'held' | 'refused' }
export interface TrippedPayload<D extends FailureDomain> extends FailureEventBase<D> { trip: TripView }
export interface RecoveredPayload<D extends FailureDomain> extends FailureEventBase<D> { trip: TripView; reason: 'probe_ok' | 'cleared' | 'expired' }
```
`HookEventMap` gains `'provider:attempt_failed'`, `'provider:failed'`, `'provider:tripped'`, `'provider:recovered'`; `HitlSuspendKind` (TRACE-1) gains `'provider_blocked'` (one additive union member). Handlers are observational, try/catch-isolated (TRACE-1 convention). Adding a domain (`tool`, `dispatch`, `store`) costs one `FailureDomainMap` entry plus emit sites; no consumer changes.

| Situation | Event | disposition / reason |
|---|---|---|
| failed attempt, will retry same target | `provider:attempt_failed` | `retrying` |
| failed attempt, moving to next `models[]` entry | `provider:attempt_failed` | `failed_over` |
| call exhausted / terminal class | `provider:failed` | `terminal` |
| credential failure parked | `provider:failed` + `hitl:suspend{kind:'provider_blocked'}` | `suspended` |
| refused locally because trip open | `provider:failed` (`failure.source:'trip'`) | `refused` |
| dispatch unit held / deferred | persisted (`dispatch_log`), not a hook (dispatch has no hook registry) | `held` |
| trip opens | `provider:tripped` | - |
| probe succeeds / controller clears / cooldown elapsed unprobed-and-expired | `provider:recovered` | `probe_ok` / `cleared` / `expired` |

**Consumers.** (1) *Tracing (TRACE)*: one generic subscription over `FAILURE_VERBS` x registered domains; `provider:attempt_failed` -> span event `agent.model_call.attempt` on the active `agent.model_call` (attrs n, class, status, backoff_ms, failover_from, credential_scope); `provider:failed` -> `agent.task.error` enrichment; `provider:tripped`/`provider:recovered` -> span event on the active root span plus counters; `hitl:suspend{provider_blocked}` -> the existing hitl span. Metrics (counters; rates derived by readers): `provider_attempts`, `provider_retries`, `provider_failovers`, `provider_failures_by_class{class,suspected}`, `provider_trips_opened`, `provider_trips_recovered`, `provider_refused`. (2) *Dispatch root*: in another process, so it consumes the **persisted** projections of the same family: `task_read.failure`, `PROVIDER_ATTEMPT` rows, and the trip table via host tools (§9.5). Hooks never cross processes; the trip table and task rows are the cross-process source of truth. (3) *Future notification (webhook/pager)*: subscribes to `*:failed` / `*:tripped` generically; no push channel is built here.

## 6. TOP-OF-AGENT BEHAVIOR (task root inside agent-mcp)

- **Credential-scoped** (`billing`/`auth`/`permission`; resumable) AND `nativeTooling.hitl !== false` AND side-effect guard clear => `awaiting_input` with `resumeToken` and persisted `suspension {kind:'provider_blocked', failure, trip}`; `task_resume {userInput:'retry'|'cancel'}`. `hitl:false` or guard violated (claudecli with `toolUseEmitted`) => `failed` typed, `partial` recorded, **no suspension** (B4).
- **Transient** (`rate_limited`/`overloaded`/`unavailable`/`timeout`) exhausted => the task **fails retryable** with `failure.trip` (the trip opened by the exhaustion); a task arriving while its whole chain is tripped **fails fast** with `source:'trip'`, zero provider calls. No suspension for transient classes (waiting is the controller's/dispatcher's policy; the trip carries `recheckAt`).
- **Durable resume.** On `task_resume` with no live resolver and `suspension.kind==='provider_blocked'`, the engine re-enqueues via `enqueueExistingTask` (`tools/task.ts:624`) rebuilding messages from the session store (assistant turns are appended before each next call, `engine/orchestrator.ts:584-593`), then repeats the failed call: valid because the call committed nothing (§2.2, API providers; claudecli only when `toolUseEmitted===false`). **`task_resume` is explicit controller intent: it force-probes the trip (§9.3)**, so a resume right after a top-up does not wait out any cooldown (S4, PF-7.AC1). Other suspension kinds keep `TASK_NOT_RESUMABLE`.
- **Partial results:** committed turns persist; terminal failures also record `failure` and `partial {turns, lastAssistantText?}` on `tasks`.

## 7. DISPATCH-ORCHESTRATOR HOP (unit level)

`IDispatchAgentRunner.poll()` returns `failure?: ProviderFailureSummary` (+ `trip?`) next to `error`. A `failure` maps to a unit disposition (never a guard failure, never a correction injection):

| failure | disposition |
|---|---|
| tripped-chain / transient exhausted (any trip-opening class) | **pause**: unit stays `pending`, `notBefore = trip.recheckAt`; not failed; **does not consume a strike** while a trip is the cause. Cycle `terminalReason:'provider-paused'`. |
| billing / auth / permission | **hold**: unit `pending-held`, derived milestone status `blocked_provider`, held until its trip closes; cycle `terminalReason:'provider-blocked'`. |
| transient failure with no trip (e.g. a single `unavailable` that did not exhaust) | deferred retry: `notBefore=now+max(retryAfterMs,30s)`, `providerAttempts++`; after 3 => `failed` with `failure` attached. |
| invalid_request / context_length / content_policy / unknown | `failed`; surfaced; no correction milestone. |

**Dispatch learns credential scope and trip state only through agent-mcp (B3).** At cycle start and **again immediately before each unit's task creation** (synchronous with dispatch, not once per cycle) the runner calls host tool `provider_trip_check {units:[{agent, modelRef?, models?}], probe:false}`; agent-mcp (which owns the registry) resolves each unit's selection chain to targets, reads the trip table, and returns `{unit, state:'clear'|'tripped'|'probing', blockedBy:[TripView], nextRecheckAt?}`. A unit whose **entire** chain is tripped is not dispatched; a unit with at least one clear target is dispatched (the engine fails over). One batched call per wave, one cheap re-check per unit.

**In-flight race — accepted and bounded.** Units already running when the first one opens a trip are stopped at their **next attempt boundary** by the pre-attempt trip read (§2.2), so the worst case is `concurrency x 1` in-flight attempt, not `concurrency x 6`. PF-8.AC2 proves it with a barrier (N units released together; server counter <= N + 0 retries after trip).

**Resume.** The held/paused unit is re-fired as a new task on the next `run` once its trip is closed or its recheck is due (the first re-fired unit is the half-open probe). Completed units stay complete; guard-verified artifacts persist; PF-7 same-task continuation is an optimization when the parked `taskId` still carries `suspension.kind==='provider_blocked'`. Verify-first (PF-8.AC0): characterize today's `failed`-across-cycles behaviour before changing it.

## 8. TOP OF CHAIN — `dispatch-cli` root

**Decision.** Credential-blocked work is *held* (resumable); transient work is *paused* by the tripwire (retry later); both exit non-zero with distinct codes. Never exit 0 when any unit is held, paused, or provider-failed.

| Situation | Exit | stdout JSON (existing `printAndExit`) | stderr |
|---|---|---|---|
| all complete | 0 | unchanged | - |
| auth/permission hold | 77 `EX_NOPERM` | `{ok:false, providerBlocked:[{class,scope,credentialScope,units,taskIds,message,trip}], failures:[...all], partial:{completed,held,paused,pending,failed}, resume:{trips:"dispatch-cli trips clear <key>", run:"dispatch-cli run --dag-path <p> --no-dry-run"}}` | one line |
| billing hold | 69 `EX_UNAVAILABLE` | same shape | one line |
| invalid_request / context_length / content_policy / unknown | 65 `EX_DATAERR` | `failures[]` carries `ProviderFailureSummary` (incl. `suspectedClass`,`confidence`,`evidence` for unknown) | one line |
| paused / transient (trip open or deferred) | 75 `EX_TEMPFAIL` | `{ok:false, paused:{recheckAt, trips:[...]}, ...}` | `provider paused until <ISO>` |
| thrown error | 1 | - | message |

**Precedence when one cycle has several classes (review S7).** Total order, first present wins: **77 > 69 > 65 > 75**; the payload always lists *every* failure (`failures[]`), the code reports only the most urgent. Rationale: 75 is the only code that means "retry blindly later"; any other non-zero means "stop and look", so anything needing a human must dominate, and auth (cannot even establish balance) outranks billing. Same-code classes merge into one payload entry per `credentialScope`.

Cycle semantics: `run` still executes one cycle. A loop caller sleeps until `paused.recheckAt` on 75; stops on 77/69/65. **Controller affordances at the root:** `dispatch-cli trips list|clear [<key>|--all]` (thin wrappers over the agent-mcp host tools of §9.5; no new store access). Switching provider = the unit/agent `models[]` already fails over onto untripped credentials; changing a DAG model is an ordinary DAG edit. **Resumability after top-up:** `dispatch-cli trips clear <key>` then `run` (or wait out the 60s cadence); nothing is lost. **Notification v1:** `dispatch_log` entry + stdout + stderr + the §5.2 events; no push channel (no env switch).

## 9. SYSTEM-WIDE PROVIDER TRIPWIRE (Q2)

A circuit breaker (closed -> open -> half-open -> closed) whose state is **shared by every process on the same operational DB** and safe under concurrent writers. It replaces the draft's per-process in-memory breakers.

### 9.1 Storage — reuse, no new store
New table `provider_trips` in `agent-store-runtime` (store tier), on the **agent-mcp operational DB** that already holds `sessions/tasks/task_events` and is shared by every agent-mcp process. All access goes through the existing ADR-0001 D3 contract in `agent-core-env/src/store-transaction.ts` (`withImmediateRetry`: `BEGIN IMMEDIATE`, `busy_timeout`, bounded busy-only retry) and the same transaction pattern as `session-store.ts:134,251`. **No new locking implementation, no new package, no file locks, no environment toggle.** PF-3's first step reads those two files and reuses their exact helper (the substrate migration to the sox adapter is in flight; the trip store must follow whichever helper `session-store` uses at implementation time). Dispatch never opens this DB.

```sql
provider_trips(
  key TEXT PRIMARY KEY,                 -- 'trip:<providerType>:<credentialScope>' | '...:<wireModel>' (§9.2)
  provider_type TEXT NOT NULL, credential_scope TEXT NOT NULL, wire_model TEXT NULL,
  class TEXT NOT NULL, scope TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','half_open','closed')),
  generation INTEGER NOT NULL,          -- monotonic CAS token, +1 on EVERY transition
  consecutive_trips INTEGER NOT NULL,   -- drives cooldown growth; reset on close
  opened_at INTEGER NOT NULL, recheck_at INTEGER NOT NULL,
  probe_owner TEXT NULL, probe_until INTEGER NULL,   -- half-open lease
  last_failure TEXT NOT NULL,           -- JSON ProviderFailureSummary
  opened_by TEXT NOT NULL, closed_by TEXT NULL, closed_reason TEXT NULL, updated_at INTEGER NOT NULL)
```
`closed` rows are kept (audit/last-known) until pruned by the next open of the same key. Reads are plain PK SELECTs (WAL readers do not block).

### 9.2 Key and scope
`credentialScope = billingScope ?? credentialKey`. `billingScope` is a new **optional** typed field on `PartialBinding` (and its zod schema) that an operator sets when several keys share one spend limit (e.g. an OpenAI org/project id). Absent, the scope is the key; the documented limit (B5): two keys in one org do not share a trip, the second key's first call re-trips (one wasted attempt, bounded because billing never retries). Key = `trip:<providerType>:<credentialScope>` for credential-scoped classes (billing/auth/permission: every model on that credential), `...:<wireModel>` for model-scoped classes (rate_limited/overloaded/unavailable/timeout/unknown-storm).

### 9.3 State machine (all transitions are single CAS statements inside `withImmediateRetry`)
- **open(failure)**: `INSERT ... ON CONFLICT(key) DO UPDATE` keeping the **later** `recheck_at`; `generation+1`; `consecutive_trips+1` only on a closed->open or half_open->open (probe failed) edge. Two processes opening the same key concurrently converge on one open row (idempotent; second just raises `recheck_at`/`generation`).
- **cooldown** = `class base` (rate_limited `max(retryAfterMs,5s)`, overloaded/unavailable/timeout 15s, billing/auth/permission 60s, unknown 60s) x `2^(consecutive_trips-1)`, capped 15 min, with full jitter on the *growth* part only (the floor is never undercut). Typed config on the binding (`tripwire?: {baseMs?, maxMs?, probeLeaseMs?}`), designed-in defaults, never env.
- **check(key, now)** (pre-attempt): `closed`/absent => proceed. `open` and `now < recheck_at` => refuse (`skipped_trip`). `open` and `now >= recheck_at` => try **acquire probe**. `half_open` with a live lease held by someone else => refuse; expired lease => re-acquire.
- **acquire probe**: `UPDATE ... SET state='half_open', probe_owner=?, probe_until=now+probeLeaseMs, generation=generation+1 WHERE key=? AND generation=? AND ((state='open' AND recheck_at<=?) OR (state='half_open' AND probe_until<?))`; `changes==1` => caller owns the probe. Exactly one prober system-wide; a crashed prober's lease expires (`probeLeaseMs` default 120s). **The probe is the caller's real next model call**, not a synthetic request (no extra spend, no fake prompt).
- **probe ok** => `closeTrip(key, generation)` CAS (`WHERE generation=?`), `closed_reason='probe_ok'`, emits `provider:recovered`. **probe failed** => back to `open` with grown cooldown. A stale-generation CAS is a no-op, never an error (a controller clear that raced the probe wins).
- **force probe** (explicit controller intent: `task_resume`, `provider_trip_check{probe:true}`): same acquire statement but ignoring `recheck_at` (still one prober). This is what makes PF-7.AC1 instant after a top-up (S4).
- **clear** (`provider_trip_clear`): `UPDATE ... SET state='closed', closed_by, closed_reason='cleared', generation=generation+1 WHERE key=? [AND generation=?]`; idempotent; with `expectGeneration` it refuses to clear a trip that re-opened since the controller looked (no clearing someone else's fresh trip by accident).
- **expiry**: an `open` trip whose `recheck_at` passed and has no prober is simply probe-eligible; it needs no sweeper (no timer, no leader).

Clock: `now` is each process's wall clock (single host; cross-host skew only shifts a probe by the skew). Correctness (single prober, no lost clear) rests on `generation` CAS, never on timestamps. The store takes an injectable clock for deterministic tests.

### 9.4 What consults it
`callWithPolicy` reads the trip for the active target **before every attempt** (one PK read; no per-process cache, so a clear/close is visible to every process on its next attempt). A refused attempt makes no provider call and is recorded `skipped_trip`; when no target in the chain is clear the call ends `refused` (§6). Opening/closing is done by the engine on the attempt outcome; the store is pure persistence.

### 9.5 Controller affordances (host tools in `entrypoint/agent-mcp`, handlers in `agent-engine-orchestrator`)
- `provider_trip_list {}` -> `TripView[]` (all non-closed + recently closed).
- `provider_trip_check {units|agents|keys, probe?:boolean}` -> per-target `{state, blockedBy, nextRecheckAt}`; resolves selection chains to `credentialScope` inside agent-mcp (B3). `probe:true` is explicit-intent force-probe.
- `provider_trip_clear {key?|all?, expectGeneration?, reason?}` -> `{cleared:[...]}`; emits `provider:recovered{reason:'cleared'}`.
- **Switching provider** is the existing `session_update {provider, model, models}` (`server.ts:133-136`, applies to the next task on the session) — nothing new. A tripped credential is avoided automatically by any `models[]` entry with a different scope.
- Who may call: any MCP client of the server (the controlling session, a parent agent, the dispatch root). The two mutating/probing tools are registered as mutating native tools so the **existing ADR-0008 permission gate** applies to agent callers (PF-5.AC4 asserts the default is not silent allow). No new auth model.
- Dispatch root: `dispatch-cli trips list|clear` call these through `AgentMcpRunner`.

### 9.6 Reconciliation with billing and PF-7 instant resume
Billing is a trip like any other (key = credentialScope, class billing, cadence 60s growing to 15 min): automatic recovery by probe, explicit recovery by `task_resume` (force probe) or `trips clear`. There is no separate billing breaker, no process-lifetime state, and no "wait 60s after a top-up": the resumed call *is* the probe. Auto-probing a dead credential costs at most one failing request per cadence, system-wide.

## INDEPENDENT ITEMS

Order: **PF-1 -> {PF-2, PF-3} -> PF-4 -> PF-5 -> {PF-6, PF-7, PF-8 -> PF-9, PF-10} -> PF-11.** PF-1, PF-3 and the claudecli capture (PF-2.AC4) can start immediately in parallel. No new packages. Per item: `npx nx lint <p>` (incl. dependency-checks), `npx nx affected -t test`, `verify-dist-load` for built packages. Tests drive REAL components; the only mock is the external boundary: a local HTTP fake provider server (`tmp/agent-engine-orchestrator/fake-provider-*`) speaking real Anthropic/OpenAI/OpenRouter wire shapes (status, headers, JSON, SSE error events) that the real SDKs hit via `baseURL`. These run **by default** (local, not a paid service). Concurrency proofs use latches/barriers and an injected clock/sleep, never wall time. Trip-store tests run **multi-process** (two real child processes on one DB file, barrier-released).

**NC protocol (all "NC" lines).** A negative control is a vitest *mutant run* against a **copy of the touched source under `tmp/<package>/nc/<id>/`** (never the tracked file); the copy is created and removed inside `try/finally`, so a failing run restores nothing because nothing tracked was touched; the test asserts the mutated copy goes RED. `git status --porcelain` must be clean afterward (AGENTS.md).

**Old->new numbering:** draft PF-2->PF-2, PF-3->PF-4, PF-4->PF-5, PF-5->PF-6, PF-6->PF-7, PF-7->PF-8, PF-8->PF-9, PF-9->PF-10, PF-10->PF-11; PF-3 (trip store) and hook types are new.

### PF-1 — types, deterministic classifier, heuristics, failure-event types (no deps; hooks hunk rebases on TRACE-1 `b0ad7219`)
Write scope: `agent-base-types/src/{provider-failure.ts,failure-events.ts (new),errors.ts,hooks.ts (additive: 4 keys + 'provider_blocked' union member),provider-binding.ts (+billingScope,+tripwire,+retryWindowMs),index.ts}`; `agent-base-types` zod for the binding; `agent-core-provider/src/failure/{classify.ts,rules.ts,heuristics.ts,retry-after.ts,cooldown.ts,index.ts}` + `__tests__/failure/*`.
- PF-1.AC1 every §1.1 row is a fixture (>=3 per provider incl. OpenRouter) asserting `{class,scope,retryable,resumable,confidence}`; classifier total (fuzz never throws).
- PF-1.AC2 OpenAI 429 `credit_balance_exhausted`=>billing vs plain 429=>rate_limited; Anthropic 429+`enforced_spend_limit_reached`=>billing vs 429+RA=>rate_limited. NC: classify by status only => RED.
- PF-1.AC3 retry-after parse order incl. HTTP-date, `retry-after-ms`, `x-should-retry:false`, raw >60s preserved. NC: drop HTTP-date branch => RED.
- PF-1.AC4 `agent-core-provider` imports no SDK: enforced by `npx nx lint agent-core-provider` (dependency-checks fails on an undeclared SDK import) plus `npx nx graph` edge assertion; no string-grep proxy.
- PF-1.AC5 (S1/Q4) fixtures: `anthropic-400-prompt-too-long` not swallowed by row 5 (=> `unknown`, suspected `context_length`); `anthropic-400-usage-limit-exact` => billing (row 5); `anthropic-400-usage-limit-reworded` => `unknown`, suspected `billing`, confidence `medium`, evidence attached. NC: widen row 5 to substring => the reworded fixture flips to billing and the "exact-only" assertion goes RED.
- PF-1.AC6 heuristics never promote: for every heuristic fixture `class==='unknown'`; evidence scrubbed (a planted `sk-...` in a body is absent from `evidence`/`message`).
- PF-1.AC7 `isFailureEventKey` accepts exactly {`provider:attempt_failed|failed|tripped|recovered`}, rejects `task:failed`/`provider:blocked`; a test-only `declare module` augmentation registering a second domain makes its keys valid (generality proof).
- PF-1.AC8 cooldown math: base x 2^(n-1), cap 15 min, floor never undercut by jitter (seeded RNG).

### PF-2 — provider adapters single-shot + raw extraction (dep PF-1)
Write scope: `agent-engine-orchestrator/src/providers/{anthropic.ts,openai.ts,claudecli.ts,construct.ts,raw-error.ts (new)}`, `package.json` (drop `p-retry` if unused).
- PF-2.AC1 real `AnthropicProvider` against the fake server: a 529 yields exactly ONE HTTP request and a thrown `ProviderCallError` with status+headers+body (server counter). NC: remove `maxRetries:0` => 3 requests => RED. Same for OpenAI. **Both non-streaming and streaming request shapes** (review gap 2).
- PF-2.AC2 401/402/400 are never re-requested even with `retryConfig.retries=3` (old pRetry bug): counter==1.
- PF-2.AC3 SSE mid-stream `error` event surfaces as `source:'stream-event'`.
- PF-2.AC4 claudecli: real-CLI error captures (auth/billing/rate-limit/overloaded) committed under `__tests__/fixtures/claudecli-errors/` with a **documented refresh procedure** (README); CI never needs the real binary or credentials; the stream loop reports `toolUseEmitted`. Fixtures are committed captures, not CI-generated (review minor).
- PF-2.AC5 (S6, verified-first) characterization: through the real agent-mcp SSE path, no incremental model text is delivered before `chat()` resolves; if the test finds it is, the item adds the `outputEmitted` guard.
- PF-2.AC6 `Retry-After` on a 529 is surfaced (header parsed into the raw error).

### PF-3 — provider trip store (dep PF-1; parallel with PF-2)
Write scope: `agent-store-runtime/src/{db/schema.ts (+provider_trips),store/trip-store.ts (new),index.ts}`, migration, using `agent-core-env` `withImmediateRetry`.
- PF-3.AC1 state machine unit tests with an injected clock: open, check-refuse, probe acquire at `recheck_at`, probe ok closes, probe fail re-opens with grown cooldown, force-probe ignores `recheck_at`, clear with stale `expectGeneration` is a no-op.
- PF-3.AC2 **multi-process safety:** two real child processes on one DB file, barrier-released: (a) 20 concurrent `acquireProbe` => exactly one winner; (b) concurrent `open` of the same key => one row, `generation` strictly increasing, no lost update; (c) a `clear` racing a probe-ok => final state `closed`, no resurrection. NC: replace the CAS `WHERE generation=?` with an unconditional UPDATE => (a) shows 2 winners => RED.
- PF-3.AC3 crashed prober: kill the prober process holding the lease; after `probe_until`, a second process acquires. 
- PF-3.AC4 persistence: close/reopen store, row identical; no timers/sweepers exist (`closed` pruning is on next open).
- PF-3.AC5 contract: the store uses `withImmediateRetry` and `busy_timeout` (assert via the adapter's transaction mode spy, not source grep); busy contention under 8 writers does not surface a raw `SQLITE_BUSY`.

### PF-4 — attempt engine: retry/backoff/failover/trip consult + D-G(4) (deps PF-1, PF-2, PF-3)
Write scope: `agent-engine-orchestrator/src/providers/call-policy.ts (new)`, `engine/orchestrator.ts` (replace catch classification `:541-586` and the `chat` call site; emit §5.2 events), `validation/errors.ts`, `agent-base-types/src/errors.ts`, `validation/agent.ts` (`retryWindowMs`), `interfaces.ts` + `agent-base-types/src/domain.ts:528` `ExecutionContext.retryWindowEndsAt`.
- PF-4.AC-DG4 (adapted from `caebab15`): `models=['claude_sonnet_4_6','claude_opus_4_8']`, first exhausts on 429 (`retries:0` or `retry-after`>60s), engine calls the second; `task_events` has `PROVIDER_ATTEMPT` n=1 `rate_limited`, n=2 `ok`, `failoverFrom:1`; `models[]` order never changed. NC: remove the failover loop => RED.
- PF-4.AC1 529,529,200 => success on attempt 3; gaps respect `retry-after` on 529 as well as 429 (injected clock/sleep).
- PF-4.AC2 402 => ONE attempt, `PROVIDER_BILLING`, `ToolError.data.class==='billing'`, trip opened on `credentialScope`; entry 2 sharing the scope is NOT called; entry 2 on a different scope IS called.
- PF-4.AC3 bounds: always-503 stops at 6 attempts; NC remove bound => RED.
- PF-4.AC4 claudecli fake binary: `tool_use` then error => no retry/failover; no `tool_use` => retried.
- PF-4.AC5 **retry window (B2):** an in-flight attempt that runs past `retryWindowMs` (latch-held) is NOT aborted and completes; no new attempt starts after the window; backoff sleep truncated to the window. NC: abort in-flight at window => the long attempt fails => RED.
- PF-4.AC6 **window reset per call (B1):** a task with 5 model turns, each hitting one 503 then 200, never exhausts a window; turn 5 still retries. NC: share one window across turns => turn 4+ get no retry => RED.
- PF-4.AC7 trip consult: after exhaustion the next call/turn is refused `skipped_trip` with ZERO requests to the server; after `recheck_at` exactly one probe request goes out; success closes the trip (events `provider:tripped`, `provider:recovered{probe_ok}` emitted).
- PF-4.AC8 existing codes unchanged for existing causes; `includes('429')`/`includes('rate limit')` string matching gone from `orchestrator.ts` (assert via the classifier-driven fixtures, not `rg`).
- PF-4.AC9 unknown policy (§1.3): `unknown`+transient suspicion => exactly one retry then terminal; `unknown`+suspected billing => no hold, no suspension, surfaced; 3 unknowns inside 5 min open the model-scoped storm trip.

### PF-5 — persistence, wire, trip host tools (deps PF-1, PF-3, PF-4)
Write scope: `agent-store-runtime/src/{db/schema.ts (tasks.failure, tasks.partial),store/task-store.ts}` + migration; `agent-engine-orchestrator/src/tools/{task.ts,trips.ts (new)}`; `validation/task.ts`; `entrypoint/agent-mcp/src/server.ts` (+`provider_trip_list|check|clear` schemas); agent-mcp README/AGENTS/USAGE_GUIDE.
- PF-5.AC1 through the LOADED MCP `task_run` tool (real stdio client against the built server) with the fake provider returning 402: payload `status:'failed'`, `error:'[PROVIDER_BILLING] ...'`, `failure.class:'billing'`. NC: drop `failure` => RED.
- PF-5.AC2 reopen persistence of `failure` + `partial`.
- PF-5.AC3 `tasks_batch`: one billing-failed, one ok => per-item `failure`; batch not aborted.
- PF-5.AC4 trip host tools through the real stdio server: `provider_trip_list` shows the trip from AC1; `provider_trip_clear` closes it (visible from a **second** agent-mcp process on the same DB); `provider_trip_check` resolves a unit's chain to `credentialScope`; mutating tools are permission-gated (default not silent allow for an agent caller). Closes Q7: structure is returned in the success-shaped payload; `isError` text stays `[CODE] message` (ADR-0004).
- PF-5.AC5 old clients unaffected (existing contract tests green).

### PF-6 — delegation propagation (deps PF-4, PF-5)
Write scope: `engine/orchestrator.ts` delegation tool-result path; `tools/task.ts` (`retryWindowEndsAt` plumbing).
- PF-6.AC1 child 402 on a scope covering the parent's whole chain: parent ends `failed`, `failure.hops` = [origin child, child-of parent], no extra parent model turn (server counter). NC: always give the model a turn => RED.
- PF-6.AC2 (S5) parent chain `[A, B]` (different scopes), child 402 on A: parent IS given a turn and completes via B.
- PF-6.AC3 `retryWindowEndsAt` inheritance: child never retries past the parent's window (injected clock); a three-level always-503 nest opens the trip at the first exhaustion and the deeper levels make zero further requests (counter), never 6^3.

### PF-7 — provider-blocked suspension + durable resume (deps PF-4, PF-5)
Write scope: `engine/orchestrator.ts` (suspension branch), `tools/task.ts` (`taskResume` fallback at `:870`), task store `suspension`.
- PF-7.AC1 billing, HITL on: `awaiting_input`, `suspension.kind==='provider_blocked'`; fake flips 402->200 ("top-up"); `task_resume{retry}` **immediately** (no cooldown wait; force-probe) completes the task and closes the trip. NC: `hitl:false` => `failed`; NC: resume without force-probe => refused by the open trip => RED.
- PF-7.AC2 **process-death resume** (API provider): kill agent-mcp while suspended, restart on the same DB, `task_resume` completes (not `TASK_NOT_RESUMABLE`); replayed request body equals the pre-failure one. NC: revert fallback => RED.
- PF-7.AC3 `cancel` => `cancelled`, resumeToken dead.
- PF-7.AC4 non-provider suspension kinds still `TASK_NOT_RESUMABLE` after restart.
- PF-7.AC5 (B4) claudecli: billing with `toolUseEmitted:true` => terminal `failed` with `partial`, **no** suspension and no durable resume; `toolUseEmitted:false` => suspends and resumes. NC: drop the guard => the tool-using case suspends => RED.

### PF-8 — dispatch hop incl. pause/hold (deps PF-5; PF-7 optional)
Write scope: `dispatch-orchestrator/src/lib/{agent-runner.ts,orchestrator.ts}`, `dispatch-base-spec` (`DispatchLogEntry.provider_failure: ProviderFailureSummary`, derived status `blocked_provider`, unit `notBefore/providerAttempts`), `dispatch-core-optimizer` eligibility.
- PF-8.AC0 characterize today's failed-unit-across-cycles behaviour (red/green, committed first).
- PF-8.AC1 two units on one scope, fake 402 on the first: before the second's task creation the runner's `provider_trip_check` returns tripped => second task NOT created (counter); cycle `provider-blocked`; log carries the summary. NC: remove the pre-create check => second dispatched => RED.
- PF-8.AC2 (B3 race) N units released together by a barrier on one scope: after the first opens the trip, total server requests <= N (no unit makes a second attempt). NC: remove the pre-attempt trip read (PF-4) => > N => RED.
- PF-8.AC3 pause: always-503 for the first unit, trip opens; remaining units stay `pending` with `notBefore=recheckAt`, **zero strikes consumed**, nothing `failed`, cycle `provider-paused`; after `recheckAt` (injected clock) the next cycle probes with one unit and, on success, dispatches the rest.
- PF-8.AC4 no correction milestone injected in any provider case (NC: guard-failure path still injects).
- PF-8.AC5 `AgentMcpRunner.poll` and `provider_trip_check` parse correctly against the real agent-mcp child process.

### PF-9 — dispatch-cli root (dep PF-8)
Write scope: `entrypoint/dispatch-cli/{bin/cli.ts,src/api.ts,src/lib/core.ts}` (+`trips` subcommand), README/AGENTS, `docs-contract.spec`.
- PF-9.AC1 spawned built CLI vs fake provider: billing=>69 (+`providerBlocked`, stderr line); auth=>77; always-503=>75 with `paused.recheckAt`; invalid=>65; success=>0; thrown=>1. Keyed on exit code.
- PF-9.AC2 **precedence:** a cycle with {auth on A, billing on B, invalid on C, transient on D} exits 77 and lists all four in `failures[]`; removing auth => 69; then removing billing => 65; then 75. NC: reverse the order table => RED.
- PF-9.AC3 resume: flip server, `dispatch-cli trips clear <key>`, `run` => exit 0; completed units not re-run (turn counter). `trips list` shows the trip with `recheckAt`.
- PF-9.AC4 `status` lists held/paused units with class + trip + resume hint.

### PF-10 — observability mapping (deps PF-4; TRACE-2 for the plugin)
Write scope: `agent-plugin-tracing` mapping (after TRACE-2; if absent, ships as a TRACE follow-up item; no env toggle either way), metrics registration.
- PF-10.AC1 `provider:attempt_failed` fires once per failed attempt; a throwing handler does not alter the outcome. NC: plugin absent => zero `agent.model_call.attempt` span events.
- PF-10.AC2 one **generic** subscription over `FAILURE_VERBS` x registered domains receives provider events with no provider-specific code; metrics snapshot shows `provider_failures_by_class.billing==1`, `provider_trips_opened==1` after the PF-4.AC2 scenario.
- PF-10.AC3 `hitl:suspend{kind:'provider_blocked'}` maps to the existing hitl span.

### PF-11 — end-to-end + docs (deps all)
Write scope: `entrypoint/dispatch-cli/src/test/integration/`, CHANGELOGs (`agent-engine-orchestrator`, `agent-store-runtime`, `agent-mcp`, `dispatch-orchestrator`, `dispatch-cli`, `agent-base-types`), READMEs/AGENTS/USAGE_GUIDE, `docs/plan/provider-failure/` status.
- PF-11.AC1 real chain dispatch-cli -> dispatch-orchestrator -> real agent-mcp child -> sub-agent -> fake provider: 402 propagates unflattened (`failure.hops.length===3`), root exits 69, `trips clear` + re-run completes. NC per hop (revert PF-5/6/8) => RED.
- PF-11.AC2 cross-process tripwire e2e: two concurrent dispatch runs on one DB; the first trips, the second makes zero provider requests.
- PF-11.AC3 docs-contract tests name every new exit code, error code, host tool and event key.

## OPEN QUESTIONS (human decision)

- Q5 claudecli: does the CLI expose a structured API status? Needs the PF-2.AC4 capture; until then claudecli classification is the weakest link.
- Q6 Mixed-provider `models[]` implies a mid-conversation provider change; confirm acceptable for tool-heavy sessions (server-side tool-result shape divergence unverified).
- Q8 Promote Anthropic "prompt is too long" to a second pinned message rule (enables larger-window failover and `CONTEXT_WINDOW_EXCEEDED` for Anthropic)? **Default until decided: no** (one pinned rule, per Q4; heuristic `suspectedClass:'context_length'` only).
- Q9 Default permission posture for the mutating host tools `provider_trip_clear` / `provider_trip_check{probe:true}` when called by an agent: **default `ask`** unless the owner prefers `deny` for agents (humans/dispatch-cli unaffected).
- Q10 Trip store placement assumes the agent-mcp operational DB is the shared DB of every cooperating process. Confirm no deployment runs agent-mcp processes against *different* DB files that nonetheless share credentials (their trips would not be shared; a per-credential file under `~/.adhd/` is the alternative).
- Closed by review/owner: Q1 (sysexits, precedence §8), Q2 (§9), Q3 (§5.2), Q4 (§1.1/§1.3), Q7 (PF-5.AC4).

## RISKS / NOT VERIFIED

OpenAI `context_length_exceeded`/`content_filter` codes and TS-SDK retry defaults are not primary-confirmed; PF-2.AC1 asserts SDK behaviour empirically. The Anthropic exact usage-limit string is the one message-coupled rule; a provider copy change fails safe to `unknown` (suspected billing) and is observable. Cross-process clock skew shifts only probe timing, never correctness. The sox-adapter migration (ADR-0001) is in flight: PF-3 must follow the transaction helper in use at implementation time. The researcher's `.research-trace/2026-10-06-llm-provider-failure-taxonomy.md` sits untracked in the repo root checkout, not committed here. ADR-0012 (sox) is not in this repo's catalog; AGENTS.md's parallel-process rule is the in-repo statement.

## REVIEW-1 DISPOSITION

Counts: **22 items dispositioned (5 blocking, 7 significant, 7 minor, 3 verified-first gaps): 21 accepted and resolved in text, 1 accepted in part (B5), 0 rejected.**

| Finding | Disposition | Change made |
|---|---|---|
| B1 retryBudget consumption undefined | Accepted | Inherited **window only** (`retryWindowEndsAt`), reset per model call, child snapshot via `min()`; `attemptsRemaining` removed; anti-storm moved to the trip + no delegation retry (§2.2). PF-4.AC6, PF-6.AC3 |
| B2 `deadlineMs` aborts healthy streams | Accepted | Renamed `retryWindowMs`; bounds only new attempts and backoff; in-flight never aborted (§2.2). PF-4.AC5 |
| B3 dispatch can't learn credentialKey; in-flight race | Accepted | `provider_trip_check` host tool resolves chain->scope inside agent-mcp; checked per wave and before each unit's creation; pre-attempt trip read bounds the race to `concurrency x 1`, stated as accepted (§7, §9.5). PF-8.AC1/AC2 |
| B4 claudecli resume after tool_use | Accepted | Side-effect guard now covers retry, failover, suspension and durable resume (§2.2, §6). PF-7.AC5 |
| B5 credentialKey vs org/project spend scope | Accepted in part | Optional `billingScope` on the binding -> `credentialScope`; the heuristic gap (keys without `billingScope` in one org) is documented and bounded, not eliminated (§9.2) |
| S1 classifier precedence / message drift | Accepted | Order proven by fixtures; row 5 exact-only and fails safe to `unknown/suspected:billing` as a drift canary; Q4 risk recorded (§1.1). PF-1.AC5 |
| S2 attempts/hops bloat | Accepted | `ProviderFailureSummary` for dispatch_log/views; task row keeps last 8 attempts; events keep all (§1, §5.1) |
| S3 ErrorCode loses information | Accepted | `PROVIDER_PERMISSION` added; `failure.class` documented as source of truth (§1.2) |
| S4 breaker semantics vs instant resume | Accepted | Breaker replaced by the shared trip; `task_resume` / `probe:true` force-probe, no cooldown wait (§9.3, §9.6). PF-7.AC1 |
| S5 H2 rule credential comparison | Accepted | Compare against the set of scopes across the whole parent chain (§4). PF-6.AC2 |
| S6 idempotency qualifier / partial output | Accepted | Verified-first PF-2.AC5; `outputEmitted` joins the guard if partial text can reach a consumer (§2.2) |
| S7 exit-code precedence | Accepted | Total order 77 > 69 > 65 > 75, payload lists all (§8). PF-9.AC2 |
| Minor: wrong `hitlResolvers` citation | Accepted | Corrected to `engine/orchestrator.ts:196` (+ `tools/task.ts:870` for `taskResume`) |
| Minor: `~` citations | Accepted | Refreshed and opened against this tree |
| Minor: D-G(4) "verbatim" | Accepted | Reworded "adapted" (§3, PF-4.AC-DG4) |
| Minor: PF-1.AC4 `rg` proxy | Accepted | Replaced by dependency-checks lint + graph edge (PF-1.AC4) |
| Minor: Q1/Q4 need defaults | Accepted | Locked by owner decisions; Q8-Q10 carry stated defaults |
| Minor: NC restore | Accepted | NC protocol: mutant runs on `tmp/` copies with `try/finally` |
| Minor: PF-2b needs real `claude` binary | Accepted | Committed captures + documented refresh procedure; CI never needs the binary (PF-2.AC4) |
| Gap 1: Q7 / ADR-0004 | Accepted | Q7 closed; structure rides the success-shaped payload (PF-5.AC4) |
| Gap 2: `maxRetries:0` for streaming | Accepted | PF-2.AC1 covers streaming and non-streaming |
| Gap 3: Retry-After on 529 | Accepted | PF-2.AC6, PF-4.AC1 |

## APPENDIX — ADR CANDIDATES (text only; do NOT create files here; propose to the owner)

Next number: 0009 (catalog holds 0001-0008). All **Status: Proposed**, Owner: pseudosky, Drives: `40fde12c`.

**ADR-0009 candidate A — Provider failures propagate fail-up as a typed value; ask-escalation is for decisions only.** *TL;DR for the next agent:* a provider failure is a credential/provider fact, not a decision. It travels as `ProviderFailure` on `ToolError.data` and task rows, never re-stringified; ADR-0008 D6 `escalate` stays reserved for permission decisions; only the `awaiting_input` carrier is reused for suspension. *Decision:* (1) typed value end to end; (2) no `escalationMaxDepth` coupling; (3) suspension only for credential-scoped classes with a clear side-effect guard. Supplements ADR-0008 D6.

**ADR-0010 candidate B — Single retry owner; sysexits for dispatch-cli.** *TL;DR:* SDK `maxRetries:0`, `callWithPolicy` is the only retry/failover loop; dispatch-cli exits with sysexits 0/65/69/75/77/1 with precedence 77>69>65>75; the payload always lists every failure. *Decision:* (1) no provider adapter retries; (2) retry window bounds starting attempts, never aborts a healthy in-flight call; (3) exit-code vocabulary and precedence as §8.

**ADR-0011 candidate C — Provider health is system-wide shared state (tripwire), stored in the operational DB.** *TL;DR:* a failing provider/credential is remembered once for every process on the shared DB via `provider_trips`; there are no per-process breakers; recovery is probe-by-real-call, force-probe on explicit controller intent, clear by CAS; correctness rests on `generation` CAS under the ADR-0001 D3 locking contract, never on timers or a leader. *Decision:* (1) key = provider + credentialScope (+ wireModel for model-scoped classes); (2) dispatch consumes trips only through agent-mcp host tools; (3) controller affordances are `provider_trip_list|check|clear` + `session_update`; (4) pausing, not failing, is the dispatcher's response to a trip. Consistent with the AGENTS.md parallel-process invariant (`sox ADR-0012`).

**ADR-0012 candidate D — Failure events are one `<domain>:<verb>` family with a closed verb vocabulary.** *TL;DR:* failures never get bespoke event names; domain = what failed, verb in {`attempt_failed`,`failed`,`tripped`,`recovered`}; blocked/held/suspended are `disposition` values; new domains register through `FailureDomainMap`. *Decision:* (1) `provider:*` keys per §5.2; (2) `task:failed` is the task-domain instance and is unchanged; (3) consumers subscribe generically via `isFailureEventKey`; (4) hooks are per-process observational projections, persisted rows are the cross-process truth.
