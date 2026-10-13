import { ApiError } from '@adhd/apigen-base-errors';
import { createStdioHostTransport, parseSourceSpec, resolveSource, serveMcpPassthrough } from '@adhd/apigen-engine-gateway';
import { createAttributesSource } from '../attributes-source';
import { splitPolicyArgv } from '../flags';
import { buildGate } from '../gate';
import { readPolicyVersion } from '../package';
import type { IVerbDeps } from './deps';
import { reportFailure } from './failure';

/**
 * `serve <source> [--spec f]... [--adhd-attributes v] [-- args...]` (argv
 * excludes the verb name). Resolves the source for `serve` (D-08: an MCP
 * `initialize` handshake with a bounded timeout, never a silent argv fallback),
 * builds the gate, then fronts the upstream with `serveMcpPassthrough` (D-21:
 * the gateway's SDK server, not `mcpPlugin.run`, so tool names, flat arguments
 * and results reach an unmodified MCP host unchanged) on stdio. The process
 * stays up until `deps.signal` aborts; disposal happens inside
 * `serveMcpPassthrough`. A refusal reaches the host as an MCP tool result with
 * `isError: true` carrying the reason. Returns 0 on a clean shutdown; a source
 * failure prints its message to stderr and returns its exit code.
 */
export async function serveVerb(argv: readonly string[], deps: IVerbDeps & { signal: AbortSignal }): Promise<number> {
  try {
    const split = splitPolicyArgv(argv);
    if (split.positionals.length !== 1) {
      throw new ApiError('invalid_argument', 'usage: adhd-policy serve <source> [--spec <file>]... [--adhd-attributes <json|@file>] [-- <args>...]');
    }
    const spec = parseSourceSpec(split.positionals[0] as string);
    const attributes = createAttributesSource({
      ...(split.attributes !== undefined ? { flag: split.attributes } : {}),
      ...(deps.env['ADHD_POLICY_ATTRIBUTES'] !== undefined ? { env: deps.env['ADHD_POLICY_ATTRIBUTES'] } : {}),
      cwd: deps.cwd,
      ...(deps.readFile !== undefined ? { readFile: deps.readFile } : {}),
    });
    await attributes.read();
    const gate = await buildGate({
      specFiles: split.specFiles,
      cwd: deps.cwd,
      attributes,
      onNote: (line) => deps.stderr(`${line}\n`),
    });
    const resolved = await resolveSource(spec, 'serve', {
      cwd: deps.cwd,
      args: split.childArgs,
      ...(deps.launcher !== undefined ? { launcher: deps.launcher } : {}),
    });
    const server = await serveMcpPassthrough({
      source: resolved,
      usePlugins: gate.usePlugins,
      serverInfo: { name: 'adhd-policy', version: readPolicyVersion() },
      transport: createStdioHostTransport(),
      signal: deps.signal,
    });
    // Stay up until the signal aborts, the host disconnects, or the upstream exits.
    await server.closed;
    return 0;
  } catch (error) {
    return reportFailure(error, deps);
  }
}
