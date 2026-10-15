import { ApiError } from '@adhd/apigen-base-errors';
import { composeSchemas } from '@adhd/apigen-core-client';
import type { ISourceResolution, TranslatorId } from '@adhd/apigen-core-client';
import { buildArgvOperation, createArgvInvoker } from './argv-operation';
import { commandBaseName } from './command-name';
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
  /** `argv`: wall-clock limit for the argv invocation (default 120000 ms; 0 disables). */
  readonly argvTimeoutMs?: number;
  /** `argv`: cancels the argv invocation (kills the process group). */
  readonly signal?: AbortSignal;
}

/**
 * Resolve a classified executable source to the `{pkg, operations}` pair an apigen host
 * consumes. Keyed by **translator** (gap analysis §3e):
 *
 * - the translator is `resolution.translator`; only when it is unset (an executable with no
 *   `protocol` option) does `deps.intent` fill it in: `run` -> `argv`, `serve` -> `mcp`.
 * - `argv` -> the argv operation (D-07); the process is NOT started until the operation is
 *   invoked.
 * - `mcp` -> `ApiError('invalid_argument')`: an MCP upstream is IR plus a binding, not a
 *   resolved source. Extract it with {@link registerSourceExtractors} and front it with
 *   `createMcpUpstreamAdapter` behind a gateway.
 * - any other translator (code, schema documents) -> `ApiError('invalid_argument')`: those
 *   sources are served by adhd-apigen. An unset translator with no intent, or an `argv`
 *   translator on a reference that is not a command, is also `invalid_argument`.
 *
 * @param resolution - The result of the core `resolveSourceReference(reference, probe)`.
 * @param deps       - Process launcher and per-translator options.
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
  if (translator === 'mcp') {
    throw new ApiError(
      'invalid_argument',
      `mcp sources are IR plus a binding, not a resolved source: extract ${resolution.reference} with the mcp extractor and serve it through a gateway adapter`
    );
  }
  if (translator !== 'argv') {
    throw new ApiError(
      'invalid_argument',
      `${resolution.asset} sources (${translator}) are served by adhd-apigen: ${resolution.reference}`
    );
  }
  if (resolution.locator.kind !== 'command') {
    throw new ApiError(
      'invalid_argument',
      `the argv translator needs an executable source, got ${resolution.asset}: ${resolution.reference}`
    );
  }
  const command = resolution.locator.command;
  const launcher = deps.launcher ?? nodeProcessLauncher;
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
