import { z } from 'zod';

import { StdioMcpClient } from '../clients/stdio-client.js';
import { HttpMcpClient, SseMcpClient } from '../clients/http-client.js';
import type { EngineConfig, EngineLogger } from '../interfaces.js';
import type { AgentDefinition, McpServerConfig } from '../validation/index.js';

/**
 * `agent_verify_mcp` — backlog 1f352507.
 *
 * Before dispatching a real task against an agent, there was no way to confirm
 * its `mcpServers` actually connect and expose the expected tools: the only
 * feedback loop was "open a session, dispatch, wait up to the provider timeout,
 * then maybe learn the `command`/`args` were wrong". This verifies each
 * configured server with a HANDSHAKE + tool-list enumeration — no model call,
 * so it spends none of the task-provider timeout budget — and returns either
 * the reachable tool names or a clear per-server connection error.
 */
export const agentVerifyMcpInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Name of the stored agent whose mcpServers configuration to verify'),
});

export type AgentVerifyMcpInput = z.infer<typeof agentVerifyMcpInputSchema>;

/**
 * The AUTHORITATIVE three-way outcome of verifying one server. Consumers should
 * switch on this rather than on `ok` alone: `ok: true` used to mean BOTH
 * "handshake verified" AND "skipped", which is ambiguous (backlog review
 * finding). `status` disambiguates:
 *   - `'verified'` — the stdio/http/sse handshake + `listTools` succeeded;
 *     `tools` carries the reachable tool names (possibly empty).
 *   - `'skipped'`  — the server needs no out-of-process probe (the
 *     self-referential `agent-mcp` entry, handled in-process); `skipped`
 *     carries the reason.
 *   - `'error'`    — connect/handshake failed; `error` carries the message.
 */
export type McpServerVerificationStatus = 'verified' | 'skipped' | 'error';

export interface McpServerVerification {
  name: string;
  transport: McpServerConfig['transport'];
  /** Authoritative tri-state — prefer this over `ok`. */
  status: McpServerVerificationStatus;
  /**
   * Convenience shorthand for `status !== 'error'` (a skipped server did not
   * error). Kept for wire backward-compatibility; use `status` when you must
   * distinguish `'verified'` from `'skipped'`.
   */
  ok: boolean;
  /** Reachable tool names — present (possibly empty) only when `status === 'verified'`. */
  tools?: string[];
  /** Human-readable connection/handshake error — present only when `status === 'error'`. */
  error?: string;
  /** The skip reason — present only when `status === 'skipped'`. */
  skipped?: string;
}

export interface AgentVerifyMcpResult {
  agent: string;
  /** One entry per configured `mcpServers` key, in config order. */
  servers: McpServerVerification[];
}

export interface AgentVerifyMcpDeps {
  agentStore: { read(name: string): AgentDefinition };
  /**
   * The SAME engine config the task path threads into every stdio client
   * (`McpClientRegistry`). Threaded here so a verify probe spawns children with
   * the identical curated env (`subprocessEnv()`) instead of none (finding A5).
   */
  config?: EngineConfig;
  /** Logger for child-process lifecycle warnings, matching the registry. */
  logger?: EngineLogger;
}

/** The bits of every concrete client this module needs (IMcpClient omits
 *  `connect()` — only the concrete stdio/http/sse classes expose it). */
interface IConnectableClient {
  connect(): Promise<void>;
  listTools(): Promise<Array<{ name: string }>>;
  close(): Promise<void>;
}

function createClient(
  name: string,
  config: McpServerConfig,
  engineConfig: EngineConfig | undefined,
  logger: EngineLogger | undefined
): IConnectableClient {
  // Mirror `McpClientRegistry.getOrCreateClient`: a stdio child gets the same
  // engine config (curated env) + logger the task path uses (A5).
  if (config.transport === 'stdio') {
    return new StdioMcpClient(name, config, engineConfig, logger);
  }
  if (config.transport === 'http') return new HttpMcpClient(name, config);
  return new SseMcpClient(name, config);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function verifyOne(
  name: string,
  config: McpServerConfig,
  deps: AgentVerifyMcpDeps
): Promise<McpServerVerification> {
  // The engine never connects to `agent-mcp` as an out-of-process MCP server —
  // it routes that name to its own in-process tool surface (see
  // McpClientRegistry.isSelfReferential). There is nothing to handshake, and
  // spawning a second server to "verify" it would be wrong.
  if (name === 'agent-mcp') {
    return {
      name,
      transport: config.transport,
      status: 'skipped',
      ok: true,
      tools: [],
      skipped: 'self-referential (handled in-process)',
    };
  }

  let client: IConnectableClient;
  try {
    client = createClient(name, config, deps.config, deps.logger);
  } catch (err) {
    return {
      name,
      transport: config.transport,
      status: 'error',
      ok: false,
      error: errorMessage(err),
    };
  }

  try {
    await client.connect();
    const tools = await client.listTools();
    return {
      name,
      transport: config.transport,
      status: 'verified',
      ok: true,
      tools: tools.map((t) => t.name),
    };
  } catch (err) {
    return {
      name,
      transport: config.transport,
      status: 'error',
      ok: false,
      error: errorMessage(err),
    };
  } finally {
    // Always reap a spawned child / open socket; a verify probe must not leak
    // a process or connection. `close()` is itself best-effort.
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Handshake-verify every MCP server configured on the named agent, without
 * invoking the model. Returns one result per server — `ok` + reachable tool
 * names, or `ok:false` + the connection error.
 */
export async function verifyAgentMcpServers(
  input: AgentVerifyMcpInput,
  deps: AgentVerifyMcpDeps
): Promise<AgentVerifyMcpResult> {
  const agent = deps.agentStore.read(input.name);
  const servers = agent.mcpServers ?? {};

  const results: McpServerVerification[] = [];
  for (const [serverName, config] of Object.entries(servers)) {
    results.push(await verifyOne(serverName, config, deps));
  }

  return { agent: input.name, servers: results };
}
