import { z } from 'zod';

import { StdioMcpClient } from '../clients/stdio-client.js';
import { HttpMcpClient, SseMcpClient } from '../clients/http-client.js';
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

export interface McpServerVerification {
  name: string;
  transport: McpServerConfig['transport'];
  /** True when the handshake + listTools succeeded (or the server was skipped). */
  ok: boolean;
  /** Reachable tool names — present (possibly empty) only when `ok`. */
  tools?: string[];
  /** Human-readable connection/handshake error — present only when `!ok`. */
  error?: string;
  /** Set instead of a connection when the server needs no out-of-process probe. */
  skipped?: string;
}

export interface AgentVerifyMcpResult {
  agent: string;
  /** One entry per configured `mcpServers` key, in config order. */
  servers: McpServerVerification[];
}

export interface AgentVerifyMcpDeps {
  agentStore: { read(name: string): AgentDefinition };
}

/** The bits of every concrete client this module needs (IMcpClient omits
 *  `connect()` — only the concrete stdio/http/sse classes expose it). */
interface IConnectableClient {
  connect(): Promise<void>;
  listTools(): Promise<Array<{ name: string }>>;
  close(): Promise<void>;
}

function createClient(name: string, config: McpServerConfig): IConnectableClient {
  if (config.transport === 'stdio') return new StdioMcpClient(name, config);
  if (config.transport === 'http') return new HttpMcpClient(name, config);
  return new SseMcpClient(name, config);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function verifyOne(
  name: string,
  config: McpServerConfig
): Promise<McpServerVerification> {
  // The engine never connects to `agent-mcp` as an out-of-process MCP server —
  // it routes that name to its own in-process tool surface (see
  // McpClientRegistry.isSelfReferential). There is nothing to handshake, and
  // spawning a second server to "verify" it would be wrong.
  if (name === 'agent-mcp') {
    return {
      name,
      transport: config.transport,
      ok: true,
      tools: [],
      skipped: 'self-referential (handled in-process)',
    };
  }

  let client: IConnectableClient;
  try {
    client = createClient(name, config);
  } catch (err) {
    return { name, transport: config.transport, ok: false, error: errorMessage(err) };
  }

  try {
    await client.connect();
    const tools = await client.listTools();
    return {
      name,
      transport: config.transport,
      ok: true,
      tools: tools.map((t) => t.name),
    };
  } catch (err) {
    return {
      name,
      transport: config.transport,
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
    results.push(await verifyOne(serverName, config));
  }

  return { agent: input.name, servers: results };
}
