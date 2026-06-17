# agent-mcp Plugin Authoring Guide

Plugins are the intended extension point for `@adhd/agent-mcp`. They consume
lifecycle hooks emitted by the orchestrator and stores, adding observability,
enforcement, or side-effects without touching the core. A plugin that throws is
never fatal — the `HookRegistry` swallows errors and logs them so a buggy plugin
can never kill a running task.

---

## Conventions at a glance

| Concern | Standard |
|---------|----------|
| **npm package name** | `@adhd/agent-mcp-<name>` |
| **Nx project name** | `agent-mcp-<name>` |
| **Directory** | `packages/ai/agent-mcp-<name>/` |
| **Nx tags** | `layer:logic`, `platform:node` |
| **Peer dependency** | `@adhd/agent-mcp-types` — shared types **and** the concrete `HookRegistry` class |
| **Runtime dependency** | `@adhd/agent-mcp` is NOT a dependency — plugins depend only on `@adhd/agent-mcp-types` |
| **Error contract** | Every handler must be wrapped in `try/catch` — never throw |

Examples: `@adhd/agent-mcp-metrics`, `@adhd/agent-mcp-budget`,
`@adhd/agent-mcp-retry`, `@adhd/agent-mcp-webhooks`.

---

## End-to-end: build and activate a plugin

This is the full workflow from zero to a loaded plugin.

### 1. Scaffold

```bash
scripts/generate-lib.sh lib agent-mcp-<name> logic node
```

The script detects the `agent-mcp-` prefix and routes to `packages/ai/` automatically,
matching the convention of `@adhd/agent-mcp-budget`. Verify the output:

Verify `packages/ai/agent-mcp-<name>/project.json` contains:

```json
{ "tags": ["layer:logic", "platform:node"] }
```

Update `packages/ai/agent-mcp-<name>/package.json`:

```json
{
  "name": "@adhd/agent-mcp-<name>",
  "peerDependencies": {
    "@adhd/agent-mcp-types": "*"
  }
}
```

`@adhd/agent-mcp-types` is a `peerDependency` — the host server provides it.
Never add `@adhd/agent-mcp` as a dependency; plugins must not import from the
server package.

### 2. Write the plugin

`packages/ai/agent-mcp-<name>/src/index.ts` — the complete skeleton:

```ts
import { z } from "zod";
import type { IHookRegistry, Plugin, PluginContext, PluginFactory } from "@adhd/agent-mcp-types";

// ── Config schema (optional) ──────────────────────────────────────────────────
// Export this so the server validates the 'config' block in agent-mcp.config.json
// before calling the factory. Zod defaults (.default()) are applied; validation
// failure skips the plugin and logs a structured error. Omit if no options needed.
export const configSchema = z.object({
    threshold: z.number().positive().default(100),
    label:     z.string().optional(),
});

type Config = z.infer<typeof configSchema>;

// ── Plugin implementation ─────────────────────────────────────────────────────

class MyPlugin implements Plugin {
    readonly name = "my-plugin";

    constructor(private readonly config: Config) {}

    install(hooks: IHookRegistry): void {
        hooks.register("task:completed", (payload) => {
            try {
                // your logic here
            } catch (err) {
                // [inv:plugin-no-throw] — never let errors escape
            }
        });
    }
}

// ── Factory (required for external loading) ───────────────────────────────────
// The server calls this once at startup. ctx.config is the validated result of
// configSchema.safeParse() — safe to cast to Config.

const createPlugin: PluginFactory = ({ db, config }: PluginContext): Plugin => {
    return new MyPlugin(config as Config);
};

export default createPlugin;
export { createPlugin }; // named export fallback
```

**`PluginContext`** (from `@adhd/agent-mcp-types`):

```ts
interface PluginContext {
  db:     unknown;                  // SQLite handle — cast to BetterSQLite3Database<any> if needed
  config: Record<string, unknown>;  // validated config block, or {} if none declared
}
```

### 3. Build

```bash
npx nx build agent-mcp-<name>
```

Output lands at:
```
dist/packages/ai/agent-mcp-<name>/src/index.js
```

### 4. Configure

Create `agent-mcp.config.json` at the **monorepo root** (same directory as
`.mcp.json`). The server's CWD when launched by Claude Code is the project root,
so this file is found automatically — no env var required.

```json
{
  "plugins": [
    {
      "module": "/Users/nix/dev/node/adhd/dist/packages/ai/agent-mcp-<name>/src/index.js",
      "config": { "threshold": 50, "label": "my-env" }
    }
  ]
}
```

Use the absolute path to the compiled `dist/` file.

### 5. Activate

Reload the MCP connection in Claude Code:

```
/mcp
```

The server restarts and logs:

```json
{"level":30,"configPath":"…/agent-mcp.config.json","pluginCount":1,"msg":"Loaded agent-mcp config file"}
{"level":30,"plugin":"my-plugin","specifier":"…/dist/…/index.js","msg":"External plugin installed"}
{"level":30,"transport":"stdio","msg":"MCP server started"}
```

If schema validation fails (e.g. wrong type in `config`), the log shows:

```json
{"level":50,"specifier":"…","issues":{"fieldErrors":{"threshold":["…"]}},"msg":"Plugin config failed schema validation — skipping."}
```

The server still starts — a broken plugin is never fatal.

---

## Hook reference

All 11 hooks and their payloads (types from `@adhd/agent-mcp-types`):

| Hook | Fires | Key payload fields |
|------|-------|--------------------|
| `task:start` | Before the first model call | `executionContext`, `messages`, `rootTaskId?` |
| `pre:model_request` | Before each provider call | `executionContext`, `messages`, `tools` |
| `post:model_response` | After each provider response | `executionContext`, `stopReason`, `toolCallCount`, `tokenUsage?` |
| `pre:tool_call` | Before each tool is dispatched (observational) | `executionContext`, `toolName`, `callId`, `toolInput` |
| `post:tool_call` | After each tool returns | `executionContext`, `toolName`, `callId`, `toolInput`, `result`, `isError` |
| `message:appended` | When any message is persisted to session history | `executionContext`, `message` |
| `task:completed` | On successful task completion | `executionContext`, `result` |
| `task:failed` | On unrecoverable failure | `executionContext`, `error` |
| `task:cancelled` | On cancellation | `executionContext` |
| `session:created` | After a new session row is inserted | `session` |
| `agent:mutated` | After an agent definition is updated or deleted | `agent`, `operation: "update" \| "delete"` |

> **`pre:tool_call` is observational in the current release.** Handlers are
> awaited but cannot block dispatch or modify arguments. Intercepting semantics
> are a planned Phase 2 addition.

---

## Error handling contract

`HookRegistry.emit()` catches every handler error, logs it at `warn` level, and
continues to the next handler. The registry catch is a safety net, not a
substitute — wrap your handler body in `try/catch` and log errors yourself so
failures are structured and attributable:

```ts
hooks.register("post:model_response", async (payload) => {
    try {
        await myDb.insert(payload);
    } catch (err) {
        myLogger.error({ err }, "my-plugin: post:model_response failed");
        // Do NOT rethrow
    }
});
```

---

## Config file discovery

The server searches for `agent-mcp.config.json` at startup (first match wins):

| Priority | Location | When to use |
|---|---|---|
| 1 | `AGENT_MCP_CONFIG=/abs/path/to/file.json` | Explicit override via env var in `.mcp.json` |
| 2 | `{cwd}/agent-mcp.config.json` | Project-local — **monorepo root for this project** |
| 3 | `~/.agent-mcp/config.json` | Global user config — active for every project |

A missing config file is silently ignored (no plugins, no error). An invalid
config file is logged as `error` and no config-file plugins load.

**`.mcp.json` stays clean** — it only needs `DATABASE_PATH` and credentials.
Plugins live in the config file:

```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/nix/dev/node/adhd/dist/packages/ai/agent-mcp/src/index.js"],
      "env": {
        "DATABASE_PATH": "/Users/nix/dev/node/adhd/packages/ai/agent-mcp/data/agents.db"
      }
    }
  }
}
```

Global plugins (active everywhere, e.g. a personal metrics plugin):

```json
// ~/.agent-mcp/config.json
{
  "plugins": [
    { "module": "/abs/path/to/dist/packages/ai/agent-mcp-metrics/src/index.js" }
  ]
}
```

### `AGENT_MCP_PLUGINS` env var (no-options shorthand)

For CI or simple activations where a config file is inconvenient:

```json
{ "env": { "AGENT_MCP_PLUGINS": "/abs/path/to/plugin.js,@scope/other-plugin" } }
```

Comma-separated specifiers, no per-plugin `config` block support. Config-file
entries always load first; env-var entries load after.

---

## Config schema enforcement

Export `configSchema` from your plugin module to have the server validate the
`config` block before calling your factory:

| Outcome | What happens |
|---|---|
| Schema passes | `ctx.config` contains the validated, coerced, defaulted result |
| Schema fails | Plugin skipped; structured error with field names logged; server continues |
| No `configSchema` exported | `ctx.config` contains the raw `config` block as-is |

The interface is duck-typed — your Zod version doesn't need to match the
server's. Any export named `configSchema` that has `.safeParse(input)` returning
`{ success, data | error }` works.

---

## Database access

Most plugins should be stateless or hold in-memory state (see
`UsagePlugin.accumulators`). If you need persistence:

- **Own your table.** Define a Drizzle schema inside the plugin package and
  receive `db` via `ctx.db`. Cast: `const handle = ctx.db as BetterSQLite3Database<any>`.
- **Never import from `agent-mcp` internals** (`src/db/schema.ts`, stores, etc.).
  Only `@adhd/agent-mcp-types` and your own package's deps are allowed imports.
- **Read-only over existing tables** (e.g. `@adhd/agent-mcp-metrics` reading
  `task_usage`): accept the handle as `BetterSQLite3Database<any>` — you don't
  own the schema, just query it.

---

## Testing

Unit-test plugins in isolation using a real `HookRegistry`:

```ts
// HookRegistry lives in @adhd/agent-mcp-types — no dependency on the server package needed
import { HookRegistry } from "@adhd/agent-mcp-types";

const hooks = new HookRegistry();
const plugin = new MyPlugin({ threshold: 50 });
await plugin.install(hooks);

// Drive the hook and assert side-effects
await hooks.emit("task:completed", { executionContext: makeCtx(), result: "done" });
expect(recorded).toContain("done");
```

Always test the error-safe invariant: emit a hook that causes your handler to
throw and assert the emit resolves (doesn't reject) — the registry swallows it.

---

## Internal plugins (inside `agent-mcp`)

`UsagePlugin` at `packages/ai/agent-mcp/src/plugins/usage-plugin.ts` is the
only legitimate internal plugin. It imports directly from the host's Drizzle
schema because it co-owns the `task_usage` table. It is **not a template** for
external plugins.

All new plugins — including first-party ones (`@adhd/agent-mcp-metrics`,
`@adhd/agent-mcp-budget`) — go in separate `packages/ai/agent-mcp-*/` packages
and load via the config file. The only reason to add something to `src/plugins/`
is if it requires a new DB table whose schema must live in `agent-mcp`'s
migrations.

---

## Checklist for a new plugin

- [ ] Scaffold: `scripts/generate-lib.sh lib agent-mcp-<name> logic node` (lands in `packages/ai/` automatically)
- [ ] `project.json` tags: `layer:logic`, `platform:node`
- [ ] `package.json` name: `@adhd/agent-mcp-<name>`, peer on `@adhd/agent-mcp-types`
- [ ] Plugin class implements `Plugin` (`name` + `install`)
- [ ] All handler bodies wrapped in `try/catch` — never throw
- [ ] `export const configSchema = z.object({ ... })` for any options
- [ ] `export default createPlugin` factory (and named `export { createPlugin }`)
- [ ] `npx nx build agent-mcp-<name>` — build passes
- [ ] Unit tests: happy path + error-safe (handler throws → emit still resolves)
- [ ] Added to `agent-mcp.config.json` with absolute dist path
- [ ] Reloaded MCP (`/mcp`) and confirmed `External plugin installed` in server log
- [ ] `CHANGELOG.md` entry in the plugin package
- [ ] Entry added to `ROADMAP.md` once shipped
