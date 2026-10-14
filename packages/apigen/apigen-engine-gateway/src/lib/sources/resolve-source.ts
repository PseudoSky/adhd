import { composeSchemas } from '@adhd/apigen-core-client';
import { buildArgvOperation, createArgvInvoker } from './argv-operation';
import { commandBaseName } from './command-name';
import { resolveMcpStdioSource } from './mcp-source';
import { nodeProcessLauncher } from './process';
import type { IProcessLauncher } from './process';
import { SourceError } from './types';
import type { IResolvedSource, SourceIntent, SourceSpec } from './types';

/** Dependencies of {@link resolveSource}. */
export interface IResolveDeps {
  /** Defaults to {@link nodeProcessLauncher}; a sandbox supplies a confining one. */
  readonly launcher?: IProcessLauncher;
  /** Working directory for a process started by `serve`. */
  readonly cwd: string;
  /** Arguments passed to the command by `serve` (never through a shell). Ignored by `run`. */
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly handshakeTimeoutMs?: number;
  /**
   * `serve`: the source name used as the operation-id prefix (`<name>.<tool>`). Defaults to
   * the command basename; it is never taken from the upstream's own `serverInfo.name`.
   */
  readonly name?: string;
  /** `serve`: per-call wait for an upstream result (default 120000 ms). */
  readonly callTimeoutMs?: number;
  /** `serve`: receives one line per upstream tool that was skipped (default: stderr). */
  readonly onWarn?: (line: string) => void;
  /** `run`: wall-clock limit for the argv invocation (default 120000 ms; 0 disables). */
  readonly argvTimeoutMs?: number;
  /** `run`: cancels the argv invocation (kills the process group). */
  readonly signal?: AbortSignal;
}

/**
 * Resolve a source to the `{pkg, operations}` pair an apigen host consumes.
 * `bin` + `run` -> the argv operation (D-07); the process is NOT started until the
 * operation is invoked.
 * `serve` operation ids are `<name>.<tool>` with `name` = `deps.name` or the command basename. `bin` + `serve` -> {@link resolveMcpStdioSource} (D-08); this
 * starts the process now (explicit serve) and a failed handshake is an error, never an
 * argv fallback. `remote` -> `SourceError('unsupported')` (tracked separately); `file` ->
 * `SourceError('unsupported')` (resolved by apigen-cli).
 */
export async function resolveSource(
  spec: SourceSpec,
  intent: SourceIntent,
  deps: IResolveDeps
): Promise<IResolvedSource> {
  switch (spec.kind) {
    case 'remote':
      throw new SourceError('unsupported', 'remote sources are not implemented');
    case 'file':
      throw new SourceError('unsupported', 'file sources are resolved by apigen-cli');
    case 'bin': {
      const launcher = deps.launcher ?? nodeProcessLauncher;
      if (intent === 'serve') {
        return resolveMcpStdioSource(
          {
            command: spec.command,
            args: deps.args ?? [],
            cwd: deps.cwd,
            ...(deps.env ? { env: deps.env } : {}),
            ...(deps.name !== undefined ? { name: deps.name } : {}),
          },
          {
            launcher,
            ...(deps.callTimeoutMs !== undefined ? { callTimeoutMs: deps.callTimeoutMs } : {}),
            ...(deps.onWarn !== undefined ? { onWarn: deps.onWarn } : {}),
            ...(deps.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: deps.handshakeTimeoutMs } : {}),
          }
        );
      }
      const { operation, fnName } = buildArgvOperation(spec.command);
      const invoke = createArgvInvoker(spec.command, launcher, {
        ...(deps.argvTimeoutMs !== undefined ? { timeoutMs: deps.argvTimeoutMs } : {}),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      const schemas = composeSchemas(
        {
          metadata: { namespace: fnName, phase: '' },
          schemas: { [fnName]: { input: operation.input, output: operation.output, safe: false } },
        },
        []
      );
      return {
        sourceId: `bin:${commandBaseName(spec.command)}`,
        operations: [operation],
        pkg: {
          id: fnName,
          version: '0.0.0',
          schemas,
          importPath: `bin:${spec.command}`,
          // apigen dispatch calls fns positionally in `input.properties` order: argv, cwd.
          fns: {
            [fnName]: (argv: unknown, cwd: unknown) =>
              invoke({ argv: argv as string[], cwd: cwd as string }),
          },
          createClient: async () => undefined,
        },
        dispose: async () => undefined,
      };
    }
  }
}
