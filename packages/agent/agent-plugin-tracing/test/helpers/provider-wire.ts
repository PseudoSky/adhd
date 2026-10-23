/**
 * Provider-wire scaffold for the tracing plugin's real-engine tests.
 *
 * Drives the REAL `Orchestrator.run()` with the REAL `AnthropicProvider` and the REAL `OpenAIProvider` (the
 * adapter DeepSeek and every OpenAI-compatible endpoint use), over the engine's `wire.fetch` seam: the bytes
 * a server would receive, with no socket and no model call. The model's replies and the MCP tool results are
 * the only scripted parts. A claudecli-shaped run is the engine's bridge path: a provider that calls
 * `request.executeTool` exactly as the claudecli loopback bridge does (no `claude` process is spawned).
 */
import { HookRegistry, Orchestrator, AnthropicProvider, OpenAIProvider } from '@adhd/agent-engine-orchestrator';
import type {
  EngineConfig,
  LLMProvider,
  McpClientRegistry,
  ProviderChatRequest,
  ProviderChatResponse,
  ToolDefinition,
} from '@adhd/agent-engine-orchestrator';
import type { ExecutionContext, PermissionAction } from '@adhd/agent-base-types';
import { engineConfig, makeCtx, makeEnv, runInput } from './harness.js';

export type Adapter = 'anthropic' | 'openai' | 'claudecli';

/** One tool call the scripted model asks for in a single assistant message. */
export interface IScriptedCall {
  id: string;
  /** Advertised `server__tool` name. */
  name: string;
  input: Record<string, unknown>;
}

const MODEL = 'claude-haiku-5-5';
const noop = (): void => undefined;
const silentLogger = { info: noop, warn: noop, error: noop, debug: noop };
const DEEPSEEK_MODEL = 'deepseek-chat';

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** An Anthropic streaming reply: the given `tool_use` blocks, or a plain text answer when `calls` is empty. */
function anthropicReply(calls: readonly IScriptedCall[]): Response {
  const parts = [
    sse('message_start', {
      type: 'message_start',
      message: { id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
    }),
  ];
  if (calls.length === 0) {
    parts.push(
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 })
    );
  }
  calls.forEach((c, index) => {
    parts.push(
      sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } }),
      sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } }),
      sse('content_block_stop', { type: 'content_block_stop', index })
    );
  });
  parts.push(
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: calls.length > 0 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
    sse('message_stop', { type: 'message_stop' })
  );
  return new Response(parts.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** An OpenAI Chat Completions reply: the given `tool_calls`, or a plain text answer when `calls` is empty. */
function openaiReply(calls: readonly IScriptedCall[]): Response {
  const message =
    calls.length === 0
      ? { role: 'assistant', content: 'done' }
      : {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })),
        };
  return new Response(
    JSON.stringify({
      id: 'cmpl-1',
      object: 'chat.completion',
      created: 0,
      model: DEEPSEEK_MODEL,
      choices: [{ index: 0, finish_reason: calls.length === 0 ? 'stop' : 'tool_calls', message }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

export interface IEngineRun {
  adapter: Adapter;
  /** Calls the model asks for on its first turn; the second turn answers `done`. */
  calls: readonly IScriptedCall[];
  /** Tools the registry advertises (their annotations drive the concurrency class). */
  tools: readonly ToolDefinition[];
  /** Runs one tool call (the MCP boundary). `tool` is the bare tool name. */
  callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  hooks: HookRegistry;
  gate?: (a: { server: string; tool: string }) => PermissionAction;
  /** Test seam: the host's own hooks, installed on `hooks` right before the run (after the caller's own). */
  beforeRun?: (hooks: HookRegistry) => void;
}

export interface IEngineRunResult {
  /** The JSON request bodies the provider put on the wire, in order (anthropic / openai only). */
  bodies: Array<Record<string, unknown>>;
  /** What the model-facing bridge returned for each call, in order (claudecli only). */
  bridged: Array<{ result: unknown; isError: boolean }>;
  /** The messages the session store persisted, in order. */
  persisted: unknown[];
  ctx: ExecutionContext;
}

/** Runs one task through the real engine with the scripted model for `adapter`. */
export async function runThroughEngine(r: IEngineRun): Promise<IEngineRunResult> {
  const env = makeEnv(r.hooks);
  const ctx = makeCtx(env);
  const providerConfigs = {
    claudecli: { type: 'claudecli' },
    anthropic: { type: 'anthropic', model: MODEL },
    openai: { type: 'openai', model: DEEPSEEK_MODEL },
  } as const;
  ctx.agentDefinition = { ...ctx.agentDefinition, provider: providerConfigs[r.adapter] } as ExecutionContext['agentDefinition'];

  const bodies: Array<Record<string, unknown>> = [];
  const bridged: IEngineRunResult['bridged'] = [];
  const fetchSeam: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const calls = bodies.length === 1 ? r.calls : [];
    return r.adapter === 'anthropic' ? anthropicReply(calls) : openaiReply(calls);
  };
  const base = engineConfig(r.gate);
  const config = {
    ...base,
    wire: { fetch: fetchSeam, withContext: async (_c: unknown, fn: () => Promise<unknown>) => fn() },
    getProviderConfig: () => (r.adapter === 'anthropic' ? { secret: 'sk-ant-api-test', model: MODEL } : { secret: 'sk-test', model: DEEPSEEK_MODEL, baseURL: 'http://localhost:1/v1' }),
  } as unknown as EngineConfig;

  let provider: LLMProvider;
  if (r.adapter === 'anthropic') {
    provider = new AnthropicProvider({ type: 'anthropic', model: MODEL }, config, silentLogger);
  } else if (r.adapter === 'openai') {
    provider = new OpenAIProvider({ type: 'openai', model: DEEPSEEK_MODEL } as never, config);
  } else {
    let turn = 0;
    provider = {
      chat: async (req: ProviderChatRequest): Promise<ProviderChatResponse> => {
        turn++;
        // The claudecli loopback bridge runs the CLI's own tool loop: every MCP call is one executeTool.
        if (turn === 1) {
          for (const c of r.calls) {
            const [server, ...rest] = c.name.split('__');
            bridged.push(await req.executeTool!(server, rest.join('__'), c.input));
          }
        }
        return {
          message: { id: `m${turn}`, sessionId: ctx.sessionId, role: 'assistant', content: 'done', createdAt: new Date().toISOString() },
          stopReason: 'completed',
          usage: { inputTokens: 1, outputTokens: 1 },
        } as ProviderChatResponse;
      },
    };
  }

  const registry = {
    listAllTools: async () => r.tools.map((t) => ({ ...t })),
    resolveToolName: (name: string) => {
      const [server, ...rest] = name.split('__');
      return { server, tool: rest.join('__') };
    },
    closeAll: async () => undefined,
    getClient: async () => ({ callTool: async (tool: string, args: unknown) => r.callTool(tool, args as Record<string, unknown>) }),
  } as unknown as McpClientRegistry;

  const persisted: unknown[] = [];
  const sessionStore = {
    appendMessage: async (_sid: string, m: unknown) => {
      persisted.push(m);
    },
    close: noop,
    appendMessageEcho: noop,
  };
  r.beforeRun?.(r.hooks);
  await new Orchestrator().run({
    ...runInput(env, ctx, { provider }),
    registry,
    config,
    sessionStore: sessionStore as never,
    hooks: r.hooks,
  });
  return { bodies, bridged, persisted, ctx };
}

export { HookRegistry };
