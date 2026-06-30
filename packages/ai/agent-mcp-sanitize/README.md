# @adhd/agent-mcp-sanitize

Sub-agent output sanitization plugin for [@adhd/agent-mcp](https://github.com/anomalyco/adhd/tree/main/packages/ai/agent-mcp). Defends against prompt injection across agent boundaries by modifying delegation tool results before the parent model sees them.

## Installation

Add to your `agent-mcp.config.json` (project root or `~/.agent-mcp/config.json`):

```json
{
  "plugins": [
    { "module": "@adhd/agent-mcp-sanitize" }
  ]
}
```

Or via env var:

```
ADHD_AGENT_PLUGINS="@adhd/agent-mcp-sanitize"
```

## Configuration

```json
{
  "plugins": [
    {
      "module": "@adhd/agent-mcp-sanitize",
      "config": {
        "defaultStrategy": "prefix",
        "delegationOnly": true,
        "agents": {
          "internal-tool": "none"
        }
      }
    }
  ]
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultStrategy` | `"none"` \| `"prefix"` \| `"wrap"` | `"prefix"` | Default sanitization strategy |
| `agents` | `Record<string, strategy>` | `{}` | Per-agent overrides (agent name → strategy) |
| `delegationOnly` | `boolean` | `true` | Only sanitize delegation tool calls (`agent-mcp__task` / `agent-mcp__agent`); when `false`, sanitizes all tool results |

## Strategies

| Strategy | Effect | Example output |
|----------|--------|---------------|
| `"none"` | Raw pass-through | `"hello world"` |
| `"prefix"` | Prepends a boundary label | `[Sub-agent output from "researcher"]\nhello world` |
| `"wrap"` | Surrounds with delimiters | `── Agent "researcher" output ──\nhello world\n── End agent output ──` |

## How it works

The plugin registers a transform handler on the `transform:tool_result` hook event.
When the orchestrator receives a delegation result in Phase 3 (before appending it to
conversation history), it emits this event. The handler mutates `payload.result` in
place — the orchestrator reads the sanitized value when building the tool result
message.
