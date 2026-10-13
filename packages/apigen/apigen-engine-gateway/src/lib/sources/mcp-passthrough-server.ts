import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Operation } from '@adhd/apigen-core-client';
import { isApiError } from '@adhd/apigen-base-errors';
import { adaptCoreLayer, createInvoker, LayerContext } from '@adhd/apigen-engine-runtime';
import type { UsePlugin } from '@adhd/apigen-engine-runtime';
import type { IResolvedSource } from './types';

/** Generic text returned for any non-refusal failure; internals are never leaked to the host. */
const GENERIC_FAILURE = 'The tool call failed.';

/** Options for {@link serveMcpPassthrough}. */
export interface IPassthroughServerOptions {
  /** The resolved upstream MCP source; `hints` (see `resolveMcpStdioSource`) become tool annotations. */
  readonly source: IResolvedSource & {
    readonly hints?: Readonly<Record<string, { readOnly?: boolean; destructive?: boolean }>>;
  };
  /** Only each plugin's `capabilities.layer` is used; composed with `createInvoker`, first = outermost. */
  readonly usePlugins: readonly UsePlugin[];
  /** Identity advertised in the MCP `initialize` response. */
  readonly serverInfo: { name: string; version: string };
  /** Stdio in production, an in-memory transport in tests. */
  readonly transport: Transport;
  /** Aborting closes the server and disposes the source. */
  readonly signal: AbortSignal;
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/**
 * D-21. Serves a resolved MCP source behind the `--use` Layer stack as a thin SDK
 * `Server` (not `mcpPlugin.run`, which renames tools and wraps arguments in `{data}`),
 * so an unmodified MCP host sees the upstream tool names, `inputSchema`s and results
 * unchanged.
 *
 * - `tools/list` advertises exactly the upstream tools: names and `inputSchema` verbatim,
 *   `annotations` from the source `hints` (a denied tool is still listed, D-08).
 * - `tools/call` dispatches through `createInvoker(layers)` with a `Call` whose
 *   `operation` is the source operation (id `<server>.<tool>`), `ctx` a fresh
 *   `LayerContext`, `envelope` `{}`, `domainArgs` the FLAT request arguments and
 *   `transport` `'mcp'`; the upstream receives the arguments through the same
 *   positional mapping `dispatch` applies to every hand-built package.
 * - A Layer refusal (an `ApiError` with code `permission_denied`, detected structurally
 *   with `isApiError`) becomes `{isError: true, content: [{type: 'text', text: <reason>}]}`
 *   and the upstream is never called. Any other thrown error becomes an `isError`
 *   result with a generic message. A successful upstream `CallToolResult` (including its
 *   own `isError`) is returned verbatim.
 * - An unknown tool name is a JSON-RPC `InvalidParams` error.
 *
 * Resolves once the server is connected; it then runs until `signal` aborts, at which
 * point the server is closed and `source.dispose()` is called (idempotent). If `signal`
 * is already aborted, or connecting fails, the source is disposed before returning/throwing.
 */
export async function serveMcpPassthrough(options: IPassthroughServerOptions): Promise<void> {
  const { source, usePlugins, serverInfo, transport, signal } = options;
  const hints = source.hints ?? {};

  const byToolName = new Map<string, Operation>();
  for (const op of source.operations) {
    const tail = op.path[op.path.length - 1];
    if (tail) byToolName.set(tail.raw, op);
  }

  const layers = usePlugins.flatMap((plugin) => {
    const cap = plugin.capabilities?.layer;
    return cap ? [adaptCoreLayer(cap)] : [];
  });
  const invoke = createInvoker(layers);
  const invokeOptions = {
    fns: source.pkg.fns,
    createClient: source.pkg.createClient as (e: Record<string, unknown>) => Promise<unknown>,
    schemas: source.pkg.schemas,
  };

  const tools: Tool[] = [...byToolName].map(([name, op]) => {
    const hint = hints[op.id];
    return {
      name,
      inputSchema: op.input as Tool['inputSchema'],
      ...(hint
        ? {
            annotations: {
              ...(hint.readOnly !== undefined ? { readOnlyHint: hint.readOnly } : {}),
              ...(hint.destructive !== undefined ? { destructiveHint: hint.destructive } : {}),
            },
          }
        : {}),
    };
  });

  const server = new Server(serverInfo, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const operation = byToolName.get(name);
    if (!operation) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    try {
      const result = await invoke(
        name,
        {
          operation,
          ctx: new LayerContext(),
          envelope: {},
          domainArgs: request.params.arguments ?? {},
          transport: 'mcp',
          signal,
        },
        invokeOptions
      );
      return result as CallToolResult;
    } catch (e) {
      if (isApiError(e) && e.code === 'permission_denied') return errorResult(e.message);
      return errorResult(GENERIC_FAILURE);
    }
  });

  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    closing ??= (async () => {
      try {
        await server.close();
      } finally {
        await source.dispose();
      }
    })();
    return closing;
  };

  if (signal.aborted) {
    await shutdown();
    return;
  }
  signal.addEventListener('abort', () => void shutdown().catch(() => undefined), { once: true });
  try {
    await server.connect(transport);
  } catch (e) {
    await shutdown().catch(() => undefined);
    throw e;
  }
}
