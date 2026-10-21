// extract-subprocess.ts — the TypeScript extractor driven as a subprocess (R8).
//
// The `ts-subprocess` extractor speaks the same registry contract as the
// in-process `ts` extractor: it takes an `ExtractCall` and returns the
// operations, reporting the files it read through `withSourceFiles`. The only
// difference is where ts-morph runs. The call is sent as JSON on a worker's
// stdin and the result comes back as one marker-prefixed JSON line on stdout,
// so the parent process never loads ts-morph and the worker's memory is
// returned to the OS when it exits.
//
// The process launcher is injected (`ExtractLauncher`), so the protocol is
// provable without spawning a process; `spawnExtractLauncher` is the real one.

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { typescriptExtractor, type Extractor, type ExtractorRegistry } from './extraction-entry';
import {
  assertExtractorOptions,
  sourceFilesOf,
  withSourceFiles,
  type ExtractCall,
  type ExtractResult,
} from './extract-invoker';
import type { Operation } from './descriptor';

/** The registry key the subprocess extractor registers under. */
export const TS_SUBPROCESS_HOST = 'ts-subprocess';

/** Prefix of the single stdout line carrying the worker's result. */
export const EXTRACT_RESULT_MARKER = 'APIGEN_EXTRACT_RESULT:';

/** One process to run, with the text to write to its stdin. */
export interface IExtractLaunchRequest {
  /** Executable. */
  command: string;
  /** Arguments. */
  args: string[];
  /** Text written to the process's stdin, which is then closed. */
  stdin: string;
  /** Working directory; defaults to the parent's. */
  cwd?: string;
  /** Aborting kills the process and rejects the launch. */
  signal?: AbortSignal;
}

/** What a finished launch produced. */
export interface IExtractLaunchResult {
  /** Exit code, or `null` when the process was killed by a signal. */
  exitCode: number | null;
  /** Everything the process wrote to stdout. */
  stdout: string;
  /** Everything the process wrote to stderr. */
  stderr: string;
}

/** Runs a process to completion; injected so the protocol needs no real spawn. */
export type ExtractLauncher = (
  request: IExtractLaunchRequest
) => Promise<IExtractLaunchResult>;

/**
 * The real launcher: `child_process.spawn` with piped stdio.
 *
 * @param request - The process to run.
 * @returns The exit code and captured output.
 * @throws Error when the process cannot be spawned or `request.signal` aborts.
 */
export const spawnExtractLauncher: ExtractLauncher = (request) =>
  new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: request.signal,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.once('error', reject);
    child.once('close', (exitCode) =>
      resolve({
        exitCode,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    );
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.stdin);
  });

/** Options for {@link createTypescriptSubprocessExtractor}. */
export interface ITypescriptSubprocessOptions {
  /** Process launcher; defaults to {@link spawnExtractLauncher}. */
  launcher?: ExtractLauncher;
  /**
   * Module the worker imports `runExtractWorker` from: a package specifier or an
   * absolute file path. Defaults to `@adhd/apigen-core-client`.
   */
  workerModule?: string;
  /** Node executable; defaults to `process.execPath`. */
  nodePath?: string;
  /** Working directory of the worker; defaults to the parent's. */
  cwd?: string;
  /** Aborts an in-flight extraction. */
  signal?: AbortSignal;
}

/** The request the parent writes to the worker's stdin. */
interface IWorkerRequest {
  call: Omit<ExtractCall, 'extractorOptions'> & {
    extractorOptions?: Record<string, unknown>;
  };
}

/** The result the worker writes after {@link EXTRACT_RESULT_MARKER}. */
interface IWorkerResponse {
  operations: Operation[];
  files: string[];
}

function workerSpecifier(workerModule: string): string {
  return path.isAbsolute(workerModule)
    ? pathToFileURL(workerModule).href
    : workerModule;
}

/**
 * Create the extractor that runs the TypeScript extraction in a worker process.
 *
 * It returns exactly what the in-process `ts` extractor returns for the same
 * call, including `sourceFiles` (the worker reports the files it read), so a
 * cache layer keys and validates identically in both modes. The run-scoped
 * `session` handle cannot cross a process boundary and is dropped from the
 * request; the worker uses a private session and releases it on exit.
 *
 * @param options - Launcher and worker location.
 * @returns An {@link Extractor} for {@link TS_SUBPROCESS_HOST}.
 * @throws (from the returned extractor) Error carrying the worker's stderr when
 *         it exits non-zero or prints no result line.
 */
export function createTypescriptSubprocessExtractor(
  options: ITypescriptSubprocessOptions = {}
): Extractor {
  const launcher = options.launcher ?? spawnExtractLauncher;
  const specifier = workerSpecifier(
    options.workerModule ?? '@adhd/apigen-core-client'
  );
  return async (call) => {
    const { session: _session, ...serialisable } = call.extractorOptions ?? {};
    void _session;
    assertExtractorOptions(serialisable);
    const request: IWorkerRequest = {
      call: { ...call, extractorOptions: serialisable },
    };
    const launched = await launcher({
      command: options.nodePath ?? process.execPath,
      args: [
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(specifier)}).then((m) => m.runExtractWorker())`,
      ],
      stdin: JSON.stringify(request),
      cwd: options.cwd,
      signal: options.signal,
    });
    return parseWorkerOutput(call, launched);
  };
}

function parseWorkerOutput(
  call: ExtractCall,
  launched: IExtractLaunchResult
): ExtractResult {
  const line = launched.stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(EXTRACT_RESULT_MARKER));
  if (launched.exitCode !== 0 || line === undefined) {
    throw new Error(
      `ts-subprocess extractor failed for ${call.source} ` +
        `(exit ${String(launched.exitCode)}): ${launched.stderr.trim() || 'no result line on stdout'}`
    );
  }
  const response = JSON.parse(
    line.slice(EXTRACT_RESULT_MARKER.length)
  ) as IWorkerResponse;
  return withSourceFiles(response.operations, response.files);
}

/**
 * Register the subprocess extractor under {@link TS_SUBPROCESS_HOST}.
 *
 * @param registry - The registry to add it to.
 * @param options  - Launcher and worker location.
 */
export function registerTypescriptSubprocessExtractor(
  registry: ExtractorRegistry,
  options: ITypescriptSubprocessOptions = {}
): void {
  registry.register(
    TS_SUBPROCESS_HOST,
    createTypescriptSubprocessExtractor(options)
  );
}

/**
 * The worker side of the protocol: read one request from `stdin`, run the
 * in-process TypeScript extractor, write one marker-prefixed result line to
 * `stdout`. Failures are written to stderr and set a non-zero exit code.
 * The subprocess extractor launches this through `-e`.
 *
 * @param io - Streams to use; default to the process's own.
 */
export async function runExtractWorker(
  io: {
    stdin?: NodeJS.ReadableStream;
    stdout?: { write(text: string): unknown };
    stderr?: { write(text: string): unknown };
  } = {}
): Promise<void> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    let text = '';
    for await (const chunk of stdin) text += String(chunk);
    const { call } = JSON.parse(text) as IWorkerRequest;
    const operations = await typescriptExtractor(call as ExtractCall);
    const response: IWorkerResponse = {
      operations: [...operations],
      files: [...(sourceFilesOf(operations) ?? [])],
    };
    stdout.write(`${EXTRACT_RESULT_MARKER}${JSON.stringify(response)}\n`);
  } catch (error) {
    stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  }
}
