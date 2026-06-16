import type { ExecutionContext, Message, ToolDefinition, Session, AgentDefinition, TokenUsage } from "./domain.js";

export interface TaskStartPayload         { executionContext: ExecutionContext; messages: Message[]; rootTaskId?: string }
export interface PreModelRequestPayload   { executionContext: ExecutionContext; messages: Message[]; tools: ToolDefinition[] }
export interface PostModelResponsePayload { executionContext: ExecutionContext; stopReason: string; toolCallCount: number; tokenUsage?: TokenUsage }
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

/**
 * Context object passed to an external plugin factory at server startup.
 *
 * - `db`     — the live SQLite database handle; cast to `BetterSQLite3Database<any>`
 *              inside your plugin package if you need direct DB access.
 * - `config` — the validated plugin options from the `config` block in
 *              `agent-mcp.config.json`. If the plugin exports a `configSchema`,
 *              the server validates `config` against it before calling the factory
 *              (failures skip the plugin). Always an object — defaults to `{}` when
 *              the config block is omitted.
 */
export interface PluginContext {
  db: unknown;
  config: Record<string, unknown>;
}

/**
 * The shape external plugin packages must export as their `default` export
 * **or** as a named `createPlugin` export.
 *
 * Example (plugin package `src/index.ts`):
 * ```ts
 * import { z } from "zod";
 * import type { PluginContext, Plugin } from "@adhd/agent-mcp-types";
 *
 * export const configSchema = z.object({ maxUSD: z.number().positive() });
 *
 * export default function createPlugin({ db, config }: PluginContext): Plugin {
 *   return new MyPlugin(db, config as { maxUSD: number });
 * }
 * ```
 */
export type PluginFactory = (ctx: PluginContext) => Plugin | Promise<Plugin>;
