# REVIEW-1 — docs/plan/provider-failure/SPEC.md

Verdict: **APPROVE WITH REQUIRED CHANGES.** The necessity case holds and the design is coherent: one typed value, one retry owner, fail-up propagation, sysexits-style exit codes. The blocking issues are specific defects in the policy and propagation rules, not in the overall direction.

Spot-checked against the worktree:
- `pRetry` is present at `providers/openai.ts:220` and `providers/anthropic.ts:322`.
- `error.message?.includes('429')` is at `engine/orchestrator.ts:556`.
- `hitlResolvers` is a module-level in-memory Map at `engine/orchestrator.ts:196`.
- `PartialBinding.models` exists at `agent-base-types/src/provider-binding.ts:26`.
- `retryBudget` and `credentialKey` appear nowhere in the repo yet. They are net-new, as the spec says.

## Blocking

**B1. The "inherited retry budget" contradicts the retry-policy default in §2.**
- The default is `retries:2` with a 6-attempt bound per call. `ExecutionContext.retryBudget {deadlineAt, attemptsRemaining}` is passed to children.
- Nothing says whether `attemptsRemaining` is consumed per model call or per task. A parent's own later turns also draw on it. Over a long multi-turn task the budget would exhaust by turn 3, and later turns would get zero retries.
- Fix: define the budget as per-delegation-subtree and per-call-window. Reset it on each parent model turn, and pass the child a snapshot. State this explicitly. PF-5.AC3 only tests the nested-503 case, which does not expose the problem.

**B2. The `deadlineMs: 120_000` default can invalidate legitimate runs.**
- Streaming calls to large models routinely run longer than 120s.
- Is `deadlineMs` a deadline on retries or on the whole call? §2.2 says "<= `deadlineMs` wall total", which reads as the whole call, including a healthy first attempt.
- Fix: scope it to the retry and backoff window, meaning no new attempt starts after the deadline. Never abort an in-flight healthy attempt with it. Say so in the spec.

**B3. Unbounded provider blocking in one dispatch cycle (§7).**
- The hold covers only units whose resolved `credentialKey` equals the held key. Units are resolved lazily. The spec does not say who resolves a unit's `credentialKey` or when, since `dispatch-orchestrator` has no registry dependency today.
- It also does not say what happens to units already in flight in the same cycle when the first one returns billing. Concurrent units will each burn up to 6 attempts before the hold registers.
- Fix: specify a runtime credential-hold check that is synchronous with unit dispatch. Specify how `credentialKey` reaches dispatch, for example via `task_read.failure` plus a registry lookup at plan time. State the in-flight race as accepted or mitigated.

**B4. Durable resume replays against a possibly changed message history (§6, PF-6.AC2).**
- The spec claims the replayed call is valid because "the chat call committed nothing". That holds for API providers only.
- For claudecli, the CLI manages its own session. The zero-`tool_use` guard in §2.2 covers retry. It is not applied to the durable-resume path, which can resume a claudecli call that already ran tools.
- PF-6.AC2's "request body equals pre-failure" check is only meaningful for API providers.
- Fix: state that provider-blocked suspension for claudecli is allowed only if `toolUseEmitted===false`. Otherwise fail terminally with `partial`. Add an AC for it.

**B5. Failover across `credentialKey` is conflated with failover across providers (§2.1).**
- For billing, the rule is "only entries whose `credentialKey` differs".
- `credentialKey = sha256(providerType|baseURL|secretEnvName)`. Two models on the same provider with the same env-var secret share the key, as intended.
- But OpenAI spend limits are per organization or project, not per key. Two keys in the same org share the limit, and the spec's key identity is a heuristic that would fail over uselessly.
- Fix: document this as a known limit. Consider letting the registry declare an optional `billingScope` on a credential. Otherwise accept the wasted attempt, which the attempt bound already caps.

## Significant

**S1. The classifier row order has a precedence bug.**
- Row 7 (any remaining 429 becomes rate_limited) comes before row 9 onwards, which is fine.
- Row 5 matches an Anthropic 400 on message text, but row 12's context-length message check is evaluated after row 11 (403) and does not cover Anthropic 400s that precede it. Row 16 (400) is last. The order works, but it depends on rows 5 and 12 both running before row 16. Add a fixture proving a 400 `prompt is too long` is not swallowed by row 5's looser matching.
- Row 5 is described as an exact message equality. Provider copy changes will silently demote billing to `invalid_request`. Add a `classifierVersion` drift canary, for example a periodic fixture refresh. A message-equality rule that fails closed to `invalid_request` is the safe direction, but record it in the Q4 risk.

**S2. The `attempts` and `hops` arrays inside `ProviderFailure` bloat `task_read` and `dispatch_log`.**
- Up to 20 attempts, plus hops, plus a 500-character message are persisted per task and copied into every dispatch log entry.
- Specify a size cap or summary form for the `dispatch_log` copy (counts and last attempt only). PF-7 says "per-unit `attempts` summary", but §5 says the same record is used everywhere.

**S3. The `ErrorCode` mapping loses information (§1.2).**
- `permission` and `unknown` both map to `PROVIDER_ERROR`.
- `content_policy` gets a new code but `permission` does not.
- Consumers that switch on codes cannot tell a rotated-key-fixable 403 from an unknown failure. Consider `PROVIDER_PERMISSION`, or document that the structure on `failure.class` is the source of truth.

**S4. Breaker semantics are under-specified (§2.1, §2.2).**
- "Credential open until process end or half-open probe every 60s" for billing means an agent-mcp server process that was topped up still fails fast for up to 60s after the top-up.
- The 60s probe is also in conflict with PF-6.AC1, where `task_resume` is expected to succeed immediately after a flip.
- Fix: an explicit `task_resume` or retry intent should bypass or reset the breaker for that credential.

**S5. §4 H2 rule 1 compares `credentialKey` between child failure and parent selection.**
- The parent may use a different `models[]` entry mid-call because of failover. Define "parent selection credentialKey" as the credential of the parent's currently active target, or the set of credentials in its chain.
- If any entry in the parent chain has a different credential, the parent should be given a turn, because failover may succeed.

**S6. Idempotency claim for API providers needs one qualifier (§2.2).**
- `chat()` is pure until it returns. That ignores server-side tools such as web_search, which the spec notes are billed-only.
- It also ignores streaming responses that have already been forwarded to a live consumer, if any exist in agent-mcp SSE streaming. Verify that no partial text is emitted to callers before the failure resolves. If it is, a retry produces duplicated output for the consumer.

**S7. The exit-code table assigns 69 only to billing.**
- A mixed cycle with billing on credential A and auth on credential B has no defined code.
- Add precedence: for example, the lowest-numbered actionable block wins, with all classes listed in the payload.
- Also, exit 65 for `invalid_request` and 75 for transient failures can co-occur in one cycle. Define the ordering.

## Minor

- The Provenance and Evidence sections cite `tools/task.ts:~884-897` for `hitlResolvers`. The Map is actually at `engine/orchestrator.ts:196`, with the resolve and delete logic at roughly L199-L738. Correct the citation.
- All line citations use `~`. Refresh them against the current tree before implementation begins.
- §3 says "D-G(4) AC is reproduced verbatim", but the text then refines it ("first 429s" now means exhausted retries). It is not verbatim. Reword to say it is "adapted".
- PF-1.AC4 asserts "no SDK imports under `agent-core-provider`" via an `rg` assertion in a test. That is a string-shaped proxy. Prefer an Nx dependency-graph check or the dependency-checks lint.
- Q2, Q6 and Q7 are legitimate open questions. Q1 and Q4 should have a recommended default stated, so the implementer is not blocked.
- Several ACs say "NC: remove X => RED". Specify, for the NC runs, how the reverted state is restored (a `finally` block), per the AGENTS.md rule on negative controls that mutate tracked files.
- The item graph is "PF-1 -> {PF-2} -> PF-3 ...", but PF-2b (claudecli fixture capture) is said to start immediately in parallel. It requires the real `claude` binary and credentials. Note that these fixtures cannot be generated in CI, so they should be committed captures with a documented refresh procedure.

## Verified-first gaps (recommend adding to the plan)

1. The ADR-0004 / `isError` channel: Q7 asks for confirmation, but PF-4.AC1 already assumes the structure is returned in the success-shaped `task_run` payload. This is consistent, so close Q7 with that decision.
2. Add an AC that SDK-level `maxRetries:0` also disables the SDK's built-in connection-level retries for streaming calls, not only for non-streaming ones. PF-2.AC1 tests only one request shape.
3. Add an AC for `Retry-After` honored on `overloaded` (529), not only 429.

## Summary of required changes before approval

B1 through B5 resolved in the text, and S1, S4, S5 and S7 resolved or explicitly deferred with a reason. The rest can be handled during implementation.
