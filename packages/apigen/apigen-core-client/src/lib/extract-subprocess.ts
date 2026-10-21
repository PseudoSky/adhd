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
import { lazyRequire } from './esm-require';
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
  /** Kills the process and rejects the launch once this many ms have elapsed. */
  timeoutMs?: number;
  /** Kills the process and rejects the launch when stdout exceeds this many bytes. */
  maxStdoutBytes?: number;
  /** Bytes of stderr kept (the tail); earlier output is discarded. */
  maxStderrBytes?: number;
}

/** Default wall-clock limit for one worker run: 5 minutes. */
export const DEFAULT_EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;

/** Default stdout ceiling for the result line: 512 MiB. */
export const DEFAULT_EXTRACT_MAX_STDOUT_BYTES = 512 * 1024 * 1024;

/** Default stderr tail kept for diagnostics: 64 KiB. */
export const DEFAULT_EXTRACT_MAX_STDERR_BYTES = 64 * 1024;

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
    const maxStdout =
      request.maxStdoutBytes ?? DEFAULT_EXTRACT_MAX_STDOUT_BYTES;
    const maxStderr =
      request.maxStderrBytes ?? DEFAULT_EXTRACT_MAX_STDERR_BYTES;
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: request.signal,
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err: Buffer[] = [];
    let errBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill('SIGKILL');
      reject(error);
    };
    const timeoutMs = request.timeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS;
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timer = setTimeout(
        () =>
          fail(
            new Error(
              `extract worker timed out after ${String(timeoutMs)}ms and was killed` +
                stderrSuffix(err)
            )
          ),
        timeoutMs
      );
      timer.unref();
    }
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxStdout) {
        fail(
          new Error(
            `extract worker stdout exceeded ${String(maxStdout)} bytes (result too large to carry on one line)` +
              stderrSuffix(err)
          )
        );
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err.push(chunk);
      errBytes += chunk.length;
      while (errBytes - err[0].length >= maxStderr && err.length > 1) {
        errBytes -= err[0].length;
        err = err.slice(1);
      }
    });
    child.once('error', (error) => fail(error));
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stderrAll = Buffer.concat(err);
      resolve({
        exitCode,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: stderrAll
          .subarray(Math.max(0, stderrAll.length - maxStderr))
          .toString('utf8'),
      });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.stdin);
  });

/** The captured stderr tail formatted for appending to an error message. */
function stderrSuffix(chunks: Buffer[]): string {
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? `: ${text}` : '';
}

/** Options for {@link createTypescriptSubprocessExtractor}. */
export interface ITypescriptSubprocessOptions {
  /** Process launcher; defaults to {@link spawnExtractLauncher}. */
  launcher?: ExtractLauncher;
  /**
   * Module the worker imports `runExtractWorker` from: a package specifier or an
   * absolute file path. Defaults to the absolute path of this package's own
   * entry, so resolution never depends on the working directory.
   */
  workerModule?: string;
  /** Node executable; defaults to `process.execPath`. */
  nodePath?: string;
  /** Working directory of the worker; defaults to the parent's `process.cwd()`. */
  cwd?: string;
  /** Aborts an in-flight extraction. */
  signal?: AbortSignal;
  /** Wall-clock limit per extraction in ms; defaults to {@link DEFAULT_EXTRACT_TIMEOUT_MS}. `0` disables it. */
  timeoutMs?: number;
  /** Stdout ceiling in bytes; defaults to {@link DEFAULT_EXTRACT_MAX_STDOUT_BYTES}. */
  maxStdoutBytes?: number;
  /** Stderr tail kept in bytes; defaults to {@link DEFAULT_EXTRACT_MAX_STDERR_BYTES}. */
  maxStderrBytes?: number;
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

/**
 * Absolute path of this package's loadable entry. The CJS build's own file is
 * used when it is plain JavaScript; otherwise (ESM build, TypeScript source
 * under a test runner) the package entry is resolved from this module's
 * location. Falls back to the bare package specifier only when neither works.
 */
function defaultWorkerModule(): string {
  if (typeof __filename === 'string' && !/\.[cm]?tsx?$/.test(__filename)) {
    return __filename;
  }
  try {
    return lazyRequire.resolve('@adhd/apigen-core-client');
  } catch {
    return '@adhd/apigen-core-client';
  }
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
 * @throws (from the returned extractor) Error carrying the worker's stderr tail
 *         when it exits non-zero, prints no result line, prints an unparseable
 *         one, exceeds `timeoutMs`, or exceeds `maxStdoutBytes`.
 */
export function createTypescriptSubprocessExtractor(
  options: ITypescriptSubprocessOptions = {}
): Extractor {
  const launcher = options.launcher ?? spawnExtractLauncher;
  const specifier = workerSpecifier(
    options.workerModule ?? defaultWorkerModule()
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
      cwd: options.cwd ?? process.cwd(),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxStdoutBytes: options.maxStdoutBytes,
      maxStderrBytes: options.maxStderrBytes,
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
  let response: IWorkerResponse;
  try {
    response = JSON.parse(
      line.slice(EXTRACT_RESULT_MARKER.length)
    ) as IWorkerResponse;
  } catch (error) {
    const tail = launched.stderr.trim().slice(-2000);
    throw new Error(
      `ts-subprocess extractor returned an unparseable result for ${call.source} ` +
        `(${error instanceof Error ? error.message : String(error)})` +
        (tail ? `; worker stderr tail: ${tail}` : '')
    );
  }
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
