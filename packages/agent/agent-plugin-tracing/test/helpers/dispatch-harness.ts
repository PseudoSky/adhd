/**
 * Real parent -> worker dispatch harness for the tracing plugin's R10 tests.
 *
 * Real: the engine `HookRegistry`, two `Orchestrator.run()` loops (parent and worker), the real
 * `taskTool` / `tasksBatch` dispatch path, real better-sqlite3 stores, the real OpenAI provider talking
 * HTTP to a loopback server, and the real `@adhd/sox-telemetry` file sink. Scripted boundaries ONLY:
 * the parent's LLM turns and the loopback server that stands in for the paid OpenAI API.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BackgroundQueue, DagEngine, PolicyEngine, resultToolWait, taskTool, tasksBatch } from '@adhd/agent-engine-orchestrator';
import type { AgentStore, EngineConfig, LLMProvider, McpClientRegistry, ProviderChatResponse, TaskDeps } from '@adhd/agent-engine-orchestrator';
import type { AgentDefinition, ExecutionContext } from '@adhd/agent-base-types';
import { Orchestrator, engineConfig, makeCtx, makeEnv, runInput } from './harness.js';
import type { Env } from './harness.js';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

/** The JSON request body the adapter sent (`{}` when it was empty or not JSON). */
function parseBody(chunks: Buffer[]): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** What the loopback chat-completions server answers with for the n-th request (1-based). */
export interface FakeReply {
  content: string;
  /** Extra non-standard reasoning text and signature the response carries (to prove they never reach a trace). */
  reasoning?: string;
  signature?: string;
  /** Answer with this tool call instead of text (OpenAI `tool_calls` / Anthropic `tool_use` shape). */
  toolCall?: { name: string; arguments: Record<string, unknown> };
}

/** Provider families the loopback servers can stand in for. */
export type ProviderKind = 'openai' | 'anthropic';

/** A loopback server that speaks just enough of the OpenAI chat-completions wire for the real provider. */
export interface FakeOpenAI {
  baseURL: string;
  /** Number of chat-completion requests served. */
  requests(): number;
  /** The parsed JSON body of every request served, in order (what the adapter actually put on the wire). */
  bodies(): Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Start the loopback OpenAI stand-in; `reply(n)` scripts the answer to the n-th request. */
export async function startFakeOpenAI(reply: (n: number) => FakeReply): Promise<FakeOpenAI> {
  let served = 0;
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      bodies.push(parseBody(chunks));
      served++;
      const { content, reasoning, signature, toolCall } = reply(served);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: `chatcmpl-${served}`,
          object: 'chat.completion',
          created: 0,
          model: 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: toolCall === undefined ? content : null,
                ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
                ...(signature === undefined ? {} : { signature }),
                ...(toolCall === undefined
                  ? {}
                  : {
                      tool_calls: [
                        { id: `call_${served}`, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) } },
                      ],
                    }),
              },
              finish_reason: toolCall === undefined ? 'stop' : 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests: () => served,
    bodies: () => bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A loopback server speaking just enough of the Anthropic Messages SSE stream for the real
 * `AnthropicProvider`: optional thinking block (with signature), then text or a `tool_use`.
 */
export async function startFakeAnthropic(reply: (n: number) => FakeReply): Promise<FakeOpenAI> {
  let served = 0;
  const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      bodies.push(parseBody(chunks));
      served++;
      const { content, reasoning, signature, toolCall } = reply(served);
      let out = frame('message_start', {
        type: 'message_start',
        message: { id: `msg_${served}`, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 1 } },
      });
      let index = 0;
      if (reasoning !== undefined) {
        out += frame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
        out += frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: reasoning } });
        out += frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: signature ?? 'sig' } });
        out += frame('content_block_stop', { type: 'content_block_stop', index });
        index++;
      }
      if (toolCall === undefined) {
        out += frame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        out += frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: content } });
      } else {
        out += frame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${served}`, name: toolCall.name, input: {} } });
        out += frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolCall.arguments) } });
      }
      out += frame('content_block_stop', { type: 'content_block_stop', index });
      out += frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: toolCall === undefined ? 'end_turn' : 'tool_use', stop_sequence: null },
        usage: { output_tokens: 3 },
      });
      out += frame('message_stop', { type: 'message_stop' });
      res.setHeader('content-type', 'text/event-stream');
      res.end(out);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests: () => served,
    bodies: () => bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Start the loopback stand-in for `kind`. */
export function startFakeProvider(kind: ProviderKind, reply: (n: number) => FakeReply): Promise<FakeOpenAI> {
  return kind === 'openai' ? startFakeOpenAI(reply) : startFakeAnthropic(reply);
}

/** Optional knobs of the dispatched worker. */
export interface WorkerOptions {
  /** The Anthropic `thinking` option the worker agent is configured with (ignored for the OpenAI family). */
  thinking?: { type: 'adaptive'; display?: 'summarized' | 'omitted' } | { type: 'disabled' };
}

function workerDefinition(kind: ProviderKind, worker: WorkerOptions = {}): AgentDefinition {
  const now = new Date().toISOString();
  return {
    name: 'worker-agent',
    version: 1,
    provider:
      kind === 'openai'
        ? { type: 'openai', model: 'gpt-4o-mini' }
        : { type: 'anthropic', model: 'claude-haiku-5-5', ...(worker.thinking !== undefined ? { thinking: worker.thinking } : {}) },
    systemPrompt: 'You are a worker.',
    mcpServers: {},
    permissions: {},
    createdAt: now,
    updatedAt: now,
  } as AgentDefinition;
}

/** The real dispatch dependencies over `env`'s stores and hooks, with workers served by `baseURL`. */
export function makeTaskDeps(env: Env, baseURL: string, kind: ProviderKind = 'openai', worker: WorkerOptions = {}): TaskDeps {
  const definition = workerDefinition(kind, worker);
  const agentStore: AgentStore = {
    create: () => definition,
    read: () => definition,
    update: () => definition,
    delete: () => undefined,
    list: () => [definition],
  };
  const queue = new BackgroundQueue(1, silent);
  const config: EngineConfig = {
    ...engineConfig(),
    getProviderConfig: () => ({ secret: 'test-secret', baseURL, model: kind === 'openai' ? 'gpt-4o-mini' : 'claude-haiku-5-5' }),
    // The Anthropic SDK takes no base URL from the engine config; the engine's egress seam is the one
    // supported place to redirect it. FAIL CLOSED: anything that is not the Anthropic API host (which is
    // rewritten to the loopback stand-in) or the loopback itself is refused, so this harness can never
    // reach a real provider.
    ...(kind === 'anthropic'
      ? {
          wire: {
            fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
              const url = input instanceof Request ? input.url : String(input);
              if (!url.startsWith('https://api.anthropic.com') && !url.startsWith(baseURL)) {
                throw new Error(`dispatch harness refused a non-loopback request: ${url}`);
              }
              return globalThis.fetch(url.replace('https://api.anthropic.com', baseURL), init);
            }) as typeof fetch,
            spawn: (() => {
              throw new Error('dispatch harness never spawns a process');
            }) as never,
            wrapTransport: (t: unknown) => t,
            withContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
          },
        }
      : {}),
  } as EngineConfig;
  const dagEngine = new DagEngine(env.db as never, queue, env.taskStore as never, async () => undefined, silent);
  return {
    agentStore,
    sessionStore: env.sessionStore as never,
    taskStore: env.taskStore as never,
    orchestrator: new Orchestrator(),
    queue,
    policy: new PolicyEngine({ serverMaxDepth: 10, serverMaxToolLoops: 10 }),
    hooks: env.hooks,
    selfUrl: undefined,
    inProcessDescriptors: [],
    inProcessHandler: async () => {
      throw new Error('no in-process tools in this harness');
    },
    db: env.db as never,
    dagEngine,
    config,
    logger: silent as never,
  } as TaskDeps;
}

/** A parent model that calls `agent-mcp__<tool>` with `args` on turn 1 and completes on turn 2. */
export function parentProvider(tool: string, args: Record<string, unknown>): LLMProvider {
  let turn = 0;
  return {
    chat: async (): Promise<ProviderChatResponse> => {
      turn++;
      const base = { id: `p${turn}`, sessionId: 's', createdAt: new Date().toISOString() };
      return (
        turn === 1
          ? {
              message: { ...base, role: 'assistant', content: '', toolCalls: [{ id: 'call-1', server: 'agent-mcp', tool, arguments: args }] },
              stopReason: 'tool_calls',
              usage: { inputTokens: 11, outputTokens: 3 },
            }
          : {
              message: { ...base, role: 'assistant', content: 'parent finished' },
              stopReason: 'completed',
              usage: { inputTokens: 20, outputTokens: 5 },
            }
      ) as ProviderChatResponse;
    },
  };
}

/** The in-process handler's routing for the three dispatch-class tools (`result` wired with hooks + the waiting parent, as the host does). */
async function invokeDispatchTool(tool: string, args: never, deps: TaskDeps, ctx: ExecutionContext): Promise<unknown> {
  if (tool === 'tasks_batch') return tasksBatch(args, deps, ctx);
  if (tool === 'result') return resultToolWait(args, { taskStore: deps.taskStore, db: deps.db, hooks: deps.hooks, callerContext: ctx });
  return taskTool(args, deps, ctx);
}

/** A registry whose in-process `agent-mcp` server routes `task` / `tasks_batch` to the REAL dispatch functions. */
function dispatchRegistry(deps: TaskDeps, ctx: ExecutionContext, toolResults: unknown[], toolErrors: unknown[]): McpClientRegistry {
  return {
    listAllTools: async () => [
      { name: 'agent-mcp__task', description: 'dispatch', inputSchema: { type: 'object', properties: {} } },
      { name: 'agent-mcp__tasks_batch', description: 'dispatch many', inputSchema: { type: 'object', properties: {} } },
      { name: 'agent-mcp__result', description: 'read or wait for a task result', inputSchema: { type: 'object', properties: {} } },
    ],
    resolveToolName: (name: string) => {
      const [server, tool] = name.split('__');
      return { server, tool };
    },
    closeAll: async () => undefined,
    getClient: async () => ({
      callTool: async (tool: string, args: never) => {
        try {
          const out = await invokeDispatchTool(tool, args, deps, ctx);
          toolResults.push(out);
          return out;
        } catch (err) {
          toolErrors.push(err);
          throw err;
        }
      },
    }),
  } as unknown as McpClientRegistry;
}

/** Everything a dispatch test needs to inspect after a run. */
export interface DispatchRun {
  env: Env;
  deps: TaskDeps;
  parent: ExecutionContext;
  result: string;
  /** The raw outputs the dispatch tools returned to the parent. */
  toolResults: unknown[];
  /** Errors the dispatch tools threw to the parent (empty on a healthy run). */
  toolErrors: unknown[];
}

/**
 * Run a parent task whose model calls `agent-mcp__<tool>(args)` once, through the real orchestrator,
 * the real dispatch tool and a real worker task. The caller installs the plugin on `hooks` first.
 */
export async function runParentDispatch(
  hooks: Env['hooks'],
  baseURL: string,
  tool: 'task' | 'tasks_batch',
  args: Record<string, unknown>,
  kind: ProviderKind = 'openai'
): Promise<DispatchRun> {
  const env = makeEnv(hooks, { realSchema: true });
  const parent = makeCtx(env);
  const deps = makeTaskDeps(env, baseURL, kind);
  const toolResults: unknown[] = [];
  const toolErrors: unknown[] = [];
  const input = runInput(env, parent, { gate: () => 'allow', provider: parentProvider(tool, args) });
  const { result } = await new Orchestrator().run({ ...input, registry: dispatchRegistry(deps, parent, toolResults, toolErrors) });
  return { env, deps, parent, result, toolResults, toolErrors };
}

/** One tool call of a scripted parent turn. */
export interface ParentCall {
  /** The model's tool call id (what `pre:tool_call` reports as `callId`). */
  id: string;
  tool: 'task' | 'tasks_batch' | 'result';
  /** The call's arguments, or a function of the run so far (a later turn can name a child an earlier one created). */
  args: Record<string, unknown> | ((run: { env: Env; parent: ExecutionContext }) => Record<string, unknown>);
}

/** A parent model that requests `turns[i]` (all calls of the turn together) on its i-th call, then completes. */
export function scriptedParentProvider(turns: ParentCall[][], run: { env: Env; parent: ExecutionContext }): LLMProvider {
  let turn = 0;
  return {
    chat: async (): Promise<ProviderChatResponse> => {
      const calls = turns[turn];
      turn++;
      const base = { id: `p${turn}`, sessionId: 's', createdAt: new Date().toISOString() };
      return (
        calls !== undefined
          ? {
              message: { ...base, role: 'assistant', content: '', toolCalls: calls.map((c) => ({ id: c.id, server: 'agent-mcp', tool: c.tool, arguments: typeof c.args === 'function' ? c.args(run) : c.args })) },
              stopReason: 'tool_calls',
              usage: { inputTokens: 11, outputTokens: 3 },
            }
          : { message: { ...base, role: 'assistant', content: 'parent finished' }, stopReason: 'completed', usage: { inputTokens: 20, outputTokens: 5 } }
      ) as ProviderChatResponse;
    },
  };
}

/**
 * Like {@link runParentDispatch}, but the parent's model follows `turns` (several calls per turn, several turns),
 * and the worker agent can be configured (`worker`).
 */
export async function runParentScript(
  hooks: Env['hooks'],
  baseURL: string,
  turns: ParentCall[][],
  kind: ProviderKind = 'openai',
  worker: WorkerOptions = {}
): Promise<DispatchRun> {
  const env = makeEnv(hooks, { realSchema: true });
  const parent = makeCtx(env);
  const deps = makeTaskDeps(env, baseURL, kind, worker);
  const toolResults: unknown[] = [];
  const toolErrors: unknown[] = [];
  const input = runInput(env, parent, { gate: () => 'allow', provider: scriptedParentProvider(turns, { env, parent }) });
  const { result } = await new Orchestrator().run({ ...input, registry: dispatchRegistry(deps, parent, toolResults, toolErrors) });
  return { env, deps, parent, result, toolResults, toolErrors };
}
