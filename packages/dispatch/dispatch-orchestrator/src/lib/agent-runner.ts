import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { DispatchUnit, ProviderConfig } from '@adhd/dispatch-base-spec';

// ---------------------------------------------------------------------------
// ── WIRE-MIRROR TYPES ────────────────────────────────────────────────────────
//
// IDispatchAgentRunner talks to agent-mcp the way a real MCP host does: a
// client over stdio JSON-RPC, calling published tools and reading back JSON
// text content (see packages/ai/agent-mcp/README.md "Tool reference" and
// packages/ai/agent-mcp/src/server.ts toMcpContent/toMcpErrorContent). The
// types below mirror the wire shapes documented in agent-mcp's
// src/validation/{task,usage}.ts. They are declared locally — never imported
// from @adhd/agent-mcp or @adhd/agent-base-types — because this package
// crosses agent-mcp as an external MCP server over the wire, not as a
// TypeScript dependency. That is the same boundary any other MCP host has.
// ---------------------------------------------------------------------------

/**
 * Task status vocabulary returned by `IDispatchAgentRunner.poll()`. Mirrors
 * agent-mcp's `taskStatusSchema` (packages/ai/agent-mcp/src/validation/task.ts).
 * agent-mcp is the only backend implementing this seam today, but the
 * `IDispatchAgentRunner` interface itself is backend-agnostic.
 */
export type DispatchTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'waiting'
  | 'awaiting_input';

/** Mirrors agent-mcp's `UsageSummary` (src/validation/usage.ts). */
export interface DispatchUsageSummary {
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  toolCallCount: number;
  latencyMs: number;
  stopReason?: string;
}

/**
 * Mirrors agent-mcp's `TaskUsageReport` (src/validation/usage.ts:84-108).
 * agent-mcp exposes ONLY this aggregate shape on its MCP surface — `direct`
 * is this task's own model calls, `subtree` includes delegated sub-tasks.
 * Per-turn usage breakdown does not exist on the wire and must not be
 * assumed (dag.json milestones["agent-runner"] description; see also
 * docs/plan/dispatch-production/contexts/tests-real-e2e.md).
 */
export interface DispatchUsageReport {
  direct: DispatchUsageSummary;
  subtree: DispatchUsageSummary;
  taskCount: number;
}

/**
 * The synthesized single-entry turns[] record described by the agent-runner
 * milestone (docs/plan/dispatch-production/dag.json, operation
 * agent-runner.1): `{ input_tokens, output_tokens, model_calls }`.
 *
 * NOTE — deliberately NOT `@adhd/dispatch-base-spec`'s `Turn` type: `Turn`
 * (packages/dispatch/dispatch-spec/src/lib/types.ts) has `turn`/`t` fields
 * and carries no `model_calls`, so it cannot literally hold this shape.
 * Reconciling a `SynthesizedTurn` into a real `Turn` for
 * `DispatchLogEntry.turns` (assigning a `turn` index + `t` timestamp, and
 * deciding whether/where `model_calls` is retained) is out of scope for this
 * seam — dispatch-spec is off-limits for this milestone — and is owned by
 * whichever milestone actually constructs `DispatchLogEntry` entries
 * (orchestrator-core). Flagged as a real dag-description / type-spec gap in
 * the agent-runner milestone completion report.
 */
export interface SynthesizedTurn {
  input_tokens: number;
  output_tokens: number;
  model_calls: number;
}

/**
 * Maps a task's `TaskUsageReport.direct` into a single synthesized turns[]
 * entry. agent-mcp exposes ONLY aggregate usage on its MCP surface — a task
 * that made N real model calls still collapses into exactly ONE entry here,
 * never N (per-turn breakdown is not available; see `DispatchUsageReport`
 * doc comment above).
 *
 * Returns `[]` when `report` is `undefined` — the task recorded zero model
 * calls (still running, or cancelled/failed before its first model call).
 */
export function usageToTurns(
  report: DispatchUsageReport | undefined
): SynthesizedTurn[] {
  if (!report) return [];
  const { direct } = report;
  return [
    {
      input_tokens: direct.inputTokens,
      output_tokens: direct.outputTokens,
      model_calls: direct.modelCalls,
    },
  ];
}

// ---------------------------------------------------------------------------
// ── IDispatchAgentRunner ─────────────────────────────────────────────────────
//
// The seam between the dispatch system and its execution backend. See
// docs/plan/dispatch-production/dag.json milestones["agent-runner"].
// ---------------------------------------------------------------------------

export interface IDispatchAgentRunner {
  /**
   * Idempotently ensures `unit.agent_name` exists as an agent-mcp agent
   * definition: `agent_read` by name; on `AGENT_NOT_FOUND`, `agent_create`
   * with `{ name, provider: { type: 'claudecli' }, systemPrompt, mcpServers: {} }`.
   */
  ensureAgent(unit: DispatchUnit): Promise<void>;
  /** Fires `unit.prompt` at `unit.agent_name` via an ephemeral (session-less), synchronous task. */
  fire(unit: DispatchUnit): Promise<{ taskId: string }>;
  /** Reads current task status and aggregate token usage. */
  poll(
    taskId: string
  ): Promise<{ status: DispatchTaskStatus; usage: DispatchUsageReport | undefined }>;
  /** Cancels a pending/running/awaiting_input task. */
  cancel(taskId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// ── AgentMcpRunner ───────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/** A single MCP content block, as returned by `@modelcontextprotocol/sdk`'s `callTool`. */
export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** The subset of `CallToolResult` this runner reads. */
export interface McpCallToolResult {
  content?: McpContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * The minimal slice of `@modelcontextprotocol/sdk`'s `Client` that
 * `AgentMcpRunner` depends on. Declared locally (rather than depending on the
 * SDK's own `Client` type directly) so tests can inject a fake implementation
 * — see `src/test/helpers/fake-mcp-client.ts` — that exercises the same
 * request/response parsing path as production without spawning a real
 * subprocess.
 */
export interface IMcpToolClient {
  connect(): Promise<void>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpCallToolResult>;
  close(): Promise<void>;
}

/**
 * Error thrown by `AgentMcpRunner` when an agent-mcp tool call returns
 * `isError: true`. `code` is the agent-mcp error code (e.g.
 * `AGENT_NOT_FOUND`, `TASK_NOT_CANCELLABLE`) parsed out of the `[CODE]
 * message` text agent-mcp's `toMcpErrorContent` produces
 * (packages/ai/agent-mcp/src/server.ts). `code` is `'UNKNOWN'` when the
 * error text doesn't match that convention.
 */
export class AgentMcpToolError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AgentMcpToolError';
  }
}

const ERROR_CODE_PATTERN = /^\[([A-Z_]+)\]\s*([\s\S]*)$/;

/**
 * Mirrors agent-mcp's real, wire-level provider payload accepted by
 * `agent_create`/`agent_update` (`providerConfigSchema`, a discriminated
 * union of exactly `'anthropic' | 'openai' | 'claudecli'` —
 * packages/agent/agent-engine-orchestrator/src/validation/agent.ts). These
 * are the SAME 3 values `@adhd/dispatch-base-spec`'s `ProviderType`/
 * `ProviderConfig.type` already restrict `DispatchUnit.provider` to
 * (types.ts:84) — DeepSeek is not a 4th type on either side: it dispatches as
 * `type: 'openai'` with a DeepSeek `model`/`baseURL`, exactly matching the
 * real production `typescript-deepseek` agent definition (verified against
 * `~/.adhd/agent-mcp/agents.db`: `{type:'openai', model:'deepseek-v4-flash',
 * baseURL:'https://api.deepseek.com/v1',
 * env:{secret:'ADHD_AGENT_DEEPSEEK_SECRET'}}`).
 */
export interface McpAgentProviderConfig {
  type: 'anthropic' | 'openai' | 'claudecli';
  model?: string;
  env?: { secret: string };
  baseURL?: string;
  timeoutMs?: number;
  retryConfig?: { retries: number; minTimeout: number; maxTimeout: number; factor: number };
}

/**
 * Translates `DispatchUnit.provider` (dispatch-base-spec's snake_case
 * `ProviderConfig`) into the camelCase payload agent-mcp's real
 * `agent_create` tool accepts. THE FIX: `ensureAgent` previously hardcoded an
 * unconditional `{ type: 'claudecli' }` here regardless of `unit.provider` —
 * every field the DAG author configured via `dag.providers` (threaded onto
 * each unit by dispatch-orchestrator's `resolveUnitProviderAndTokens`) was
 * silently discarded, so the real (`dryRun: false`) path could never reach
 * DeepSeek (or any provider other than claudecli) no matter what the DAG
 * specified. Now a `type: 'openai'` unit with a DeepSeek `model_id`/
 * `base_url`/`env_secret` really dispatches to DeepSeek.
 *
 * `null` (no provider configured — every pre-fix caller, including
 * MockAgentRunner fixtures and the real-e2e claudecli live gate) preserves
 * the exact pre-fix default: a bare `{ type: 'claudecli' }` agent, no other
 * keys — verified byte-for-byte against `agent-runner.spec.ts`'s existing
 * `ensureAgent` assertions, which still pass unmodified.
 */
export function toAgentMcpProviderConfig(
  provider: ProviderConfig | null
): McpAgentProviderConfig {
  if (!provider) return { type: 'claudecli' };

  if (provider.type === 'claudecli') {
    const config: McpAgentProviderConfig = { type: 'claudecli' };
    if (provider.model_id) config.model = provider.model_id;
    if (provider.timeout_ms) config.timeoutMs = provider.timeout_ms;
    return config;
  }

  // 'anthropic' | 'openai' — DeepSeek and any other OpenAI-compatible
  // endpoint dispatch through 'openai' + model_id/base_url (see doc comment
  // above).
  const config: McpAgentProviderConfig = { type: provider.type };
  if (provider.model_id) config.model = provider.model_id;
  if (provider.base_url) config.baseURL = provider.base_url;
  if (provider.env_secret) config.env = { secret: provider.env_secret };
  if (provider.timeout_ms) config.timeoutMs = provider.timeout_ms;
  if (provider.retry_config) {
    config.retryConfig = {
      retries: provider.retry_config.retries,
      minTimeout: provider.retry_config.min_timeout,
      maxTimeout: provider.retry_config.max_timeout,
      factor: provider.retry_config.factor,
    };
  }
  return config;
}

export interface AgentMcpRunnerConfig {
  /**
   * Command used to spawn the agent-mcp MCP server (e.g. `"node"` or
   * `"npx"`). Required — no default is baked in here, so no filesystem path
   * or package spec is hardcoded in this seam; the caller supplies whatever
   * is correct for its environment (a `dist/index.js` path in dev, `npx -y
   * @adhd/agent-mcp` in prod, per packages/ai/agent-mcp/README.md Quickstart).
   */
  command: string;
  /** Args passed to `command` (e.g. `["dist/packages/ai/agent-mcp/src/index.js"]`). */
  args?: string[];
  /** Extra environment variables merged over the current process env for the spawned server. */
  env?: Record<string, string>;
  /**
   * Produces the MCP client used for every tool call. Defaults to a real
   * `@modelcontextprotocol/sdk` stdio `Client` wired to `command`/`args`/`env`.
   * Tests inject a fake here to exercise the real request/response parsing
   * path without spawning a subprocess — the real-seam live proof (a real
   * agent-mcp process + a real model) is owned by the tests-real-e2e
   * milestone, not this one.
   */
  clientFactory?: () => IMcpToolClient;
}

function defaultClientFactory(
  config: Pick<AgentMcpRunnerConfig, 'command' | 'args' | 'env'>
): () => IMcpToolClient {
  return () => {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...config.env } as Record<string, string>,
    });
    const client = new Client(
      { name: 'dispatch-orchestrator', version: '0.0.1' },
      { capabilities: {} }
    );
    return {
      connect: () => client.connect(transport),
      callTool: (params) =>
        client.callTool(params) as Promise<McpCallToolResult>,
      close: () => client.close(),
    };
  };
}

/**
 * Real `IDispatchAgentRunner` implementation over agent-mcp's MCP tool
 * surface (`agent_read`, `agent_create`, `task`, `result`, `task_cancel`) —
 * see docs/plan/dispatch-production/dag.json milestones["agent-runner"] for
 * the full seam contract, and packages/ai/agent-mcp/README.md for the tool
 * reference this implementation was written against.
 */
export class AgentMcpRunner implements IDispatchAgentRunner {
  private readonly makeClient: () => IMcpToolClient;
  private client: IMcpToolClient | null = null;
  private connecting: Promise<IMcpToolClient> | null = null;

  constructor(config: AgentMcpRunnerConfig) {
    this.makeClient = config.clientFactory ?? defaultClientFactory(config);
  }

  private async getClient(): Promise<IMcpToolClient> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = this.makeClient();
        await client.connect();
        this.client = client;
        return client;
      })();
    }
    return this.connecting;
  }

  private async callTool<T>(
    name: string,
    args: Record<string, unknown>
  ): Promise<T> {
    const client = await this.getClient();
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.[0]?.text ?? '';

    if (result.isError) {
      const match = ERROR_CODE_PATTERN.exec(text);
      throw new AgentMcpToolError(match?.[1] ?? 'UNKNOWN', match?.[2] ?? text);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AgentMcpToolError(
        'PARSE_ERROR',
        `Tool '${name}' returned non-JSON content: ${text}`
      );
    }
  }

  async ensureAgent(unit: DispatchUnit): Promise<void> {
    try {
      await this.callTool('agent_read', { name: unit.agent_name });
      return; // already exists — nothing to do
    } catch (err) {
      if (!(err instanceof AgentMcpToolError) || err.code !== 'AGENT_NOT_FOUND') {
        throw err;
      }
    }

    // The `mcpServers: {}` fallback is deliberate — see dag.json
    // milestones["agent-runner"] description (BL-105): claudecli agents need
    // no MCP servers, so this bypasses the mcp_servers: null catalog-lookup
    // stub (PoC compiler.ts:1788) that would otherwise block e2e.
    await this.callTool('agent_create', {
      name: unit.agent_name,
      provider: toAgentMcpProviderConfig(unit.provider),
      systemPrompt: unit.prompt ?? undefined,
      mcpServers: {},
    });
  }

  async fire(unit: DispatchUnit): Promise<{ taskId: string }> {
    if (unit.prompt == null) {
      throw new Error(
        `DispatchUnit '${unit.id}' has no compiled prompt (prompt is null) — cannot fire`
      );
    }
    const result = await this.callTool<{ task_id: string }>('task', {
      agent_name: unit.agent_name,
      prompt: unit.prompt,
    });
    return { taskId: result.task_id };
  }

  async poll(
    taskId: string
  ): Promise<{ status: DispatchTaskStatus; usage: DispatchUsageReport | undefined }> {
    const result = await this.callTool<{
      status: DispatchTaskStatus;
      usage?: DispatchUsageReport;
    }>('result', { task_id: taskId });
    return { status: result.status, usage: result.usage };
  }

  async cancel(taskId: string): Promise<void> {
    await this.callTool('task_cancel', { task_id: taskId });
  }

  /**
   * Closes the underlying MCP client (and, for the default client, its
   * spawned subprocess). Not part of `IDispatchAgentRunner` — callers and
   * tests own this lifecycle step and should invoke it during teardown.
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.connecting = null;
  }
}
