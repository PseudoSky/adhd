# @adhd/agent-plugin-sanitize

Sub-agent output sanitization plugin for [@adhd/agent-mcp](https://github.com/anomalyco/adhd/tree/main/packages/ai/agent-mcp). Defends against prompt injection across agent boundaries by modifying delegation tool results before the parent model sees them.

## Installation

Add to your `agent-mcp.config.json` (project root or `~/.agent-mcp/config.json`):

```json
{
  "plugins": [{ "module": "@adhd/agent-plugin-sanitize" }]
}
```

Or via env var:

```
ADHD_AGENT_PLUGINS="@adhd/agent-plugin-sanitize"
```

## Configuration

```json
{
  "plugins": [
    {
      "module": "@adhd/agent-plugin-sanitize",
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

| Option            | Type                               | Default    | Description                                                                                                            |
| ----------------- | ---------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `defaultStrategy` | `"none"` \| `"prefix"` \| `"wrap"` | `"prefix"` | Default sanitization strategy                                                                                          |
| `agents`          | `Record<string, strategy>`         | `{}`       | Per-agent overrides (agent name → strategy)                                                                            |
| `delegationOnly`  | `boolean`                          | `true`     | Only sanitize delegation tool calls (`agent-mcp__task` / `agent-mcp__agent`); when `false`, sanitizes all tool results and also stops provider server-tool results from being stored (see below) |

## Strategies

| Strategy   | Effect                    | Example output                                                         |
| ---------- | ------------------------- | ---------------------------------------------------------------------- |
| `"none"`   | Raw pass-through          | `"hello world"`                                                        |
| `"prefix"` | Prepends a boundary label | `[Sub-agent output from "researcher"]\nhello world`                    |
| `"wrap"`   | Surrounds with delimiters | `── Agent "researcher" output ──\nhello world\n── End agent output ──` |

## How it works

The plugin registers a transform handler on the `transform:tool_result` hook event.
When the orchestrator receives a delegation result in Phase 3 (before appending it to
conversation history), it emits this event. The handler mutates `payload.result` in
place — the orchestrator reads the sanitized value when building the tool result
message.

## Provider server-tool results are NOT sanitized

Some providers execute tools themselves. With the Anthropic provider these are the native
`web_fetch` and `web_search` tools: the provider runs them and returns the fetched page or
search results inside the assistant message. **That content is untrusted third-party
content, and it bypasses `transform:tool_result` entirely, so this plugin cannot prefix,
wrap or otherwise sanitize it** (the blocks are opaque and signed; rewriting them would
invalidate them). It reaches the model unmodified.

To keep that content from steering the model beyond the run that fetched it, the
orchestrator keeps the provider-native blocks of each assistant message and replays them
on later requests. By default, server-tool results are stored for a bounded idle window
(`echo.serverResultTtlMinutes`, default 10 minutes), so a page injected into one task can
influence later turns in the same session during that window (prompt-injection
persistence).

What this plugin does about it:

- `delegationOnly: true` (default): nothing changes. Server-tool results follow the
  orchestrator's normal retention.
- `delegationOnly: false` ("sanitize all tool output"): the plugin registers a handler on
  the `transform:server_result_persist` hook and sets `persist = false`. Server-tool
  results are then replayed **within the producing run only** and are never stored. Other
  provider-native blocks (thinking, text) are unaffected. This is a persistence veto, not
  sanitization: inside the run the content is still unsanitized.

If you need more than that, the opt-outs are:

| Opt-out | Effect |
| --- | --- |
| `nativeWebTools: false` (agent setting) | The provider's own web tools are not offered, so no server-tool results exist at all. Use the engine's regular, sanitizable tools instead. |
| `echo.serverResultTtlMinutes: 0` | Server-tool results are never stored, for every agent, independent of this plugin. |
| `session_clear` | Purges a session's stored history, including any stored provider-native blocks. |

### Hook contract (for plugin authors)

`transform:server_result_persist` carries `{ sessionId, agentName?, serverBytes, persist }`
and is emitted once per assistant message, before its provider-native blocks are stored,
with `persist: true`. Handlers mutate the payload by reference, like
`transform:tool_result`. A handler may only veto (`persist = false`); it must never set
`persist` back to `true`, because handlers run in registration order and would undo an
earlier plugin's veto.
