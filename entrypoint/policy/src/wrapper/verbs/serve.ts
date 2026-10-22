import { ApiError, isApiError } from '@adhd/apigen-base-errors';
import { resolveSourceReference, type Operation } from '@adhd/apigen-core-client';
import {
  createGateway,
  createMcpUpstreamAdapter,
  createStdioHostTransport,
  defaultBackoff,
  DEFAULT_CALL_TIMEOUT_MS,
  GENERIC_FAILURE,
  nodeSourceProbe,
  upstreamErrorForHost,
  type HostAdapter,
} from '@adhd/apigen-engine-gateway';
import { createLogger, type Terminal } from '@adhd/apigen-engine-runtime';
import { mcpPlugin } from '@adhd/apigen-plugin-mcp';
import { attributesFromFlags } from '../attributes-from-flags';
import { splitPolicyArgv } from '../flags';
import { buildGate } from '../gate';
import { readPolicyVersion } from '../package';
import type { IVerbDeps } from './deps';
import { reportFailure } from './failure';

/**
 * The restart budget of the supervised upstream (BA-6): the most restarts allowed within
 * {@link SERVE_RESTART_WINDOW_MS}, and also the most consecutive failed restart attempts.
 * Finite on purpose: the gateway default restarts forever.
 */
export const SERVE_MAX_RESTARTS = 5;

/** Length of the rolling window in which at most {@link SERVE_MAX_RESTARTS} upstream restarts are allowed. */
export const SERVE_RESTART_WINDOW_MS = 60_000;

/** Optional knobs of {@link watchRestartBudget}. */
export interface IRestartBudgetOptions {
  /** Rolling window for the restart count. Default {@link SERVE_RESTART_WINDOW_MS}. */
  readonly windowMs?: number;
  /** Clock in epoch milliseconds; injected by tests. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Wraps a host adapter so the verb learns when the gateway's supervision has given up on
 * it. The gateway restarts a crashed host with an attempt counter that starts over at every
 * crash and parks the host as `unavailable` only when one outage spends its budget, and it
 * exposes no signal for that, so the wrapper enforces two bounds and calls `onExhausted`
 * (once) when either is hit:
 *
 * - consecutive failed restart attempts (a `start()` that throws, or a `ready()` that
 *   resolves `false`, after the host exited) reach `maxRestarts`; a restart that becomes
 *   ready resets this count;
 * - upstream exits within the rolling `windowMs` exceed `maxRestarts`, i.e. the host has been
 *   restarted `maxRestarts` times in the window and exited again. A restart that becomes
 *   ready does not reset this count, so a host that comes up and crashes again in a loop is
 *   bounded too.
 *
 * Everything else delegates to `inner` untouched.
 *
 * @param inner The adapter the gateway would supervise.
 * @param maxRestarts The restart budget for this host.
 * @param onExhausted Called once, when the budget is spent.
 * @param options Window length and clock.
 * @returns An adapter with the same host, cost and behaviour as `inner`.
 */
export function watchRestartBudget(
  inner: HostAdapter,
  maxRestarts: number,
  onExhausted: () => void,
  options: IRestartBudgetOptions = {}
): HostAdapter {
  const windowMs = options.windowMs ?? SERVE_RESTART_WINDOW_MS;
  const now = options.now ?? Date.now;
  let exited = false;
  let failures = 0;
  let spent = false;
  const exitTimes: number[] = [];
  const exhaust = (): void => {
    if (spent) return;
    spent = true;
    onExhausted();
  };
  const fail = (): void => {
    failures += 1;
    if (failures === maxRestarts) exhaust();
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
        const at = now();
        exitTimes.push(at);
        while (exitTimes.length > 0 && at - (exitTimes[0] as number) > windowMs) exitTimes.shift();
        if (exitTimes.length > maxRestarts) exhaust();
        listener(reason);
      }),
    stop: () => inner.stop(),
  };
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
 * `finally`. When the upstream spends its restart budget ({@link watchRestartBudget}:
 * {@link SERVE_MAX_RESTARTS} consecutive failed restarts, or more than that many exits within
 * {@link SERVE_RESTART_WINDOW_MS}), the verb stops serving and exits non-zero (`internal`) instead
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
      exhausted = new ApiError('internal', `upstream '${upstream.host}' exited and exceeded its restart budget (${SERVE_MAX_RESTARTS} restarts within ${SERVE_RESTART_WINDOW_MS / 1000}s, or ${SERVE_MAX_RESTARTS} consecutive failed restarts)`);
      exhaustion.abort();
    });
    const gateway = createGateway({
      adapters: [adapter],
      backoff: { delayMs: defaultBackoff.delayMs, maxRestarts: SERVE_MAX_RESTARTS },
      // The adapter bounds each upstream call by DEFAULT_CALL_TIMEOUT_MS; the gateway's own deadline must not cut it short.
      defaultDeadlineMs: DEFAULT_CALL_TIMEOUT_MS,
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
        const upstreamError = upstreamErrorForHost(error);
        if (upstreamError !== undefined) throw upstreamError;
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
