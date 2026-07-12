# Provider Prompt Caching & Token Usage Reporting — Cross-Provider Report

*Primary-source research, fetched 2026-07-11. Every claim cited to a live primary doc URL.
Ambiguities and undocumented gaps are flagged explicitly, not filled from model recall.*

## Why this matters

Measured incident: this framework enforces context limits by dropping the oldest messages from
history. Because chat APIs are stateless and providers cache the *prefix* of the request,
front-eviction mutates the prefix and collapsed the cache hit rate from 93–100% to 5–6% on the 4
calls where trimming occurred, burning 154,224 full-price tokens — with DeepSeek's ~50× miss
penalty, ~70% of total spend and 3.3× cost inflation. See `BUG-ORCH-008` in `BACKLOG.md`.

**All four providers below share the same underlying vulnerability to this failure mode.** DeepSeek
is simply the one with zero provider-side safety net.

---

## 1. Anthropic (Claude)

**Sources:** [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) · [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)

| Aspect | Detail |
|---|---|
| Mechanism | Explicit opt-in: `cache_control: {"type":"ephemeral"}` on content blocks. Up to **4 breakpoints/request**. "Automatic caching" variant (breakpoint at top level) auto-slides the breakpoint forward as conversation grows. |
| Exact match | 100% identical content up to the breakpoint required. |
| Cache order/hierarchy | **tools → system → messages**. Tools sit first in the hashed prefix. |
| What invalidates | Any tool-definition change invalidates the *entire* cache (tools+system+messages). Changes further down (tool_choice, images, thinking params) invalidate only messages-level cache. Editing any earlier cached block invalidates that level and everything downstream. |
| Min cacheable length | Model-dependent: 512–4,096 tokens (e.g. Sonnet 5 = 1,024). Below this, `cache_control` is silently ignored (no error). |
| **Lookback window** | Only **20 blocks** are searched backward from a breakpoint for a prior write. If a conversation grows >20 blocks between cache-write positions, the lookback misses the earlier entry → full miss even with no content change. |
| TTL | Default ephemeral = **5 min**, free refresh on hit. Optional **1h** via `ttl:"1h"`. Mixed 5m/1h in one request allowed; 1h entries must precede 5m entries. |
| Usage fields | `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, optional `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`. |
| **Headline count** | `input_tokens` **EXCLUDES** cached tokens — it's only the uncached tail after the last breakpoint. Total input = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. **This is the outlier vs. the other 3 providers.** |
| Pricing multipliers | 5m write = **1.25×** base input; 1h write = **2×**; cache read = **0.1×** (90% discount). |
| Eviction guidance | `clear_tool_uses_20250919` context-editing strategy (trigger default 100k input tokens, `keep` last N tool uses, `clear_at_least` to batch-clear so cache-invalidation cost is amortized, `exclude_tools`). Clearing **invalidates cache at the clear point**; upstream-cache survival is explicitly **not guaranteed** ("implementation-dependent"). Anthropic explicitly recommends **server-side compaction** (`compact_20260112`, beta, header `anthropic-beta: compact-2026-01-12`) as the *primary* strategy for long tool-loops: summarizes old content into a `compaction` block instead of discarding it; auto-drops everything before the latest compaction block on the next call; explicitly recommends caching the system prompt with its own breakpoint **separate** from the compaction summary so it survives repeated compactions. Default trigger 150k tokens (min 50k). Billing: sum `usage.iterations[]`, not just top-level `input_tokens`. |

---

## 2. OpenAI

**Sources:** [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) · [Realtime costs](https://developers.openai.com/api/docs/guides/realtime-costs) · [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)

| Aspect | Detail |
|---|---|
| Mechanism | **Fully automatic**, no opt-in, for prompts ≥1,024 tokens (gpt-4o+ family), both Chat Completions and Responses APIs. |
| Granularity | Caches the longest matching prefix; quantized starting at **1,024 tokens**, then **+128-token increments**. |
| Exact match | Static content must be byte-identical at the start; "place variable content ... at the end." |
| Tools in prefix | Yes — tools array is injected **before** developer/system instructions in the cache hash. Changing it busts cache. To restrict callable tools per-turn *without* busting cache, use `tool_choice: {type:"allowed_tools", ...}` instead of editing the tools array. |
| TTL | GPT-5.6+: "at least 30 minutes," possibly longer. Pre-GPT-5.6: ~5–10 min inactivity, ≤1h in-memory, up to 24h with extended retention. |
| Usage fields | Chat Completions: `usage.prompt_tokens_details.cached_tokens`. Responses API: `usage.input_tokens_details.cached_tokens`. GPT-5.6+ adds `cache_write_tokens`. |
| **Headline count** | `cached_tokens` is **INCLUDED** in `prompt_tokens`/`input_tokens` (subset breakdown field, not additive). Same convention as DeepSeek and Gemini. **Ambiguous/unverified:** whether GPT-5.6+ `cache_write_tokens` is additive on top of `prompt_tokens` or also a subset — not stated explicitly in fetched docs; verify empirically before hardcoding. |
| Pricing | Pre-GPT-5.6: writes free, reads discounted (exact % not quantified in fetched primary text — check current per-model pricing page). GPT-5.6+: writes at **1.25×** uncached rate; reads at "standard cached-input rate" (discount % also not quantified in fetched text — verify against the live pricing page before use in a cost model). |
| Eviction guidance | **Realtime API only**: `session.truncation.retention_ratio` (default 1.0). Setting e.g. 0.8 makes the server over-trim (drop 20% of the window) **once**, rather than trimming a little every turn — explicit quote: *"truncation busts the cache near the beginning of the conversation, and if truncation occurs on every turn then cache rate will be very low."* **This feature does not exist for standard Chat Completions/Responses API** — a framework using those must implement the equivalent policy itself. `previous_response_id` chaining (Responses API): docs do **not** state whether it interacts with/bypasses prefix caching; only that "all previous input tokens for responses in the chain are billed as input tokens," implying no guaranteed caching discount — flagged as unresolved. |

---

## 3. DeepSeek

**Sources:** [Context Caching guide](https://api-docs.deepseek.com/guides/kv_cache/) · [Pricing](https://api-docs.deepseek.com/quick_start/pricing/) · [Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion)

| Aspect | Detail |
|---|---|
| Mechanism | **Fully automatic**, on by default, "Context Caching on Disk," zero code changes. Requires a **full match** of a complete cache-prefix-unit from the start of the conversation: *"a subsequent request can only hit the cache if it fully matches a cache prefix unit."* Explicitly **best-effort** — no guaranteed hit rate. |
| Granularity | **Undocumented.** Docs only say prefix units form "at request boundaries and fixed token intervals for long inputs/outputs" with no quantified block size anywhere in primary docs. Do not assume a number. |
| Tools in prefix | Not addressed in the formal API reference. Only soft guidance in the kv_cache guide: keep tool schema order/wording stable, structure as "stable system instructions + stable tool schemas + stable examples + stable context + variable user question at the end." This is guidance, **not a documented hard rule**. |
| TTL | **Undocumented precisely** — only "usually within a few hours to a few days," no configurable value, no way to query remaining TTL. |
| Usage fields | `prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens` (explicit equation in primary docs). `completion_tokens`, `total_tokens = prompt + completion`. |
| **Headline count** | `prompt_tokens` **INCLUDES** both hit and miss tokens (inclusive), same convention as OpenAI and Gemini. |
| Pricing (July 2026; models `deepseek-v4-flash`/`deepseek-v4-pro`; legacy `deepseek-chat`/`deepseek-reasoner` aliases deprecate 2026-07-24) | v4-flash: cache-hit **$0.0028/M**, cache-miss **$0.14/M**, output $0.28/M (**50× hit:miss**). v4-pro: cache-hit **$0.003625/M**, cache-miss **$0.435/M**, output $0.87/M (~120× ratio). **No cache-write surcharge documented anywhere** — unlike Anthropic/OpenAI, a cache-miss token is billed once at the miss rate and simply becomes cacheable going forward at no extra fee. |
| Eviction guidance | **None found.** No compaction primitive, no context-editing analog, no retention-ratio analog. DeepSeek provides zero provider-side help for context-window eviction — the framework's own eviction policy is 100% responsible for prefix stability. **This is the direct, documented root cause of the measured incident.** |

---

## 4. Google Gemini

**Sources:** [Context caching (implicit)](https://ai.google.dev/gemini-api/docs/caching) · [Context caching (explicit)](https://ai.google.dev/gemini-api/docs/generate-content/caching) · [UsageMetadata](https://ai.google.dev/api/generate-content) · [Pricing](https://ai.google.dev/gemini-api/docs/pricing)

Gemini has **two architecturally distinct** mechanisms — the only provider of the four with this split.

| Aspect | Detail |
|---|---|
| **Implicit caching** | Automatic/default-on, Gemini 2.5+ models, prefix-hash style (like the other 3). Min token threshold: Gemini 2.5 Pro/Flash = 2,048; Gemini 3.1 Pro Preview / 3.5 Flash = 4,096. Invalidation rules **undocumented** — only two heuristics disclosed: "put large/common content at the beginning" and "send requests with similar prefix in a short amount of time" (implies recency-bounded/LRU-ish behavior with no formal contract). |
| **Explicit caching** | Opt-in, **addressable-object model**, not annotate-in-place: create a `CachedContent` resource (`system_instruction` + `contents` params — **tools/function_declarations inclusion not confirmed** in fetched docs, needs direct schema verification), reference it via `cachedContent: cache.name` on subsequent calls. TTL defaults to **1 hour** if unset; configurable via `ttl` (e.g. `"300s"`) or `expire_time`. Invalidated by TTL expiry or manual delete — **not** by prefix mutation. Fundamentally different integration shape than the other three. |
| Usage fields | `usageMetadata.promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`, `totalTokenCount`. |
| **Headline count** | `promptTokenCount` explicitly documented as **INCLUDING** `cachedContentTokenCount` ("still the total effective prompt size ... includes the number of tokens in the cached content"). Inclusive, same as OpenAI/DeepSeek. |
| Pricing (July 2026) | ~90% discount on cached vs. standard input: Gemini 2.5 Pro standard $1.25/M(≤200k)/$2.50/M(>200k) vs cached $0.125/M/$0.25/M; 2.5 Flash standard $0.30/M vs cached $0.03/M; 3.5 Flash standard $1.50/M vs cached $0.15/M; 3.1 Pro Preview standard $2.00/M(≤200k)/$4.00(>200k) vs cached $0.20/M/$0.40/M. Initial cache-populating call billed at **standard** input price — no write premium. **Unique to Gemini:** explicit caching carries an **additional hourly storage rental fee** independent of reads — **$4.50/M tokens/hour** (Pro-tier), **$1.00/M tokens/hour** (Flash-tier). No other provider charges standing storage rent. |
| Eviction guidance | None beyond the two implicit-caching heuristics; no compaction primitive, no retention-ratio analog. |

---

## Synthesis: the provider-neutral abstraction

### (a) Keeping prefixes stable and cacheable across a tool-calling loop

The single most important finding: **every provider's cache is fundamentally a prefix match**
(Anthropic/OpenAI/DeepSeek by hash; Gemini implicit the same; Gemini explicit swaps to an addressable
object but the rule is still "don't mutate the stable head"). **Naive FIFO-drop-oldest eviction is
catastrophic on all four providers** — it mutates the exact prefix every provider hashes against.

Universal fix, synthesized from what the providers themselves recommend:

1. **Freeze the head.** Tool definitions + system prompt = permanently stable; never reordered,
   edited, or regenerated.
2. **Append-only history.** Never touch anything before the volatile tail.
3. **Evict rarely, in large batches, from a defined checkpoint** — never a little on every call.
   This is the shared principle behind Anthropic's `compact_20260112` (client-side equivalent:
   periodically summarize a large contiguous chunk into one static block and hold it stable
   thereafter), Anthropic's `clear_at_least` (batch clears to amortize cache-write cost), and
   OpenAI Realtime's `retention_ratio < 1.0` ("over-trim once" instead of trimming every turn).
4. **DeepSeek and Gemini have no provider-native primitive for this** — the framework must implement
   "stable-prefix + rare-large-batch-trim" itself for those two. There is no server-side safety net.
5. **Tool filtering per-turn:** only OpenAI can restrict callable tools (`allowed_tools`) without
   mutating the cached tools array. On Anthropic/DeepSeek/Gemini, any per-turn tool-set filtering
   necessarily busts the cache — plan around this (expose the full stable toolset always; filter
   client-side or in-prompt instead).
6. **Anthropic-specific:** respect the 20-block lookback — don't let >20 content blocks accumulate
   between cache-write positions without advancing the breakpoint, or you take a full miss with no
   content change.

### (b) Normalizing usage reporting

**Critical divergence (silently corrupts cross-provider accounting if unhandled):** whether the
headline input field *includes* cached tokens.

| Provider | Headline field | Includes cached tokens? |
|---|---|---|
| **Anthropic** | `input_tokens` | **NO** — excludes both `cache_read_input_tokens` and `cache_creation_input_tokens`; must sum all three |
| OpenAI | `prompt_tokens` / `input_tokens` | **YES** — `cached_tokens` is a subset breakdown |
| DeepSeek | `prompt_tokens` | **YES** — explicit equation: `prompt_tokens = hit + miss` |
| Gemini | `promptTokenCount` | **YES** — explicit doc statement |

Anthropic is the sole outlier. A shared normalization layer must special-case it — treating it like
the other three will either **double-count** (adding cache fields to an already-total number) or
**under-count** (forgetting to add them).

**Recommended normalized struct per call:**

```
{
  uncached_input_tokens,
  cache_read_tokens,
  cache_write_tokens,           // 0 if provider doesn't bill writes separately
  output_tokens,
  total_input_tokens_processed  // = sum of the first 3, computed uniformly regardless
                                // of each provider's own inclusive/exclusive headline
                                // convention. Use THIS — not the raw headline field —
                                // for context-window / "near the limit" arithmetic.
}
```

Cost must be computed per-provider with each provider's own multiplier table. **Do not hardcode one
cache-write multiplier for all four:** Anthropic (1.25×/2×) and OpenAI GPT-5.6+ (1.25×) charge a real
premium on the populating call; DeepSeek and Gemini charge **none**.

Track **cumulative tokens billed across a run** and **peak single-call context size** as two separate
metrics, never conflated. Window-limit enforcement must be driven by peak/current call size, not the
cumulative run total. Conflating them is what produced the "710K incident" post-mortem and sent it
optimizing the wrong variable (see `FINDING-ORCH-007`).

### What cannot be papered over by a common abstraction

- **Gemini explicit caching's create-then-reference-by-ID model** (plus its hourly storage rent) is
  architecturally different from the others' annotate-in-place hashing. A neutral layer needs **two**
  primitives: "mark this content cacheable" vs. "create/get-or-create a named cache object, reference
  it, and pay standing rent while it's open."
- **Anthropic's exclusive `input_tokens`** vs. the other three's inclusive convention is a hard
  semantic difference requiring provider-specific arithmetic.
- **Write-surcharge economics differ in kind, not degree** — two providers charge a premium, two none.
- **OpenAI's `allowed_tools`** has no documented equivalent anywhere else.
- **Eviction/compaction tooling exists only for Anthropic (full) and OpenAI (Realtime-only)**;
  DeepSeek and Gemini have none.

---

## Documented gaps — flagged, not guessed

- **DeepSeek:** exact cache block granularity (no number given anywhere in primary docs); exact TTL
  (only "a few hours to a few days"); whether the tools array formally participates in cache hashing
  (soft guidance only, not a hard rule).
- **OpenAI:** exact cache-read discount %; whether GPT-5.6+ `cache_write_tokens` is additive on top of
  `prompt_tokens` or a subset; whether `previous_response_id` chaining gets any caching discount at
  all (docs imply full reprocessing but don't say so definitively).
- **Gemini:** exact implicit-cache invalidation/LRU algorithm; whether `tools`/`function_declarations`
  can be included in an explicit `CachedContent` object.
- **Anthropic:** whether content upstream of a `clear_tool_uses_20250919` clearing point remains
  cached (explicitly "implementation-dependent", not guaranteed).

---

*Durable findings also persisted to the memory store under topic `provider-prompt-caching`
(5 episodes; tags: prompt-caching, token-usage, cost-accounting, multi-provider, anthropic, openai,
deepseek, gemini, context-window, agent-framework).*
