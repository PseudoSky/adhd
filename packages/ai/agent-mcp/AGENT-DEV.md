# agent-mcp: LLM Agent Dev Loop

Instructions for LLM agents making changes to this package. The MCP client points at compiled `dist/` output — source edits have no effect until rebuilt and the MCP connection is reloaded.

---

## Full update cycle

### 1. Make your changes

Edit files under `packages/ai/agent-mcp/src/`.

### 2. Build

```bash
npx nx build agent-mcp
```

Wait for: `NX Successfully ran target build for project agent-mcp`

If the build fails, fix the errors before continuing — do not ask the user to reload until the build is clean.

### 3. Ask the user to reload the MCP connection

Tell the user:

> Build complete. Please run `/mcp` in Claude Code and reconnect `agent-mcp` to pick up the changes.

Wait for the user to confirm the connection is back before proceeding.

### 4. Verify the reload took effect

Call `usage` on the local server and confirm the response reflects your changes (e.g. a new tool appears, a field is present, behaviour changed):

```
mcp__agent-mcp__usage: {}
```

If the tool schema or behaviour you changed is not yet visible, the old process may still be running. Ask the user to fully disconnect and reconnect via `/mcp`.

### 5. Test

Run the minimal sequence that exercises the changed code.

**Example — LM Studio worker (simplest, no delegation):**

```
mcp__agent-mcp__agent_create:
  name: "dev-worker"
  provider: { type: "lmstudio", model: "qwen2.5-coder-7b-instruct-mlx" }
  systemPrompt: "You are a helpful assistant. Answer concisely."
  mcpServers: {}
  permissions: { allowedAgents: [] }

session_id = mcp__agent-mcp__agent: { name: "dev-worker" }

mcp__agent-mcp__task:
  session_id: "<session_id from above>"
  prompt: "What is 2 + 2? Reply in one sentence."
```

Expected: `{ status: "completed", result: "2 + 2 equals 4." }`

**Example — claudecli orchestrator delegating to LM Studio worker (full chain):**

```
mcp__agent-mcp__agent_create:
  name: "dev-orchestrator"
  provider: { type: "claudecli" }
  systemPrompt: >
    You are an orchestrator. Delegate the task to the 'dev-worker' agent using
    the agent and task tools. Open a session with agent({name: 'dev-worker'}),
    submit the task with task({session_id, prompt}), and return the result.
  mcpServers:
    agent-mcp:
      transport: stdio
      command: node
      args: ["/Users/nix/dev/node/adhd/dist/packages/ai/agent-mcp/src/index.js"]
      env:
        DATABASE_PATH: /Users/nix/dev/node/adhd/packages/ai/agent-mcp/data/agents.db
        LMSTUDIO_API_KEY: <key>
        LMSTUDIO_BASE_URL: http://localhost:1234/v1
  permissions: { allowedAgents: ["dev-worker"] }

session_id = mcp__agent-mcp__agent: { name: "dev-orchestrator" }

mcp__agent-mcp__task:
  session_id: "<session_id from above>"
  prompt: "Ask the dev-worker what 2 + 2 is and return its answer."
```

Expected: `{ status: "completed", result: "The dev-worker's answer: 2 + 2 equals 4." }`

Check `status: "completed"` and inspect `result`. If the task fails, call `result` with the `task_id` to get the full error.

### 6. Verify via the database

The database is the ground truth — it records every session and task that actually ran, not just what the tool returned.

```bash
DB=/Users/nix/dev/node/adhd/packages/ai/agent-mcp/data/agents.db

# Most recent tasks
sqlite3 $DB "
  SELECT a.name as agent, t.status, t.error, substr(t.result, 1, 120) as result
  FROM tasks t
  JOIN sessions s ON t.session_id = s.id
  JOIN agents a ON s.agent_name = a.name
  ORDER BY t.created_at DESC
  LIMIT 10;
"
```

A `status: completed` with a non-empty `result` and no `error` confirms the full path ran correctly.

---

## Notes

- **Never test against `dist/` directly** — always go through the MCP tools so the full server stack (validation, store, orchestrator, provider) is exercised.
- **The local server (`agent-mcp`) and the published server (`agent-mcp-published`) share the same MCP tool names** but use separate databases. Changes to source only affect the local server after a rebuild + reload.
- **Session state persists across reloads** — you do not need to recreate agents or sessions after a `/mcp` reconnect unless you changed the schema.
- **If you change the database schema** (files under `src/db/schema.ts` or `drizzle/`), the migration runs automatically on next server start. Existing data is preserved unless you drop a column.
