# SCOPE — agent-mcp usage accounting

> Plan type: **investigate + correct**. Goal: make agent-mcp's token/usage data model
> **accurate, unambiguous, and reconcilable** — so a caller can tell "what did this cost"
> (cumulative) apart from "will a call fit" (context size), and can attribute cost to tool
> calls. Written 2026-07-16 against `@adhd/agent-mcp` **v2.1.1**
> (`entrypoint/agent-mcp/package.json`).

## Sourcing convention (read this first)

Every factual claim below is tagged with how it was established. **Nothing in this document
is asserted from model recall.**

| Tag | Meaning |
|---|---|
| `[DDL]` | Read directly from a Drizzle migration file under `entrypoint/agent-mcp/drizzle/*.sql` (the authoritative applied schema). File cited inline. |
| `[DB]` | Observed by a **read-only** (`sqlite3 -readonly` / `PRAGMA` / `SELECT`) inspection of a live database on 2026-07-16. DB path cited inline. |
| `[TOOL]` | Observed as literal output of the agent-mcp `usage_query` MCP tool on 2026-07-16. |
| `[ARITH]` | Derived by arithmetic from `[DB]`/`[TOOL]` numbers; the calculation is shown. |
| `[SRC-COMMENT]` | Quoted from a maintainer comment in repo source (migration comment). File + lines cited. |
| `[RESEARCH]` | From the 2026-07-16 research runs (memory episodes cited by UID) and/or vendor docs. **Snippet-sourced, MEDIUM confidence, NOT independently verified in this environment.** Treat as a lead to confirm, not fact. |

If a statement has no tag, it is a definition or a proposal, not a claim of fact.

---

## 1. Problem statement

Two tools reporting the "same" work produced numbers that looked contradictory, which
surfaced three real defects in how usage is modeled and exposed:

- agent-mcp reported a single task as **`inputTokens: 1,154,170`** while another tool showed a
  whole session as **`input: 88 / cache read: 355,712 / total: 356,498`**. `[TOOL]` / (the
  second is an opencode panel, see §5). These were never comparable — one is a **cumulative
  running total that includes cache reads**, the other is a **per-turn snapshot that excludes
  cache** — but nothing in the field names says so.
- The field name `input_tokens` does not signal that it is (a) **cumulative** across all model
  calls and (b) **cache-inclusive** (`= uncached + cache_read`). `[ARITH]` (§3).
- Tool-call token consumption — a first-class cost driver — is **not stored at all**; only a
  `tool_call_count` integer exists. `[DB]` (§4).

The maintainer already identified the cumulative-vs-peak half of this and partially fixed it
in migration `0008` (§3); this scope covers what remains.

---

## 2. Ground truth — the agent-mcp schema (what is stored, and at what grain)

DB inspected: **`/Users/nix/.adhd/agent-mcp/agents.db`** (Drizzle-managed SQLite). `[DB]`
Tables present: `agents, sessions, messages, tasks, task_events, task_usage,
composed_prompts, experiment_assignments, __drizzle_migrations`. `[DB]`

### 2.1 `task_usage` — grain: **one row per task** (`task_id` PRIMARY KEY) `[DDL]` `[DB]`

Column provenance (each column traced to the migration that added it):

| Column | Added by | Meaning |
|---|---|---|
| `task_id` (PK), `root_task_id`, `agent_name`, `provider_type`, `model`, `created_at` | `0001_task_usage.sql` `[DDL]` | identity |
| `input_tokens`, `output_tokens`, `tool_call_count`, `model_calls`, `latency_ms`, `is_complete` | `0001_task_usage.sql` `[DDL]` | **cumulative** counters (see 0008 comment) |
| `stop_reason`, `max_tokens` | `0002_lumpy_silver_centurion.sql` `[DDL]` | |
| `cache_read_input_tokens`, `cache_creation_input_tokens` | `0003_nifty_shriek.sql` `[DDL]` | cumulative cache tokens |
| (table rebuilt to consolidate the above) | `0007_smart_callisto.sql` `[DDL]` | |
| `uncached_input_tokens`, `reasoning_tokens`, `peak_context_tokens`, `peak_context_at` | `0008_cache_and_peak_context_usage.sql` `[DDL]` | cache split + **peak (snapshot) high-water mark** |

`tool_call_count` and `model_calls` are **integer counts, not token sizes**. `[DDL]`

### 2.2 `task_events` — grain: **one row per event** `[DB]`

Event-type counts across the DB at inspection time: `TOOL_CALL` 141, `TOOL_RESULT` 141,
`MODEL_REQUEST` 113, `MODEL_RESPONSE` 112, `TASK_COMPLETED` 17, `TASK_FAILED` 1. `[DB]`
Token data lives only in the JSON `payload`:

- **`MODEL_RESPONSE`** payload carries per-model-call tokens: `inputTokens, outputTokens,
  cacheReadTokens, cacheCreationTokens`, plus a provider-native `rawUsage` object
  (`prompt_tokens, completion_tokens, total_tokens, prompt_cache_hit_tokens,
  prompt_cache_miss_tokens, prompt_tokens_details, completion_tokens_details`), plus
  `stopReason, toolCallCount, hasContent`. `[DB]`
  **Coverage is partial: only 48 of 112 `MODEL_RESPONSE` events actually carry `inputTokens`**;
  the remaining 64 have only `stopReason/hasContent/toolCallCount`. `[DB]`
- `MODEL_REQUEST` payload: `messageCount, toolCount` — **no tokens**. `[DB]`
- `TOOL_CALL` payload: `tool, callId, arguments` — **no tokens**. `[DB]`
- `TOOL_RESULT` payload: `tool, callId, isError, result` — **no tokens**. `[DB]`

(`task_events` table created in `0000_nifty_sasquatch.sql`. `[DDL]`)

### 2.3 `messages` — grain: one row per message — **no token columns at all** `[DB]`

Columns: `id, session_id, role, content, tool_calls, tool_results, created_at`. `[DB]`

---

## 3. The cumulative-vs-snapshot distinction (the core concept)

**Definitions.**
- **Cumulative** = a running total summed over every model call in a task/session.
  Monotonically increasing. **Unbounded** — it can far exceed the model's context window and
  says nothing about whether any single call fits.
- **Snapshot** = the size of a **single** model call's prompt. This — and only this — is what
  the context window bounds; a call errors when its prompt exceeds the window.

**The maintainer already stated this problem verbatim** in
`drizzle/0008_cache_and_peak_context_usage.sql` (lines 8–12) `[SRC-COMMENT]`:

> "Peak context. Every column accumulated with `+=`; nothing tracked a MAX. So a run that
> billed 715K tokens across 24 calls was indistinguishable from one that held a 715K context,
> when the true high-water mark was 43K. Callers could not tell 'many small calls' (fix:
> preserve the cache) from 'one huge call' (fix: cap that input)."

`0008` added `peak_context_tokens` / `peak_context_at` to record the snapshot high-water mark
alongside the cumulative counters. `[DDL]` **This is the correct structural fix and is already
in place** — but the cumulative columns are still *named* as if they were sizes (see §7).

**Live falsification proof that `input_tokens` is cumulative, not context size** — task
`9aa2cb7b-4473-4789-a3fb-86ba1256f3de` `[TOOL]`:

```
input_tokens        = 1,154,170     (cumulative)
peak_context_tokens =   172,521     (snapshot — the real context size)
model_calls         =         8
is_complete         =         1     (ran to completion — never hit a context limit)
```

If `1,154,170` were a single prompt it would exceed any current context window and the call
would have errored. It completed with a peak single-call size of `172,521`. Therefore
`input_tokens` is a **sum across the 8 calls**, not an occupancy. `[ARITH]`

**Which agent-mcp fields are which:**

| Field | Kind | Window-bounded? |
|---|---|---|
| `input_tokens`, `output_tokens`, `uncached_input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `reasoning_tokens`, `tool_call_count`, `model_calls`, `latency_ms` | **cumulative** | No — unbounded |
| `peak_context_tokens`, `peak_context_at` | **snapshot** (max) | Yes |

---

## 4. Cache accounting

- **`input_tokens` is cache-INCLUSIVE**: `input_tokens = uncached_input_tokens +
  cache_read_input_tokens`. Verified on task `9aa2cb7b`: `139,386 + 1,014,784 = 1,154,170`.
  `[ARITH]` `[TOOL]`
- Cache tokens matter enormously to cost. Per the `0008` comment `[SRC-COMMENT]`: on
  `deepseek-v4-flash`, **cache-hit vs cache-miss input differs 50× in price
  ($0.0028/M vs $0.14/M)** — "the largest cost signal in the system." The comment records that
  a context limiter once "silently collapse[d] cache hit rate from ~98% to ~5% (BUG-ORCH-008)
  with no telemetry able to show it."
- The provider-native cache fields are captured in the `MODEL_RESPONSE` `rawUsage` payload
  (`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`) `[DB]` — i.e. DeepSeek's OpenAI-
  compatible convention where `prompt_tokens` **includes** cached tokens.
- `cache_creation_input_tokens` is **0** across the observed DeepSeek tasks `[TOOL]` — DeepSeek
  has no separate cache-write billing class (cache hit vs miss only). Contrast Anthropic, which
  bills cache *writes* at a premium — see §6, `[RESEARCH]`.

---

## 5. Reference: how opencode models the same thing (for contrast)

DB inspected read-only: **`/Users/nix/.local/share/opencode/opencode.db`** (SQLite, WAL). `[DB]`
opencode stores tokens at **both** grains, which is instructive:

- **Per assistant message** (`message.data` JSON): `tokens.{input, output, reasoning,
  cache.write, cache.read, total}` + `cost`; finer still, per model step (`part` type
  `step-finish`). `[DB]`
- **Per session** (dedicated columns on `session`): `tokens_input, tokens_output,
  tokens_reasoning, tokens_cache_read, tokens_cache_write, cost` — these are a **cumulative
  sum**, verified on a 1,928-message session where the session columns equalled `SUM()` over
  every message's `tokens.*` to the digit (cumulative input there = 9,427,070). `[DB]` `[ARITH]`
- The usage **panel** number (`input 88 / cache read 355,712`) is a **per-turn snapshot of the
  last assistant message**, not a session total: on a busy session the last message read
  `input 46, cache.read 291,072` while the session cumulative input was 9.4M. `[DB]` `[ARITH]`
- opencode **compacts context**: a dedicated `part` type `compaction` (17 parts across 13
  sessions), keyed `{auto, tail_start_id, type}`, prunes context before `tail_start_id`. `[DB]`
  This is why its cumulative growth stays sublinear where agent-mcp's does not (agent-mcp has
  no compaction mechanism in its schema `[DB]`).

**Takeaways for agent-mcp:** (a) opencode proves it is reasonable to keep BOTH per-call and
cumulative token records; (b) a headline "input" number can be a snapshot in one tool and a
cumulative in another — naming must disambiguate.

---

## 6. Reference: provider usage conventions `[RESEARCH — UNVERIFIED IN THIS ENVIRONMENT]`

The following provider-API field shapes are from the 2026-07-16 research (memory episodes,
§9) and vendor docs. They were **snippet-sourced, not independently exercised here**. Confirm
against the cited docs before implementing against them.

- **Anthropic (Messages API):** `input_tokens` **excludes** cache; cache is separate lines
  `cache_read_input_tokens` (~0.1×) and `cache_creation_input_tokens` (~1.25×). Per-call.
  `[RESEARCH]` — docs.anthropic.com.
- **OpenAI (Chat Completions):** `prompt_tokens` **includes** `prompt_tokens_details.cached_tokens`;
  `completion_tokens_details.reasoning_tokens` is a subset of completion. `total_tokens =
  prompt + completion`. Per-call. `[RESEARCH]` — platform.openai.com/docs.
- **OpenRouter:** per-generation; `native_tokens_prompt/completion` (provider tokenizer) vs
  normalized `tokens_prompt/completion`; adds `cost` / `cache_discount`; cumulative is the
  caller's own sum. `[RESEARCH]` — openrouter.ai/docs.

agent-mcp's `providerType: "openai"` path (used for DeepSeek) follows the **OpenAI/cache-
inclusive** convention, consistent with §4. `[DB]`

---

## 7. Corrections in scope

Ranked by impact on accuracy. Each states the defect (with evidence) and the fix.

1. **Complete `MODEL_RESPONSE` usage capture.** Only 48/112 model responses carry
   `inputTokens` `[DB]`; the other 64 are token-blind. Likely cause: streaming responses whose
   usage arrives only in the terminal chunk, or tool-only turns. **Fix:** capture the final
   usage chunk on every response; where a provider omits usage, tokenize locally as a fallback.
   Without this, per-model-call analysis is lossy and `task_usage` cannot be reconciled against
   the event log.
2. **Store per-tool-call token size.** `TOOL_CALL`/`TOOL_RESULT` payloads carry no tokens `[DB]`.
   **Fix:** tokenize the `TOOL_RESULT.result` payload when the event is written and store
   `result_tokens` (optionally `arguments_tokens` on `TOOL_CALL`). See §8 for why this is the
   correct approach rather than input-delta inference. This is the direct answer to the
   open "tool call token approximation" question.
3. **Disambiguate cumulative vs snapshot in names/exposure** (see Unresolved Q2, §10). The peak
   columns already exist `[DDL]`; the cumulative columns still read like sizes. **Fix:** expose
   token data under two clearly-named groups (a cumulative/"billed" group and a
   snapshot/"context-fit" group) and document `input_tokens` as cumulative + cache-inclusive.
4. **Single source of truth / reconciliation.** Given the coverage gap (#1), verify
   `task_usage.input_tokens == Σ MODEL_RESPONSE.inputTokens`; if the aggregate is computed from
   a complete provider counter while events are lossy, the two silently diverge. **Fix:** make
   `task_usage` the sum of the (now-complete) events, reconcilable and auditable.
5. **Per-call context-size series.** Only a single `peak_context_tokens` is kept `[DDL]`. A
   per-model-call context series (derivable once #1 lands) is what reveals *growth over time*
   and predicts a context-limit failure, not just the max.
6. **(Larger, optional) Context compaction.** Not strictly accounting, but it is *why* agent-mcp
   cumulative balloons where opencode's does not (§5) `[DB]`. Out of scope for the accounting
   model itself; noted so the big cumulative numbers are read correctly (pair every cumulative
   with `peak_context_tokens`).

---

## 8. Formulas

**Cumulative vs snapshot (from per-call usage):**
```
cumulative_input = Σ_i  input_tokens(call_i)          # monotonic, unbounded
context_size(i)  = input_tokens(call_i)               # snapshot, window-bounded
peak_context     = max_i input_tokens(call_i)         # == task_usage.peak_context_tokens
```

**Tool-call token consumption — approximation vs exact.**

The tempting approximation is the input delta on the model request that *follows* a tool call:
```
Δ = input_tokens(call_{N+1}) − input_tokens(call_N)
  = output_tokens(call_N)            # the assistant's turn-N response, incl. the tool_call request itself
  + Σ tool_result_tokens(turn N)     # ALL tool results returned in turn N
  + framework/system additions
```
This is **imprecise and cannot attribute per-tool cost**, because:
- It also contains `output_tokens(call_N)`, which must be subtracted out.
- agent-mcp fires **parallel** tool calls (141 `TOOL_CALL` vs 112 `MODEL_RESPONSE` `[DB]`), so
  the delta yields only the **turn total**, never per-tool.
- After first appearance a tool result is re-sent as **cache_read**, not fresh input — so the
  "cost" of a tool result is its *first-appearance uncached* contribution, not the gross delta.

**Correct technique (proposed):** tokenize the `TOOL_RESULT.result` payload directly at write
time → `result_tokens`. Exact, per-tool, cache-independent. The input-delta formula above is
retained only as a per-*turn* cross-check:
```
Σ tool_result_tokens(turn N)  ≈  input_tokens(call_{N+1}) − input_tokens(call_N) − output_tokens(call_N)
```

---

## 9. Unresolved questions

1. **Standardize naming.** `input_tokens` (cumulative, cache-inclusive) reads identically to a
   context size. What is the canonical field vocabulary that makes cumulative-vs-snapshot and
   fresh-vs-cached unmistakable, and does it get applied at the DB column level, the
   `usage_query` API level, or both? (Renaming DB columns is a migration + a breaking API
   change — scope the blast radius.)
2. **Structurally differentiate cumulative vs per-turn.** `peak_context_tokens` exists `[DDL]`,
   but there is no per-call context series and the API returns cumulative and snapshot fields
   flat, side by side. Should the `usage_query` response be restructured into explicit
   `cumulative { … }` and `contextFit { … }` groups? Should per-model-call rows (from
   `task_events`) be a first-class queryable, given only 48/112 currently carry tokens (§7 #1)?
3. **Tool-call token approximation technique.** Confirm the §8 decision: store `result_tokens`
   at write time (exact) vs derive from input deltas (per-turn only, cache-confounded). Open
   sub-questions: which tokenizer to use when the provider's is unavailable; whether to also
   store `arguments_tokens`; how to reconcile `result_tokens` against the subsequent call's
   uncached delta as a validation gate.

---

## 10. References

**Repo (authoritative, read this session):**
- `entrypoint/agent-mcp/drizzle/0000_nifty_sasquatch.sql` — `task_events` table `[DDL]`
- `entrypoint/agent-mcp/drizzle/0001_task_usage.sql` — base `task_usage` `[DDL]`
- `entrypoint/agent-mcp/drizzle/0002_lumpy_silver_centurion.sql` — `stop_reason`, `max_tokens` `[DDL]`
- `entrypoint/agent-mcp/drizzle/0003_nifty_shriek.sql` — cache token columns `[DDL]`
- `entrypoint/agent-mcp/drizzle/0007_smart_callisto.sql` — table rebuild `[DDL]`
- `entrypoint/agent-mcp/drizzle/0008_cache_and_peak_context_usage.sql` — uncached/reasoning/peak
  columns **and the maintainer comment quoted in §3–§4** (BUG-ORCH-008/009/010, FINDING-ORCH-007) `[SRC-COMMENT]` `[DDL]`
- `entrypoint/agent-mcp/package.json` — version 2.1.1

**Databases inspected read-only (2026-07-16):**
- `/Users/nix/.adhd/agent-mcp/agents.db` `[DB]`
- `/Users/nix/.local/share/opencode/opencode.db` `[DB]`

**Live tool output (2026-07-16):** agent-mcp `usage_query` — task `9aa2cb7b…` per-task row and
the 5-task aggregate (`totalInputTokens 1,927,244`). `[TOOL]`

**Research (memory episodes, MEDIUM confidence, snippet-sourced — `[RESEARCH]`):**
- Token accounting: `01KXP4MDPARC…` (opencode), `01KXP4MDPQR6…` (Claude Code), `01KXP4P2ZV7D…`
  (OpenRouter), `01KXP4P30GZSHKNH2NC7YMQMYA` (context vs cumulative), `01KXP4P30NPWVXWZVXBH3E5CT2`
  (588k-vs-356k worked example), `01KXP4P30SV99308NGEYM3G3GW` (cross-provider caching).
- Prior caching research: `01KX9Z06VE4MDV5KYB3H0A0ADT` (cross-provider), `01KX9Z06T924F6N9GH7XM940RX`
  (Anthropic), `01KX9Z06V4B6M7S5R5RF2F4F6Z` (OpenAI), `01KX9Z06V72ZN13YX60QV99B1Z` (DeepSeek).
- Vendor docs referenced by the research (not fetched here): docs.anthropic.com,
  platform.openai.com/docs, openrouter.ai/docs.
