/**
 * spawn-mcp-host.ts — the ONE abstraction for the MCP host seam.
 *
 * Per AGENTS.md "Proving an MCP server works — drive the real tools, never a
 * bypass" and QA-STRATEGY.md §2 ("Live end-to-end (MCP host)"): the consumer
 * seam is the built server as a HOST loads it — `node dist/index.js serve
 * --transport mcp`, speaking real MCP JSON-RPC over stdio. This helper spawns
 * that EXACT command (the same one `.mcp.json` names) as a genuine child
 * process and connects a real `@modelcontextprotocol/sdk` `Client`. It never
 * imports the build and never reaches into `startBacklogServer` — that would
 * skip the CLI `serve` entrypoint, tool registration, dist dependency
 * resolution and the stdio framing, which is precisely the layer under test.
 *
 * Isolation reuses `isolatedSpawnOptions` (HOME redirect + `ADHD_BACKLOG_SCOPE=project`)
 * plus an explicit `ADHD_BACKLOG_DATABASE_PATH`, so the child never opens the
 * machine's real `~/.adhd` store. The caller owns the temp root (under
 * `tmp/backlog/**`) and its teardown.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isolatedSpawnOptions } from './spawn-isolated-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DIST_INDEX = join(HERE, '..', '..', '..', 'dist', 'index.js');

export interface IMcpHost {
  client: Client;
  /** The exact argv the host spawned (proves the documented command was used). */
  readonly argv: readonly string[];
  close(): Promise<void>;
}

/** Spawn the built server exactly as `.mcp.json` does and complete `initialize`. */
export async function connectMcpHost(opts: {
  root: string;
  dbPath: string;
}): Promise<IMcpHost> {
  if (!existsSync(DIST_INDEX)) {
    throw new Error(
      `built server missing at ${DIST_INDEX} — the e2e lane must depend on the build`
    );
  }
  const argv = [DIST_INDEX, 'serve', '--transport', 'mcp'];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: argv,
    ...isolatedSpawnOptions(opts.root, {
      ADHD_BACKLOG_DATABASE_PATH: opts.dbPath,
      // Silence the real pino logger (server.ts writes jsonl to stderr when
      // VITEST is unset); this does not touch the JSON-RPC stdout channel.
      VITEST: 'true',
      // The embedding stack is opt-in and must be OFF for a deterministic
      // test that never loads the model.
      ADHD_BACKLOG_EMBEDDING_ENABLED: 'false',
    }),
  });
  const client = new Client(
    { name: 'backlog-mcp-host-client', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport);
  return {
    client,
    argv,
    async close() {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    },
  };
}

export interface IToolEnvelope {
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
  meta?: Record<string, unknown>;
}

export interface IToolCall {
  /** The MCP result's `isError` flag (undefined on a clean dispatch). */
  isError: boolean | undefined;
  /** The parsed flat envelope carried on the single text content block. */
  envelope: IToolEnvelope;
}

/**
 * Call a loaded tool and parse the flat `content` payload (ADR-0004). A
 * non-JSON content block is a real contract failure, so it throws with the
 * raw text rather than being coerced.
 */
export async function callToolJson(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<IToolCall> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === 'text')?.text ?? '';
  let envelope: IToolEnvelope;
  try {
    envelope = JSON.parse(text) as IToolEnvelope;
  } catch {
    throw new Error(
      `tool ${name} returned a non-JSON content block: ${JSON.stringify(text)}`
    );
  }
  return {
    isError: typeof result.isError === 'boolean' ? result.isError : undefined,
    envelope,
  };
}
