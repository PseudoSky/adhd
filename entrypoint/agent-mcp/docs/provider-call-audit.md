# agent-mcp: Provider Call & Event Storage Audit

Audit of what agent-mcp sends to the provider API each turn and what it stores in
the DB. Compared against the standard ReAct loop pattern used by OpenCode and Claude
Code.

**Date:** 2026-07-02
**Trigger:** investigating 262k input tokens for a 15-turn, 775-line implementation task.

---

## 1. What Goes to the Provider Every Turn

### Orchestrator Loop (`packages/ai/agent-mcp/src/engine/orchestrator.ts`)

Every iteration of the while-loop (lines ~130–850):

1. **`registry.listAllTools()` (line 176)** — fetches the full tool list from every
   connected MCP server. For each server, this:
   - Calls `getOrCreateClient(serverName)` (stdio clients are cached; the stdio
     subprocess persists across calls)
   - Calls `client.listTools()` which sends an MCP `tools/list` JSON-RPC request
     over stdio and waits for the response
   - Prefixes each tool name as `<server>__<tool>`
   - Returns the complete array of `ToolDefinition[]`

2. **HITL append (lines 180-185)** — if the agent has `allowHumanInput: true` and
   the task is durable, appends the built-in `request_human_input` tool.

3. **Hook emission (lines 208-226)** — fires `pre:model_request` for observation
   and enforcement, with the full `{messages, tools}` payload.

4. **Provider call (lines 235-237)** — passes `tools: tools.length > 0 ? tools : undefined`
   to `provider.chat()`.

### OpenAI Provider (`packages/ai/agent-mcp/src/providers/openai.ts`)

`toOpenAITools()` (lines 62-76) serializes every `ToolDefinition` as:

```typescript
{
  type: "function",
  function: {
    name: "filesystem__read_text_file",
    description: "Read the complete contents of a file...",
    parameters: {           // full JSON Schema — type, properties, required, descriptions
      type: "object",
      properties: {
        path: { type: "string", description: "..." },
        head: { type: "number", description: "..." },
        tail: { type: "number", description: "..." },
        ...
      },
      required: ["path"],
      additionalProperties: false
    }
  }
}
```

The OpenAI client then sends this `tools` array in EVERY `chat.completions.create()`
call (line 121). The API is stateless — tool definitions must be present in every
request for the model to emit tool calls.

### Measured Overhead (from the 2-tool-call experiment)

| Agent | Tools sent per turn | Input tokens (2 turns) | Cache hit | Net paid | Overhead vs shell |
|---|---|---|---|---|---|
| Both (fs + shell) | ~10 tools | 5,645 | — | — | 3.0× |
| Filesystem-only | ~8 tools | 5,126 | 2,560 (50%) | 2,566 | 2.7× |
| Shell-only | ~1 tool | 1,877 | 768 (41%) | 1,109 | 1.0× baseline |

Tool schemas are the dominant per-turn cost. On a 15-turn task:
- Filesystem-only: ~48k tokens (tool schemas re-sent 15×)
- Shell-only: ~10k tokens
- Delta: ~38k tokens (17% of the 262k total on the spec-types task)

### Cache Behavior

DeepSeek caches repeated prefixes automatically. The 50% cache-hit rate on the
filesystem agent means:
- Turn 1: 2,560 tokens paid at full price (system prompt + tool schemas + work order)
- Turn 2: 2,560 tokens read from cache at ~10% cost (256 billed), 2,566 new tokens
  (tool results from turn 1 + assistant response + next turn's request)
- The 50% that changes is the growing conversation history — this is inherent and
  cannot be eliminated by any agent-mcp change.

---

## 2. What Gets Stored in the DB

### `task_events` Table

Schema: `(id TEXT PK, task_id TEXT, type TEXT, payload TEXT, created_at TEXT)`

Event types written per turn:
- `MODEL_REQUEST` — `{messageCount, toolCount}` (thin summary, no token data)
- `MODEL_RESPONSE` — `{stopReason, hasContent, toolCallCount}` (thin summary, no token data)
- `TOOL_CALL` — empty payload
- `TOOL_RESULT` — empty payload

**The payload column is arbitrary JSON but carries no usage data.** Per-turn token
counts from `providerResponse.usage` are available at the event emission site
(`orchestrator.ts:303`) but were never written to the payload.

### `task_usage` Table

Schema includes: `task_id PK, input_tokens, output_tokens, tool_call_count,
model_calls, cache_read_input_tokens, cache_creation_input_tokens, ...`

Updated per turn via UPSERT (accumulate in-place):
```sql
INSERT ... ON CONFLICT(task_id) DO UPDATE SET
  input_tokens = input_tokens + <new>,
  output_tokens = output_tokens + <new>,
  model_calls = model_calls + 1,
  cache_read_input_tokens = COALESCE(cache_read_input_tokens, 0) + <new>
```

Single row per task. Per-turn deltas are lost — only the aggregate survives.

### `cache_read_input_tokens` Gap (FIXED 2026-07-02)

Prior to the fix in `openai.ts:169-170`, `cacheReadTokens` was never extracted from
the OpenAI SDK response (`sdkUsage.prompt_tokens_details.cached_tokens` existed but
was ignored). The Anthropic provider had equivalent extraction since inception.
The fix (3 lines) now captures cache reads for all OpenAI-compatible providers
(OpenAI, DeepSeek, LM Studio, Ollama).

### Per-turn token tracking (PENDING)

The MODEL_RESPONSE event payload at `orchestrator.ts:311-315` still writes only
`{stopReason, hasContent, toolCallCount}`. The fix to add `{inputTokens,
outputTokens, cacheReadTokens, cacheCreationTokens}` from `providerResponse.usage`
was applied to source but not yet built/reloaded. Once live, every MODEL_RESPONSE
row will carry per-turn token counts, enabling reconstruction of exactly where
tokens went in a multi-turn task.

---

## 3. Comparison: OpenCode / Claude Code Standard Pattern

The standard ReAct (Reasoning + Acting) agent loop sends tools on every request.
This is not an agent-mcp design flaw — it's how the OpenAI/Anthropic APIs work
(stateless chat completions).

| Aspect | agent-mcp | OpenCode (anomalyco) | Claude Code (Anthropic) |
|---|---|---|---|
| Tools fetched per turn | Yes — `listAllTools()` calls MCP `tools/list` every loop iteration | Yes — tool registry queried per turn | Yes — tool schemas sent every request |
| Full tools sent every turn | Yes — all servers, all tools | Yes — all registered tools | Yes — all tools the model can call |
| Tool pruning | No — all tools always sent | Partial — tools gated by permission mode | Yes — per-task tool filtering |
| Tool schema size | Filesystem: ~8 tools, ~3,200 tokens of JSON Schema | ~45 tools, variable | Model-dependent; auto-compacted |
| Caching behavior | Provider-dependent (DeepSeek: auto-prefix, ~50% hit) | Provider-dependent | Anthropic: explicit breakpoints, 90%+ hit with Sentinel-Fanout |

The critical difference: **agent-mcp has no tool pruning.** Claude Code sends only
the tools relevant to the current task. OpenCode gates tools by permission mode.
agent-mcp sends every tool from every connected MCP server on every turn.

---

## 4. Opportunities

> **Status update (2026-07-02):** #1, #2, and #3 are SHIPPED. `listAllTools()` is
> hoisted out of the loop; MODEL_RESPONSE events carry the normalized per-turn
> token fields plus `rawUsage` (the provider usage object verbatim); and tool
> advertisement defaults to `"names"` — slim name-only definitions on the wire
> with full documentation prepended to the system message as a cacheable prefix
> (per-agent override: `toolAdvertisement: "full"`; claudecli always full). See
> `engine/tool-advertisement.ts` and `__tests__/tool-advertisement.test.ts`
> (includes negative control). Remaining: registry-backed tool docs (Plan 8).

### Immediate (low effort, high impact)

1. **Pull `listAllTools()` out of the loop** — tools don't change mid-task. Call it
   once before the while-loop and reuse the array. Eliminates MCP `tools/list`
   round-trips on every turn. **DONE.**

2. **Add `inputTokens/outputTokens/cacheReadTokens/cacheCreationTokens` to
   MODEL_RESPONSE payloads** — fix applied to source, pending build. **DONE, plus
   `rawUsage` verbatim.**

### Medium (requires design)

3. **Tool pruning** — the agent definition or system prompt should declare which
   tools the work order needs. The `DispatchUnit` from the dispatch-optimizer
   already carries `context_files` and operation shapes — the orchestrator could
   pass a `tools` allowlist. GitHub Engineering cut costs 62% with this approach.
   Per-turn savings for filesystem-only: ~1,600 tokens/turn after caching.

4. **Cache-optimized system prompt** — place the largest stable prefix (system
   prompt + tool schemas) first in the messages array to maximize cache-hit
   surface area.

### Speculative (would require provider API changes)

5. **Omit `tools` on follow-up turns** — some providers tolerate this (model
   already emitted valid tool calls, doesn't need schemas re-validated). Would
   save ~1,600-3,200 tokens/turn. Not standard OpenAI behavior; needs testing
   per provider.

---

## 5. Verbatim: What the Provider Sees Each Turn

A synthesized, token-annotated view of a single turn in the spec-types task:

```
SYSTEM (3,500 tokens — CACHED after turn 1)
  "You are an implementation agent for the ADHD Nx monorepo..."
  + repo conventions, tool discipline, fail-fast rules

TOOLS (3,200 tokens — CACHED after turn 1)
  filesystem__read_text_file  { path: string, head?: number, tail?: number }
  filesystem__write_file      { path: string, content: string }
  filesystem__edit_file       { path: string, old_string: string, new_string: string }
  filesystem__search_files    { path: string, pattern: string }
  filesystem__list_directory  { path: string }
  shell__shell_exec           { command: string }
  ... (8 tools * ~400 tokens avg JSON Schema each)

USER MESSAGE (1,500 tokens — CACHED after turn 1)
  "SANDBOX MODE — compiler smoke test. Work order compiled from..."
  + spec-types operations list

ASSISTANT (turn 1 — 120 tokens — NOT CACHED)
  Tool call: filesystem__read_text_file(path="packages/dispatch/...")

TOOL RESULT (turn 1 — 22,000 tokens — NOT CACHED)
  Full content of types.ts (660 lines)

ASSISTANT (turn 2 — 80 tokens — NOT CACHED)
  Tool call: filesystem__create_directory(path="...")

TOOL RESULT (turn 2 — 15 tokens — NOT CACHED)
  "Directory created"

... (grows each turn — everything below the USER MESSAGE changes)

ASSISTANT (turn N — this request)
  "I will now write types.ts..."
```

Every turn after turn 1: ~3,500 system + 3,200 tools + 1,500 work order =
~8,200 tokens READ FROM CACHE (820 billed), plus the entire growing conversation
history PAID AT FULL PRICE.

For turn 15 with ~30 messages in history (~180k tokens of conversation +
tool results): 820 (cached) + 180,000 (uncached) = ~180,820 input tokens.
This matches the observed average of ~17,500/turn × 15 turns = 262,590.

**The tool schemas are not the dominant cost on turn 15 — the accumulated
conversation history is.** But the tool schemas ARE the dominant cost on
early turns, and they compound the problem by bloating the prefix that
rides along in every turn.
