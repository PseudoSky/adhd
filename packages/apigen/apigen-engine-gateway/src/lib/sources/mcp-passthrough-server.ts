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
import { adaptCoreLayer, LayerContext } from '@adhd/apigen-engine-runtime';
import type { Call, Next, UsePlugin } from '@adhd/apigen-engine-runtime';
import type { IResolvedSource } from './types';

/** Generic text returned for any non-refusal failure; internals are never leaked to the host. */
const GENERIC_FAILURE = 'The tool call failed.';

/** JSON-RPC codes the SDK itself raises locally (connection lost, request timeout); never the upstream's words. */
const LOCAL_ERROR_CODES: ReadonlySet<number> = new Set([ErrorCode.ConnectionClosed, ErrorCode.RequestTimeout]);

/** Where a non-refusal failure happened. Carries no argument values. */
export interface IPassthroughErrorContext {
  /** The upstream tool name. */
  readonly tool: string;
  /** The operation id (`<source>.<tool>`) the Layer saw. */
  readonly operationId: string;
}

/** Options for {@link serveMcpPassthrough}. */
export interface IPassthroughServerOptions {
  /** The resolved upstream MCP source (`resolveSource(spec, 'serve', ...)`); it must carry `mcp`. */
  readonly source: IResolvedSource;
  /** Only each plugin's `capabilities.layer` is used; composed first = outermost. */
  readonly usePlugins: readonly UsePlugin[];
  /** Identity advertised in the MCP `initialize` response. */
  readonly serverInfo: { name: string; version: string };
  /** Stdio in production, an in-memory transport in tests. */
  readonly transport: Transport;
  /** Aborting closes the server and disposes the source. */
  readonly signal: AbortSignal;
  /**
   * Receives every failure other than a Layer refusal (the host only sees generic text).
   * Defaults to one stderr line carrying the tool name and error class, never argument values.
   */
  readonly onError?: (error: unknown, ctx: IPassthroughErrorContext) => void;
}

/** Handle returned once the server is connected. */
export interface IPassthroughServer {
  /** Resolves after the server has closed and the source was disposed (host disconnect, upstream exit, or `signal`). */
  readonly closed: Promise<void>;
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function defaultOnError(error: unknown, ctx: IPassthroughErrorContext): void {
  const kind = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  process.stderr.write(
    `apigen-gateway: tool call failed: tool=${ctx.tool} error=${kind}${typeof code === 'number' || typeof code === 'string' ? ` code=${String(code)}` : ''}\n`
  );
}

/** The SDK prefixes `MCP error <code>: `; strip it so re-raising does not double the prefix. */
function upstreamMessage(e: McpError): string {
  return e.message.replace(/^MCP error -?\d+: /, '');
}

/**
 * D-21. Serves a resolved MCP source behind the `--use` Layer stack as a thin SDK
 * `Server` (not `mcpPlugin.run`, which renames tools and wraps arguments in `{data}`),
 * so an unmodified MCP host sees the upstream's tools and results unchanged.
 *
 * - `tools/list` advertises the FULL upstream `Tool` objects (name, title, description,
 *   inputSchema, outputSchema, annotations) as the upstream sent them. A denied tool is
 *   still listed (D-08).
 * - `tools/call` runs the Layer stack (`adaptCoreLayer`, first = outermost) around a final
 *   step that calls the upstream with the request's arguments VERBATIM (undeclared
 *   properties included; no schema-property mapping, no validate layer). The Layer sees a
 *   `Call` whose `operation` is the source operation (id `<source>.<tool>`), `ctx` a fresh
 *   `LayerContext`, `envelope` `{}`, `domainArgs` the same flat arguments object,
 *   `transport` `'mcp'`, and `signal` aborting on either `options.signal` or the host
 *   cancelling this request.
 * - A Layer refusal (an `ApiError` with code `permission_denied`) becomes
 *   `{isError: true, content: [{type: 'text', text: <reason>}]}` and the upstream is never
 *   called. An error the upstream itself returned (an SDK `McpError` with a non-local code)
 *   is re-raised to the host with the upstream's code and message verbatim. Any other
 *   failure becomes an `isError` result with generic text. Every non-refusal failure is
 *   passed to `options.onError`. A successful upstream result is returned verbatim.
 * - An unknown tool name is a JSON-RPC `InvalidParams` error.
 *
 * Lifecycle: the server shuts down (closes, disposes the source) when `signal` aborts, when
 * the host closes the transport, or when the upstream connection closes on its own. If
 * `signal` is already aborted, or connecting fails, the source is disposed before
 * returning/throwing. Resolves once connected with a handle whose `closed` settles after
 * shutdown.
 */
export async function serveMcpPassthrough(options: IPassthroughServerOptions): Promise<IPassthroughServer> {
  const { source, usePlugins, serverInfo, transport, signal } = options;
  const onError = options.onError ?? defaultOnError;
  const upstream = source.mcp;
  if (!upstream) {
    await source.dispose().catch(() => undefined);
    throw new TypeError('serveMcpPassthrough: the source is not an MCP source (resolve it with intent "serve")');
  }

  const byToolName = new Map<string, Operation>();
  for (const op of source.operations) {
    const tail = op.path[op.path.length - 1];
    if (tail) byToolName.set(tail.raw, op);
  }

  const layers = usePlugins.flatMap((plugin) => {
    const cap = plugin.capabilities?.layer;
    return cap ? [adaptCoreLayer(cap)] : [];
  });

  const tools: Tool[] = [...upstream.tools.values()];

  const server = new Server(serverInfo, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const name = request.params.name;
    const operation = byToolName.get(name);
    if (!operation || !upstream.tools.has(name)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    const rawArguments = request.params.arguments;
    const callSignal = AbortSignal.any([signal, extra.signal]);
    const call: Call = {
      operation,
      ctx: new LayerContext(),
      envelope: {},
      domainArgs: rawArguments ?? {},
      transport: 'mcp',
      signal: callSignal,
    };
    const final: Next = () => upstream.callTool(name, rawArguments, callSignal);
    const composed = layers.reduceRight<Next>((inner, layer) => () => layer(call, inner), final);
    try {
      return (await composed()) as CallToolResult;
    } catch (e) {
      if (isApiError(e) && e.code === 'permission_denied') return errorResult(e.message);
      try {
        onError(e, { tool: name, operationId: operation.id });
      } catch {
        // a faulty reporter must not change what the host sees
      }
      if (e instanceof McpError && !LOCAL_ERROR_CODES.has(e.code)) {
        throw new McpError(e.code, upstreamMessage(e), e.data);
      }
      return errorResult(GENERIC_FAILURE);
    }
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    closing ??= (async () => {
      try {
        await server.close();
      } catch {
        // already closed by the host side
      } finally {
        await source.dispose().catch(() => undefined);
        resolveClosed();
      }
    })();
    return closing;
  };

  // The host closed the transport (or it failed): follow it down rather than leak the upstream.
  server.onclose = () => void shutdown();
  // The upstream process exited or its connection dropped: the host must see a disconnect.
  upstream.onClose(() => void shutdown());

  if (signal.aborted) {
    await shutdown();
    return { closed };
  }
  signal.addEventListener('abort', () => void shutdown(), { once: true });
  try {
    await server.connect(transport);
  } catch (e) {
    await shutdown();
    throw e;
  }
  return { closed };
}
