# Context Management & Cache-Preserving Cost Strategy for agent-mcp

Status: DESIGN — verified against raw wire capture, ready for implementation.
Author: performance-engineer review, 2026-07-11.
Primary evidence: `~/dev/agent-mcp-wiretap/calls.jsonl` (41 calls, verbatim request/response
bytes in `~/dev/agent-mcp-wiretap/raw/req-<n>.json` / `res-<n>.json`), captured by
`~/dev/agent-mcp-wiretap/proxy.mjs` sitting between agent-mcp and the DeepSeek API.

All numbers in this document were recomputed independently from the raw JSONL/JSON
files via `python3`, not copied from any prior summary. Every arithmetic step is
shown. Where a prior claim (mine or a previous agent's, in `BACKLOG.md`) turned out
to be imprecise, that is called out explicitly rather than silently corrected.

---

## 0. TL;DR

1. All six numbered claims in the brief are **verified correct on the core facts**.
   One (`93-100% steady-state hit rate`) is directionally right but the real range
   is wider (27%–99.6%, converging upward as the conversation grows) — corrected below.
2. A **new, previously unflagged bug** was found while verifying claim 5: the
   *shipped* OpenAI-compatible provider (`@adhd/agent-mcp@2.0.1`,
   `src/providers/openai.js`) drops DeepSeek's `prompt_cache_hit_tokens` /
   `prompt_cache_miss_tokens` / `reasoning_tokens` fields entirely — even though the
   DB schema, the usage plugin, and the `usage_query` tool already have columns and
   SQL wired up to store and aggregate them (built for Anthropic's cache model).
   The *repo* (`agent-engine-orchestrator/src/providers/openai.ts`) already fixed the
   capture (`cacheReadTokens` from `prompt_tokens_details.cached_tokens`), but the
   per-task **summary** (`summarise()` in `tools/usage.ts`) still never reads those
   columns, and nothing anywhere computes or stores **peak per-call context** — only
   a cumulative sum. Logged as `BUG-ORCH-009` in `BACKLOG.md` (§9 below).
3. **Cost math**: with prefix caching intact, the architecturally awful part of
   re-sending full history every call (quadratic growth) is charged at DeepSeek's
   99.98%-discounted cache-hit rate; only the linear "one new turn per call" delta is
   charged at full price. The quadratic term only dominates spend past ~100
   consecutive tool-call rounds (derived below) — outside the `maxToolLoops` default
   of 50. **Breaking the prefix converts the cheap quadratic term back into the
   expensive one.** That is the entire mechanism of `BUG-ORCH-008`, and it is why the
   fix now shipped to the repo (`packages/agent/agent-engine-orchestrator`,
   pairing-aware `windowMessages`) does not solve the problem: **it still evicts
   from the front, so it still busts the cache.** Confirmed both by mechanism and by
   re-reading the diff.
4. Recommended context-management design (§5, single recommendation, not a menu):
   **cap inputs at the source; never trim until real usage approaches the true model
   ceiling (read from the provider's own `prompt_tokens`, not the undercounting
   local estimator); when a trim is unavoidable, collapse the middle into one
   synthetic summary turn exactly once, and never touch the untouched leading
   segment again.**
5. Recommended usage-reporting shape (§6): stop conflating cumulative-billed and
   peak-context in one field; add a second column pair (`peakContextTokens` /
   `peakContextAt`) captured via `MAX()`, not `SUM()`; finish wiring the
   already-half-built cache-token plumbing through `summarise()` and
   `buildTaskUsageReport`; add a provider-neutral `cachedInputTokens` /
   `uncachedInputTokens` pair that both DeepSeek's (hit/miss) and Anthropic's
   (read/creation) shapes normalize into.
6. Safety check on `ADHD_AGENT_CONTEXT_LIMIT=0` (§7): **safe from a runaway-spend
   perspective** (an over-limit call fails the task cleanly, no retry storm — traced
   through the code) but **not sufficient on its own** to prevent ever hitting the
   provider's real context ceiling, because agent-mcp core has **no cap on
   individual tool-result size** today. That gap, not the context limiter, is the
   correct lever — consistent with the original 710K incident's actual root cause
   (an uncapped 330K-character `directory_tree` dump), which a context *limiter* addresses
   only by re-billing everything after the dump at full price, repeatedly.

---

## 1. Claim-by-claim verification

Recomputation script (representative; run against `~/dev/agent-mcp-wiretap/calls.jsonl`):

```python
import json
rows = [json.loads(l) for l in open("calls.jsonl")]
task3 = [r for r in rows if 18 <= r["call"] <= 41]
sum_prompt = sum(r["providerUsage"]["prompt_tokens"] for r in task3)
peak_prompt = max(r["providerUsage"]["prompt_tokens"] for r in task3)
```

### Claim 1 — `inputTokens` is a cumulative sum, not a context size

**VERIFIED, exactly.** `sum(prompt_tokens)` over calls 18-41 = **715,316**, matching
the brief's figure to the digit. `max(prompt_tokens)` over the same range =
**43,187** (at call 38). Mechanism confirmed by reading the code, not just fitting
the number:

- `src/providers/openai.js:138-139` (shipped) maps `inputTokens: sdkUsage.prompt_tokens`
  — DeepSeek's `prompt_tokens` is the **full prompt size of that one call**, not a delta.
- `src/plugins/usage-plugin.js:104-117` — `onModelResponse` runs on every
  `post:model_response` event and does an **UPSERT with `SET inputTokens =
  taskUsageTable.inputTokens + inputTokens`** (line 107), i.e. it adds each call's
  full prompt size onto a running total keyed by `taskId`. There is exactly one row
  per task in `task_usage`; `inputTokens` on that row is `Σ prompt_tokens_i` across
  every model call in the task.
- `src/tools/usage.js` (`summarise()`, `usageQuery`, `buildTaskUsageReport`) only
  ever reads this already-summed column. There is no `MAX()` anywhere in the file —
  peak context size is not tracked at all, at any layer.

The repo (`agent-engine-orchestrator/src/plugins/usage-plugin.ts:137-142`,
`src/tools/usage.ts:39-56`) has the identical shape — this was **not** touched by
the orchestrator/window-messages rework. Same bug, same file role, unreleased and
released alike.

### Claim 2 — DeepSeek prefix caching was working at 93-100% hit rate in steady state

**PARTIALLY CORRECT — the ceiling is right, the floor is optimistic.** Full
per-call hit-rate table (`hit / (hit+miss)`) for the 24-call run (calls 18-41):

| call | hit% | call | hit% | call | hit% |
|---|---|---|---|---|---|
| 18 | 79.92 (cold start) | 26 | 93.44 | 34 | 98.96 |
| 19 | 48.78 | 27 | 94.44 | 35 | 97.62 |
| 20 | 66.83 | 28 | 98.99 | 36 | **5.44 (broken)** |
| 21 | 71.44 | 29 | 87.09 | 37 | **5.52 (broken)** |
| 22 | 76.97 | 30 | 92.76 | 38 | 97.51 |
| 23 | 86.49 | 31 | 98.83 | 39 | **5.78 (broken)** |
| 24 | 88.83 | 32 | 97.83 | 40 | 99.53 |
| 25 | 93.66 | 33 | **5.83 (broken)** | 41 | 99.58 |

The hit rate is a **ramp**, not a plateau: it climbs from ~49% at call 19 (second
call of the task — the cache only has the system prompt + first turn to hit
against) through the 80s and low 90s, and only crosses 97% around call 28 onward.
Even in the later "steady" region there are dips into the high-80s (call 29, 87.09%
— a normal cache-miss on that call's *new* content, not a prefix break). The
accurate statement: **cache hit rate converges toward 97-99.6% as the conversation
lengthens, provided the prefix is never mutated; it is not uniformly 93-100% from
the start.** This matters for the design in §5 — a strategy that assumes "the cache
is already hot" at low message counts would be wrong.

### Claim 3 — `windowMessages` breaks the cache by dropping the oldest messages

**VERIFIED, with a precise mechanistic confirmation not in the original claim.**

`src/store/session-store.js:175-196` (shipped):
```js
export function windowMessages(messages, tokenLimit) {
    if (tokenLimit <= 0) return messages;
    if (estimateTokens(messages) <= tokenLimit) return messages;
    const systemMessages = messages.filter(m => m.role === "system");
    const nonSystemMessages = messages.filter(m => m.role !== "system");
    ...
    for (let i = nonSystemMessages.length - 1; i >= 0; i--) { ... }   // newest→oldest
    return [...systemMessages, ...selected];
}
```
Called from `src/engine/orchestrator.js:135-137`:
```js
const messagesToSend = contextLimit > 0
    ? windowMessages(currentMessages, contextLimit)
    : currentMessages;
```

Reading the raw requests directly (`req-32.json` vs `req-33.json`) shows the
mechanism happening live. `req-32.json` (30 messages, not yet windowed):
`system → user("Read every one of these files...") → assistant("") → ...`.
`req-33.json` (29 messages, first windowed request): `system →
assistant("**collections.ts** — Exports...") → tool(...) → ...` — **the original
`user` message and everything up through the next several turns is gone**, and
message-index-1 is now a completely different message than it was in call 32.
Since DeepSeek's (and every provider's) prefix cache is keyed on the byte-identical
token sequence from position 0, changing message[1] invalidates the cached KV state
for **everything from that point on**, even for content whose raw text is unchanged
— because the attention context feeding into every subsequent token's KV state has
changed. This is confirmed empirically: `prompt_cache_hit_tokens` at the four broken
calls is **exactly 2304 in all four** (33, 36, 37, 39) — precisely the token count
of the untouched system message, and nothing more. Every byte after the system
prompt was re-billed at full price on those four calls.

Total miss tokens burned by those 4 calls: `37,206 + 40,063 + 39,410 + 37,545 =
154,224` — matches the brief exactly. As a share of the run's total miss tokens
(190,260): **81.1%**. As a share of the run's total dollar cost (§3): **~71.6%**
(these are two different denominators — token-share and dollar-share — both true,
and worth stating separately since they get conflated easily).

### Claim 4 — DeepSeek pricing and the ~3.3x cost multiplier

**Pricing figures VERIFIED via web search against DeepSeek's official pricing page**
(checked 2026-07-10, per the source): DeepSeek V4 Flash — cache-hit input
$0.0028/M tokens, cache-miss input $0.14/M tokens (a 50x penalty, not 50.4x —
0.14/0.0028 = 50 exactly), output $0.28/M tokens.

Recomputed actual dollar cost of the 24-call run (calls 18-41) from the raw
`providerUsage` fields:
```
cost = hit*0.0028/1e6 + miss*0.14/1e6 + completion*0.28/1e6
     = 525,056*0.0028/1e6 + 190,260*0.14/1e6 + 7,370*0.28/1e6
     = $0.00147 + $0.02664 + $0.00206
     = $0.03017
```
Counterfactual — same run, but the 4 broken calls hit at the ~97.5% rate typical of
their neighbors (34: 98.96%, 35: 97.62%, 38: 97.51%, 40: 99.53%) instead of
collapsing to 5-6%:
```
hypothetical hit/miss per broken call ≈ prompt_tokens * (0.975, 0.025)
new total hit  = 525,056 − 9,216  + 159,354 = 675,194
new total miss = 190,260 − 154,224 + 4,086  =  40,122
hypothetical cost = 675,194*0.0028/1e6 + 40,122*0.14/1e6 + 7,370*0.28/1e6
                   = $0.00189 + $0.00562 + $0.00206
                   = $0.00957
```
Ratio: `0.03017 / 0.00957 ≈ 3.15x`. The brief's "~3.3x" is in the right
ballpark; **treat both as estimates** — the counterfactual hit rate is inferred
from neighboring calls, not measured (we cannot re-run the same conversation with
caching preserved). The **directionally solid, non-estimated** number is the
71.6%-of-spend / 81.1%-of-miss-tokens figures above, since those come straight
from the observed data with no counterfactual assumption.

### Claim 5 — `estimateTokens` never counts the `tools` array

**VERIFIED.** `src/store/session-store.js:160-167`:
```js
export function estimateTokens(messages) {
    return Math.ceil(messages.reduce((sum, m) => sum +
        (m.content?.length ?? 0) +
        (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0) +
        (m.toolResults ? JSON.stringify(m.toolResults).length : 0), 0) / 4);
}
```
Only ever called on the `messages` array (`windowMessages` at line 178, 182, 189).
The wire request has a **separate top-level `tools` field**
(`req-38.json`: `{"model", "temperature", "max_tokens", "messages", "tools"}`).
Measured directly on `req-38.json`: `tools` array = 15 entries, `JSON.stringify(tools).length`
= **9,308 chars** (~2,327 tokens at the 4-chars/token heuristic the estimator itself
uses) — entirely uncounted, on every single request, for the life of the task.
`estimateTokens` therefore systematically undercounts every call by at least this
amount (constant, since the tool schema set doesn't change mid-task) plus whatever
the messages-array undercounting contributes.

The observed effect: real single-call `prompt_tokens` reached 38,038 (call 17) and
43,187 (call 38) while the configured `ADHD_AGENT_CONTEXT_LIMIT` (per `BACKLOG.md`
`BUG-ORCH-003`/`006`, confirmed present in `~/.adhd/.env` during this capture) was
30,000 — the limiter first fires at call 33, well after real usage had already
exceeded the configured cap in task 2 (call 17, 38,038 tokens, no trim) and again in
task 3.

### Claim 6 — deepseek-v4-flash has a 1M context window

**VERIFIED via web search** (multiple 2026 sources agree; the request body's
`model` field, read directly from `req-32.json` through `req-41.json`, confirms
`"model": "deepseek-v4-flash"` is indeed the model in use). DeepSeek V4 Flash: 1M
token context length, up to 384K max output. A 30,000-token `ADHD_AGENT_CONTEXT_LIMIT`
is **3% of the real ceiling** — confirmed as stated.

---

## 2. New finding surfaced during verification: `BUG-ORCH-009`

While confirming claim 5's "cache-neutral shape" implications for §6, I read the
provider-to-DB pipeline for cache fields end to end and found a gap not previously
logged.

**Shipped (`@adhd/agent-mcp@2.0.1`) `src/providers/openai.js:134-140`** maps only:
```js
usage: sdkUsage ? {
    inputTokens: sdkUsage.prompt_tokens,
    outputTokens: sdkUsage.completion_tokens,
    stopReason: normalisedStopReason,
    maxTokens: this.providerConfig.maxTokens,
} : undefined,
```
It drops `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, and
`completion_tokens_details.reasoning_tokens` entirely — even though every single
DeepSeek response in the capture carries them (verified: `prompt_cache_hit_tokens +
prompt_cache_miss_tokens === prompt_tokens` held exactly, 0 mismatches, across all
41 calls). Meanwhile the DB schema (`src/db/schema.js:178-179`,
`cacheReadTokens`/`cacheCreationTokens` columns), the usage plugin
(`src/plugins/usage-plugin.js:100-101,112-113`), and the grouped-aggregation path in
`src/tools/usage.js:103-104` **already exist** — they were built for Anthropic
(`src/providers/anthropic.js:229-234` populates them from
`cache_read_input_tokens`/`cache_creation_input_tokens`). For every DeepSeek/OpenAI-
compatible task, those columns are silently `NULL` — the infrastructure to answer
"how much did caching save this task" already exists in the schema and is simply
never fed for the provider this incident is about.

**The repo has partially fixed this** —
`packages/agent/agent-engine-orchestrator/src/providers/openai.ts:161-167`:
```ts
rawUsage: sdkUsage,
usage: sdkUsage ? {
    inputTokens: sdkUsage.prompt_tokens,
    outputTokens: sdkUsage.completion_tokens,
    cacheReadTokens: sdkUsage.prompt_tokens_details?.cached_tokens ?? undefined,
    cacheCreationTokens: undefined,
    ...
} : undefined,
```
`cached_tokens` and `prompt_cache_hit_tokens` are the same number in every sampled
response (call 38: both 42,112) so this capture is correct, and `rawUsage` (the full
provider usage blob) is preserved end to end through
`orchestrator.ts:362-364`. **But two gaps remain even in the repo:**

1. `tools/usage.ts:39-56` (`summarise()`, used by both `usageQuery`'s row-summary
   path and `buildTaskUsageReport`, i.e. every task-completion report a caller
   actually sees) **never reads `cacheReadTokens`/`cacheCreationTokens`** — they're
   captured into the DB row but dropped again on the way back out to any consumer
   except the grouped-`usage_query` path.
2. No `MAX()` of any per-call usage field exists anywhere — `taskUsageTable` has a
   single row per task that only ever accumulates via `+=`. Peak-context tracking
   (Claim 1's fix) is a structurally identical gap to the cache-column gap: the
   plumbing accumulates, nothing anywhere tracks a maximum.

Filed as `BUG-ORCH-009` in `BACKLOG.md` (§9). Fix is specified in §6.

---

## 3. Cost model: how cumulative billed input actually scales

Stateless chat APIs resend the full message history on every call. Let `H_i` be the
context size (tokens) sent on call `i`, and model it as growing by roughly a
constant increment `Δ` per tool-call round: `H_i ≈ H_0 + (i-1)·Δ`.

**Without caching**, total billed input over `N` calls is
`Σ H_i ≈ N·H_0 + Δ·N(N-1)/2` — quadratic in `N`. Sanity-checked against the data:
task 3's `Δ ≈ (43,187 − 2,884) / 20 ≈ 2,015` tokens/call, `H_0 ≈ 2,884`, `N = 24`
gives `Σ H_i ≈ 24·2,884 + 2,015·24²/2 ≈ 69,216 + 580,320 = 649,536` — same order of
magnitude as the measured 715,316 (the model is a first-order approximation; actual
growth wasn't perfectly linear and the eviction event perturbs it).

**With intact prefix caching**, DeepSeek's cache hits everything that was already
in the *previous* request (since a strictly-append-only history has the entire
prior request as a literal prefix of the current one). So per call:
`cache_hit_i ≈ H_{i-1}` (the quadratic part), `cache_miss_i ≈ Δ_i` (just the new
turn, linear). Effective cost:
```
cost ≈ p_hit · Σ H_{i-1}  +  p_miss · Σ Δ_i  +  p_out · Σ O_i
     ≈ p_hit · (quadratic term)  +  p_miss · H_N  (linear term)  +  p_out · Σ O_i
```
The quadratic term only dominates spend once `p_hit·N/2 > p_miss`, i.e.
`N > 2·p_miss/p_hit = 2·(0.14/0.0028) = 100` tool-call rounds. **`agent-mcp`'s
server-side `maxToolLoops` default is 50** (`config.js:129`,
`policy.js:83-85`, enforced as `MAX_TOOL_LOOPS_EXCEEDED`) — below the crossover.
So for every realistic task under the default policy, **an intact prefix cache
makes the re-send-everything architecture cost-linear in practice**, not quadratic.
The 50x cache discount doesn't just shave cost — it changes which term in the cost
equation actually matters.

**This is the core argument against any front-eviction strategy, including the
already-rewritten one in the repo:** front eviction forces exactly one full-price
re-read of the entire surviving history on the very next call (§1, Claim 3), which
is precisely the quadratic-at-full-price term the cache exists to avoid. Doing that
*repeatedly*, every time the estimator's local threshold is crossed, is what
produced the 3.15x-3.3x cost multiplier measured above. **The optimal strategy is
therefore: never force that full-price re-read at all unless truly forced to by an
approaching real ceiling, and when forced, force it the fewest possible number of
times (once, not four times in 24 calls).**

---

## 4. Does the repo's rewritten `windowMessages` also break the cache?

**Yes — confirmed by reading the diff, not by suspicion.**
`packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts:788-869`
(`git diff` against the pre-fix version) fixes two real, distinct bugs:

- `BUG-ORCH-003` (orphaned tool messages / hard 400s): fixed correctly.
  `groupIntoAtomicUnits` (line 819) keeps an `assistant`-with-`toolCalls` message
  and all its `tool` replies as one unit; eviction only ever drops whole units.
  Verified against the test suite (`window-messages.test.ts`, 7 tests, including a
  parallel-tool-calls case matching the real production failure it names:
  `typescript-deepseek`, 13 tool calls / 9 model calls).
- `BUG-ORCH-004` (estimator regression, tool payloads scored as 0 tokens): fixed
  correctly. `estimateMessageTokens` (line 800) now sums `content` +
  `JSON.stringify(toolCall.arguments)` + `JSON.stringify(toolResult.result)`,
  restoring parity with the shipped `estimateTokens`.

But the docstring on the rewritten function says it plainly (line ~847, comment
above `windowMessages`): *"keeps the most recent atomic units that fit the budget,
dropping contiguously from the oldest end."* **It still evicts from the front.**
The mechanism that busts the cache (§1, Claim 3) has nothing to do with pairing
correctness or token-counting accuracy — it is caused purely by *changing what's at
message-index-1 onward*, which pairing-aware, byte-accurate eviction still does.
Making the eviction "smarter" (correct units, correct byte counts) does not change
*where* it cuts from; it only changes *how cleanly* it cuts. A pairing-aware trim
that fires at exactly the same cadence as the naive one (same `contextLimit`
threshold, same "trim a little every time we cross it" cadence) produces the
**identical cache-bust pattern** — same number of full-price re-reads, same
frequency, just without the 400 errors and with a slightly more accurate trigger
point. **This is a real and valuable fix for two real bugs, but it does not address
`BUG-ORCH-008` (cache-hostile eviction) at all**, and should not be read as
"context management is now solved" — it is currently the same architecture with two
fewer defects.

---

## 5. Recommended context-management design

**Single recommendation** (not a menu): combine input-capping (cheapest, prevents
the problem at the source), provider-truth-based triggering (fixes when to act),
and single-step middle-collapse (fixes how to act, when action is unavoidable).
Reject repeated front-eviction entirely, including the already-fixed pairing-aware
version — it's a strict improvement over the shipped code but the wrong strategy at
the architectural level.

### 5a. Cap the inputs, not the context (primary control)

This addresses the actual root cause of both incidents in scope: the 710K incident
was one call reading a 330K-character `directory_tree` dump plus several large
`cat`s (§ RESEARCH.md, "710K DeepSeek Incident"); this capture's 154,224-token
cache-bust cost was caused by *responding* to steady, moderate growth with a
mechanism that makes things worse, not by a single oversized turn. Neither is fixed
by a smarter trim — both are fixed by not letting a turn get huge in the first
place.

- Add a **hard per-tool-result byte cap** in the orchestrator's tool-dispatch path
  (`orchestrator.ts` Phase 2 dispatch, where `toolResultMessage` is constructed —
  shipped equivalent `orchestrator.js:~405-413`), independent of any per-agent
  `security.yaml` (which today only bounds `shell_exec` output, not filesystem or
  other MCP tool results, and is opt-in per agent, not a server-side floor). Default
  ~50-100KB (≈12.5K-25K tokens) truncated with an explicit `"[truncated, N bytes
  omitted — use offset/limit or a narrower query]"` marker, mirroring the
  `read_text_file` offset/limit pattern already recommended in the post-incident
  agent prompts (`RESEARCH.md` "Fixes Deployed" table) but enforced server-side so
  it applies regardless of whether a given agent's prompt remembered to say it.
- `maxToolLoops` (already exists, default 50, `policy.js:83-85`) remains the
  aggregate-turn-count control. No change needed there — it already does its job;
  it was never the layer that failed.

### 5b. Trigger off provider truth, not the local estimator (fixes *when*)

`estimateTokens` is a heuristic (4 chars/token, no `tools` array, `BUG-ORCH-006`).
The exact prompt size for the *next* call is already sitting in the *previous*
response, for free: `providerResponse.usage.inputTokens` (already captured, already
persisted). Replace the local pre-flight estimate with:
```
lastKnownContext = previousResponse.usage.inputTokens ?? estimateTokens(currentMessages)  // fallback only when no prior call exists yet (first call of a task)
trigger = lastKnownContext >= modelWindow * headroomFraction   // e.g. 0.90
```
This can only be wrong by one call's worth of growth (the newest, still-unsent
turn) rather than by the `tools`-array-sized, systematic undercount measured in §1
(44% under real usage at call 38: 43,187 real vs the local estimator's blindness to
9,308 chars of `tools`). It also means the trigger fires **relative to the real
ceiling**, not an arbitrary global scalar — see 5d.

### 5c. When a trim is unavoidable, collapse the middle once — don't evict repeatedly

Once `lastKnownContext` crosses the headroom threshold:

1. Keep the system message (unchanged, as today).
2. Keep the most recent `K` atomic units (assistant+tool-replies, reusing the
   repo's `groupIntoAtomicUnits`) verbatim — this is the part the model still needs
   full fidelity on. `K` should be generous (e.g. last 10-15 units), because the
   goal is to trim *rarely*, not *minimally* — every trim costs one full re-read
   regardless of how much or little is cut, so cutting a lot buys a long runway
   before the *next* full-price re-read is needed.
3. Replace everything between the system message and the kept tail with a single
   synthetic `assistant`-role summary message (no `toolCalls`) produced by one extra,
   cheap model call (or a deterministic extractive summary of the tool results —
   file paths read, key findings, decisions made) — this collapses the middle
   instead of deleting it, preserving continuity of reasoning instead of the abrupt
   "the model forgot everything before turn N" failure mode a hard cut produces.
4. **Never touch that synthetic summary or anything before it again for the rest of
   the task.** All future turns append after it. This is the critical difference
   from both the shipped and the repo's eviction: it collapses the middle exactly
   **once** per task (in the overwhelming majority of tasks, zero times, since 5b's
   threshold is the true 90%-of-1M-token ceiling, not an arbitrary 30K), converting
   `BUG-ORCH-008`'s repeated-full-price-re-read pattern (4 times in 24 calls here)
   into at most a single one, and typically none.

This still busts the cache once, unavoidably (§1: any change anywhere in the prefix
invalidates the cached KV state for everything downstream, mechanically — there is
no eviction strategy, however clever, that avoids this when *something* upstream of
the tail must change). The design goal is not "never bust the cache" — it's "bust
it at most once, and only when actually necessary," rather than every time an
under-tuned heuristic fires.

### 5d. Per-model window configuration, not a single global env var

`ADHD_AGENT_CONTEXT_LIMIT` is one scalar (`config.js:131`, default `0`) applied
identically regardless of which model a given agent uses. A 30,000-token cap is 3%
of `deepseek-v4-flash`'s real window and could be the *entire* window of a
128K-context model. Replace with a small static table (same shape LiteLLM and
similar SDKs use), keyed by model id, carrying `contextWindow` and
`headroomFraction`, with the existing `ADHD_AGENT_CONTEXT_LIMIT` env var
reinterpreted as an optional **override in tokens** (still supported for anyone who
wants a hard operator-imposed ceiling below the model's real one — e.g. for cost
control on an expensive model — but no longer the only way to express a limit, and
no longer misapplied to every model uniformly).

```ts
// packages/agent/agent-engine-orchestrator/src/config/model-windows.ts (new)
export interface ModelWindowConfig {
  contextWindow: number;       // true provider ceiling, tokens
  headroomFraction: number;    // trigger point, e.g. 0.90
}
export const MODEL_WINDOWS: Record<string, ModelWindowConfig> = {
  "deepseek-v4-flash": { contextWindow: 1_000_000, headroomFraction: 0.90 },
  "deepseek-v4-pro":   { contextWindow: 1_000_000, headroomFraction: 0.90 },
  // ...fallback below covers unlisted models
};
export const DEFAULT_WINDOW: ModelWindowConfig = { contextWindow: 128_000, headroomFraction: 0.85 };
```

---

## 6. Redesigned usage reporting

### 6a. What's wrong today (concretely)

- `task_usage.inputTokens` is `Σ prompt_tokens` across every model call in the
  task (§1) — a spend metric, reported and read everywhere as if it were a context
  size. This is exactly the conflation that produced the original "710K context
  explosion" framing (`RESEARCH.md`) for what was, in the reproduction captured
  here, a cumulative-billing artifact with a peak context of 43,187 — 6% of the
  reported number. `FINDING-ORCH-007` in `BACKLOG.md` already flags this; this
  document adds the mechanism trace and the fix.
- No field anywhere records **peak per-call context** — the number that actually
  matters for "are we close to falling off the model's real window" (§5b) and for
  distinguishing "many small calls" from "one huge call" as root causes, which
  require completely different fixes (fewer/smaller tool calls vs. capping a single
  input; §3, §5a).
- Cache-hit/miss data (50x cost driver) is captured for Anthropic, dropped entirely
  in the shipped OpenAI/DeepSeek provider, half-captured in the repo, and never
  surfaced through the per-task summary consumers actually read (`BUG-ORCH-009`, §2).

### 6b. Target shape

Extend `taskUsageTable` (`packages/agent/agent-store-runtime/src/db/schema.ts`,
shipped equivalent `src/db/schema.js:163-179`) with two new columns and complete the
existing ones:

```ts
// ADD:
peakContextTokens: integer("peak_context_tokens"),       // MAX(usage.inputTokens) across calls this task
peakContextAt:     text("peak_context_at"),               // ISO timestamp of the call that set the peak
// cacheReadTokens / cacheCreationTokens already exist (schema.ts:149-150) — keep,
// but see 6c for the provider-neutral read path.
```

Plugin change (`plugins/usage-plugin.ts`, `onModelResponse`): the `onConflictDoUpdate`
SET clause already does `+=` for `inputTokens`/`outputTokens`/cache columns — add a
sibling `MAX()`:
```ts
peakContextTokens: sql`MAX(COALESCE(${taskUsageTable.peakContextTokens}, 0), ${inputTokens})`,
peakContextAt: sql`CASE WHEN ${inputTokens} > COALESCE(${taskUsageTable.peakContextTokens}, 0)
                    THEN ${nowIso()} ELSE ${taskUsageTable.peakContextAt} END`,
```
(SQLite supports multi-arg `MAX()` as a scalar function, distinct from the
aggregate `MAX()` used in `usage.ts`'s `groupBy` path — both are valid uses in this
codebase already, e.g. `mostSevere()`'s severity-ordering pattern for `stopReason`
is the same "keep the more significant of old vs. new on each UPSERT" idiom, just
for token counts instead of an enum.)

### 6c. Provider-neutral cache shape

DeepSeek and Anthropic expose genuinely different cache accounting models:
DeepSeek always attempts the cache and reports `hit + miss = prompt_tokens` exactly
(verified, 0 mismatches across 41 calls); Anthropic separately reports
`cache_read_input_tokens` (discounted) and `cache_creation_input_tokens` (a
*surcharge* for populating the cache, which DeepSeek has no equivalent of — every
DeepSeek prompt attempts a cache lookup for free). Normalize both into:

```ts
// packages/agent/agent-base-types/src/domain.ts — extend TokenUsage
export interface TokenUsage {
  inputTokens: number;            // this call's full prompt_tokens (existing)
  outputTokens: number;           // existing
  cachedInputTokens?: number;     // DeepSeek: prompt_cache_hit_tokens. Anthropic: cache_read_input_tokens.
  uncachedInputTokens?: number;   // DeepSeek: prompt_cache_miss_tokens. Anthropic: inputTokens - cacheReadTokens - cacheCreationTokens.
  cacheWriteTokens?: number;      // Anthropic cache_creation_input_tokens only; undefined for DeepSeek (no such charge exists).
  reasoningTokens?: number;       // DeepSeek completion_tokens_details.reasoning_tokens; Anthropic thinking-token equivalent when present.
  // invariant (enforced in a unit test, not just documented):
  //   cachedInputTokens + uncachedInputTokens === inputTokens   (when both are defined)
}
```
Provider mapping changes:
- `providers/openai.ts:161-167` (repo) — add `uncachedInputTokens:
  sdkUsage.prompt_cache_miss_tokens ?? (sdkUsage.prompt_tokens -
  (sdkUsage.prompt_tokens_details?.cached_tokens ?? 0))`, rename the existing
  `cacheReadTokens` mapping to `cachedInputTokens` (or keep both names during a
  migration window — see 6d), add `reasoningTokens:
  sdkUsage.completion_tokens_details?.reasoning_tokens`.
- Shipped `providers/openai.js:134-140` — add the full mapping (today has none of
  this; §2, `BUG-ORCH-009`). This is the highest-value single-line-count fix in this
  whole document: DeepSeek already returns everything needed in every response
  body, unconditionally — it's purely a dropped-on-the-floor mapping bug, not a
  missing capability.
- `providers/anthropic.ts:256-263` — add `uncachedInputTokens: sdkUsage.input_tokens
  - (sdkUsage.cache_read_input_tokens ?? 0) - (sdkUsage.cache_creation_input_tokens ?? 0)`,
  keep `cacheCreationTokens`/rename to `cacheWriteTokens`.

`summarise()` (`tools/usage.ts:39-56`) — add the new columns to the reduce (this is
the gap that made even the repo's already-captured cache data invisible to
`buildTaskUsageReport`, §2):
```ts
cachedInputTokens: acc.cachedInputTokens + (row.cacheReadTokens ?? 0),
uncachedInputTokens: acc.uncachedInputTokens + (row.inputTokens ?? 0) - (row.cacheReadTokens ?? 0),
peakContextTokens: Math.max(acc.peakContextTokens, row.peakContextTokens ?? 0),
estimatedCostUsd: acc.estimatedCostUsd + estimateCost(row, PRICE_TABLE[row.model]),
```

### 6d. What a caller sees (the actual deliverable — this is what would have
prevented the wrong post-mortem)

```jsonc
// usage_query response, per task — today vs. proposed
{
  "taskId": "88b49d82-...",
  "model": "deepseek-v4-flash",
  "modelCalls": 24,
  // TODAY — one number, reads like a context size, isn't one:
  "inputTokens": 715316,
  // PROPOSED — explicit, separates the two failure modes claim 1/FINDING-ORCH-007 conflated:
  "cumulativeBilledInputTokens": 715316,     // renamed from inputTokens for clarity; sum across all calls
  "peakContextTokens": 43187,                // single largest call — the number that matters for "close to the ceiling?"
  "peakContextAt": "2026-07-11T20:11:42Z",
  "cachedInputTokens": 525056,               // sum of cache-hit tokens across all calls
  "uncachedInputTokens": 190260,             // sum of cache-miss tokens — the expensive ones
  "cacheHitRate": 0.734,                     // cachedInputTokens / cumulativeBilledInputTokens
  "estimatedCostUsd": 0.03017,               // computed from a per-model price table, not guessed
  "outputTokens": 7370,
  "reasoningTokens": 2101
}
```
With this shape, the exact mistake in `RESEARCH.md`'s original incident write-up
(treating a 710K cumulative number as a context explosion, deploying a context
*limiter* as the fix) is structurally harder to make: `peakContextTokens` and
`cumulativeBilledInputTokens` are two different fields with two different implied
fixes (cap a single input vs. reduce call count / preserve caching), and
`cacheHitRate` would have shown the limiter itself tanking cache performance the
moment it was turned on, rather than requiring a follow-up wire capture to discover.

---

## 7. Is `ADHD_AGENT_CONTEXT_LIMIT=0` safe right now?

**Traced through the actual failure path, not assumed.**

**Runaway-spend risk: no.** If a task's context exceeds the provider's true window
with no client-side windowing, DeepSeek rejects the request
(`context_length_exceeded` / "prompt is too long"). `orchestrator.js:182-186`
(shipped) / equivalent in the repo already special-cases this into
`ToolError("CONTEXT_WINDOW_EXCEEDED", ...)`. That error is **not** in the
`FATAL_CODES` list used inside the tool-dispatch loop (`orchestrator.js:355`,
`["MAX_DEPTH_EXCEEDED", "MAX_TOOL_LOOPS_EXCEEDED", "DELEGATION_NOT_ALLOWED"]`) —
because it's thrown from the *provider-call* try/catch (line 160-188), one level up
from where `FATAL_CODES` is checked, and propagates directly to the orchestrator's
outer `catch (error)` block (line 445 onward), which cleanly marks the task
`"failed"` with the error message, emits `TASK_FAILED`/`done`, and returns — **no
retry loop, no silent respend.** (`pRetry`, used inside the provider's `chat()` call,
wraps only genuinely transient failures the retry-config permits; a hard
context-length rejection is deterministic and would fail identically on every
retry attempt, so at worst it costs a few wasted round trips before giving up — not
unbounded spend, and providers typically don't bill generation tokens for a request
rejected pre-generation, though this specific billing behavior for DeepSeek was not
independently verified here and should be treated as an assumption, not a
verified fact.)

**Ceiling-hitting risk: yes, realistically possible, and not adequately guarded
today.** `maxToolLoops` (default 50) bounds the *count* of tool-call rounds, not
the *size* of any single one. There is currently no per-tool-result size cap
anywhere in agent-mcp core (confirmed by search — the only size cap that exists at
all, `max_execution_time`/`max_output_size: 5MB` from the original incident's
fix, lives in a **per-agent, opt-in `security.yaml`** and bounds only `shell_exec`
output, not filesystem or other MCP tool results, and is not a server-side floor
applied to every agent). A single uncapped tool result — the exact shape of the
original 710K incident's 330K-character `directory_tree` dump — can inject on the
order of 80K+ tokens in one turn; a handful of such turns, well within the 50-loop
budget, would reach the true 1M ceiling. **So: turning the limiter off does not
introduce a new risk (the failure mode was already reachable with the limiter on —
the limiter never actually prevented the original incident's mechanism, since it
fires on cumulative estimate, not per-call size, and Claim 5 showed it was
undercounting badly enough to under-fire anyway) — but it does mean the
underlying gap (§5a, uncapped tool-result size) is now the only thing standing
between a pathological task and a clean, single, correctly-attributed task failure.**
Given the clean-failure-mode analysis above, that is an acceptable interim state —
disabling the limiter while §5a-5d are implemented is the right call, provided §5a
(the per-tool-result cap) lands promptly, since it is the actual mechanism that
prevented the *original* incident's cause, not the context limiter that was
deployed in response to it.

---

## 8. File/function map (exact locations referenced above)

**Shipped (`@adhd/agent-mcp@2.0.1`, running via `npx -y @adhd/agent-mcp@latest`):**
| File | Symbol | Line |
|---|---|---|
| `src/store/session-store.js` | `estimateTokens` | 160 |
| `src/store/session-store.js` | `windowMessages` | 175 |
| `src/engine/orchestrator.js` | `contextLimit` read | 75 |
| `src/engine/orchestrator.js` | `windowMessages(...)` call site | 135-137 |
| `src/engine/orchestrator.js` | `CONTEXT_WINDOW_EXCEEDED` throw | 185 |
| `src/engine/orchestrator.js` | `FATAL_CODES` (tool-dispatch loop only) | 355 |
| `src/engine/orchestrator.js` | outer catch → task `"failed"` | 445-470 |
| `src/providers/openai.js` | usage mapping (drops cache fields — `BUG-ORCH-009`) | 134-140 |
| `src/plugins/usage-plugin.js` | cumulative `SET inputTokens = ... + inputTokens` | 107 |
| `src/tools/usage.js` | `summarise()` (never reads cache columns) | 19-34 |
| `src/db/schema.js` | `taskUsageTable` (`cacheReadTokens`/`cacheCreationTokens` exist, unused for openai) | 163-179 |
| `src/config.js` | `contextLimit` default `0` | 131 |
| `src/config.js` | `maxToolLoops` default `50` | 129 |
| `src/engine/policy.js` | `MAX_TOOL_LOOPS_EXCEEDED` enforcement | 83-85 |

**Repo (`packages/agent/agent-engine-orchestrator`, diverged, version 2.0.0 vs
published 2.0.1):**
| File | Symbol | Line |
|---|---|---|
| `src/engine/orchestrator.ts` | `estimateMessageTokens` | 800 |
| `src/engine/orchestrator.ts` | `groupIntoAtomicUnits` | 819 |
| `src/engine/orchestrator.ts` | `windowMessages` (still front-evicts — §4) | 851 |
| `src/engine/orchestrator.ts` | cache fields threaded into DB write | 362-364 |
| `src/providers/openai.ts` | `cacheReadTokens` capture (partial fix) | 161-167 |
| `src/providers/anthropic.ts` | `cacheReadTokens`/`cacheCreationTokens` | 256-263 |
| `src/plugins/usage-plugin.ts` | cumulative cache-column `SET` | 137-142 |
| `src/tools/usage.ts` | `summarise()` (still never reads cache columns) | 39-56 |
| `src/__tests__/window-messages.test.ts` | 7 tests, all passing, prove pairing + counting fixes only | — |
| `src/providers/types.ts` | `rawUsage?: unknown` (already exists, underused) | 20 |
| `packages/agent/agent-base-types/src/domain.ts` | `TokenUsage` shape to extend (§6c) | 6-7 |
| `packages/agent/agent-store-runtime/src/db/schema.ts` | `taskUsageTable` (add `peakContextTokens`/`peakContextAt`, §6b) | 149-150 |

---

## 9. BACKLOG.md addition

Appended as `BUG-ORCH-009` (see `/Users/nix/dev/node/adhd/BACKLOG.md`), consistent
with the existing `BUG-ORCH-003`..`008` numbering and format used in this file.

---

## Open items not resolved by this document (carry forward, do not bury)

- **Anthropic path for `windowMessages`/pairing-aware trim not independently
  verified** — `BUG-ORCH-003`'s blast-radius note ("the anthropic path shares the
  constraint... NOT yet verified") is still open; this document did not add new
  evidence either way since the capture is DeepSeek-only.
- **DeepSeek billing behavior on a rejected (`context_length_exceeded`) request is
  assumed, not verified** (§7) — whether input tokens are billed for a
  pre-generation rejection was not confirmed against DeepSeek's docs or a live
  test; flagged as an assumption in place, not stated as fact.
- **`peakContextTokens`/cache-column wiring (§6b/6c) is a design, not yet
  implemented** — no code changes were made as part of this document; it is a
  specification for the next implementation pass, filed against `BUG-ORCH-009`.
- **§5's input-size cap (5a) needs a concrete default byte threshold decided by a
  human** — 50-100KB was proposed as a reasonable default informed by DeepSeek's
  pricing (well under the 90%-headroom trigger even summed across ~50 calls) but
  wasn't validated against any specific agent's real workload.
