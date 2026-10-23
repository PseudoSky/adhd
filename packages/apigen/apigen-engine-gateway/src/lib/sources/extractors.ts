import * as path from 'node:path';
import { ApiError } from '@adhd/apigen-base-errors';
import { withSourceFiles } from '@adhd/apigen-core-client';
import type { ExtractCall, ExtractResult, Extractor, ExtractorRegistry } from '@adhd/apigen-core-client';
import { buildArgvOperation, ARGV_HOST } from './argv-operation';
import { sourceNameOf } from './command-name';
import { MCP_HOST, mcpBindingOf, openMcpStdioUpstream, operationsFromMcpTools } from './mcp-source';
import { nodeProcessLauncher } from './process';
import type { IProcessLauncher } from './process';

/** Dependencies of {@link registerSourceExtractors}. */
export interface ISourceExtractorDeps {
  /**
   * Starts the upstream process of the `mcp` translator (default {@link nodeProcessLauncher}; a
   * sandbox supplies a confining one). It decides how the process is launched, never what the
   * extraction returns, so it does not travel in the extract call.
   */
  readonly launcher?: IProcessLauncher;
  /** Receives one line per upstream tool the `mcp` translator did not expose (default: stderr). */
  readonly onWarn?: (line: string) => void;
}

/**
 * The options the `mcp` translator reads from `ExtractCall.extractorOptions`. All are plain data,
 * so a cache layer keyed on the call sees every input that changes the extracted operations.
 */
export interface IMcpExtractorOptions {
  /** Arguments passed to the upstream command (never through a shell). */
  readonly args?: readonly string[];
  /** Working directory of the upstream process (default `process.cwd()`). */
  readonly cwd?: string;
  /** Environment of the upstream process. */
  readonly env?: Record<string, string>;
  /**
   * The source alias: the operation-id namespace (`<name>/<tool>`) and binding key (`mcp:<name>`).
   * Falls back to `ExtractCall.namespace`, then to the command basename; never the upstream's own
   * `serverInfo.name`.
   */
  readonly name?: string;
  /** Bound on `initialize` and `tools/list` (default 10000 ms). */
  readonly handshakeTimeoutMs?: number;
}

function invalid(message: string): ApiError {
  return new ApiError('invalid_argument', message);
}

function optionOf<T>(
  options: Record<string, unknown> | undefined,
  key: string,
  guard: (value: unknown) => value is T,
  expected: string
): T | undefined {
  const value = options?.[key];
  if (value === undefined) return undefined;
  if (!guard(value)) throw invalid(`extractor option ${JSON.stringify(key)} must be ${expected}`);
  return value;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(isString);

function requireCommand(call: ExtractCall, translator: string): string {
  if (call.source.length === 0) throw invalid(`the ${translator} translator needs an executable source`);
  return call.source;
}

/**
 * The `argv` translator: the executable becomes one `action` operation (`bin/<base>`,
 * `host: 'argv'`, `binding: 'bin:<base>'`). Pure construction; the process is not started.
 * The reported file is the executable itself when the command names a path (it contains a
 * separator, resolved to an absolute path); a bare command name resolved through `PATH` names
 * no file, so none is reported.
 */
function argvExtractor(): Extractor {
  return async (call): Promise<ExtractResult> => {
    const command = requireCommand(call, ARGV_HOST);
    const { operation } = buildArgvOperation(command);
    const files = /[\\/]/.test(command) ? [path.resolve(command)] : [];
    return withSourceFiles([operation], files);
  };
}

/**
 * The `mcp` translator: starts the upstream once, performs `initialize`, lists its tools,
 * translates them with {@link operationsFromMcpTools} (`host: 'mcp'`, `binding: 'mcp:<name>'`)
 * and closes the upstream before returning. The result is IR only; the live connection that
 * serves calls is the gateway adapter's (`createMcpUpstreamAdapter`), not the extraction's.
 * An MCP upstream reads no local source file, so the reported file list is empty.
 */
function mcpExtractor(deps: ISourceExtractorDeps): Extractor {
  return async (call): Promise<ExtractResult> => {
    const command = requireCommand(call, MCP_HOST);
    const options = call.extractorOptions;
    const args = optionOf(options, 'args', isStringArray, 'an array of strings') ?? [];
    const cwd = optionOf(options, 'cwd', isString, 'a string') ?? process.cwd();
    const env = optionOf(options, 'env', isStringRecord, 'a string-to-string object');
    const alias = optionOf(options, 'name', isString, 'a string') ?? call.namespace;
    const handshakeTimeoutMs = optionOf(options, 'handshakeTimeoutMs', isNumber, 'a positive number');
    const name = sourceNameOf(command, alias);
    const onWarn = deps.onWarn ?? ((line: string) => void process.stderr.write(`${line}\n`));

    const upstream = await openMcpStdioUpstream(
      { command, args, cwd, ...(env ? { env } : {}) },
      mcpBindingOf(name),
      {
        launcher: deps.launcher ?? nodeProcessLauncher,
        ...(handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs } : {}),
      }
    );
    try {
      const { operations } = operationsFromMcpTools(upstream.rawTools, name, onWarn);
      return withSourceFiles(operations, []);
    } finally {
      await upstream.dispose();
    }
  };
}

/**
 * Register the gateway's source translators with an extractor registry: `argv` (an executable
 * run once per call) and `mcp` (an MCP stdio upstream, listed once). Each returns the operations
 * as IR whose `host` is the translator id and whose `binding` is the runtime adapter key
 * (`bin:<base>` / `mcp:<name>`), together with the files it read (see the translators above).
 *
 * @param registry - The registry from the core `createExtractorRegistry()`.
 * @param deps     - Process launcher and warning sink for the `mcp` translator.
 */
export function registerSourceExtractors(registry: ExtractorRegistry, deps: ISourceExtractorDeps = {}): void {
  registry.register(ARGV_HOST, argvExtractor());
  registry.register(MCP_HOST, mcpExtractor(deps));
}
