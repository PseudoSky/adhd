/**
 * Shared real-component harness for the tracing plugin's tests.
 *
 * Real: the engine `HookRegistry`, `Orchestrator.run()` (with TRACE-2's emit sites), a
 * better-sqlite3 `TaskStore` + `SessionStore`, `resolveHitl`, and a real `@adhd/sox-telemetry`
 * file sink on a throwaway directory. Scripted boundaries ONLY: the LLM provider and the MCP
 * tool registry.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '@adhd/agent-store-runtime';
import { SessionStore, TaskStore } from '@adhd/agent-store-runtime';
import { HookRegistry, Orchestrator } from '@adhd/agent-engine-orchestrator';
import type {
  EngineConfig,
  EngineLogger,
  LLMProvider,
  McpClientRegistry,
  OrchestratorRunInput,
  PolicyEngine,
  ProviderChatResponse,
  ToolDefinition,
} from '@adhd/agent-engine-orchestrator';
import type { AgentDefinition, ExecutionContext, IHookRegistry, Message, PermissionAction } from '@adhd/agent-base-types';
import { _resetTelemetryForTest } from '@adhd/sox-telemetry';
import type { Plugin } from '@adhd/agent-base-types';

export { HookRegistry, Orchestrator };

const DDL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL, agent_name TEXT NOT NULL, agent_version INTEGER NOT NULL,
  agent_data TEXT NOT NULL, status TEXT DEFAULT 'active' NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, closed_at TEXT, composed_prompt_id TEXT,
  provider_type TEXT, model_ref TEXT, models TEXT
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT, tool_calls TEXT, tool_results TEXT, created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL, session_id TEXT, parent_task_id TEXT,
  is_ephemeral INTEGER DEFAULT 0 NOT NULL, recursion_depth INTEGER DEFAULT 0 NOT NULL,
  status TEXT DEFAULT 'pending' NOT NULL, prompt TEXT NOT NULL, result TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, cancelled_at TEXT,
  depends_on TEXT, on_upstream_failure TEXT, inputs TEXT, resume_token TEXT
);
CREATE TABLE task_events (
  id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL
);
CREATE TABLE task_usage (
  task_id TEXT PRIMARY KEY NOT NULL, root_task_id TEXT, agent_name TEXT NOT NULL,
  provider_type TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER DEFAULT 0 NOT NULL,
  output_tokens INTEGER DEFAULT 0 NOT NULL, tool_call_count INTEGER DEFAULT 0 NOT NULL,
  model_calls INTEGER DEFAULT 0 NOT NULL, latency_ms INTEGER DEFAULT 0 NOT NULL,
  is_complete INTEGER DEFAULT 0 NOT NULL, stop_reason TEXT, max_tokens INTEGER,
  cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
  uncached_input_tokens INTEGER, reasoning_tokens INTEGER, peak_context_tokens INTEGER,
  peak_context_at INTEGER, compute_ms INTEGER, est_tool_result_tokens INTEGER,
  est_cost_usd REAL, created_at TEXT NOT NULL
);
`;

const silentLogger: EngineLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

/** A parsed JSONL record from the telemetry sink. */
export interface Recorded {
  event: string;
  level?: string;
  trace_id?: string | null;
  duration_ms?: number;
  [key: string]: unknown;
}

/** A throwaway telemetry log directory, removed by `dispose()`. */
export function makeLogDir(): { dir: string; dispose: () => void } {
  _resetTelemetryForTest();
  const dir = mkdtempSync(join(tmpdir(), 'agent-tracing-'));
  return {
    dir,
    dispose: () => {
      _resetTelemetryForTest();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Every record the plugin's telemetry handle has written so far. */
export function readRecords(path: string | null | undefined): Recorded[] {
  if (path === null || path === undefined || !existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Recorded);
}

/** Every durable `metrics.snapshot` record under `dir` (they land in their own rotated file). */
export function readSnapshots(dir: string): Recorded[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.includes('metrics-snapshot'))
    .sort()
    .flatMap((f) => readRecords(join(dir, f)));
}

/** Records whose event is `agent.*` (the plugin's trace vocabulary). */
export const agentRecords = (records: Recorded[]): Recorded[] => records.filter((r) => r.event.startsWith('agent.'));

/** `<span>.start` / `<span>.finish` / `<span>.error` counts for one span name. */
export function spanCounts(records: Recorded[], span: string): { start: number; finish: number; error: number } {
  const n = (suffix: string): number => records.filter((r) => r.event === `${span}.${suffix}`).length;
  return { start: n('start'), finish: n('finish'), error: n('error') };
}

export interface Env {
  hooks: IHookRegistry;
  sessionStore: SessionStore;
  taskStore: TaskStore;
  sessionId: string;
  definition: AgentDefinition;
}

function agentDefinition(hitl: boolean): AgentDefinition {
  const now = new Date().toISOString();
  return {
    name: 'trace-agent',
    version: 1,
    provider: { type: 'openai', model: 'gpt-4o-mini' },
    systemPrompt: 'You are helpful.',
    mcpServers: {},
    permissions: {},
    ...(hitl ? {} : { nativeTooling: { hitl: false } }),
    createdAt: now,
    updatedAt: now,
  } as AgentDefinition;
}

/** Real in-memory stores wired to `hooks` (so `session:created` / `session:closed` reach the plugin). */
export function makeEnv(hooks: IHookRegistry = new HookRegistry()): Env {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(DDL);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  const sessionStore = new SessionStore(db, hooks);
  const taskStore = new TaskStore(db);
  const definition = agentDefinition(true);
  const session = sessionStore.create({ agentName: definition.name, agentDefinition: definition });
  return { hooks, sessionStore, taskStore, sessionId: session.id, definition };
}

export function makeCtx(env: Env, opts: { hitl?: boolean; parentTaskId?: string; depth?: number } = {}): ExecutionContext {
  const task = env.taskStore.create({
    sessionId: env.sessionId,
    prompt: 'go',
    ...(opts.parentTaskId ? { parentTaskId: opts.parentTaskId } : {}),
    recursionDepth: opts.depth ?? 0,
  });
  return {
    taskId: task.id,
    sessionId: env.sessionId,
    agentName: 'trace-agent',
    agentDefinition: agentDefinition(opts.hitl ?? true) as ExecutionContext['agentDefinition'],
    recursionDepth: opts.depth ?? 0,
    toolCallCount: 0,
    ...(opts.parentTaskId ? { parentTaskId: opts.parentTaskId } : {}),
  } as ExecutionContext;
}

const GATED_TOOL: ToolDefinition = {
  name: 'agent-mcp__task',
  description: 'dispatch a sub-agent',
  inputSchema: { type: 'object', properties: {} },
};

function makeRegistry(executed: string[]): McpClientRegistry {
  return {
    listAllTools: async () => [{ ...GATED_TOOL }],
    resolveToolName: (name: string) => {
      const [server, tool] = name.split('__');
      return { server, tool };
    },
    closeAll: async () => undefined,
    getClient: async (server: string) => ({
      callTool: async (tool: string) => {
        executed.push(`${server}__${tool}`);
        return { ok: true };
      },
    }),
  } as unknown as McpClientRegistry;
}

/** Scripted LLM: turn 1 calls `server__tool`, turn 2 completes (the only scripted boundary). */
export function scriptedProvider(server = 'agent-mcp', tool = 'task', toolArgs: Record<string, unknown> = {}): LLMProvider {
  let turn = 0;
  return {
    chat: async (): Promise<ProviderChatResponse> => {
      turn++;
      const base = { id: `m${turn}`, sessionId: 's', createdAt: new Date().toISOString() };
      if (turn === 1) {
        return {
          message: { ...base, role: 'assistant', content: '', toolCalls: [{ id: 'call-1', server, tool, arguments: toolArgs }] },
          stopReason: 'tool_calls',
          usage: { inputTokens: 11, outputTokens: 3 },
        } as ProviderChatResponse;
      }
      return {
        message: { ...base, role: 'assistant', content: 'finished' },
        stopReason: 'completed',
        usage: { inputTokens: 20, outputTokens: 5 },
      } as ProviderChatResponse;
    },
  };
}

export function engineConfig(gate?: (a: { server: string; tool: string }) => PermissionAction): EngineConfig {
  const cfg: EngineConfig = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    queue: { concurrency: 1 },
    sse: { baseUrl: 'http://localhost:0' },
    plugins: { entries: [] },
    getProviderConfig: () => ({}),
    subprocessEnv: () => ({}),
    resolveEnvName: () => undefined,
    isEnvNameAllowed: () => true,
  };
  if (gate) cfg.permissionGate = (ctx) => gate(ctx);
  return cfg;
}

export interface RunOpts {
  gate?: (a: { server: string; tool: string }) => PermissionAction;
  executed?: string[];
  signal?: AbortSignal;
  provider?: LLMProvider;
}

/** The `Orchestrator.run()` input for `ctx`, wired to the env's real stores and hooks. */
export function runInput(env: Env, ctx: ExecutionContext, o: RunOpts = {}): OrchestratorRunInput {
  const message: Message = {
    id: 'u1',
    sessionId: ctx.sessionId,
    role: 'user',
    content: 'hello',
    createdAt: new Date().toISOString(),
  };
  return {
    executionContext: ctx,
    messages: [message],
    registry: makeRegistry(o.executed ?? []),
    provider: o.provider ?? scriptedProvider(),
    policy: { check: () => undefined } as unknown as PolicyEngine,
    taskStore: env.taskStore as never,
    sessionStore: env.sessionStore as never,
    signal: o.signal ?? new AbortController().signal,
    taskId: ctx.taskId,
    hooks: env.hooks,
    config: engineConfig(o.gate),
    logger: silentLogger,
  };
}

/** Bounded await: fails loudly rather than hanging the suite. */
export function withDeadline<T>(p: Promise<T>, label: string, ms = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e))
    );
  });
}

/** Resolves once `hooks` has seen `event` (registered as a plain observer — no sleeps). */
export function eventSeen(hooks: IHookRegistry, event: 'hitl:suspend'): Promise<void> {
  return new Promise((resolve) => {
    hooks.register(event, (() => resolve()) as never);
  });
}

/** Install `plugin` on `hooks` and return it (convenience for tests). */
export async function install<P extends Plugin>(plugin: P, hooks: IHookRegistry): Promise<P> {
  await plugin.install(hooks);
  return plugin;
}
