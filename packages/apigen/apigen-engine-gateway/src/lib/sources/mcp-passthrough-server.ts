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
import { ApiError, isApiError } from '@adhd/apigen-base-errors';
import { adaptCoreLayer, buildOpPlan, LayerContext } from '@adhd/apigen-engine-runtime';
import type { Call, Next, UsePlugin } from '@adhd/apigen-engine-runtime';
import type { Gateway } from '../gateway';

/** Generic text returned for any non-refusal failure; internals are never leaked to the host. */
const GENERIC_FAILURE = 'The tool call failed.';

/** JSON-RPC codes the SDK itself raises locally (connection lost, request timeout); never the upstream's words. */
const LOCAL_ERROR_CODES: ReadonlySet<number> = new Set([ErrorCode.ConnectionClosed, ErrorCode.RequestTimeout]);

/** Where a non-refusal failure happened. Carries no argument values. */
export interface IPassthroughErrorContext {
  /** The upstream tool name. */
  readonly tool: string;
  /** The operation id (`<source>/<tool>`) the Layer saw. */
  readonly operationId: string;
}

/** Options for {@link serveMcpPassthrough}. */
export interface IPassthroughServerOptions {
  /**
   * The IR operations to serve, each carrying the `binding` the gateway routes it by
   * (`mcp:<source>` for an upstream tool, `bin:<base>` for the argv operation). Tool names are
   * the standard BA-1 projection of each operation (`<namespace>_<path>` joined with `_`).
   */
  readonly operations: readonly Operation[];
  /**
   * The started gateway holding one adapter per binding. The caller owns it: start it before
   * serving and stop it after `closed` settles (`try { await gateway.start(); ... } finally {
   * await gateway.stop(); }`), with a finite `backoff.maxRestarts` so a dead upstream is not
   * restarted forever.
   */
  readonly gateway: Gateway;
  /** Only each plugin's `capabilities.layer` is used; composed first = outermost. */
  readonly usePlugins: readonly UsePlugin[];
  /** Identity advertised in the MCP `initialize` response. */
  readonly serverInfo: { name: string; version: string };
  /** Stdio in production, an in-memory transport in tests. */
  readonly transport: Transport;
  /** Aborting closes the server. */
  readonly signal: AbortSignal;
  /**
   * Receives every failure other than a Layer refusal (the host only sees generic text).
   * Defaults to one stderr line carrying the tool name and error class, never argument values.
   */
  readonly onError?: (error: unknown, ctx: IPassthroughErrorContext) => void;
}

/** Handle returned once the server is connected. */
export interface IPassthroughServer {
  /** Resolves after the server has closed (host disconnect or `signal`). */
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

function isCallToolResult(value: unknown): value is CallToolResult {
  return typeof value === 'object' && value !== null && Array.isArray((value as { content?: unknown }).content);
}

/** The result shape of the argv operation (`{exitCode, stdout, stderr, signal?}`). */
function isArgvResult(value: unknown): value is { exitCode: number; stdout: string; stderr: string; signal?: string } {
  const v = value as { exitCode?: unknown; stdout?: unknown; stderr?: unknown } | null;
  return (
    typeof v === 'object' && v !== null && typeof v.exitCode === 'number' && typeof v.stdout === 'string' && typeof v.stderr === 'string'
  );
}

/**
 * Shapes what a gateway route resolved with into a `CallToolResult`. A `CallToolResult` (an
 * MCP upstream's answer) passes through verbatim. The argv operation's `{exitCode, stdout,
 * stderr}` becomes its stdout as text, its stderr as a second text block when non-empty, and
 * `isError` when the process exited non-zero or was ended by a signal. Anything else is
 * serialised as JSON text.
 */
function toToolResult(result: unknown): CallToolResult {
  if (isCallToolResult(result)) return result;
  if (isArgvResult(result)) {
    const content: CallToolResult['content'] = [];
    if (result.stdout.length > 0) content.push({ type: 'text', text: result.stdout });
    if (result.stderr.length > 0) content.push({ type: 'text', text: result.stderr });
    const failed = result.exitCode !== 0 || result.signal !== undefined;
    if (failed) {
      content.push({ type: 'text', text: `exit code ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ''}` });
    }
    return { content, ...(failed ? { isError: true } : {}) };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
}

/**
 * D-21 / O-8. Serves IR operations plus a gateway as an MCP server behind the `--use` Layer
 * stack: the degenerate proxy target (source protocol equals target protocol) of
 * `adhd-policy serve bin:<executable>`. It consumes operations and a gateway, never a live
 * resolved source: the upstream (an MCP server, or the argv operation of a plain executable)
 * lives behind a `HostAdapter` the gateway routes to by `operation.binding ?? operation.host`.
 *
 * - `tools/list` advertises one tool per operation. Its name is the standard BA-1 projection
 *   (`buildOpPlan(...).mcp.name`, e.g. `fs_read_file` for `fs/read-file`), its `inputSchema` the
 *   operation's `input`, and its `title` and `annotations` the operation's `tool` metadata when
 *   present. A denied tool is still listed (D-08).
 * - `tools/call` runs the Layer stack (`adaptCoreLayer`, first = outermost) around a final step
 *   that routes through `gateway.route` with the request's arguments VERBATIM as `data`
 *   (undeclared properties included; no validate layer). The Layer sees a `Call` whose
 *   `operation` is the IR operation, `ctx` a fresh `LayerContext`, `envelope` `{}`,
 *   `domainArgs` the same flat arguments object, `transport` `'mcp'`, and `signal` aborting on
 *   either `options.signal` or the host cancelling this request.
 * - A Layer refusal (an `ApiError` with code `permission_denied`) becomes
 *   `{isError: true, content: [{type: 'text', text: <reason>}]}` and the gateway is never
 *   called. An error the upstream itself returned (an SDK `McpError` with a non-local code) is
 *   re-raised to the host with the upstream's code and message verbatim. Any other failure
 *   (including a gateway `unavailable` / `deadline_exceeded`) becomes an `isError` result with
 *   generic text. Every non-refusal failure is passed to `options.onError`. A successful
 *   result is shaped by {@link toToolResult}.
 * - An unknown tool name is a JSON-RPC `InvalidParams` error.
 *
 * Lifecycle: the server closes when `signal` aborts or the host closes the transport. The
 * gateway is the caller's: upstream exits are the gateway's supervision (a crashed upstream
 * is `unavailable` until restarted), and the caller stops the gateway after `closed` settles.
 * If `signal` is already aborted, nothing is connected. Resolves once connected with a handle
 * whose `closed` settles after shutdown.
 *
 * @throws ApiError(`invalid_argument`) when two operations project to the same tool name.
 */
export async function serveMcpPassthrough(options: IPassthroughServerOptions): Promise<IPassthroughServer> {
  const { operations, gateway, usePlugins, serverInfo, transport, signal } = options;
  const onError = options.onError ?? defaultOnError;

  const byToolName = new Map<string, Operation>();
  const tools: Tool[] = [];
  for (const operation of operations) {
    const name = buildOpPlan({ op: operation, transport: 'mcp' }).mcp.name;
    const clash = byToolName.get(name);
    if (clash !== undefined) {
      throw new ApiError(
        'invalid_argument',
        `operations ${JSON.stringify(clash.id)} and ${JSON.stringify(operation.id)} both project to the tool name ${JSON.stringify(name)}`
      );
    }
    byToolName.set(name, operation);
    tools.push({
      name,
      inputSchema: operation.input as Tool['inputSchema'],
      ...(operation.tool?.title !== undefined ? { title: operation.tool.title } : {}),
      ...(operation.tool?.annotations !== undefined ? { annotations: operation.tool.annotations as Tool['annotations'] } : {}),
    });
  }

  const layers = usePlugins.flatMap((plugin) => {
    const cap = plugin.capabilities?.layer;
    return cap ? [adaptCoreLayer(cap)] : [];
  });

  const server = new Server(serverInfo, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const name = request.params.name;
    const operation = byToolName.get(name);
    if (!operation) {
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
    // The Layers see (and may mutate, e.g. a policy `set`) `call.domainArgs`; what the upstream
    // receives is that same object, so a forced value reaches it even when the host sent no
    // `arguments`.
    const final: Next = () =>
      gateway.route({ operation, data: call.domainArgs, envelope: call.envelope, transport: 'mcp' }, callSignal);
    const composed = layers.reduceRight<Next>((inner, layer) => () => layer(call, inner), final);
    try {
      return toToolResult(await composed());
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
        resolveClosed();
      }
    })();
    return closing;
  };

  // The host closed the transport (or it failed): follow it down.
  server.onclose = () => void shutdown();

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
