import { ApiError } from '@adhd/apigen-base-errors';
import { composeSchemas } from '@adhd/apigen-core-client';
import type { ISourceResolution, TranslatorId } from '@adhd/apigen-core-client';
import { buildArgvOperation, createArgvInvoker } from './argv-operation';
import { commandBaseName } from './command-name';
import { resolveMcpStdioSource } from './mcp-source';
import { nodeProcessLauncher } from './process';
import type { IProcessLauncher } from './process';
import type { IResolvedSource, SourceIntent } from './types';

/** Dependencies of {@link resolveSource}. */
export interface IResolveDeps {
  /** Defaults to {@link nodeProcessLauncher}; a sandbox supplies a confining one. */
  readonly launcher?: IProcessLauncher;
  /**
   * Fills an unset `resolution.translator` only: `run` -> `argv`, `serve` -> `mcp`. A
   * translator the resolution already names always wins.
   */
  readonly intent?: SourceIntent;
  /** Working directory for a process started by the `mcp` translator. */
  readonly cwd: string;
  /** `mcp`: arguments passed to the command (never through a shell). Ignored by `argv`. */
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly handshakeTimeoutMs?: number;
  /**
   * `mcp`: the source name used as the operation-id namespace (`<name>/<tool>`) and binding key (`mcp:<name>`). Defaults to
   * the command basename; it is never taken from the upstream's own `serverInfo.name`.
   */
  readonly name?: string;
  /** `mcp`: per-call wait for an upstream result (default 120000 ms). */
  readonly callTimeoutMs?: number;
  /** `mcp`: receives one line per upstream tool that was skipped (default: stderr). */
  readonly onWarn?: (line: string) => void;
  /** `argv`: wall-clock limit for the argv invocation (default 120000 ms; 0 disables). */
  readonly argvTimeoutMs?: number;
  /** `argv`: cancels the argv invocation (kills the process group). */
  readonly signal?: AbortSignal;
}

/**
 * Resolve a classified source reference to the `{pkg, operations}` pair an apigen host
 * consumes. Keyed by **translator** (gap analysis §3e):
 *
 * - the translator is `resolution.translator`; only when it is unset (an executable with no
 *   `protocol` option) does `deps.intent` fill it in: `run` -> `argv`, `serve` -> `mcp`.
 * - `argv` -> the argv operation (D-07); the process is NOT started until the operation is
 *   invoked.
 * - `mcp` -> {@link resolveMcpStdioSource} (D-08); this starts the process now and a failed
 *   start or handshake is `makeUnavailableError('mcp:<name>', '(start)', reason)`, never an
 *   argv fallback. Operation ids are `<name>/<tool>` with `name` = `deps.name` or the
 *   command basename.
 * - any other translator (code, schema documents) -> `ApiError('invalid_argument')`: those
 *   sources are served by adhd-apigen. An unset translator with no intent, or an `argv` /
 *   `mcp` translator on a reference that is not a command, is also `invalid_argument`.
 *
 * @param resolution - The result of the core `resolveSourceReference(reference, probe)`.
 * @param deps       - Process launcher, working directory and per-translator options.
 */
export async function resolveSource(
  resolution: ISourceResolution,
  deps: IResolveDeps
): Promise<IResolvedSource> {
  const translator = resolution.translator ?? defaultTranslator(deps.intent);
  if (translator === undefined) {
    throw new ApiError(
      'invalid_argument',
      `source ${JSON.stringify(resolution.reference)} needs a translator: choose argv or mcp`
    );
  }
  if (translator !== 'argv' && translator !== 'mcp') {
    throw new ApiError(
      'invalid_argument',
      `${resolution.asset} sources (${translator}) are served by adhd-apigen: ${resolution.reference}`
    );
  }
  if (resolution.locator.kind !== 'command') {
    throw new ApiError(
      'invalid_argument',
      `the ${translator} translator needs an executable source, got ${resolution.asset}: ${resolution.reference}`
    );
  }
  const command = resolution.locator.command;
  const launcher = deps.launcher ?? nodeProcessLauncher;
  if (translator === 'mcp') {
    return resolveMcpStdioSource(
      {
        command,
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
  const { operation, fnName } = buildArgvOperation(command);
  const invoke = createArgvInvoker(command, launcher, {
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
    sourceId: `bin:${commandBaseName(command)}`,
    operations: [operation],
    pkg: {
      id: fnName,
      version: '0.0.0',
      schemas,
      importPath: `bin:${command}`,
      // Keyed by the path tail's `raw`; apigen dispatch calls fns positionally in
      // `input.properties` order: argv, cwd.
      fns: {
        [fnName]: (argv: unknown, cwd: unknown) =>
          invoke({ argv: argv as string[], cwd: cwd as string }),
      },
      createClient: async () => undefined,
    },
    dispose: async () => undefined,
  };
}

function defaultTranslator(intent: SourceIntent | undefined): TranslatorId | undefined {
  if (intent === 'run') return 'argv';
  if (intent === 'serve') return 'mcp';
  return undefined;
}
