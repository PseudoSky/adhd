/**
 * guards: the ts-subprocess extractor diverges from the in-process ts extractor (lost operations or sourceFiles, a leaked session handle), or a failed / timed-out / malformed worker run surfaces as an unnamed error instead of one that names the source and carries the worker's stderr
 * tier: S
 * cites: REMEDIATION-PLAN T-R8 DoD (ts-subprocess returns operations deep-equal to the in-process ts extractor for the fixture source), rule 3 (R8 proven in the unit lane through an injected launcher); commit 47e06f90 (bounded subprocess extractor, absolute worker module)
 * tags: contract
 * teeth: red: drop the last operation in parseWorkerOutput (`response.operations.slice(0, -1)`, guarded temporary edit, restored) and run `npx vitest run src/test/extract-subprocess.spec.ts` in packages/apigen/apigen-core-client -> exit 1; the loopback deep-equal case goes red
 *
 * The launcher is injected. The "loopback" launcher feeds the request's stdin to the real worker entry
 * (`runExtractWorker`) in this process, with only the ts-morph boundary (`extract`) replaced by a deterministic stub.
 */
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/extract', () => ({ extract: vi.fn() }));

import { extract } from '../lib/extract';
import { typescriptExtractor } from '../lib/extraction-entry';
import { sourceFilesOf, withSourceFiles, type ExtractCall } from '../lib/extract-invoker';
import {
  createTypescriptSubprocessExtractor,
  DEFAULT_EXTRACT_MAX_STDERR_BYTES,
  DEFAULT_EXTRACT_MAX_STDOUT_BYTES,
  DEFAULT_EXTRACT_TIMEOUT_MS,
  EXTRACT_RESULT_MARKER,
  registerTypescriptSubprocessExtractor,
  runExtractWorker,
  TS_SUBPROCESS_HOST,
  type ExtractLauncher,
  type IExtractLaunchRequest,
  type IExtractLaunchResult,
} from '../lib/extract-subprocess';
import { createExtractorRegistry } from '../lib/extraction-entry';
import type { Operation } from '../lib/descriptor';

const OP = (id: string): Operation =>
  ({
    id,
    host: 'ts',
    namespace: { raw: 'notes', words: ['notes'] },
    path: [{ raw: id, words: [id] }],
    kind: 'action',
    async: true,
    streaming: false,
    safe: false,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
  }) as Operation;

const CALL: ExtractCall = { source: '/work/api.ts', host: 'ts', namespace: 'notes' };

const mockedExtract = vi.mocked(extract);

afterEach(() => {
  mockedExtract.mockReset();
});

/** Runs the real worker entry in-process for each launch. */
function loopbackLauncher(seen: IExtractLaunchRequest[] = []): ExtractLauncher {
  return async (request) => {
    seen.push(request);
    let stdout = '';
    let stderr = '';
    const before = process.exitCode;
    try {
      process.exitCode = undefined;
      await runExtractWorker({
        stdin: Readable.from([request.stdin]),
        stdout: { write: (t) => ((stdout += t), true) },
        stderr: { write: (t) => ((stderr += t), true) },
      });
      const failed = process.exitCode !== undefined && Number(process.exitCode) !== 0;
      return { exitCode: failed ? Number(process.exitCode) : 0, stdout, stderr };
    } finally {
      process.exitCode = before;
    }
  };
}

function canned(result: Partial<IExtractLaunchResult>, seen: IExtractLaunchRequest[] = []): ExtractLauncher {
  return async (request) => {
    seen.push(request);
    return { exitCode: 0, stdout: '', stderr: '', ...result };
  };
}

const marker = (payload: unknown): string => `${EXTRACT_RESULT_MARKER}${JSON.stringify(payload)}\n`;

describe('ts-subprocess extractor via an injected launcher (T-R8)', () => {
  it('returns operations deep-equal to the in-process ts extractor, with the same sourceFiles', async () => {
    mockedExtract.mockImplementation(async () =>
      withSourceFiles([OP('save'), OP('list')], ['/work/z.ts', '/work/api.ts', '/work/api.ts'])
    );
    const inProcess = await typescriptExtractor(CALL);
    const viaWorker = await createTypescriptSubprocessExtractor({ launcher: loopbackLauncher() })(CALL);
    expect(viaWorker).toEqual(inProcess);
    expect(viaWorker.map((o) => o.id)).toEqual(['save', 'list']);
    expect(sourceFilesOf(viaWorker)).toEqual(['/work/api.ts', '/work/z.ts']);
    expect(sourceFilesOf(viaWorker)).toEqual(sourceFilesOf(inProcess));
    expect(JSON.stringify(viaWorker)).toBe(JSON.stringify(inProcess));
  });

  it('hands the worker the call with the extractor options and without the session handle', async () => {
    mockedExtract.mockResolvedValue(withSourceFiles([OP('save')], []));
    const seen: IExtractLaunchRequest[] = [];
    await createTypescriptSubprocessExtractor({ launcher: loopbackLauncher(seen) })({
      ...CALL,
      extractorOptions: { tsconfig: './tsconfig.json', dropFileSegment: true, session: { live: () => 1 } },
    });
    const sent = JSON.parse(seen[0].stdin) as { call: ExtractCall };
    expect(sent.call.extractorOptions).toEqual({ tsconfig: './tsconfig.json', dropFileSegment: true });
    expect(sent.call.source).toBe('/work/api.ts');
    expect(mockedExtract).toHaveBeenCalledWith({
      sourceFile: '/work/api.ts',
      namespace: 'notes',
      tsconfig: './tsconfig.json',
      dropFileSegment: true,
      session: undefined,
    });
  });

  it('launches the configured node on an absolute worker module URL, in the configured cwd, with the limits forwarded', async () => {
    const seen: IExtractLaunchRequest[] = [];
    const signal = new AbortController().signal;
    const extractor = createTypescriptSubprocessExtractor({
      launcher: canned({ stdout: marker({ operations: [], files: [] }) }, seen),
      nodePath: '/opt/node/bin/node',
      workerModule: '/abs/dist/index.cjs',
      cwd: '/work',
      signal,
      timeoutMs: 1234,
      maxStdoutBytes: 99,
      maxStderrBytes: 7,
    });
    await extractor(CALL);
    const [request] = seen;
    expect(request.command).toBe('/opt/node/bin/node');
    expect(request.args.join(' ')).toContain('file:///abs/dist/index.cjs');
    expect(request.args.join(' ')).toContain('runExtractWorker');
    expect(request.cwd).toBe('/work');
    expect(request.signal).toBe(signal);
    expect(request.timeoutMs).toBe(1234);
    expect(request.maxStdoutBytes).toBe(99);
    expect(request.maxStderrBytes).toBe(7);
  });

  it('leaves the limits unset for the launcher to default, and publishes the defaults', async () => {
    const seen: IExtractLaunchRequest[] = [];
    await createTypescriptSubprocessExtractor({
      launcher: canned({ stdout: marker({ operations: [], files: [] }) }, seen),
    })(CALL);
    expect(seen[0].timeoutMs).toBeUndefined();
    expect(seen[0].maxStdoutBytes).toBeUndefined();
    expect(DEFAULT_EXTRACT_TIMEOUT_MS).toBe(5 * 60 * 1000);
    expect(DEFAULT_EXTRACT_MAX_STDOUT_BYTES).toBe(512 * 1024 * 1024);
    expect(DEFAULT_EXTRACT_MAX_STDERR_BYTES).toBe(64 * 1024);
  });

  it('takes the LAST marker line and ignores earlier noise', async () => {
    const stdout = `warming up\n${marker({ operations: [OP('stale')], files: [] })}log line\n${marker({ operations: [OP('fresh')], files: ['/b', '/a'] })}`;
    const result = await createTypescriptSubprocessExtractor({ launcher: canned({ stdout }) })(CALL);
    expect(result.map((o) => o.id)).toEqual(['fresh']);
    expect(sourceFilesOf(result)).toEqual(['/a', '/b']);
  });

  it('registers under ts-subprocess and replaces nothing else', () => {
    const registry = createExtractorRegistry();
    registerTypescriptSubprocessExtractor(registry, { launcher: canned({}) });
    expect(TS_SUBPROCESS_HOST).toBe('ts-subprocess');
    expect(registry.hosts()).toEqual(['ts', 'ts-subprocess']);
    expect(registry.get('ts')).toBe(typescriptExtractor);
  });

  describe('failure surfaces', () => {
    it('a non-zero exit names the source and carries the worker stderr', async () => {
      const extractor = createTypescriptSubprocessExtractor({
        launcher: canned({ exitCode: 3, stderr: 'Error: boom\n  at x\n' }),
      });
      await expect(extractor(CALL)).rejects.toThrow(/failed for \/work\/api\.ts \(exit 3\): Error: boom/);
    });

    it('a zero exit with no marker line says there was no result line', async () => {
      const extractor = createTypescriptSubprocessExtractor({ launcher: canned({ stdout: 'noise only\n' }) });
      await expect(extractor(CALL)).rejects.toThrow(/\/work\/api\.ts.*no result line on stdout/);
    });

    it('a killed worker (exit null) is a failure, never an empty result', async () => {
      const extractor = createTypescriptSubprocessExtractor({
        launcher: canned({ exitCode: null, stdout: marker({ operations: [OP('x')], files: [] }) }),
      });
      await expect(extractor(CALL)).rejects.toThrow(/exit null/);
    });

    it('malformed JSON after the marker names the source and appends the stderr tail', async () => {
      const extractor = createTypescriptSubprocessExtractor({
        launcher: canned({ stdout: `${EXTRACT_RESULT_MARKER}{not json\n`, stderr: 'heap near limit' }),
      });
      await expect(extractor(CALL)).rejects.toThrow(/unparseable result for \/work\/api\.ts.*worker stderr tail: heap near limit/s);
    });

    it('a launcher timeout rejection (the real launcher kills the worker) reaches the caller unchanged', async () => {
      const extractor = createTypescriptSubprocessExtractor({
        timeoutMs: 50,
        launcher: async (request) => {
          throw new Error(`extract worker timed out after ${String(request.timeoutMs)}ms and was killed: slow`);
        },
      });
      await expect(extractor(CALL)).rejects.toThrow('extract worker timed out after 50ms and was killed: slow');
    });

    it('a stdout-overflow rejection from the launcher reaches the caller unchanged', async () => {
      const extractor = createTypescriptSubprocessExtractor({
        maxStdoutBytes: 10,
        launcher: async (request) => {
          throw new Error(`extract worker stdout exceeded ${String(request.maxStdoutBytes)} bytes`);
        },
      });
      await expect(extractor(CALL)).rejects.toThrow('stdout exceeded 10 bytes');
    });

    it('a non-JSON extractor option throws before any process is launched', async () => {
      const seen: IExtractLaunchRequest[] = [];
      const extractor = createTypescriptSubprocessExtractor({ launcher: canned({}, seen) });
      await expect(
        extractor({ ...CALL, extractorOptions: { hook: () => 1 } })
      ).rejects.toThrow(/extractorOptions\.hook is not plain JSON data/);
      expect(seen).toHaveLength(0);
    });

    it('the worker reports its own failure on stderr with a non-zero exit', async () => {
      mockedExtract.mockRejectedValue(new Error('cannot read tsconfig'));
      const extractor = createTypescriptSubprocessExtractor({ launcher: loopbackLauncher() });
      await expect(extractor(CALL)).rejects.toThrow(/exit 1\): .*cannot read tsconfig/s);
    });

    // A marker line that parses but is not a { operations, files } object. The error must name the source like
    // every other worker failure; today `{}` raises a raw TypeError ("Object.defineProperty called on non-object"), `null` raises "Cannot read properties of null (reading 'operations')", and a non-array `operations` resolves silently as a non-array result (see the T-R8 report). `it.fails` flips red the
    // moment parseWorkerOutput validates the shape, which is the signal to turn these into plain `it`.
    it.each([
      ['an empty object', '{}'],
      ['null', 'null'],
      ['operations that is not an array', '{"operations":{},"files":[]}'],
    ])('a well-formed marker line carrying %s names the source', async (_name, body) => {
      const extractor = createTypescriptSubprocessExtractor({
        launcher: canned({ stdout: `${EXTRACT_RESULT_MARKER}${body}\n` }),
      });
      await expect(extractor(CALL)).rejects.toThrow(/\/work\/api\.ts/);
    });
  });
});
