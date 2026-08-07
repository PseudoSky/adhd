# DESIGN — agent-mcp usage accounting redesign

> Companion to [`SCOPE.md`](./SCOPE.md) (the investigation). This document records the
> **locked design decisions** reached through Q&A, corrected against live evidence where
> the investigation's speculation didn't hold up. Tracks **DEBT-AGENTMCP-ACCOUNTING-001**.
> Written 2026-07-16 in worktree `agent-mcp-usage-accounting`.

## 0. Status

| Item | Status |
|---|---|
| Ephemeral task session-id bug (precondition for session grain) | **FIXED, committed** `76de942d` in this worktree — `packages/agent/agent-engine-orchestrator/src/tools/task.ts:85` + regression test |
| §5 DB capture layer (`compute_ms`, `est_tool_result_tokens`, `est_cost_usd`, migration 0010, rate card) | **IMPLEMENTED** — `packages/agent/agent-store-runtime/src/db/schema.ts`, `agent-engine-orchestrator/src/{engine/orchestrator.ts,plugins/usage-plugin.ts}`, `agent-core-provider/src/pricing/rate-card.ts`. Real-component tests: `agent-engine-orchestrator/src/__tests__/usage-accounting.test.ts`, `agent-core-provider/src/__tests__/rate-card.test.ts`. |
| §8 grain-based `usage_query` (session/task/turn) | **IMPLEMENTED** — `agent-engine-orchestrator/src/tools/usage.ts` (`usageQueryByGrain`), `validation/usage.ts` (row/summary schemas), wired into `entrypoint/agent-mcp/src/server.ts`'s `usage_query` tool. Real-component tests: `agent-engine-orchestrator/src/__tests__/usage-grain.test.ts` (includes the §8 reconciliation test: task_usage cumulative == Σ turn-grain rows). See §9 for the two implementation decisions this pass made that supersede/clarify the original design. |
| `nx build`/`nx test agent-mcp` | **BLOCKED** by a pre-existing, unrelated infrastructure bug (`vite-plugin-dts` composite-project-boundary violation on `agent-plugin-budget`/`agent-plugin-sanitize`) — see `BACKLOG.md` BUG-AGENTMCP-009. Verified instead via `agent-engine-orchestrator`'s full build/lint/test (green), which doesn't route through the broken path. |

## 1. Governing principle

**Turn is the base unit.** Task and session are pure aggregations over turns — nothing is
computed independently at those levels. One `MODEL_RESPONSE` event = one turn.

- **DB layer: additive only.** No existing column in `task_usage` is renamed or dropped.
- **API layer (`usage_query` MCP tool response): breaking change, clean major version bump.**
  snake_case throughout, identical field set at every grain (no grain-specific shapes).

## 2. Grains

`grain: 'session' | 'task' | 'turn'` — request param, default `'task'`, **echoed back** as a
top-level `grain` key in the response so a consumer never has to infer what they got.

| Grain | Source | Meaning |
|---|---|---|
| `turn` | `task_events` (`type='MODEL_RESPONSE'`) | one model call |
| `task` | `task_usage` | one task (current default behavior) |
| `session` | `tasks.session_id` join over `task_usage` | one session |

Session grain's precondition — every task (including ephemeral) actually carrying a
`session_id` — is now fixed (§0). Before the fix, live data showed 11/18 tasks
(100% of ephemeral tasks) with `session_id IS NULL`, invisible to this grain entirely.

## 3. Row shape — same metrics at every grain, flattened

Metrics are **flattened directly onto the row** (no `cumulative{}` wrapper) because once
`grain` picks what a row *represents*, the row's own fields already ARE that grain's
numbers — task-grain `input_tokens` is already "cumulative for this task."

`context_size` / `context_size_at` (renamed from `peak_tokens`/`peak_at` — "peak" was
accurate but not the clearest name; "context_size" says directly what it measures) are
**also flat, not nested** — a `context{}` wrapper would stutter into
`context.context_size`, and the field name is now self-descriptive enough not to need a
wrapper at all, consistent with the plain-compound-name convention used everywhere else
in this response. `context_size` remains structurally different from every other field —
a **MAX**, never a **SUM** — that distinction now lives entirely in the name, not in
nesting. (Not the same thing as `contextWindowFor()` in `context-window.ts` — that's the
model's *fixed* window size, a config constant; `context_size` here is the *measured*
largest single call. Not exposed in the same response, so no actual collision, just don't
conflate them when reading the codebase.)

```jsonc
{
  "grain": "task",
  "rows": [{
    "session_id": "...", "task_id": "...", "root_task_id": "...",
    "call_index": null,                      // populated (1-based) only at turn grain
    "agent_name": "...", "provider_type": "...", "model": "...",
    "created_at": "...", "is_complete": true, "stop_reason": "...",

    "input_tokens": 1154170, "output_tokens": 41200,
    "uncached_input_tokens": 139386, "cache_read_tokens": 1014784,
    "cache_creation_tokens": 0, "reasoning_tokens": 0,
    "tool_call_count": 34, "model_calls": 8,
    "compute_ms": 41200, "total_ms": 219340,
    "tool_call_est_result_tokens": 88120, "est_cost_usd": 4.31,

    "context_size": 172521, "context_size_at": { "task_id": "...", "call_index": 6 }
  }],
  "summary": {
    "row_count": 5,
    "input_tokens": 0, "output_tokens": 0, "uncached_input_tokens": 0,
    "cache_read_tokens": 0, "cache_creation_tokens": 0, "reasoning_tokens": 0,
    "tool_call_count": 0, "model_calls": 0, "compute_ms": 0, "total_ms": 0,
    "tool_call_est_result_tokens": 0, "est_cost_usd": 0,
    "context_size": 0, "context_size_at": { "task_id": "...", "call_index": 0 }
  }
}
```

`context_size_at` is an **object** (`{task_id, call_index}`) at every grain, not a bare
integer — at turn/task grain it's trivially self-referential, but at session grain it
must identify *which task's which call* had the largest context, so the shape has to be
the object form everywhere for the "same model at every grain" rule to hold.

## 4. Formulas per grain

### Turn (base unit — one `MODEL_RESPONSE` event)

| Field | Formula |
|---|---|
| `input_tokens` | `payload.inputTokens` (provider-normalized: Anthropic = reconstructed `uncached+cache_read+cache_creation`; OpenAI-family = `prompt_tokens`, natively inclusive) |
| `output_tokens` | `payload.outputTokens` |
| `uncached_input_tokens` | `payload.uncachedInputTokens` |
| `cache_read_tokens` | `payload.cacheReadTokens ?? 0` |
| `cache_creation_tokens` | `payload.cacheCreationTokens ?? 0` |
| `reasoning_tokens` | `payload.reasoningTokens ?? 0` — **subset of `output_tokens`, not additive** |
| `tool_call_count` | `payload.toolCallCount` |
| `model_calls` | `1` (trivial) |
| `compute_ms` | `MODEL_RESPONSE.created_at − MODEL_REQUEST.created_at`, paired adjacent events same `task_id` |
| `total_ms` | `= compute_ms` (trivial — no gap within a single call) |
| `tool_call_est_result_tokens` | Σ `tool_call_est_result_tokens` over `TOOL_RESULT` events for this `task_id` between this `MODEL_RESPONSE` and the next `MODEL_REQUEST` |
| `est_cost_usd` | `uncached_input_tokens×rate.input + cache_read_tokens×rate.cache_read + cache_creation_tokens×rate.cache_write + output_tokens×rate.output` |
| `context_size` | `= input_tokens` (trivial, one call) |
| `context_size_at` | `{ task_id: own, call_index: own }` (trivial self-reference) |

### Task (Σ over every turn where `task_events.task_id = X`)

All 10 additive fields (including `compute_ms`, see §6) = **Σ over turns**. `model_calls`
= **COUNT** of turns.

Two fields are **not** simple sums:
- `total_ms` — **wall-clock** (`task.completed_at − task.started_at`, the existing
  `latency_ms` DB column, unchanged, exposed under this new API name) — **not**
  `Σ turn.total_ms` — a turn-sum would only capture model-thinking time and undercount
  real duration (misses tool-exec/queueing gaps between calls). `compute_ms` IS that
  turn-sum, which is exactly why the two fields had to split.
- `context_size` = **MAX** over turns' `input_tokens`. `context_size_at` =
  `{ task_id: X, call_index: <argmax turn> }`.

### Session (Σ over every task where `tasks.session_id = X`)

All 10 additive fields (including `compute_ms`) = **Σ over tasks** (transitively Σ over
every turn in the session).

- `total_ms` = `MAX(task.completed_at) − MIN(task.created_at)` across the session's
  tasks — **not** a sum. Resolved (§6): correctly handles concurrent/delegated sub-tasks
  instead of oversumming their wall-clock spans.
- `context_size` = **MAX** over every turn across every task in the session.
  `context_size_at` = `{ task_id: <which task>, call_index: <which turn> }`.

## 5. DB schema changes (additive, migration 0010, non-destructive)

```sql
ALTER TABLE task_usage ADD COLUMN est_tool_result_tokens INTEGER;  -- cumulative rollup
ALTER TABLE task_usage ADD COLUMN est_cost_usd REAL;               -- cumulative rollup, NULL if no rate-card entry (never silently 0)
ALTER TABLE task_usage ADD COLUMN compute_ms INTEGER;              -- cumulative Σ turn (MODEL_RESPONSE - MODEL_REQUEST); existing `latency_ms` column is unchanged and becomes the `total_ms` API field
```

`task_events.payload` needs no schema migration (JSON blob) — new keys just start
appearing:
- `TOOL_RESULT` payload `+= tool_call_est_result_tokens` (tokenized on the **full**
  untruncated result, **before** the existing 500-char truncation at
  `orchestrator.ts:663-677` — tokenizing the already-truncated summary would undercount
  every large tool result).
- `MODEL_RESPONSE` payload — **no shape change needed**. Live-verified (see §7 below):
  capture is already 100% complete on/after `2026-07-15T19:47:22`; the historical gap is
  backfill-only, not an active bug.

## 6. Resolved questions

1. **Latency — RESOLVED, split into two fields instead of one ambiguous one:**
   - `compute_ms` — **always Σ**, no special case, at every grain: turn =
     `MODEL_RESPONSE.created_at − MODEL_REQUEST.created_at`; task = Σ turn `compute_ms`;
     session = Σ task `compute_ms`. New additive rollup column, `task_usage.compute_ms`.
   - `total_ms` — the non-additive wall-clock span, same category as `context_size` (a
     computed span, not a sum): turn = same as `compute_ms` (trivial, no gap within one
     call); task = `task.completed_at − task.started_at` (the **existing** `latency_ms`
     DB column, unchanged, just exposed under a new API name); session =
     `MAX(task.completed_at) − MIN(task.created_at)` across the session's tasks — the
     real elapsed span, correctly handling concurrent/delegated sub-tasks instead of
     oversumming them.
   - The old single `latency_ms` field is retired at the API layer (DB column stays,
     unchanged, per the additive-only rule — it just now maps to `total_ms` instead).

3. **`providers/openai.ts`'s silent-usage-drop guard — RESOLVED, no action.** Zero
   observed instances since the 2026-07-15 cutover. Leaving as-is; revisit only if it
   actually recurs in live data.

## 6b. Still open

2. **`est_cost_usd` rate-card sourcing.** Confirmed (re-checked in code, not assumed):
   neither Anthropic's Messages API nor the OpenAI-compatible/DeepSeek completions API
   returns a dollar cost anywhere in `rawUsage` — only token counts. No $/M-token rate
   card exists anywhere in the repo today (`agent-core-provider/src/seed/models.ts` has
   only a `pricingTier` label, no actual rates) — so it must be sourced, not captured.
   Three options, still none chosen: (a) I research + source current published rates for
   the 4 seeded Claude models + DeepSeek, log to memory per DRY policy; (b) you supply the
   numbers directly; (c) drop cost from this pass, ship tokens-only, file as follow-up
   BACKLOG.

## 7. Corrections made during design (superseding SCOPE.md speculation)

- **SCOPE.md's "streaming responses / tool-only turns" theory for the 48/112 gap is
  falsified.** Live query against `~/.adhd/agent-mcp/agents.db` shows a clean binary
  cutover at `2026-07-15T19:47:22` — every task before it has 0% turn-level `inputTokens`
  coverage, every task at/after it has 100%, zero partial-coverage tasks anywhere. That's a
  one-time code change (the event payload started capturing `inputTokens`), not a per-call
  provider quirk. `git log -S` confirms the line was added in a prior commit.
- **The "`usage-plugin.ts:93` zero-fills `task_usage` on missing usage" claim was
  overstated.** Live data shows every one of the historical no-turn-coverage tasks has a
  **correct, nonzero** `task_usage.input_tokens` — `task_usage` was never actually missing
  data; only the *duplicate* copy in the event payload was, before that field existed in
  the write path.

## 8. Implemented (was: "Not yet implemented (next steps once §6 is resolved)")

- Migration 0010 (additive columns, §5) — done.
- `usage.ts` serializer: `grain` param + flattened snake_case row/summary response (§3) —
  done, as `usageQueryByGrain()`. See §9.1 for how it coexists with the pre-existing
  `group_by` aggregation instead of replacing it.
- Session-grain query (`tasks` JOIN `task_usage`, grouped by `session_id`) — done.
- Turn-grain query (`task_events` sourced, `call_index` derivation) — done. Attributes
  `TOOL_RESULT` token estimates to the `MODEL_RESPONSE` turn that produced them by
  walking events per task in creation order (a `MODEL_REQUEST` closes out attribution
  for the prior turn).
- `gpt-tokenizer` dependency + tool-result tokenization at write time — done (was
  already landed before this pass; unchanged here).
- Rate-card module `agent-core-provider/src/pricing/rate-card.ts` (§6.2, option (a)) —
  done (was already landed before this pass; unchanged here).
- Reconciliation test: `task_usage` cumulative == Σ turn-grain rows — done, in
  `agent-engine-orchestrator/src/__tests__/usage-grain.test.ts` ("Σ turn fields equal
  task_usage's cumulative rollups").

## 9. Implementation decisions made completing this pass (not pre-specified in §1-§8)

### 9.1 `grain` is additive alongside `group_by`, not a breaking replacement

§1 called for the whole `usage_query` response to be "a breaking change, clean major
version bump." In practice `group_by='agent'|'model'|'provider'` (the pre-existing
aggregate-by-key shape, with its own `BUG-ORCH-009` regression tests) has no equivalent
in the grain design — a `group_by` row represents "one agent/model/provider" the way a
grain row represents "one turn/task/session," and the two are orthogonal request shapes,
not one subsuming the other. Rather than delete a tested, working feature to force a
"clean" bump: `usage_query`'s dispatch (`entrypoint/agent-mcp/src/server.ts`,
`runUsageQuery()`) sends a request to the legacy `usageQuery()` (`group_by` shape) when
`group_by` is supplied, and to the new `usageQueryByGrain()` (§2-§4 shape) otherwise —
`group_by` wins if a caller (incorrectly) supplies both. This is a **purely additive**
change to the public contract, not the breaking bump originally specified; if retiring
`group_by` entirely is still wanted, that's a separate, deliberate follow-up (not
bundled into this pass to avoid deleting working, tested behavior unprompted).

### 9.2 Session-grain identity fields are `null`, not a single (possibly wrong) value

§3's example row is generic and doesn't show a session-grain row explicitly. A session
aggregates every task in `tasks.session_id = X` — which, via delegation, can span
multiple agents and even multiple models. There is no single correct value for
`task_id`, `root_task_id`, `agent_name`, `provider_type`, `model`, or `stop_reason` at
session grain, so the row schema (`usageRowSchema`, `validation/usage.ts`) makes all six
nullable and `usageQueryByGrain`'s session-grain rows always emit `null` for them —
never an arbitrary "first task's" value, which would silently misattribute the session
to one delegate. `session_id`, the 10 additive metrics, and `context_size`/
`context_size_at` (which — critically — still names the exact task/call that produced
the session's peak) remain fully populated and are the fields a session-grain consumer
should actually read.
