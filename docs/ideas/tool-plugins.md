# Tool Plugins — Extending agent-mcp with Injectable Tools

## Current State

- Plugin system supports lifecycle hooks only: 11 hooks across orchestrator + stores
  - `task:start`, `pre:model_request`, `post:model_response`, `pre:tool_call`, `post:tool_call`,
    `message:appended`, `task:completed`, `task:failed`, `task:cancelled`,
    `session:created`, `agent:mutated`
- Plugins are observational (`emit`) or enforcement (`enforce`) — they cannot register tools
- Custom MCP tools must be run as external MCP server processes (stdio/http/sse clients)
- Example: `@adhd/agent-mcp-budget` enforces budgets via `pre:model_request` enforcement hook

### Existing plugin architecture

Plugins are loaded at server startup by `loadExternalPlugins()` in `loader.ts`. Each plugin
exports a `createPlugin(ctx: PluginContext): Plugin` factory. The `Plugin` interface has
a single method: `install(hooks: IHookRegistry): void`. There is no mechanism for a plugin
to contribute tool definitions — tools are hardcoded in `server.ts` in the
`ListToolsRequestSchema` and `CallToolRequestSchema` handlers, with a parallel
`inProcessDescriptors` array for recursive self-calls.

The `McpClientRegistry` in `registry.ts` maintains the complete tool set for each task.
It merges tools from external MCP client connections (stdio/http/sse) and from the
`InProcessMcpClient` (self-referential agent-mcp calls). This is the natural integration
point for plugin-contributed tools.

## The Gap

External MCP servers have overhead:

- Separate process per tool set (memory, startup latency)
- Stdio/http transport (serialization, error handling)
- No access to agent-mcp's internal state (DB, stores, in-memory caches)
- No shared schema validation with agent-mcp's existing Zod schemas
- Custom filesystem/shell MCP servers (`@modelcontextprotocol/server-filesystem`,
  `scripts/mcp-shell-restricted.mjs`) are simple wrappers that could be in-process plugins

A tool plugin would let a package register MCP tools directly into the agent's
toolchain without spawning a child process, with full access to agent-mcp's internal
stores and database.

## Proposed: ToolPlugin Interface

```typescript
interface ToolPlugin {
  name: string;
  version: string;
  /** Called once per agent session to register tools. Receives shared context. */
  registerTools(ctx: ToolPluginContext): ToolDefinition[];
}

interface ToolPluginContext {
  db: Database;                     // same SQLite connection
  config: Record<string, unknown>;  // plugin-specific validated config
  agentDef: AgentDefinition;        // the agent being sessioned
  stores: {
    agents: AgentStore;
    sessions: SessionStore;
    tasks: TaskStore;
  };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema
  handler: (args: Record<string, unknown>, ctx: ToolPluginContext) => Promise<ToolResult>;
}
```

### Design rationale

The `ToolPlugin` interface mirrors the existing `Plugin` interface (both expose
`name` and `version`), but replaces `install(hooks)` with `registerTools(ctx)`.
This keeps the two plugin types orthogonal:

- A lifecycle plugin calls `hooks.register(event, handler)` to observe or enforce.
- A tool plugin returns an array of `ToolDefinition` objects that get merged into
  the agent's available tool set.

The `ToolPluginContext` provides the same `db` and `config` that `PluginContext`
provides, plus the full `agentDef` (so the tool can adapt its behavior to the
calling agent) and the three core stores.

The `handler` function on each `ToolDefinition` receives the tool's arguments and
the same `ToolPluginContext`, so it has full access to stores and DB at call time.
This contrasts with the `post:tool_call` lifecycle hook, which only receives the
tool's return value — a tool plugin's handler owns the full execution.

## How Tools Get Registered

```
agent-mcp server startup
  └── loadExternalPlugins() — existing, loads lifecycle plugins
  └── loadToolPlugins()     — NEW, loads tool plugins

session creation (agent())
  └── lifecycle plugins install hooks
  └── tool plugins register tool definitions
  └── McpClientRegistry merges tool definitions:
      in-process tools (server.ts handlers)
      + tool plugin tools (new)
      + MCP server tools (external stdio/http clients)
```

### Registration flow detail

At server startup, `loadToolPlugins()` follows the same discovery pattern as
`loadExternalPlugins()`: it reads the config file for a `toolPlugins` array,
resolves each module via the same `resolveSpecifier()` function, validates
config against the plugin's `configSchema`, and calls the factory.

At `agent()` call time (session creation), the orchestrator calls each loaded
tool plugin's `registerTools(ctx)` with the context for the new session. The
returned `ToolDefinition[]` arrays are collected and injected into the
`McpClientRegistry` alongside `inProcessDescriptors` and external MCP server
tools.

The registry's `listAllTools()` method already returns the union of all tools
from all sources — tool plugin tools flow through the same path.

### Tool dispatch

When the model calls a tool registered by a plugin, the `CallToolRequestSchema`
handler in `server.ts` must be able to route it. The simplest approach is to
maintain a `Map<string, (args: unknown) => Promise<unknown>>` of plugin tool
handlers alongside the `inProcessHandler` switch. The registry's `resolveToolName()`
would map the prefixed tool name to the plugin handler just as it maps to
external client calls today.

Alternatively, tool plugin handlers can be wrapped as lightweight
`InProcessMcpClient` instances and injected into the `McpClientRegistry` under
a synthetic server name (e.g. `__plugin_<name>__`). This reuses the existing
dispatch path without modifying the `CallToolRequestSchema` handler.

## Use Cases

| Plugin package | What it provides |
|---|---|
| `@adhd/tool-plugin-filesystem` | File operations via the agent-mcp process — no separate MCP server needed |
| `@adhd/tool-plugin-shell` | Restricted shell execution with access to agent-mcp's policy engine |
| `@adhd/tool-plugin-dispatch` | Dispatch DAG tools that read/write dag.json via `IDagClient` directly |
| `@adhd/tool-plugin-registry` | Query agent registry from within the tool runtime |
| `@adhd/tool-plugin-memory` | Read/write agent memory stores for persistent agent context |

### `@adhd/tool-plugin-filesystem`

Currently served by `@modelcontextprotocol/server-filesystem` as a separate MCP
server process. Moving it in-process eliminates the subprocess overhead and lets
the tool use agent-mcp's existing policy engine for path allowlisting.

### `@adhd/tool-plugin-dispatch`

A tool plugin for the dispatch ecosystem (`@adhd/dispatch-*` packages) that
registers tools like `dispatch_run`, `dispatch_status`, and `dispatch_graph`.
These need access to the `IDagClient` and task stores, which are only available
in-process.

## Distinction from Lifecycle Hooks

| | Lifecycle Plugin | Tool Plugin |
|---|---|---|
| What it does | Observes/enforces at hook points | Registers tools agents can call |
| When it runs | At specific orchestrator lifecycle events | When the agent calls the tool |
| Returns | `void` (or throws for enforcement) | `ToolResult` (structured response) |
| State access | Read-only (hooks context) | Full store access via context |
| Examples | budget, metrics, tracing | filesystem, shell, dispatch |

### Orthogonality in practice

A single plugin package can implement both interfaces. For example,
`@adhd/tool-plugin-dispatch` might register lifecycle hooks to track dispatch
execution timing (`task:start`, `task:completed`) while also registering the
dispatch DAG tools themselves via `registerTools()`. The factory function would
return both a `Plugin` (with `install()`) and a `ToolPlugin` (with `registerTools()`).

## Plugin Config (extends existing config format)

The existing `agent-mcp.config.json` gains a `toolPlugins` array alongside the
existing `plugins` array:

```json
{
  "plugins": [
    { "module": "@adhd/agent-mcp-budget", "config": { "maxTotalTokens": 50000 } }
  ],
  "toolPlugins": [
    { "module": "@adhd/tool-plugin-filesystem", "config": { "allowedDir": "/repo" } },
    { "module": "@adhd/tool-plugin-shell", "config": { "allowlist": ["npx", "node"] } }
  ]
}
```

Each entry follows the same schema as lifecycle plugin entries: `module` (npm
package or file path) and optional `config` (validated against the plugin's
`configSchema`). The `ADHD_AGENT_PLUGINS` env var is a shorthand that applies
only to lifecycle plugins; tool plugins require a config file entry because
they have no `toolPlugins` equivalent in the env var format.

## Implementation Sketch

### New functions in `loader.ts`

```typescript
// ToolPlugin discovery — mirrors loadExternalPlugins
async function loadToolPlugins(
  hooks: IHookRegistry,
  db: unknown,
  configFile: AgentMcpConfigFile
): Promise<ToolPlugin[]> { ... }

interface ToolPluginModule {
  default?: unknown;
  createToolPlugin?: unknown;
  configSchema?: SchemaLike;
}
```

The loader reads `configFile.toolPlugins`, resolves each module, validates
config, and calls the factory. Returned `ToolPlugin[]` are stored in the
`ServerDeps` and passed to the `Orchestrator` for session-scoped registration.

### Changes to `server.ts`

- `ServerDeps` gains a `toolPlugins: ToolPlugin[]` field
- `ListToolsRequestSchema` handler: after collecting `inProcessDescriptors`,
  calls `toolPlugins.flatMap(p => p.registerTools(ctx))` and includes the
  results in the tool list
- `CallToolRequestSchema` handler: a fallthrough after the `switch(name)`
  dispatches to plugin tool handlers

### Changes to `McpClientRegistry`

The registry already merges tools from all sources. Plugin-contributed tools
can enter as synthetic server entries:

```typescript
// In McpClientRegistry constructor or a new addPluginTools() method:
for (const plugin of toolPlugins) {
  const syntheticName = `__plugin_${plugin.name}`;
  const descriptors = plugin.registerTools(sessionCtx).map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    handler: t.handler,
  }));
  // Wraps each descriptor as a lightweight McpClient
  const client = new PluginToolMcpClient(descriptors, sessionCtx);
  this.clients.set(syntheticName, client);
}
```

## Relationship to Existing ROADMAP

This proposal keeps tools in the CORE/PLUGIN framework defined in ROADMAP.md.
External MCP servers remain the right choice for cross-language tooling (Python,
Go). Tool plugins are the right choice when the tool needs access to agent-mcp's
internal state or when process-per-tool overhead is unacceptable.

The scoring methodology from ROADMAP.md would evaluate tool plugins as:

| Dimension | Score | Rationale |
|---|---|---|
| Impact | 8 | Eliminates subprocess overhead for common tools |
| Ease | 7 | Reuses existing loader infrastructure |
| Safety | 6 | In-process tools share the server's failure domain |
| Necessity | 7 | Production deployments benefit from reduced latency |

BI Score estimate: **6.8** — PLUGIN territory. Tool plugins complement lifecycle
plugins as a second plugin interface within the same package ecosystem.

## Constraints for Implementation

1. Tool plugins use the same config discovery and validation as lifecycle plugins
   (`findConfigFile()`, `resolveSpecifier()`, `configSchema`)
2. A broken tool plugin (bad config, unresolvable module, factory error) is logged
   and skipped — never prevents server startup (same contract as lifecycle plugins)
3. Tool definitions from plugins are prefixed with a synthetic server name just
   like external MCP tools, avoiding name collisions with built-in tools
4. `ToolPluginContext` provides `db`, `config`, `agentDef`, and `stores` — it does
   NOT expose the `IHookRegistry` or the orchestrator internals
5. Tool plugin handlers run within the task's abort signal scope (cancellation
   propagates to in-flight plugin tool calls)
6. The existing `Plugin` interface is unchanged — tool plugins are a separate
   interface, not an extension of the lifecycle plugin
