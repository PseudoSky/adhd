# @adhd/agent-mcp-budget

Enforcement plugin for `@adhd/agent-mcp`. Caps token spend, model calls, wall-clock time, and tool usage per task, session, agent, provider, or globally — with configurable time windows and warning/block modes.

## Config

Place at `.adhd/agent-mcp/config.json` (auto-discovered by the plugin loader):

```json
{
  "plugins": [{
    "module": "@adhd/agent-mcp-budget",
    "config": {
      "defaults": {
        "caps": [
          { "field": "tokens", "maximum": 50000 },
          { "field": "calls", "maximum": 8 },
          { "field": "wallClock", "maximum": 120000 }
        ]
      }
    }
  }]
}
```

## Caps

Each cap defines one limit. Fields:

| Field | Unit | Scope | Description |
|---|---|---|---|---|
| `tokens` | count | all | Sum of input + output + cache tokens |
| `inputTokens` | count | all | Input tokens only |
| `outputTokens` | count | all | Output tokens only |
| `calls` | count | all | Number of LLM model calls |
| `wallClock` | ms | task only | Wall-clock time from task start |
| `modelMs` | ms | task only | Cumulative model response time |
| `cost` | USD | all | Estimated cost (requires `costPerInputToken` / `costPerOutputToken`) |
| `toolCalls` | count | tool only | Per-tool call count |
| `responseSize` | chars | tool only | Raw response character length. Enforced at `transform:tool_result` — truncates (warning) or replaces with error (block) |

### Custom message

Each cap supports an optional `message` that overrides the auto-generated enforcement message. Use it to give the agent actionable guidance:

```json
{ "field": "toolCalls", "maximum": 5, "mode": "block",
  "message": "Search is expensive. Use the index: query__search first" }
```

### Scopes

| Scope | Coverage | DB query |
|---|---|---|
| `task` | Current task in-memory only | None |
| `session` | Current task + all historical tasks in session | `task_usage` JOIN `tasks` WHERE `session_id` |
| `agent` | Current task + all historical tasks for this agent | `task_usage` WHERE `agent_name` |
| `global` | Current task + ALL historical tasks across all agents | `task_usage` all rows |

Scope is inherited from the dimension's `scope` field if not set on the individual cap:

```json
{
  "defaults": {
    "scope": "agent",
    "caps": [
      { "field": "tokens", "maximum": 50000 },
      { "field": "calls", "maximum": 8 }
    ]
  }
}
```

### Time windows

Use ISO8601 durations for rolling window caps:

```json
{ "field": "tokens", "maximum": 200000, "window": "PT24H", "scope": "agent" }
```

Supported formats: `PT24H`, `PT1H30M`, `P1DT6H`, `PT30M`, etc.

When a cap has both `scope` and `window`, the window query provides the historical total (scope-filtered, within the window) — no double-counting.

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
          { "field": "responseSize", "maximum": 500, "mode": "warning",
            "message": "File too large. Use read_text_file with head:100 to preview, search_files for pattern matching, or read_multiple_files to batch-read small files" },
          { "field": "toolCalls", "maximum": 100, "mode": "warning",
            "message": "Too many file reads. Use search_files or get_file_info first" }
        ]
      }
    }
  }
}
```

- `toolCalls` field — enforced at `pre:tool_call`
  - `warning` — tool call is blocked, agent receives a diagnostic, task continues
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
    "default": { "caps": [{ "field": "cost", "maximum": 0.10 }] },
    "overrides": {
      "anthropic": { "caps": [{ "field": "cost", "maximum": 0.50 }] }
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
        "caps": [
          { "field": "responseSize", "maximum": 500, "mode": "warning",
            "message": "Raw file content is too large. Use shell tools instead: head -n 100, wc -l, grep for patterns" }
        ]
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
    "caps": [{ "field": "cost", "maximum": 0.10 }]
  }
}
```

Cost = `inputTokens × costPerInputToken + outputTokens × costPerOutputToken`.

## Backward compat (flat format)

The old flat field format is supported via automatic conversion:

```json
{
  "config": {
    "maxTotalTokens": 50000,
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
    { "field": "tokens", "maximum": 50000 },
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
    "maxTotalTokens": 50000,
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
nx test agent-mcp-budget
```
