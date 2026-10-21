import { ApiError, isApiError } from '@adhd/apigen-base-errors';
import { resolveSourceReference, type Operation } from '@adhd/apigen-core-client';
import {
  createGateway,
  createMcpUpstreamAdapter,
  createStdioHostTransport,
  defaultBackoff,
  nodeSourceProbe,
  type HostAdapter,
} from '@adhd/apigen-engine-gateway';
import { createLogger, type Terminal } from '@adhd/apigen-engine-runtime';
import { mcpPlugin } from '@adhd/apigen-plugin-mcp';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { attributesFromFlags } from '../attributes-from-flags';
import { splitPolicyArgv } from '../flags';
import { buildGate } from '../gate';
import { readPolicyVersion } from '../package';
import type { IVerbDeps } from './deps';
import { reportFailure } from './failure';

/**
 * How many times the gateway restarts a crashed upstream before parking it as
 * `unavailable` (BA-6). Finite on purpose: the gateway default restarts forever.
 */
export const SERVE_MAX_RESTARTS = 5;

/** JSON-RPC codes the SDK raises locally (connection lost, request timeout); never the upstream's words. */
const LOCAL_ERROR_CODES: ReadonlySet<number> = new Set([ErrorCode.ConnectionClosed, ErrorCode.RequestTimeout]);

/** Generic text a host sees for any failure that is not a refusal or an upstream's own error. */
const GENERIC_FAILURE = 'The tool call failed.';

/**
 * Wraps a host adapter so the verb learns when the gateway's supervision has given up on
 * it. The gateway parks a crashed host as `unavailable` once its restart budget is spent
 * and exposes no signal for that, so the wrapper counts consecutive failed restart
 * attempts (a `start()` that throws, or a `ready()` that resolves `false`, after the host
 * exited) and calls `onExhausted` when the count reaches `maxRestarts`. A restart that
 * becomes ready resets the count. Everything else delegates to `inner` untouched.
 *
 * @param inner The adapter the gateway would supervise.
 * @param maxRestarts The gateway's restart budget for this host.
 * @param onExhausted Called once, when the budget is spent.
 * @returns An adapter with the same host, cost and behaviour as `inner`.
 */
export function watchRestartBudget(inner: HostAdapter, maxRestarts: number, onExhausted: () => void): HostAdapter {
  let exited = false;
  let failures = 0;
  const fail = (): void => {
    failures += 1;
    if (failures === maxRestarts) onExhausted();
  };
  return {
    host: inner.host,
    hopCost: inner.hopCost,
    async start() {
      try {
        await inner.start();
      } catch (error) {
        if (exited) fail();
        throw error;
      }
    },
    async ready() {
      const ok = await inner.ready();
      if (!exited) return ok;
      if (ok) {
        exited = false;
        failures = 0;
      } else {
        fail();
      }
      return ok;
    },
    invoke: (req, signal) => inner.invoke(req, signal),
    onExit: (listener) =>
      inner.onExit((reason) => {
        exited = true;
        failures = 0;
        listener(reason);
      }),
    stop: () => inner.stop(),
  };
}

/** The SDK prefixes `MCP error <code>: `; strip it so re-raising does not double the prefix. */
function upstreamMessage(error: McpError): string {
  return error.message.replace(/^MCP error -?\d+: /, '');
}

/**
 * `serve <source> [--spec f]... [--adhd-attributes v] [--name alias] [-- args...]`
 * (argv excludes the verb name). The source is classified with the core
 * `resolveSourceReference` and must name an executable that speaks MCP over stdio.
 * `--name` is the operation-id prefix (`<alias>/<tool>`, D-08); it defaults to the
 * command's basename and is never the upstream's own `serverInfo.name`.
 *
 * The upstream is an MCP adapter behind a gateway (`createGateway` with a finite
 * restart budget, {@link SERVE_MAX_RESTARTS}); `gateway.start()` performs the
 * `initialize` handshake (D-08: bounded, never a silent argv fallback) and a
 * failed handshake rejects, so the verb exits non-zero (startup-failure
 * contract). The adapter's IR operations are served on stdio by `mcpPlugin.run`
 * with the gate's Layer stack composed around every call and a dispatch terminal
 * that routes each call through `gateway.route`: tool names are the standard BA-1
 * projection of each operation id, arguments reach the upstream flat, results are
 * the upstream's own, and every `ApiError` (a refusal included) reaches the host
 * as an MCP tool result with `isError: true` and its reason (BA-4). An error the
 * upstream itself returned is re-raised to the host with its code and message.
 * The process stays up until `deps.signal` aborts or the host closes stdin / the
 * transport; the gateway (and with it the upstream's process group) is stopped in
 * `finally`. When the upstream exits and {@link SERVE_MAX_RESTARTS} consecutive
 * restarts fail, the verb stops serving and exits non-zero (`internal`) instead
 * of answering `unavailable` indefinitely. Returns 0 on a clean shutdown; a source
 * failure prints its message to stderr and returns its exit code.
 *
 * Accepted risk (O-2): the upstream is spawned at startup, before any gating, to
 * list its tools.
 *
 * @param argv The verb's arguments, without the verb name.
 * @param deps The verb ports; `signal` is required.
 * @returns The process exit code.
 */
export async function serveVerb(argv: readonly string[], deps: IVerbDeps & { signal: AbortSignal }): Promise<number> {
  try {
    const split = splitPolicyArgv(argv);
    if (split.positionals.length !== 1) {
      throw new ApiError('invalid_argument', 'usage: adhd-policy serve <source> [--spec <file>]... [--adhd-attributes <json|@file>] [--name <alias>] [-- <args>...]');
    }
    const reference = resolveSourceReference(split.positionals[0] as string, nodeSourceProbe);
    if (!reference.ok) throw new ApiError('invalid_argument', reference.error.message);
    const resolution = reference.value;
    if (resolution.locator.kind !== 'command' || (resolution.translator ?? 'mcp') !== 'mcp') {
      throw new ApiError('invalid_argument', 'serve needs a bin:<command> source that speaks MCP over stdio');
    }
    const attributes = await attributesFromFlags(split, deps);
    const gate = await buildGate({
      specFiles: split.specFiles,
      cwd: deps.cwd,
      ...(deps.home !== undefined ? { stopAt: deps.home } : {}),
      attributes,
      onNote: (line) => deps.stderr(`${line}\n`),
    });
    const upstream = createMcpUpstreamAdapter(
      // An empty alias makes the gateway default the source name to the command's basename.
      { name: split.name ?? '', transport: { kind: 'stdio', command: resolution.locator.command, args: split.childArgs, cwd: deps.cwd } },
      {
        ...(deps.launcher !== undefined ? { launcher: deps.launcher } : {}),
        ...(deps.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: deps.handshakeTimeoutMs } : {}),
      }
    );
    const exhaustion = new AbortController();
    let exhausted: ApiError | undefined;
    const adapter = watchRestartBudget(upstream, SERVE_MAX_RESTARTS, () => {
      exhausted = new ApiError('internal', `upstream '${upstream.host}' exited and could not be restarted after ${SERVE_MAX_RESTARTS} attempts`);
      exhaustion.abort();
    });
    const gateway = createGateway({
      adapters: [adapter],
      backoff: { delayMs: defaultBackoff.delayMs, maxRestarts: SERVE_MAX_RESTARTS },
    });
    // The innermost step of every call: route to the upstream through the gateway. Only the
    // refusal/ApiError channel and an upstream's own McpError carry words to the host.
    const terminal: Terminal = async (_fnName, call) => {
      try {
        return await gateway.route({ operation: call.operation as unknown as Operation, data: call.domainArgs, envelope: call.envelope, transport: 'mcp' }, call.signal);
      } catch (error) {
        if (isApiError(error)) throw error;
        const kind = error instanceof Error ? error.name : typeof error;
        const code = (error as { code?: unknown } | null)?.code;
        deps.stderr(
          `apigen-gateway: tool call failed: operation=${call.operation.id} error=${kind}${typeof code === 'number' || typeof code === 'string' ? ` code=${String(code)}` : ''}\n`
        );
        if (error instanceof McpError && !LOCAL_ERROR_CODES.has(error.code)) {
          throw new McpError(error.code, upstreamMessage(error), error.data);
        }
        throw new ApiError('internal', GENERIC_FAILURE);
      }
    };
    try {
      await gateway.start();
      await mcpPlugin.run?.({
        packages: [],
        outputDir: '',
        operations: [...upstream.operations()],
        logger: createLogger({ level: 'silent' }),
        signal: AbortSignal.any([deps.signal, exhaustion.signal]),
        options: {
          transport: 'stdio',
          hostTransport: deps.hostTransport ?? createStdioHostTransport(),
          serverInfo: { name: 'adhd-policy', version: readPolicyVersion() },
          usePlugins: gate.usePlugins,
          terminal,
        },
      });
      if (exhausted !== undefined) throw exhausted;
      return 0;
    } finally {
      await gateway.stop();
    }
  } catch (error) {
    return reportFailure(error, deps);
  }
}
