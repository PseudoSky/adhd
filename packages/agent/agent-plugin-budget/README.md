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
| `cost`         | USD   | all       | Estimated cost (requires `costPerInputToken` / `costPerOutputToken`)                                                    |
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

For the `cost` field, set token prices on the defaults dimension:

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

## Testing

```bash
nx test agent-plugin-budget
```
