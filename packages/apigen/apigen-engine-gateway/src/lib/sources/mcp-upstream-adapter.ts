import { ApiError } from '@adhd/apigen-base-errors';
import type { Operation } from '@adhd/apigen-core-client';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { makeDeadlineExceededError, makeUnavailableError } from '../gateway';
import type { HostAdapter, HostRequest } from '../gateway';
import { sourceNameOf } from './command-name';
import {
  DEFAULT_CALL_TIMEOUT_MS,
  mcpBindingOf,
  openMcpStdioUpstream,
  operationsFromMcpTools,
} from './mcp-source';
import type { IOpenedMcpUpstream } from './mcp-source';
import { nodeProcessLauncher } from './process';
import type { IProcessLauncher } from './process';
import type { ISkippedTool } from './types';

/** How an MCP upstream is reached. Only `stdio` is implemented; `http` is out of the slice (O-6). */
export type IMcpUpstreamTransport =
  | {
      readonly kind: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
      readonly env?: Record<string, string>;
    }
  | { readonly kind: 'http'; readonly url: string };

/** One upstream MCP server to front through the gateway. */
export interface IMcpUpstreamSpec {
  /**
   * The user-chosen source alias: the operation-id namespace (`<name>/<tool>`) and the binding
   * key (`mcp:<name>`). Normalised to `[a-z0-9_-]`; never the upstream's own `serverInfo.name`.
   */
  readonly name: string;
  readonly transport: IMcpUpstreamTransport;
}

/** Dependencies of {@link createMcpUpstreamAdapter}. */
export interface IMcpUpstreamDeps {
  /** Defaults to {@link nodeProcessLauncher}; a sandbox supplies a confining one. */
  readonly launcher?: IProcessLauncher;
  /** Bound on `initialize` and `tools/list` (default 10000 ms) and on each readiness `ping`. */
  readonly handshakeTimeoutMs?: number;
  /** This adapter's own per-call deadline (default 120000 ms); the gateway's default must be at least this. */
  readonly callTimeoutMs?: number;
  /** One line per upstream tool that was not exposed (default: stderr). */
  readonly onWarn?: (line: string) => void;
}

/** The {@link HostAdapter} of one MCP upstream (`host` = `mcp:<name>`, `hopCost` 1). */
export interface IMcpUpstreamAdapter extends HostAdapter {
  /** The normalised source alias (the part after `mcp:`). */
  readonly sourceName: string;
  /** The upstream tools exposed by the first successful `start()`; empty before it. */
  tools(): readonly Tool[];
  /** The IR operations (`<name>/<tool>`, `binding: 'mcp:<name>'`) of the first successful `start()`; empty before it. */
  operations(): readonly Operation[];
  /** The tools the first successful `start()` did not expose, with the reason. */
  skipped(): readonly ISkippedTool[];
}

/**
 * Create the {@link HostAdapter} of one MCP upstream, registered with `createGateway` under the
 * binding key `mcp:<name>` (so two upstreams coexist in one gateway; the gateway routes by
 * `operation.binding ?? operation.host`).
 *
 * - `start()` spawns the process through the launcher, performs `initialize` and reads
 *   `tools/list`, translating it with {@link operationsFromMcpTools}. Idempotent while the
 *   connection is up; after the upstream exits it respawns (the gateway's supervision calls it
 *   again). A failed start rejects with `makeUnavailableError('mcp:<name>', '(start)', reason)`
 *   and fires no `onExit` listener (startup-failure contract).
 * - `ready()` is true while connected and an MCP `ping` round-trips.
 * - `invoke(req, signal)` sends `tools/call {name, arguments: req.data}` with the arguments
 *   exactly as given (undeclared keys survive) and returns the upstream's `CallToolResult`
 *   verbatim. `signal` cancels the in-flight request; a call outliving `callTimeoutMs` rejects
 *   with `deadline_exceeded`; a dropped connection rejects with `unavailable`; an error the
 *   upstream itself returned rejects with the SDK `McpError` unchanged.
 * - `onExit` fires only for an exit after a successful `start()`.
 * - `stop()` closes the client and kills the process group.
 *
 * @param spec - The upstream: alias and transport.
 * @param deps - Launcher, timeouts and the warning sink.
 * @throws ApiError(`invalid_argument`) for a transport other than `stdio`.
 */
export function createMcpUpstreamAdapter(
  spec: IMcpUpstreamSpec,
  deps: IMcpUpstreamDeps = {}
): IMcpUpstreamAdapter {
  if (spec.transport.kind !== 'stdio') {
    throw new ApiError(
      'invalid_argument',
      `MCP upstream ${JSON.stringify(spec.name)}: the ${spec.transport.kind} transport is not supported yet`
    );
  }
  const transport = spec.transport;
  const sourceName = sourceNameOf(transport.command, spec.name);
  const host = mcpBindingOf(sourceName);
  const launcher = deps.launcher ?? nodeProcessLauncher;
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const onWarn = deps.onWarn ?? ((line: string) => void process.stderr.write(`${line}\n`));

  let upstream: IOpenedMcpUpstream | undefined;
  let starting: Promise<void> | undefined;
  let stopped = false;
  let translated = false;
  let toolList: Tool[] = [];
  let operationList: Operation[] = [];
  let skippedList: ISkippedTool[] = [];
  const exitListeners = new Set<(reason: unknown) => void>();

  async function open(): Promise<void> {
    if (stopped) throw makeUnavailableError(host, '(start)', 'adapter stopped');
    if (upstream !== undefined && !upstream.isClosed()) return;
    const opened = await openMcpStdioUpstream(
      {
        command: transport.command,
        args: transport.args,
        cwd: transport.cwd,
        ...(transport.env ? { env: transport.env } : {}),
      },
      host,
      {
        launcher,
        ...(deps.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: deps.handshakeTimeoutMs } : {}),
        callTimeoutMs,
      }
    );
    if (stopped) {
      await opened.dispose();
      throw makeUnavailableError(host, '(start)', 'adapter stopped during start');
    }
    if (!translated) {
      const translation = operationsFromMcpTools(opened.rawTools, sourceName, onWarn);
      toolList = [...translation.tools.values()];
      operationList = translation.operations;
      skippedList = translation.skipped;
      translated = true;
    }
    upstream = opened;
    // Registered only now, after start succeeded: an exit during a failed start fires nothing.
    opened.onClose(() => {
      if (upstream !== opened) return;
      upstream = undefined;
      if (stopped) return;
      for (const listener of [...exitListeners]) listener(new Error(`MCP upstream ${host} closed`));
    });
  }

  function toolNameOf(operation: Operation): string {
    const tail = operation.path[operation.path.length - 1]?.raw;
    if (tail === undefined) {
      throw new ApiError('invalid_argument', `operation ${JSON.stringify(operation.id)} has no tool name`);
    }
    return tail;
  }

  return {
    host,
    hopCost: 1,
    sourceName,
    tools: () => toolList,
    operations: () => operationList,
    skipped: () => skippedList,

    start() {
      starting ??= open().finally(() => {
        starting = undefined;
      });
      return starting;
    },

    async ready() {
      const current = upstream;
      if (current === undefined || current.isClosed()) return false;
      try {
        await current.ping();
        return true;
      } catch {
        return false;
      }
    },

    async invoke(req: HostRequest, signal: AbortSignal) {
      const current = upstream;
      if (current === undefined || current.isClosed()) {
        throw makeUnavailableError(host, req.operation.id, 'upstream not connected');
      }
      const tool = toolNameOf(req.operation);
      try {
        return await current.callTool(tool, req.data, signal);
      } catch (e) {
        // The SDK wraps a caller abort as McpError(RequestTimeout); a cancellation is not a deadline.
        if (signal.aborted) throw e;
        if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) {
          throw makeDeadlineExceededError(host, req.operation.id, callTimeoutMs);
        }
        if (e instanceof McpError && e.code === ErrorCode.ConnectionClosed) {
          throw makeUnavailableError(host, req.operation.id, 'upstream connection closed');
        }
        throw e;
      }
    },

    onExit(listener) {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    },

    async stop() {
      stopped = true;
      exitListeners.clear();
      const current = upstream;
      upstream = undefined;
      await current?.dispose();
    },
  };
}
