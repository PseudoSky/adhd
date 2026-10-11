# @adhd/agent-plugin-budget

Enforcement plugin for `@adhd/agent-mcp`. Caps token spend, model calls, wall-clock time, and tool usage per task, session, agent, provider, or globally — with configurable time windows and warning/block modes.

## Config

Place at `.adhd/agent-mcp/config.json` (auto-discovered by the plugin loader):

```json
{
  "plugins": [
    {
      "module": "@adhd/agent-plugin-budget",
      "config": {
        "defaults": {
          "caps": [
            { "field": "inputTokens", "maximum": 50000 },
            { "field": "calls", "maximum": 8 },
            { "field": "wallClock", "maximum": 120000 }
          ]
        }
      }
    }
  ]
}
```

## Caps

Each cap defines one limit. Fields:

| Field          | Unit  | Scope     | Description                                                                                                             |
| -------------- | ----- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `context`      | count | model     | PEAK single-request input size (use `maximum` or `contextWindowFraction`); rejects `window`                            |
| `inputTokens`  | count | all       | Input tokens only (cache-read and cache-write included in the provider-neutral input total). A windowed cap sums INPUT only |
| `outputTokens` | count | all       | Output tokens only. A windowed cap sums OUTPUT only                                                                      |
| `calls`        | count | all       | Number of LLM model calls                                                                                               |
| `wallClock`    | ms    | task only | Wall-clock time from task start                                                                                         |
| `modelMs`      | ms    | task only | Cumulative model response time                                                                                          |
| `cost`         | USD   | all       | Estimated cost; priced from the shared model rate card unless flat `costPer*Token` rates are set (see [Cost pricing](#cost-pricing))   |
| `toolCalls`    | count | tool only | Per-tool call count                                                                                                     |
| `responseSize` | chars | tool only | Raw response character length. Enforced at `transform:tool_result` — truncates (warning) or replaces with error (block) |

### Custom message

Each cap supports an optional `message` that overrides the auto-generated enforcement message. Use it to give the agent actionable guidance:

```json
{ "field": "toolCalls", "maximum": 5, "mode": "block", "message": "Search is expensive. Use the index: query__search first" }
```

### Scopes

| Scope     | Coverage                                              | DB query                                     |
| --------- | ----------------------------------------------------- | -------------------------------------------- |
| `task`    | Current task in-memory only                           | None                                         |
| `session` | Current task + all historical tasks in session        | `task_usage` JOIN `tasks` WHERE `session_id` |
| `agent`   | Current task + all historical tasks for this agent    | `task_usage` WHERE `agent_name`              |
| `global`  | Current task + ALL historical tasks across all agents | `task_usage` all rows                        |

Scope is inherited from the dimension's `scope` field if not set on the individual cap:

```json
{
  "defaults": {
    "scope": "agent",
    "caps": [
      { "field": "inputTokens", "maximum": 50000 },
      { "field": "calls", "maximum": 8 }
    ]
  }
}
```

### Time windows

Use ISO8601 durations for rolling window caps:

```json
{ "field": "inputTokens", "maximum": 200000, "window": "PT24H", "scope": "agent" }
```

Supported formats: `PT24H`, `PT1H30M`, `P1DT6H`, `PT30M`, etc.

When a cap has both `scope` and `window`, the window query provides the historical total (scope-filtered, within the window) — no double-counting. A windowed `inputTokens` cap sums only the INPUT tokens of history and a windowed `outputTokens` cap sums only OUTPUT tokens; the two never share a value, even on the same scope and window.

### Modes

Every cap (or dimension) takes a `mode`. The default is `warning`.

| Mode                      | Model request (`pre:model_request`)        | Tool call (`pre:tool_call`)                                                   |
| ------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| `warning` (alias `warn`)  | emits `budget:warning`; request proceeds   | emits `budget:warning`; tool executes. Warning only; never alters a call      |
| `soft-block` (opt-in)     | emits `budget:warning`; request proceeds   | tool call skipped, the model receives the message as the tool result; task continues |
| `block`                   | throws `BUDGET_EXCEEDED`                   | throws `BUDGET_EXCEEDED`                                                      |

A `warning` trip emits exactly ONE `budget:warning` per (budget, task) — a budget is a cap's field + scope + window + limit (+ the tool, for per-tool `toolCalls` caps) — so a tripped cap does not spam an event per call. The default message reads:

```
[budget global-PT24H-inputTokens WARN] 4201334 / 500000 tokens (841%, window PT24H, scope global). Warning only; execution continues.
```

A custom `message` on the cap replaces it verbatim. `responseSize` is unaffected: any non-`block` mode truncates the result (it is a shaping cap, not an alarm).

**Migration (0.2.7).** Before 0.2.7, `warning` meant "warn" on model requests but silently soft-blocked TOOL calls, so a tripped global cap could stop a run that was only meant to be warned. Existing configs with `mode: "warning"` now warn only. To keep the old tool-path behaviour, change those caps to `mode: "soft-block"`. Windowed `inputTokens` / `outputTokens` caps also stopped counting the other direction's tokens: a cap that previously tripped on input+output history now sees input (or output) only, so it trips later.

### Tool-level caps

Tool caps enforce at `pre:tool_call` (toolCalls) or `transform:tool_result` (responseSize):

```json
{
  "tool": {
    "default": { "caps": [{ "field": "toolCalls", "maximum": 100 }], "mode": "warning" },
    "overrides": {
      "web_search": {
        "caps": [{ "field": "toolCalls", "maximum": 20 }],
        "mode": "block"
      },
      "filesystem__read_text_file": {
        "caps": [
          { "field": "responseSize", "maximum": 500, "mode": "warning", "message": "File too large. Use read_text_file with head:100 to preview, search_files for pattern matching, or read_multiple_files to batch-read small files" },
          { "field": "toolCalls", "maximum": 100, "mode": "warning", "message": "Too many file reads. Use search_files or get_file_info first" }
        ]
      }
    }
  }
}
```

- `toolCalls` field — enforced at `pre:tool_call`
  - `warning` (alias `warn`) — a `budget:warning` event is emitted (once per budget per task); the call is NEVER altered and the tool executes
  - `soft-block` — tool call is skipped, agent receives a diagnostic, task continues (the pre-0.2.7 behaviour of `warning`)
  - `block` — tool call is blocked, task fails with `BUDGET_EXCEEDED`
- `responseSize` field — enforced at `transform:tool_result` (after the tool runs)
  - `warning` — tool result is **truncated** to `maximum` chars, task continues
  - `block` — tool result is replaced with an error message (task continues, agent sees the error)

## Dimensions

Caps are merged from three dimensions in this order:
`defaults ← agent ← provider`

```json
{
  "defaults": {
    "caps": [{ "field": "calls", "maximum": 8 }]
  },
  "agent": {
    "default": { "caps": [{ "field": "calls", "maximum": 5 }] },
    "overrides": {
      "cheap-agent": {
        "caps": [{ "field": "calls", "maximum": 1, "message": "Cheap agents get 1 call max" }]
      }
    }
  },
  "provider": {
    "default": { "caps": [{ "field": "cost", "maximum": 0.1 }] },
    "overrides": {
      "anthropic": { "caps": [{ "field": "cost", "maximum": 0.5 }] }
    }
  },
  "tool": {
    "default": { "caps": [{ "field": "toolCalls", "maximum": 100 }], "mode": "warning" },
    "overrides": {
      "web_search": {
        "caps": [{ "field": "toolCalls", "maximum": 20, "message": "Consider caching search results" }],
        "mode": "block"
      },
      "filesystem__read_file": {
        "caps": [{ "field": "responseSize", "maximum": 500, "mode": "warning", "message": "Raw file content is too large. Use shell tools instead: head -n 100, wc -l, grep for patterns" }]
      }
    }
  }
}
```

Caps are **additive** across dimensions — multiple caps targeting the same field all apply. For example, `defaults` and `agent.overrides` can both cap `calls`; the stricter bound wins by throwing first.

## Cost estimation

### Cost pricing

The `cost` cap prices every model turn one of two ways, chosen by the top-level `pricing` key:

| `pricing`            | Behaviour                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default)     | Explicit flat `costPer*Token` rates win (defaults, or an agent / provider override). With none configured, the model-keyed rate card prices the turn.                          |
| `rate-card`          | The rate card prices every turn; flat rates are ignored, except as the fallback for a model the card cannot price.                                                              |
| `flat`               | Only the configured flat rates price a turn; the rate card is never read (no flat rates = cost 0, the pre-rate-card behaviour).                                                  |

The rate card is `estimateCost` from `@adhd/agent-core-provider` -- the same model-keyed, provider-agnostic table `usage_query` reports `est_cost_usd` from. The model is resolved per turn as the provider's reported `responseModel`, else the resolved wire model (`selection.modelRef`), else the agent's inline model; multi-model responses (claudecli `modelUsage`) are priced entry by entry on each concrete model id. A DeepSeek agent on the `openai` adapter is therefore priced at DeepSeek's rates and a Sonnet agent at Sonnet's, with no per-provider configuration.

Unpriceable models are never a silent $0: with flat rates configured the turn bills at them; otherwise it accrues nothing and the plugin emits one `budget:unpriced_model` event per task and model (payload: `model`, `field: "cost"`, `usedFlatRates`, `message`).

Per-agent and per-provider rate overrides (`agent.overrides.<name>.costPerInputToken`, `provider.overrides.<type>.costPerInputToken`, ...) are honoured and take precedence over `defaults`; the provider dimension keys on the resolved selection's provider type, then the agent's inline provider, then `unknown`.

Scoped (`session` / `agent` / `global`) cost caps add the persisted `est_cost_usd` of the scope's other tasks when the scope bills by rate card, and the persisted token classes at the flat rates when flat pricing governs.

> **Host default.** `agent-mcp`'s `ADHD_AGENT_BUDGET_COST_USD` now sets `pricing: "rate-card"` instead of injecting flat $3/$15 Sonnet rates. Non-Sonnet agents are priced at their own rates (a cache-warm DeepSeek run no longer trips the cap ~17x early). To keep the old flat pricing, set explicit `costPerInputToken` / `costPerOutputToken` in the budget plugin config.

For flat pricing, set token prices on the defaults dimension:

```json
{
  "defaults": {
    "costPerInputToken": 0.000003,
    "costPerOutputToken": 0.000015,
    "costPerCacheReadToken": 0.0000003,
    "costPerCacheWriteToken": 0.00000375,
    "caps": [{ "field": "cost", "maximum": 0.1 }]
  }
}
```

Cost = `uncachedInputTokens × costPerInputToken + cacheReadTokens × costPerCacheReadToken + cacheCreationTokens × costPerCacheWriteToken + outputTokens × costPerOutputToken`.

`costPerCacheReadToken` and `costPerCacheWriteToken` default to `costPerInputToken` when unset, so a config that only sets the two flat rates bills every input token at the flat input rate — identical to the pre-cache-aware behavior. To match a model's real rate card (e.g. DeepSeek: input `$0.14/M`, cache-read `$0.0028/M`), copy the per-class rates from the provider rate card; on cache-warm runs most input is cache-read, and billing it at the flat input rate over-counts spend by up to ~50x.

## Backward compat (flat format)

The old flat field format is supported via automatic conversion (`maxTotalTokens` and the `tokens` cap field were removed — use `maxInputTokens` / `maxOutputTokens`; a config that still uses them fails at load):

```json
{
  "config": {
    "maxInputTokens": 50000,
    "maxModelCalls": 8,
    "maxWallClockMs": 120000,
    "scope": "agent"
  }
}
```

Converts internally to:

```json
{
  "caps": [
    { "field": "inputTokens", "maximum": 50000 },
    { "field": "calls", "maximum": 8 },
    { "field": "wallClock", "maximum": 120000 }
  ],
  "scope": "agent"
}
```

### Custom messages in flat format

The `message` key is also passed through in flat format — it applies to all caps in the dimension:

```json
{
  "config": {
    "maxInputTokens": 50000,
    "maxModelCalls": 8,
    "mode": "warning",
    "message": "Budget limit hit"
  }
}
```

## Performance

Enforcement makes exactly `U + W` DB queries per event where:

- `U` = number of unique non-task scopes across all caps (0..3)
- `W` = number of unique (scope, window) pairs across all caps

Zero DB queries when no caps are configured. No per-cap scaling.

## Concurrency

The per-tool `toolCalls` counter is in-process and per-task; it is never persisted, so in-process atomicity is the whole story. `pre:tool_call` reserves the call (reads and increments the counter in one synchronous step, before any `await`), and releases the reservation if the call is refused (`soft-block` / `block`). Simultaneous calls to the same tool therefore each count exactly once, and a `toolCalls` cap cannot be overshot by calls that were in flight together, even when a `warn`-mode handler is awaiting. (699da472)

Spend-style caps (`cost`, `inputTokens`, `outputTokens`, `context`, windowed and non-task scopes, and the task-level error counters) are different: they are read at `pre:tool_call` / `pre:model_call` and charged only after the call completes (`post:tool_call` / `post:model_call`). When the engine fans a turn's tool calls out concurrently, up to `toolCallConcurrency` calls (default 8) can pass the same pre-check before any of them is charged, so such a cap can be overshot by at most `toolCallConcurrency - 1` calls' worth of spend. Set `toolCallConcurrency: 1` for strict spend caps.

**The `toolCallConcurrency - 1` bound is a native tool-loop property only.** It comes from the orchestrator's bounded tool pool, which the `anthropic` and `openai` providers' tool loop runs through. The `claudecli` provider does not use that pool: the `claude` CLI runs its own tool loop and calls the engine back with one `tools/call` request per tool use over a loopback MCP bridge. Each bridged call is still governed individually (permission gate, then `pre:tool_call`, then policy, then the call counter), so a `toolCalls` cap and every other pre-check apply to it, and the per-tool reservation described above is exact there too. But the engine puts no limit on how many bridged calls are in flight together; that is whatever the CLI issues in one message. The CLI runs same-message calls serially unless the tool advertises `readOnlyHint`, and the bridge advertises it for `task`, `tasks_batch` and `agent` so parallel delegation really is parallel. A spend-style cap on a `claudecli` agent can therefore be overshot by the spend of every bridged call in flight together, which is bounded by the CLI's same-message fan-out, not by `toolCallConcurrency` (setting it to `1` does not constrain the bridge). When a bridged call is `task` or `tasks_batch`, its spend is that of a whole child task, so the overshoot per call can be large. For a hard spend ceiling on a `claudecli` agent, do not rely on the parent's post-charged caps alone: give the delegated agents their own caps, or deny `task`, `tasks_batch` and `agent` for the parent. (b3999dfa AC1)

**A refused call can over-refuse a concurrent one.** `toolCalls` reservation is conservative by design: call A reserves the counter (N to N+1) before its cap loop awaits, so a simultaneous call B reads N+1. If A is then refused by a different cap (for example `cost`) and releases its reservation, B may already have been refused against a count that included A, even though A never ran and B would have fit. The failure direction is always "refuse too much", never "allow too much": the cap is never exceeded and the refused caller can simply retry (the released slot is available at once). Reserving before the first `await` is what closes the lost-update window; removing the over-refusal would mean not holding the reservation across the cap loop, which reopens that window, so the conservative failure is kept. (b3999dfa AC1) Counters for non-`task` scopes are read from the shared SQLite store, which several processes may write concurrently, so those caps are likewise advisory at the granularity of the calls in flight across all processes.

## Testing

```bash
nx test agent-plugin-budget
```
