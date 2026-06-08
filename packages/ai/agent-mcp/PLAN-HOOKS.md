# Phase 1 Plan: `@adhd/agent-mcp-types` + Hooks Harness

Two deliverables shipped together because the hooks types must exist before the harness can import them.

---

## Deliverable 1 — `@adhd/agent-mcp-types`

A zero-runtime-dependency types package. No Zod, no SQLite, no MCP SDK. Safe to import from any plugin, client SDK, or future UI package.

### 1.1 Generate the library

```bash
./generate-lib.sh lib agent-mcp-types shared shared
```

Creates `packages/shared/agent-mcp-types/` with import path `@adhd/agent-mcp-types`.

Verify `project.json` tags are exactly:
```json
{ "tags": ["layer:shared", "platform:shared"] }
```

### 1.2 Files to create

#### `src/domain.ts`

Plain TypeScript interfaces — no Zod dependency. `ToolDefinition.description` is `string` (required) to match the existing definition in `providers/types.ts`.

```ts
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type TaskEventType =
  | "MODEL_REQUEST" | "MODEL_RESPONSE"
  | "TOOL_CALL" | "TOOL_RESULT"
  | "TASK_COMPLETED" | "TASK_FAILED" | "TASK_CANCELLED";

export interface Task {
  id: string;
  sessionId: string;
  parentTaskId?: string;
  recursionDepth: number;
  status: TaskStatus;
  prompt: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  type: TaskEventType;
  payload?: unknown;
  createdAt: string;
}

export type SessionStatus = "active" | "closed";

export interface Session {
  id: string;
  agentName: string;
  agentVersion: number;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  server: string;
  tool: string;
  arguments: unknown;
}

export interface ToolResult {
  toolCallId: string;
  result: unknown;
  isError: boolean;
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  createdAt: string;
}

export interface RetryConfig {
  retries: number;
  minTimeout: number;
  maxTimeout: number;
  factor: number;
}

export type ProviderConfig =
  | { type: "anthropic"; model: string; apiKeyEnv?: string; temperature?: number; maxTokens?: number; timeoutMs?: number; retryConfig?: RetryConfig }
  | { type: "openai";    model: string; apiKeyEnv?: string; baseURL?: string; temperature?: number; maxTokens?: number; timeoutMs?: number; retryConfig?: RetryConfig }
  | { type: "lmstudio";  model: string; apiKeyEnv?: string; baseURL?: string; temperature?: number; maxTokens?: number; timeoutMs?: number; retryConfig?: RetryConfig };

export type McpServerConfig =
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; timeoutMs?: number }
  | { transport: "http";  url: string; headers?: Record<string, string>; timeoutMs?: number }
  | { transport: "sse";   url: string; headers?: Record<string, string>; timeoutMs?: number };

export interface AgentPermissions {
  allowedAgents?: string[];
}

export interface AgentDefinition {
  name: string;
  description?: string;
  version: number;
  provider: ProviderConfig;
  systemPrompt: string;
  mcpServers: Record<string, McpServerConfig>;
  permissions: AgentPermissions;
  maxToolLoops?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionContext {
  taskId: string;
  sessionId: string;
  agentName: string;
  agentDefinition: AgentDefinition;
  callingAgentName?: string;
  parentTaskId?: string;
  recursionDepth: number;
  toolCallCount: number;
}

/**
 * Tool descriptor passed to the LLM. Name is encoded as `<server>__<tool>`.
 * description is required — matches the existing definition in providers/types.ts.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
```

#### `src/hooks.ts`

Phase 1 hooks are purely observational: handlers are awaited but errors are caught and logged rather than propagated. Intercepting semantics (`pre:tool_call` blocking, `pre:model_request` mutation) are deferred to Phase 2.

```ts
import type { ExecutionContext, Message, ToolDefinition, Session, AgentDefinition } from "./domain.js";

export interface TaskStartPayload         { executionContext: ExecutionContext; messages: Message[] }
export interface PreModelRequestPayload   { executionContext: ExecutionContext; messages: Message[]; tools: ToolDefinition[] }
export interface PostModelResponsePayload { executionContext: ExecutionContext; stopReason: string; toolCallCount: number }
export interface PreToolCallPayload       { executionContext: ExecutionContext; toolName: string; callId: string; toolInput: unknown }
export interface PostToolCallPayload      { executionContext: ExecutionContext; toolName: string; callId: string; toolInput: unknown; result: unknown; isError: boolean }
export interface MessageAppendedPayload   { executionContext: ExecutionContext; message: Message }
export interface TaskCompletedPayload     { executionContext: ExecutionContext; result: string }
export interface TaskFailedPayload        { executionContext: ExecutionContext; error: string }
export interface TaskCancelledPayload     { executionContext: ExecutionContext }
export interface SessionCreatedPayload    { session: Session }
export interface AgentMutatedPayload      { agent: AgentDefinition; operation: "update" | "delete" }

export interface HookEventMap {
  "task:start":           TaskStartPayload;
  "pre:model_request":    PreModelRequestPayload;
  "post:model_response":  PostModelResponsePayload;
  "pre:tool_call":        PreToolCallPayload;
  "post:tool_call":       PostToolCallPayload;
  "message:appended":     MessageAppendedPayload;
  "task:completed":       TaskCompletedPayload;
  "task:failed":          TaskFailedPayload;
  "task:cancelled":       TaskCancelledPayload;
  "session:created":      SessionCreatedPayload;
  "agent:mutated":        AgentMutatedPayload;
}

export type HookEvent = keyof HookEventMap;
export type HookHandler<E extends HookEvent> = (payload: HookEventMap[E]) => void | Promise<void>;

export interface IHookRegistry {
  register<E extends HookEvent>(event: E, handler: HookHandler<E>): void;
  emit<E extends HookEvent>(event: E, payload: HookEventMap[E]): Promise<void>;
}

export interface Plugin {
  name: string;
  install(hooks: IHookRegistry): void | Promise<void>;
}
```

#### `src/errors.ts`

Includes `VALIDATION_ERROR` to match the existing `errorCodeSchema` in `agent-mcp`.

```ts
export type AgentMcpErrorCode =
  | "AGENT_NOT_FOUND"
  | "AGENT_ALREADY_EXISTS"
  | "AGENT_HAS_ACTIVE_SESSIONS"
  | "SESSION_NOT_FOUND"
  | "SESSION_CLOSED"
  | "TASK_NOT_FOUND"
  | "TASK_NOT_CANCELLABLE"
  | "DELEGATION_NOT_ALLOWED"
  | "MAX_DEPTH_EXCEEDED"
  | "MAX_TOOL_LOOPS_EXCEEDED"
  | "PROVIDER_ERROR"
  | "MCP_CLIENT_ERROR"
  | "VALIDATION_ERROR";
```

#### `src/index.ts`

```ts
export * from "./domain.js";
export * from "./hooks.js";
export * from "./errors.js";
```

### 1.3 `package.json` for the generated library

Verify/update after generation:
- `"name": "@adhd/agent-mcp-types"`
- `"dependencies": {}` — must stay empty (zero runtime deps)
- `"peerDependencies": {}` — none

---

## Deliverable 2 — Hooks Harness in `@adhd/agent-mcp`

### 2.1 Add dependency

`packages/ai/agent-mcp/package.json`:

```json
"dependencies": {
  "@adhd/agent-mcp-types": "*",
  ...existing...
}
```

`"*"` is correct for monorepo workspace packages — Nx resolves via `tsconfig.base.json` paths.

### 2.2 Migrate `validation/` imports

Each file keeps its Zod schemas for runtime parsing. `z.infer<>` aliases are replaced with re-exports from `@adhd/agent-mcp-types`.

#### `validation/task.ts`
```diff
-export type TaskStatus = z.infer<typeof taskStatusSchema>;
-export type Task = z.infer<typeof taskSchema>;
-export type TaskEventType = z.infer<typeof taskEventTypeSchema>;
-export type TaskEvent = z.infer<typeof taskEventSchema>;
+export type { TaskStatus, Task, TaskEventType, TaskEvent } from "@adhd/agent-mcp-types";
```
Keep: all Zod schemas, `TaskToolInput`, `TaskToolOutput`, `TaskListInput`, `TaskCancelInput`, `ResultInput`.

#### `validation/session.ts`
```diff
-export type SessionStatus = z.infer<typeof sessionStatusSchema>;
-export type Session = z.infer<typeof sessionSchema>;
+export type { SessionStatus, Session } from "@adhd/agent-mcp-types";
```
Keep: all Zod schemas, all tool input/output types.

#### `validation/message.ts`
```diff
-export type MessageRole = z.infer<typeof messageRoleSchema>;
-export type ToolCall = z.infer<typeof toolCallSchema>;
-export type ToolResult = z.infer<typeof toolResultSchema>;
-export type Message = z.infer<typeof messageSchema>;
+export type { MessageRole, ToolCall, ToolResult, Message } from "@adhd/agent-mcp-types";
```
Keep: all Zod schemas.

#### `validation/agent.ts`
```diff
-export type ProviderConfig = z.infer<typeof providerConfigSchema>;
-export type AgentPermissions = z.infer<typeof agentPermissionsSchema>;
-export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
+export type { ProviderConfig, AgentPermissions, AgentDefinition } from "@adhd/agent-mcp-types";
```
Keep: all Zod schemas, `AgentCreateInput`, `AgentUpdateInput`, `AgentReadInput`, `AgentDeleteInput`.

#### `validation/mcp.ts`
```diff
-export type McpStdioConfig = z.infer<typeof mcpStdioConfigSchema>;
-export type McpHttpConfig = z.infer<typeof mcpHttpConfigSchema>;
-export type McpSseConfig = z.infer<typeof mcpSseConfigSchema>;
-export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
+export type { McpServerConfig } from "@adhd/agent-mcp-types";
```
`McpStdioConfig` / `McpHttpConfig` / `McpSseConfig` are internal only — keep as `z.infer<>` if still referenced internally, otherwise remove.

#### `validation/execution.ts`
```diff
-export type ExecutionContext = z.infer<typeof executionContextSchema>;
+export type { ExecutionContext } from "@adhd/agent-mcp-types";
```
Keep: `executionContextSchema` (used in tests).

#### `validation/errors.ts`
```diff
-export type ErrorCode = z.infer<typeof errorCodeSchema>;
+export type { AgentMcpErrorCode } from "@adhd/agent-mcp-types";
+export type ErrorCode = AgentMcpErrorCode; // alias kept for existing internal usages
```
Keep: `errorCodeSchema` (Zod, for runtime validation), `ToolError` class. Update `ToolError.code` type from `ErrorCode` to `AgentMcpErrorCode` (the alias makes this transparent).

#### `validation/index.ts`
No change — `export *` re-exports flow through automatically.

### 2.3 Migrate `providers/types.ts`

`ToolDefinition` is already defined here. Replace the local definition with a re-export from the types package, removing the duplicate:

```diff
+import type { ToolDefinition } from "@adhd/agent-mcp-types";
+export type { ToolDefinition };
-export interface ToolDefinition {
-    name: string;
-    description: string;
-    inputSchema: Record<string, unknown>;
-}
```

`ProviderChatRequest`, `ProviderChatResponse`, and `LLMProvider` remain in this file — they are implementation-internal and reference `Message` which is now imported from `@adhd/agent-mcp-types` via `validation/index.ts`.

### 2.4 Create `src/engine/hooks.ts`

Observational-only in Phase 1: handler errors are caught and logged; they never propagate to the orchestrator. This prevents a buggy plugin from killing tasks.

```ts
import type { HookEvent, HookEventMap, HookHandler, IHookRegistry } from "@adhd/agent-mcp-types";
import { logger } from "../logger.js";

export class HookRegistry implements IHookRegistry {
  private readonly handlers = new Map<HookEvent, HookHandler<HookEvent>[]>();

  register<E extends HookEvent>(event: E, handler: HookHandler<E>): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as HookHandler<HookEvent>);
    this.handlers.set(event, list);
  }

  async emit<E extends HookEvent>(event: E, payload: HookEventMap[E]): Promise<void> {
    const list = this.handlers.get(event);
    if (!list?.length) return;
    for (const handler of list) {
      try {
        await (handler as HookHandler<E>)(payload);
      } catch (err) {
        // Phase 1: all hooks are observational. Errors are logged and swallowed so a
        // buggy plugin never kills a task. Intercepting semantics (pre:tool_call blocking,
        // pre:model_request mutation) are Phase 2.
        logger.warn({ event, err }, "hook handler error (swallowed)");
      }
    }
  }
}
```

### 2.5 Update `src/engine/orchestrator.ts`

Add `hooks: IHookRegistry` to `OrchestratorRunInput`. Insert emit calls at the 9 points below. All are fire-and-await; errors are already swallowed inside `HookRegistry.emit()`.

| Location in current file | Event | Key payload fields |
|--------------------------|-------|--------------------|
| After `updateStatus(taskId, "running")` (line 47) | `task:start` | `executionContext`, `messages` |
| Before `provider.chat(...)` (line 90) | `pre:model_request` | `executionContext`, `messages`, `tools` |
| After assistant message pushed to `currentMessages` (line 122) | `post:model_response` | `executionContext`, `stopReason`, `toolCallCount` |
| Same point | `message:appended` | `executionContext`, `message: assistantMessage` |
| Before `policy.check(...)` (line 162) | `pre:tool_call` | `executionContext`, `toolName: qualifiedToolName`, `callId`, `toolInput: toolCall.arguments` |
| After `toolResult` captured (line ~221) | `post:tool_call` | `executionContext`, `toolName`, `callId`, `toolInput`, `result: toolResult`, `isError` |
| After `toolResultMessage` pushed to `currentMessages` (line 259) | `message:appended` | `executionContext`, `message: toolResultMessage` |
| Before `return { result }` (line 284) | `task:completed` | `executionContext`, `result: finalContent` |
| In cancelled branch (line ~295) | `task:cancelled` | `executionContext` |
| In failed branch (line ~304) | `task:failed` | `executionContext`, `error: errorMessage` |

`pre:tool_call` is observational in Phase 1 — it fires but cannot block. No changes to the fatal codes list are needed.

### 2.6 Update `src/store/session-store.ts`

```ts
constructor(private db: ..., private hooks?: IHookRegistry) {}

// After the INSERT that creates a new session row, fire-and-forget:
void this.hooks?.emit("session:created", { session });
```

`session:created` is observational. Fire-and-forget (`void`) avoids making the method async when it doesn't need to be.

### 2.7 Update `src/store/agent-store.ts`

All `AgentStore` methods are currently synchronous. Adding `await` would cascade async through all call sites. Since `agent:mutated` is observational, fire-and-forget is correct.

```ts
constructor(private db: ..., private hooks?: IHookRegistry) {}

// End of update(), after the DB write, using the already-computed `updated` value:
void this.hooks?.emit("agent:mutated", { agent: updated, operation: "update" });

// In delete(), read the definition BEFORE the DELETE executes, then fire after:
const definition = this.read(name); // existing read path, throws AGENT_NOT_FOUND if missing
// ... existing active-session check and DELETE ...
void this.hooks?.emit("agent:mutated", { agent: definition, operation: "delete" });
```

Note: `this.read(name)` is already called implicitly in `update()` — in `delete()` it is a new call added before the SQL DELETE.

### 2.8 Wire in `src/index.ts`

```ts
import { HookRegistry } from "./engine/hooks.js";

const hooks = new HookRegistry();

const agentStore   = new AgentStore(db, hooks);
const sessionStore = new SessionStore(db, hooks);
// hooks is passed into each orchestrator.run() call via TaskDeps (see 2.9)
```

### 2.9 Update `src/tools/task.ts`

Add `hooks: IHookRegistry` to `TaskDeps`. Pass it into `OrchestratorRunInput` in both the session-mode path and `runEphemeralTask`.

---

## New Test: `src/__tests__/hooks.test.ts`

```ts
describe("HookRegistry", () => {
  it("calls a registered handler with the emitted payload")
  it("is a no-op when no handlers are registered for the event")
  it("awaits async handlers before returning")
  it("calls multiple handlers for the same event in registration order")
  it("swallows handler errors and continues to the next handler")
  it("swallowed error does not throw from emit()")
})
```

---

## Build & Verify Sequence

```bash
# 1. Build types package first — agent-mcp depends on it
npx nx build agent-mcp-types

# 2. Build agent-mcp — catches import migration errors and type mismatches
npx nx build agent-mcp

# 3. Run full test suite — all existing tests must pass, new hooks tests must pass
npx nx test agent-mcp

# 4. Lint both packages
npx nx lint agent-mcp-types
npx nx lint agent-mcp
```

---

## Out of scope for Phase 1

- Plugin loading mechanism (`AGENT_MCP_PLUGINS` env var or `src/plugins/`)
- Any concrete plugin implementation (`budget.ts`, `retry.ts`, etc.)
- Intercepting hook semantics: `pre:tool_call` blocking (`TOOL_BLOCKED` error code) and `pre:model_request` message mutation
- Exposing `IHookRegistry` / `Plugin` via the MCP tool surface
