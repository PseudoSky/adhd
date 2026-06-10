# Installing @adhd/agent-mcp

Complete setup guide for every supported provider and MCP host.

---

## Requirements

- Node.js 18+
- An MCP-compatible host (Claude Code, LM Studio, Cursor, Zed, or any host that supports stdio MCP servers)
- A writable path for the SQLite database

No global install is needed — `npx` downloads and runs the package on demand.

---

## How to connect

Add a server entry to your MCP host's config file. The key fields are:

```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp@latest"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/agents.db"
      }
    }
  }
}
```

`DATABASE_PATH` is the only required variable. The file is created automatically if it doesn't exist. Everything else is provider-specific — pick your provider below and add the relevant env vars.

---

## Provider configs

### LM Studio (local, no billing)

Run LM Studio, load a model, and enable the local server. Copy the API key from LM Studio's developer settings.

```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp@latest"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/agents.db",
        "LMSTUDIO_BASE_URL": "http://localhost:1234/v1",
        "LMSTUDIO_API_KEY": "your-lmstudio-key"
      }
    }
  }
}
```

Verify LM Studio is reachable:
```bash
curl http://localhost:1234/v1/models \
  -H "Authorization: Bearer your-lmstudio-key" \
  | jq '.data[].id'
```

Use the model ID exactly as returned (e.g. `qwen2.5-coder-7b-instruct-mlx`) when creating agents.

---

### OpenAI

```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp@latest"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/agents.db",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Agents use `type: "openai"` with models like `gpt-4o`, `gpt-4o-mini`.

---

### Anthropic API key

```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp@latest"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/agents.db",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Agents use `type: "anthropic"` with models like `claude-opus-4-8`, `claude-haiku-4-5`.

---

### Anthropic via Claude Max subscription (OAuth keychain — macOS only)

No API key or billing setup required. Uses the OAuth token stored by Claude Code in the macOS keychain.

**Prerequisite:** Claude Code must be installed and you must have logged in at least once (`claude login`).

```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp@latest"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/agents.db"
      }
    }
  }
}
```

When creating an agent, set `useClaudeOauth: true`:

```json
{
  "name": "my-agent",
  "provider": {
    "type": "anthropic",
    "model": "claude-haiku-4-5",
    "useClaudeOauth": true
  },
  "systemPrompt": "...",
  "mcpServers": {},
  "permissions": { "allowedAgents": [] }
}
```

The token is read from the keychain on every request and refreshed automatically when within 5 minutes of expiry. Rotated credentials are written back to the keychain so Claude Code stays in sync.

**Note:** Not supported on Linux or Windows — use `ANTHROPIC_AUTH_TOKEN` instead.

---

### Anthropic via auth token (subscription users, all platforms)

Generate a token with `claude setup-token` (Claude Code CLI), or retrieve one from your Claude account.

```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp@latest"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/agents.db",
        "ANTHROPIC_AUTH_TOKEN": "your-auth-token"
      }
    }
  }
}
```

---

### claudecli (drives local `claude` CLI as a subprocess)

Uses the `claude` CLI binary installed by Claude Code. The subprocess manages its own tool-use loop internally. Useful for orchestrator agents that need to use Claude Code's built-in tools or delegate to other agents via MCP.

No additional env vars are needed beyond `DATABASE_PATH` — the subprocess inherits credentials from Claude Code's own keychain state.

```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp@latest"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/agents.db"
      }
    }
  }
}
```

When creating an agent, use `type: "claudecli"`. Pass `allowedBuiltinTools` to permit specific Claude Code built-ins (all others are blocked by default):

```json
{
  "name": "orchestrator",
  "provider": {
    "type": "claudecli",
    "allowedBuiltinTools": []
  },
  "systemPrompt": "You are an orchestrator...",
  "mcpServers": {
    "agent-mcp": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp@latest"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/agents.db",
        "LMSTUDIO_BASE_URL": "http://localhost:1234/v1",
        "LMSTUDIO_API_KEY": "your-key"
      }
    }
  },
  "permissions": { "allowedAgents": ["worker-agent"] }
}
```

---

## All providers at once

To make all providers available simultaneously, set all their env vars. The server starts regardless — variables are only used when a matching agent type makes a request.

```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp@latest"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/agents.db",
        "LMSTUDIO_BASE_URL": "http://localhost:1234/v1",
        "LMSTUDIO_API_KEY": "your-lmstudio-key",
        "OPENAI_API_KEY": "sk-...",
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "ANTHROPIC_AUTH_TOKEN": "",
        "AGENT_MCP_MAX_DEPTH": "5",
        "AGENT_MCP_MAX_TOOL_LOOPS": "50",
        "QUEUE_CONCURRENCY": "5",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

---

## MCP host setup

### Claude Code (`.mcp.json`)

Save the config as `.mcp.json` in your project root. Claude Code picks it up automatically. After editing, run `/mcp` in Claude Code and reconnect.

```
project-root/
  .mcp.json        ← goes here
```

#### Required: allowlist in `.claude/settings.json`

If your project has a `.claude/settings.json` with an `allowedMcpServers` field, you must add `agent-mcp` to it or the server will be blocked entirely — Claude Code treats that field as an explicit trust list and rejects any server not on it. This is a supply-chain protection: it prevents a malicious `.mcp.json` committed to a cloned repo from loading an untrusted server automatically.

```json
{
  "allowedMcpServers": [
    { "serverName": "agent-mcp" }
  ]
}
```

If your project also runs Claude agents unattended (no human to approve prompts), add each tool to `permissions.allow` so they aren't blocked at call time:

```json
{
  "permissions": {
    "allow": [
      "mcp__agent-mcp__guide",
      "mcp__agent-mcp__agent_create",
      "mcp__agent-mcp__agent_read",
      "mcp__agent-mcp__agent_update",
      "mcp__agent-mcp__agent_delete",
      "mcp__agent-mcp__agent_list",
      "mcp__agent-mcp__agent",
      "mcp__agent-mcp__session_list",
      "mcp__agent-mcp__session_close",
      "mcp__agent-mcp__session_clear",
      "mcp__agent-mcp__task",
      "mcp__agent-mcp__task_list",
      "mcp__agent-mcp__task_cancel",
      "mcp__agent-mcp__result",
      "mcp__agent-mcp__usage_query"
    ]
  }
}
```

Projects that only use Claude Code interactively (a human is present) don't need `permissions.allow` — Claude Code will prompt for approval on first use and remember the answer.

### Claude Code (global `~/.claude/mcp.json`)

To make agent-mcp available in all projects:

```bash
# Edit (or create) ~/.claude/mcp.json and add the agent-mcp entry
```

### LM Studio

Open **Settings → MCP Plugins** and paste the `mcpServers` block. LM Studio restarts the server automatically on save.

### Cursor / Zed / other hosts

These hosts use the same `{ command, args, env }` shape. Paste the `mcpServers` block into the host's MCP config file (location varies by host — check that host's docs for the path).

---

## Verify the connection

Once connected, call the `guide` tool — it returns the full server usage guide and confirms the server is reachable:

```
mcp__agent-mcp__guide: {}
```

To inspect recorded token usage after running tasks, call `usage_query` (all
filters optional — a bare `{}` returns the most recent rows):

```
mcp__agent-mcp__usage_query: { "task_id": "<root-task-id>" }
```

Passing a `task_id` returns that task's row plus its entire delegation subtree
(every sub-task whose `root_task_id` matches), with an aggregate `summary` of
input/output tokens, model calls, and tool calls across the tree.

If the tool is not visible, the server failed to start. Check that `DATABASE_PATH` is an absolute path to a writable directory.

---

## Next steps

- [README.md](./README.md) — full tool reference and architecture overview
- [PUBLISHING.md](./PUBLISHING.md) — smoke test procedure after each publish
- [AGENT-DEV.md](./AGENT-DEV.md) — dev loop for LLM agents making changes to this package
- [GAPS.md](./GAPS.md) — known limitations and their fix paths
