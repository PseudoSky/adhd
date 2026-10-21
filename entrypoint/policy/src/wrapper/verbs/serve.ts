import { ApiError } from '@adhd/apigen-base-errors';
import { resolveSourceReference } from '@adhd/apigen-core-client';
import {
  createGateway,
  createMcpUpstreamAdapter,
  createStdioHostTransport,
  defaultBackoff,
  nodeSourceProbe,
  serveMcpPassthrough,
} from '@adhd/apigen-engine-gateway';
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
 * contract). The adapter's IR operations are fronted on stdio by
 * `serveMcpPassthrough`, with the gate's Layer stack composed around every call:
 * tool names are the standard BA-1 projection of each operation id, arguments
 * reach the upstream flat and results are the upstream's own. A refusal reaches the
 * host as an MCP tool result with `isError: true` carrying the reason. The process
 * stays up until `deps.signal` aborts or the host closes stdin / the transport;
 * the gateway (and with it the upstream's process group) is stopped in `finally`.
 * Returns 0 on a clean shutdown; a source failure prints its message to stderr
 * and returns its exit code.
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
    const adapter = createMcpUpstreamAdapter(
      // An empty alias makes the gateway default the source name to the command's basename.
      { name: split.name ?? '', transport: { kind: 'stdio', command: resolution.locator.command, args: split.childArgs, cwd: deps.cwd } },
      {
        ...(deps.launcher !== undefined ? { launcher: deps.launcher } : {}),
        ...(deps.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: deps.handshakeTimeoutMs } : {}),
      }
    );
    const gateway = createGateway({
      adapters: [adapter],
      backoff: { delayMs: defaultBackoff.delayMs, maxRestarts: SERVE_MAX_RESTARTS },
    });
    try {
      await gateway.start();
      const server = await serveMcpPassthrough({
        operations: adapter.operations(),
        gateway,
        usePlugins: gate.usePlugins,
        serverInfo: { name: 'adhd-policy', version: readPolicyVersion() },
        transport: deps.hostTransport ?? createStdioHostTransport(),
        signal: deps.signal,
      });
      // Stay up until the signal aborts or the host disconnects.
      await server.closed;
      return 0;
    } finally {
      await gateway.stop();
    }
  } catch (error) {
    return reportFailure(error, deps);
  }
}
