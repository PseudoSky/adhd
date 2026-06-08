import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type http from "node:http";

import { logger } from "./logger.js";
import type { AgentStore } from "./store/agent-store.js";
import type { SessionStore } from "./store/session-store.js";
import type { TaskStore } from "./store/task-store.js";
import { BackgroundQueue } from "./engine/queue.js";
import { Orchestrator } from "./engine/orchestrator.js";
import type { PolicyEngine } from "./engine/policy.js";
import type { InProcessToolDescriptor, InProcessToolHandler } from "./clients/in-process.js";
import type { IHookRegistry } from "@adhd/agent-mcp-types";

import {
    agentCreate,
    agentRead,
    agentUpdate,
    agentDelete,
    agentList,
} from "./tools/agent-crud.js";
import { agentTool, sessionList, sessionClose, sessionClear } from "./tools/session.js";
import { taskTool, taskList, taskCancel, resultTool } from "./tools/task.js";
import { ToolError } from "./validation/errors.js";
import {
    agentCreateInputSchema,
    agentReadInputSchema,
    agentUpdateInputSchema,
    agentDeleteInputSchema,
    agentToolInputSchema,
    sessionListInputSchema,
    sessionCloseInputSchema,
    sessionClearInputSchema,
    taskToolInputSchema,
    taskListInputSchema,
    taskCancelInputSchema,
    resultInputSchema,
} from "./validation/index.js";

export interface ServerDeps {
    agentStore: AgentStore;
    sessionStore: SessionStore;
    taskStore: TaskStore;
    queue: BackgroundQueue;
    policy: PolicyEngine;
    orchestrator: Orchestrator;
    hooks: IHookRegistry;
    selfUrl?: string;
}

function toMcpErrorContent(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
    let message: string;
    if (error instanceof ToolError) {
        message = `[${error.code}] ${error.message}`;
    } else if (error instanceof Error) {
        message = error.message;
    } else {
        message = String(error);
    }

    return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
    };
}

function toMcpContent(value: unknown): { content: Array<{ type: "text"; text: string }> } {
    return {
        content: [
            {
                type: "text" as const,
                text: JSON.stringify(value, null, 2),
            },
        ],
    };
}

/**
 * Converts a Zod schema to an MCP-compliant inputSchema object.
 *
 * The MCP spec requires every tool's inputSchema to have `type: "object"` at
 * the top level. Zod's union schemas (z.union / z.discriminatedUnion) produce
 * `anyOf: [...]` without a root `type`, which fails MCP SDK validation and
 * causes clients like LM Studio to reject the tool list with an
 * `invalid_literal` error on `inputSchema.type`.
 *
 * This helper normalises the output: for union schemas it merges all object
 * variant properties into a single flat object schema so every MCP client
 * (including LM Studio) accepts the tool list.
 */
function toMcpInputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;

    // Plain object schema — strip the JSON Schema $schema declaration that some
    // clients reject and return the rest as-is.
    if (jsonSchema["type"] === "object") {
        const { $schema: _drop, ...rest } = jsonSchema;
        return rest;
    }

    // Union schema (z.union / z.discriminatedUnion) — merge every object
    // variant's properties into one flat object schema so MCP is happy.
    const variants =
        (jsonSchema["anyOf"] as Record<string, unknown>[] | undefined) ??
        (jsonSchema["oneOf"] as Record<string, unknown>[] | undefined);

    if (variants) {
        const mergedProperties: Record<string, unknown> = {};
        for (const variant of variants) {
            const props = variant["properties"];
            if (props && typeof props === "object" && !Array.isArray(props)) {
                Object.assign(mergedProperties, props as Record<string, unknown>);
            }
        }
        return { type: "object", properties: mergedProperties };
    }

    // Fallback: return an empty object schema.
    return { type: "object", properties: {} };
}

const USAGE_GUIDE = `
# agent-mcp Usage Guide

This server lets you create persistent AI agents, open sessions with them, and
run tasks — including having agents delegate work to other agents recursively.

---

## Core concepts

- **Agent definition** — a stored blueprint: provider, model, system prompt, MCP
  tools, and delegation permissions. Created once with \`agent_create\`.
- **Session** — a stateful conversation thread tied to one agent definition. The
  agent snapshot is taken at session creation, so updating the definition later
  does not affect open sessions.
- **Task** — a single prompt sent to a session. Can run synchronously (wait for
  the result) or in the background (poll with \`result\`).

---

## Workflow 0 — One-shot (ephemeral): no session needed

Use \`agent_name\` instead of \`session_id\` when you want a single answer with no
persistent context. The agent definition is loaded from the DB, the orchestrator
runs with a fresh in-memory message list, and nothing is written to the DB beyond
the agent read. Always synchronous.

\`\`\`
1. agent_create  { name, provider, systemPrompt, ... }
2. task          { agent_name, prompt }      → { task_id, status, result }
\`\`\`

Example:

\`\`\`jsonc
task({ "agent_name": "assistant", "prompt": "What is 2 + 2?" })
// → { "task_id": "t-ephemeral-uuid", "status": "completed", "result": "4" }
\`\`\`

The \`task_id\` in the response is a generated UUID that is **not** stored in the DB —
it cannot be passed to \`result\` or \`task_cancel\`.

---

## Workflow 1 — Basic: ask an agent a question

\`\`\`
1. agent_create   { name, provider, systemPrompt, mcpServers, permissions }
2. agent          { name }                   → { session_id }
3. task           { session_id, prompt,
                    background: false }       → { task_id, status, result }
\`\`\`

Example calls:

\`\`\`jsonc
// Step 1 — create the agent (once; skip if already exists)
agent_create({
  "name": "assistant",
  "systemPrompt": "You are a concise assistant.",
  "provider": {
    "type": "openai",
    "model": "gpt-4o-mini"
  },
  "mcpServers": {},
  "permissions": {}
})

// Step 2 — open a session
agent({ "name": "assistant" })
// → { "session_id": "abc-123" }

// Step 3 — run a prompt synchronously
task({ "session_id": "abc-123", "prompt": "What is 2 + 2?", "background": false })
// → { "task_id": "t-456", "status": "completed", "result": "4" }
\`\`\`

The session is persistent — call \`task\` again on the same \`session_id\` to
continue the conversation with full history.

---

## Workflow 2 — Background task with polling

Use \`background: true\` for long-running tasks so this call returns immediately.

\`\`\`
1. task   { session_id, prompt, background: true }  → { task_id, status: "pending" }
2. result { task_id }                               → { status: "running"|"completed"|"failed" }
   (repeat step 2 until status is terminal)
\`\`\`

Example:

\`\`\`jsonc
task({ "session_id": "abc-123", "prompt": "Write a 500-word essay on recursion.", "background": true })
// → { "task_id": "t-789", "status": "pending" }

result({ "task_id": "t-789" })
// → { "status": "running", ... }   ← not done yet, poll again

result({ "task_id": "t-789" })
// → { "status": "completed", "result": "Recursion is ..." }
\`\`\`

---

## Workflow 3 — Agent delegation (agents calling agents)

An agent can call another agent if:
  - Its \`mcpServers\` contains an \`"agent-mcp"\` entry pointing back at this server
  - The target agent is in its \`permissions.allowedAgents\` (or the list is omitted = unrestricted)

\`\`\`jsonc
// Create the sub-agent
agent_create({
  "name": "researcher",
  "systemPrompt": "You are a research specialist. Answer with citations.",
  "provider": { "type": "anthropic", "model": "claude-opus-4-5" },
  "mcpServers": {},
  "permissions": {}
})

// Create the orchestrator agent that can delegate to "researcher"
agent_create({
  "name": "orchestrator",
  "systemPrompt": "You coordinate tasks. Delegate research questions to the researcher agent.",
  "provider": { "type": "anthropic", "model": "claude-opus-4-5" },
  "mcpServers": {
    "agent-mcp": { "transport": "stdio", "command": "node",
                   "args": ["/path/to/dist/index.js"] }
  },
  "permissions": {
    "allowedAgents": ["researcher"]
  }
})

// Open a session for the orchestrator and run a task
agent({ "name": "orchestrator" })
// → { "session_id": "orch-session-id" }

task({
  "session_id": "orch-session-id",
  "prompt": "Research the history of the MCP protocol and summarise it.",
  "background": false
})
// The orchestrator will autonomously call agent("researcher") and task() internally.
\`\`\`

---

## Workflow 4 — Multi-turn conversation

Sessions preserve full message history. Call \`task\` repeatedly on the same
\`session_id\` to have a back-and-forth conversation.

\`\`\`jsonc
task({ "session_id": "abc-123", "prompt": "My name is Alice.",  "background": false })
// → { "result": "Nice to meet you, Alice!" }

task({ "session_id": "abc-123", "prompt": "What is my name?",   "background": false })
// → { "result": "Your name is Alice." }
\`\`\`

---

## Updating an agent definition

\`agent_update\` never affects open sessions. It bumps the version and only
applies to sessions opened after the update.

\`\`\`jsonc
agent_update({
  "name": "assistant",
  "patch": { "systemPrompt": "You are a terse assistant. Reply in one sentence." }
})
\`\`\`

---

## Cancelling a task

\`\`\`jsonc
task_cancel({ "task_id": "t-789" })
\`\`\`

Only works when status is \`"pending"\` or \`"running"\`.

---

## Clearing a session's context

\`session_clear\` deletes all messages from a session without closing it. The session
stays active and the next task starts with a blank slate. The system prompt is
part of the agent definition — it is never affected by \`session_clear\`.

\`\`\`jsonc
session_clear({ "session_id": "abc-123" })
// → { "session_id": "abc-123", "cleared": 12 }
\`\`\`

---

## Provider types

| type          | required fields | notes                                                                 |
|---------------|-----------------|-----------------------------------------------------------------------|
| \`openai\`      | model           | apiKeyEnv defaults to OPENAI_API_KEY                                  |
| \`anthropic\`   | model           | apiKeyEnv defaults to ANTHROPIC_API_KEY; \`useClaudeOauth: true\` reads OAuth token from macOS keychain (Claude Max / no API key needed) |
| \`lmstudio\`    | model, baseURL  | OpenAI-compatible local server                                        |
| \`claudecli\`   | —               | Drives local \`claude\` CLI via stream-json; uses Claude Code's auth; MCP tools work via --mcp-config; built-ins blocked by default (\`allowedBuiltinTools\` to opt in) |

\`openai\`, \`anthropic\`, and \`lmstudio\` accept: \`temperature\`, \`maxTokens\`, \`timeoutMs\`, \`retryConfig\`.
\`claudecli\` accepts: \`model\`, \`claudePath\`, \`timeoutMs\`, \`allowedBuiltinTools\`.

---

## Common errors

| error code              | meaning                                               |
|-------------------------|-------------------------------------------------------|
| AGENT_NOT_FOUND         | Call \`agent_create\` first                            |
| AGENT_ALREADY_EXISTS    | Agent name already taken; use \`agent_update\` instead |
| SESSION_NOT_FOUND       | Invalid or expired session_id                         |
| SESSION_CLOSED          | Session was closed; open a new one with \`agent\`      |
| TASK_NOT_FOUND          | Invalid task_id                                       |
| TASK_NOT_CANCELLABLE    | Task already completed, failed, or cancelled           |
| MAX_DEPTH_EXCEEDED      | Delegation chain too deep (server limit: MAX_DEPTH)   |
| MAX_TOOL_LOOPS_EXCEEDED | Agent used too many tool calls in one task            |
| DELEGATION_NOT_ALLOWED  | Target agent not in caller's allowedAgents list       |
`.trim();

export function createServer(deps: ServerDeps): Server {
    const server = new Server(
        { name: "agent-mcp", version: "1.0.0" },
        { capabilities: { tools: {} } }
    );

    // ── Tool descriptors for in-process recursive calls ──────────────────
    // These describe the MCP tools that an agent can call via the
    // "agent-mcp" self-referential server entry.
    const inProcessDescriptors: InProcessToolDescriptor[] = [
        {
            name: "agent",
            description: "Instantiate a session for a named agent",
            inputSchema: toMcpInputSchema(agentToolInputSchema),
        },
        {
            name: "task",
            description: "Run a prompt against a session",
            inputSchema: toMcpInputSchema(taskToolInputSchema),
        },
        {
            name: "result",
            description: "Get the result of a task",
            inputSchema: toMcpInputSchema(resultInputSchema),
        },
        {
            name: "task_list",
            description: "List tasks",
            inputSchema: toMcpInputSchema(taskListInputSchema),
        },
        {
            name: "task_cancel",
            description: "Cancel a running task",
            inputSchema: toMcpInputSchema(taskCancelInputSchema),
        },
        {
            name: "session_list",
            description: "List sessions",
            inputSchema: toMcpInputSchema(sessionListInputSchema),
        },
        {
            name: "session_close",
            description: "Close a session",
            inputSchema: toMcpInputSchema(sessionCloseInputSchema),
        },
        {
            name: "session_clear",
            description: "Clear all messages from a session's context without closing it",
            inputSchema: toMcpInputSchema(sessionClearInputSchema),
        },
    ];

    // In-process handler that routes tool calls to the local handlers
    const inProcessHandler: InProcessToolHandler = async (toolName, args, ctx) => {
        switch (toolName) {
            case "agent":
                return agentTool(
                    agentToolInputSchema.parse(args),
                    { agentStore: deps.agentStore, sessionStore: deps.sessionStore, policy: deps.policy },
                    ctx
                );
            case "task":
                return taskTool(
                    taskToolInputSchema.parse(args),
                    {
                        agentStore: deps.agentStore,
                        sessionStore: deps.sessionStore,
                        taskStore: deps.taskStore,
                        orchestrator: deps.orchestrator,
                        queue: deps.queue,
                        policy: deps.policy,
                        hooks: deps.hooks,
                        selfUrl: deps.selfUrl,
                        inProcessDescriptors,
                        inProcessHandler,
                    },
                    ctx
                );
            case "result":
                return resultTool(resultInputSchema.parse(args), { taskStore: deps.taskStore });
            case "task_list":
                return taskList(taskListInputSchema.parse(args), { taskStore: deps.taskStore });
            case "task_cancel":
                return taskCancel(taskCancelInputSchema.parse(args), { taskStore: deps.taskStore });
            case "session_list":
                return sessionList(sessionListInputSchema.parse(args), {
                    agentStore: deps.agentStore,
                    sessionStore: deps.sessionStore,
                    policy: deps.policy,
                });
            case "session_close":
                return sessionClose(sessionCloseInputSchema.parse(args), {
                    agentStore: deps.agentStore,
                    sessionStore: deps.sessionStore,
                    policy: deps.policy,
                });
            case "session_clear":
                return sessionClear(sessionClearInputSchema.parse(args), {
                    agentStore: deps.agentStore,
                    sessionStore: deps.sessionStore,
                    policy: deps.policy,
                });
            default:
                throw new ToolError("VALIDATION_ERROR", `Unknown in-process tool: ${toolName}`);
        }
    };

    // ── Tool list ─────────────────────────────────────────────────────────
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "agent_create",
                description: "Create a new stored agent definition",
                inputSchema: toMcpInputSchema(agentCreateInputSchema),
            },
            {
                name: "agent_read",
                description: "Read a stored agent definition by name",
                inputSchema: toMcpInputSchema(agentReadInputSchema),
            },
            {
                name: "agent_update",
                description: "Update a stored agent definition",
                inputSchema: toMcpInputSchema(agentUpdateInputSchema),
            },
            {
                name: "agent_delete",
                description: "Delete a stored agent definition",
                inputSchema: toMcpInputSchema(agentDeleteInputSchema),
            },
            {
                name: "agent_list",
                description: "List all stored agent definitions",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "agent",
                description: "Instantiate a stateful session for a named agent",
                inputSchema: toMcpInputSchema(agentToolInputSchema),
            },
            {
                name: "session_list",
                description: "List sessions",
                inputSchema: toMcpInputSchema(sessionListInputSchema),
            },
            {
                name: "session_close",
                description: "Close an active session",
                inputSchema: toMcpInputSchema(sessionCloseInputSchema),
            },
            {
                name: "session_clear",
                description: "Clear all messages from a session's context without closing it",
                inputSchema: toMcpInputSchema(sessionClearInputSchema),
            },
            {
                name: "task",
                description: "Run a prompt against a session's agent (session_id mode, sync or background) or run a one-shot ephemeral task with no persisted context (agent_name mode, always sync)",
                inputSchema: toMcpInputSchema(taskToolInputSchema),
            },
            {
                name: "task_list",
                description: "List tasks",
                inputSchema: toMcpInputSchema(taskListInputSchema),
            },
            {
                name: "task_cancel",
                description: "Cancel a running or pending task",
                inputSchema: toMcpInputSchema(taskCancelInputSchema),
            },
            {
                name: "result",
                description: "Get the current state and result of a task",
                inputSchema: toMcpInputSchema(resultInputSchema),
            },
            {
                name: "usage",
                description: "Returns a complete guide explaining how to use this server — call this first if you are unsure what to do",
                inputSchema: { type: "object", properties: {} },
            },
        ],
    }));

    // ── Tool dispatcher ───────────────────────────────────────────────────
    server.setRequestHandler(CallToolRequestSchema, async request => {
        const { name, arguments: args } = request.params;

        try {
            switch (name) {
                case "agent_create":
                    return toMcpContent(agentCreate(agentCreateInputSchema.parse(args), { agentStore: deps.agentStore }));

                case "agent_read":
                    return toMcpContent(agentRead(agentReadInputSchema.parse(args), { agentStore: deps.agentStore }));

                case "agent_update":
                    return toMcpContent(agentUpdate(agentUpdateInputSchema.parse(args), { agentStore: deps.agentStore }));

                case "agent_delete":
                    return toMcpContent(agentDelete(agentDeleteInputSchema.parse(args), { agentStore: deps.agentStore }));

                case "agent_list":
                    return toMcpContent(agentList(args, { agentStore: deps.agentStore }));

                case "agent":
                    return toMcpContent(
                        await agentTool(agentToolInputSchema.parse(args), {
                            agentStore: deps.agentStore,
                            sessionStore: deps.sessionStore,
                            policy: deps.policy,
                        })
                        // No executionContext — top-level call
                    );

                case "session_list":
                    return toMcpContent(
                        sessionList(sessionListInputSchema.parse(args), {
                            agentStore: deps.agentStore,
                            sessionStore: deps.sessionStore,
                            policy: deps.policy,
                        })
                    );

                case "session_close":
                    return toMcpContent(
                        sessionClose(sessionCloseInputSchema.parse(args), {
                            agentStore: deps.agentStore,
                            sessionStore: deps.sessionStore,
                            policy: deps.policy,
                        })
                    );

                case "session_clear":
                    return toMcpContent(
                        sessionClear(sessionClearInputSchema.parse(args), {
                            agentStore: deps.agentStore,
                            sessionStore: deps.sessionStore,
                            policy: deps.policy,
                        })
                    );

                case "task":
                    return toMcpContent(
                        await taskTool(taskToolInputSchema.parse(args), {
                            agentStore: deps.agentStore,
                            sessionStore: deps.sessionStore,
                            taskStore: deps.taskStore,
                            orchestrator: deps.orchestrator,
                            queue: deps.queue,
                            policy: deps.policy,
                            hooks: deps.hooks,
                            selfUrl: deps.selfUrl,
                            inProcessDescriptors,
                            inProcessHandler,
                        })
                        // No callerContext — top-level call
                    );

                case "task_list":
                    return toMcpContent(taskList(taskListInputSchema.parse(args), { taskStore: deps.taskStore }));

                case "task_cancel":
                    return toMcpContent(taskCancel(taskCancelInputSchema.parse(args), { taskStore: deps.taskStore }));

                case "result":
                    return toMcpContent(resultTool(resultInputSchema.parse(args), { taskStore: deps.taskStore }));

                case "usage":
                    return toMcpContent(USAGE_GUIDE);

                default:
                    return toMcpErrorContent(new ToolError("VALIDATION_ERROR", `Unknown tool: ${name}`));
            }
        } catch (error) {
            return toMcpErrorContent(error);
        }
    });

    return server;
}

export async function startServer(deps: ServerDeps): Promise<{
    close: () => Promise<void>;
    httpServer?: http.Server;
}> {
    const server = createServer(deps);
    const transport = process.env["TRANSPORT"] ?? "stdio";
    const port = parseInt(process.env["PORT"] ?? "3000", 10);

    if (transport === "stdio") {
        const stdioTransport = new StdioServerTransport();
        await server.connect(stdioTransport);

        logger.info({ transport: "stdio" }, "MCP server started");

        return {
            close: async () => {
                await server.close();
            },
        };
    }

    if (transport === "http") {
        // Dynamically import http to avoid requiring it in stdio mode
        const { createServer: createHttpServer } = await import("node:http");

        const httpTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
        });

        const httpServer = createHttpServer(async (req, res) => {
            await httpTransport.handleRequest(req, res);
        });

        await server.connect(httpTransport);

        await new Promise<void>((resolve, reject) => {
            httpServer.listen(port, () => {
                logger.info({ transport: "http", port }, "MCP server started");
                resolve();
            });
            httpServer.on("error", reject);
        });

        const selfUrl = `http://localhost:${port}`;
        deps.selfUrl = selfUrl;

        return {
            close: async () => {
                await server.close();
                await new Promise<void>((resolve, reject) => {
                    httpServer.close(err => (err ? reject(err) : resolve()));
                });
            },
            httpServer,
        };
    }

    // SSE transport
    if (transport === "sse") {
        // SSE transport requires a different setup; use StreamableHTTP as fallback for now
        // A proper SSE implementation would use express or a custom HTTP server
        logger.warn({ transport }, "SSE transport not fully implemented; falling back to stdio behavior");
        const stdioTransport = new StdioServerTransport();
        await server.connect(stdioTransport);

        return {
            close: async () => {
                await server.close();
            },
        };
    }

    throw new Error(`Unknown transport: ${transport}`);
}
