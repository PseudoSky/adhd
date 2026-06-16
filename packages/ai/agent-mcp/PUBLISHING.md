# agent-mcp Publishing Guide

Package-specific smoke test for `@adhd/agent-mcp`.

See the [root PUBLISHING.md](../../../../PUBLISHING.md) for the general version-bump and publish steps.

---

## Pre-publish checklist

**Run the full sequence below, top-to-bottom, without skipping steps.**

### Step 1 — Bump the version (from workspace root)

```bash
# run from /path/to/adhd (workspace root), NOT from inside packages/ai/agent-mcp
npm version patch --no-git-tag-version --prefix packages/ai/agent-mcp
```

Or edit `packages/ai/agent-mcp/package.json` manually.  The version change
invalidates Nx's build cache so the next build is always fresh.

> ⚠️ **CWD matters.** Never `cd packages/ai/agent-mcp && npm version` — that
> changes your shell CWD, and relative paths like `ls dist/...` will silently
> resolve to the wrong directory for the rest of the session.

### Step 2 — Clean dist and build

```bash
rm -rf dist/packages/ai/agent-mcp
npx nx build agent-mcp --skip-nx-cache
```

Removing the dist directory first guarantees that Nx's task-result cache cannot
serve a stale entry. `--skip-nx-cache` ensures the executor actually runs.
The build is configured with `clean: true` — it wipes the output directory,
compiles TypeScript, copies `drizzle/` (migrations), and writes `package.json`.

After building, confirm all three folders are present:

```bash
ls dist/packages/ai/agent-mcp/
# must show: drizzle  package.json  src
```

If `drizzle/` is absent the published server crashes at startup with
`Can't find meta/_journal.json`. Do not proceed.

### Step 3 — Reload the MCP connection

In Claude Code, run `/mcp` and confirm `agent-mcp` (the local dist server) reconnects
successfully. A `-32000` error means the server crashed at startup — do not proceed.

### Step 4 — Verify server version

After reconnecting, call the `guide` tool on `agent-mcp`. The response includes the
server version in the MCP server info. Confirm it matches the version in
`packages/ai/agent-mcp/package.json`.

### Step 5 — Run a functional smoke test

Create a minimal agent, run a task, and clean up — all against the **local** server
(`mcp__agent-mcp__*`, not `mcp__agent-mcp-published__*`):

```
agent_create: { name: "pre-pub-check", provider: { type: anthropic, model: "claude-haiku-4-5-20251001", useClaudeOauth: true, maxTokens: 1024 }, systemPrompt: "You are a test assistant.", mcpServers: {}, permissions: {} }
task: { agent_name: "pre-pub-check", prompt: "Reply with exactly: ok" }
→ expect status: completed, result: "ok"
agent_delete: { name: "pre-pub-check" }
```

Only proceed to publish once the task completes successfully.

### Step 6 — Publish

```bash
npx nx release publish --projects=agent-mcp
```

This command:
1. Runs `npx nx test agent-mcp` (via `dependsOn: ["build", "test"]`)
2. Runs `npx nx build agent-mcp` — served from cache (Step 2 just built it; inputs unchanged)
3. Runs `npm publish dist/packages/ai/agent-mcp --access public`

To preview what would be published without actually pushing to npm:

```bash
npx nx release publish --projects=agent-mcp --dry-run
```

The dry-run output lists every file in the tarball. Confirm `drizzle/` appears before
doing the real publish.

---

## Smoke test against the published version

### 1. Start LM Studio

Open LM Studio, load a model, and enable the local server on `http://localhost:1234`.

Verify it is reachable and auth works:

```bash
curl -s http://localhost:1234/v1/models \
  -H "Authorization: Bearer $LMSTUDIO_API_KEY" \
  | jq '.data[].id'
```

Note the exact model ID returned — you will need it below.

---

### 2. Verify .mcp.json points to the latest published version

Check `.mcp.json` in the repo root. The `agent-mcp-published` entry must use `@adhd/agent-mcp@latest`:

```json
{
  "mcpServers": {
    "agent-mcp-published": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp@latest"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/agents-published.db",
        "LMSTUDIO_API_KEY": "<your-key>",
        "LMSTUDIO_BASE_URL": "http://localhost:1234/v1"
      }
    }
  }
}
```

Confirm the version that will be pulled:

```bash
npm view @adhd/agent-mcp dist-tags.latest
```

Reconnect MCP in Claude Code (`/mcp`) and confirm `agent-mcp-published` shows as connected.

---

### 3. Run the Claude → LM Studio smoke test

The following MCP tool sequence dispatches a task through a `claudecli` orchestrator
that delegates to an LM Studio worker. Run these in order via Claude Code MCP tools
(or script them against the MCP server directly).

### 3a. Create the LM Studio worker agent

```
agent_create:
  name: test-worker
  provider: { type: lmstudio, model: "<model-id-from-step-1>" }
  systemPrompt: "You are a helpful assistant. Answer concisely."
  mcpServers: {}
  permissions: { allowedAgents: [] }
```

### 3b. Create the claudecli orchestrator agent

```
agent_create:
  name: claude-orchestrator
  provider: { type: claudecli }
  systemPrompt: >
    You are an orchestrator. When given a task, delegate it to the 'test-worker'
    agent using the agent and task tools. Open a session with agent({name: 'test-worker'}),
    submit the task with task({session_id, prompt}), and return the result.
  mcpServers:
    agent-mcp:
      transport: stdio
      command: npx
      args: ["-y", "@adhd/agent-mcp@latest"]
      env:
        DATABASE_PATH: <same path as above>
        LMSTUDIO_API_KEY: <your-key>
        LMSTUDIO_BASE_URL: http://localhost:1234/v1
  permissions:
    allowedAgents: [test-worker]
```

### 3c. Open a session and run the task

```
session_id = agent({ name: "claude-orchestrator" })

task({
  session_id,
  prompt: "Ask the test-worker to explain what a binary search tree is in one sentence, then return its answer."
})
```

Expected: `status: "completed"` with a result that quotes the worker's answer.

---

### 4. Verify logs via the database

The SQLite database is the authoritative record of what actually ran.

```bash
DB=/absolute/path/to/agents-published.db

# Confirm all sessions created
sqlite3 $DB "
  SELECT s.id, a.name, s.status
  FROM sessions s
  JOIN agents a ON s.agent_name = a.name
  ORDER BY s.created_at;
"

# Confirm the full task chain
sqlite3 $DB "
  SELECT a.name as agent, t.status, t.prompt, t.result
  FROM tasks t
  JOIN sessions s ON t.session_id = s.id
  JOIN agents a ON s.agent_name = a.name
  ORDER BY t.created_at;
"
```

**Expected output:**

| agent | status | prompt (truncated) |
|---|---|---|
| `test-worker` | `completed` | `What is 2 + 2?...` |
| `claude-orchestrator` | `completed` | `Ask the test-worker...` |
| `test-worker` | `completed` | `Explain what a binary search tree...` |

The key signal: there must be a `test-worker` task row that was spawned *by* the orchestrator's session — confirming the delegation hop actually happened rather than Claude answering directly.
