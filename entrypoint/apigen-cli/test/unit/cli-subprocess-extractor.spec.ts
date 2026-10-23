/**
 * guards: the CLI's choice of extractor regresses: `--opt extract.subprocess=true` fails to route extraction through the subprocess extractor (or routes it there when absent), the subprocess path returns different operations than the in-process one, a worker failure is swallowed, or `run` starts serving before the process-lifetime ts-morph tier is released
 * tier: S
 * cites: REMEDIATION-PLAN T-R8 (policy-core, R8) AC1 the subprocess extractor is selected only by `--opt extract.subprocess=true|1`; AC2 its operations deep-equal the in-process extractor's for the same source; AC3 a failing worker surfaces its error; AC4 releaseExtractionMemory runs before the run plugin's run() on both paths
 * tags: contract
 * teeth: red: npx vitest run --config entrypoint/apigen-cli/vite.config.ts src/test/cli-subprocess-extractor.spec.ts -> exit 1 under production negative controls (each restored with git restore): AC1 (wantsSubprocessExtractor always false) `expected [] to have a length of 1 but got +0`; AC2 (subprocess decoder drops an operation) `expected [ { id: 'svc/api/ping', ... } ] to deeply equal [ ..., ... ]`; AC3 (worker stderr dropped from the error) `expected [Function] to throw error matching /ts-subprocess extractor failed.*exit 3.*worker exploded/s`; AC4 (releaseExtractionMemory call removed from orchestrateRun) `expected [ 'run' ] to deeply equal [ 'release', 'run' ]`
 *
 * Consumer path: the real `run` / `generate` Commander commands, real orchestrator and the real subprocess extractor registered by the orchestrator. The process launcher is the injected seam (`ITypescriptSubprocessOptions.launcher`): it is supplied by wrapping `registerTypescriptSubprocessExtractor` and it drives the REAL worker protocol (`runExtractWorker` over an in-memory stdin/stdout) in this process, so the request JSON, the result line and ts-morph extraction are all real and no process is spawned (subprocess lane stays in `*.e2e.ts`). process.exitCode set by a failing worker is saved and restored.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import type { IExtractLaunchRequest, Operation, OutputPlugin } from '@adhd/apigen-core-client';

const hoisted = vi.hoisted(() => ({
  events: [] as string[],
  launched: [] as unknown[],
  failWorker: false,
}));

vi.mock('@adhd/apigen-core-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@adhd/apigen-core-client')>();
  const launcher = async (request: IExtractLaunchRequest) => {
    hoisted.launched.push(request);
    if (hoisted.failWorker) {
      return { exitCode: 3, stdout: '', stderr: 'worker exploded' };
    }
    let stdout = '';
    let stderr = '';
    const savedExitCode = process.exitCode;
    try {
      await actual.runExtractWorker({
        stdin: Readable.from([request.stdin]),
        stdout: { write: (t: string) => (stdout += t) },
        stderr: { write: (t: string) => (stderr += t) },
      });
      return { exitCode: Number(process.exitCode ?? 0), stdout, stderr };
    } finally {
      process.exitCode = savedExitCode;
    }
  };
  return {
    ...actual,
    registerTypescriptSubprocessExtractor: (
      registry: Parameters<typeof actual.registerTypescriptSubprocessExtractor>[0],
      options: Parameters<typeof actual.registerTypescriptSubprocessExtractor>[1] = {}
    ) => actual.registerTypescriptSubprocessExtractor(registry, { ...options, launcher }),
    releaseExtractionMemory: () => {
      hoisted.events.push('release');
      actual.releaseExtractionMemory();
    },
  };
});

import { registerGenerateCommand } from '../../src/lib/commands/generate';
import { registerRunCommand } from '../../src/lib/commands/run';

const SCRATCH_ROOT = path.resolve(__dirname, '../../../../tmp/apigen-cli');
let root: string;
let seq = 0;

/** The slice of PluginInput / RunInput the recording plugin reads. */
interface IPluginInput {
  options: Record<string, unknown>;
  operations?: Operation[];
}

interface IRecorder {
  operations?: Operation[];
}

function writeSource(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs' } })
  );
  const file = path.join(dir, 'api.ts');
  fs.writeFileSync(
    file,
    'export function createItem(payload: { x: number }): string { return String(payload.x); }\n' +
      'export function ping(): string { return "pong"; }\n'
  );
  return file;
}

function recordingPlugin(rec: IRecorder): OutputPlugin {
  return {
    id: 'rec',
    description: 'rec fixture',
    generate: async (input: IPluginInput) => {
      rec.operations = input.operations;
      hoisted.events.push('generate');
      return { files: [] };
    },
    run: async (input: IPluginInput) => {
      rec.operations = input.operations;
      hoisted.events.push('run');
    },
  } as unknown as OutputPlugin;
}

async function invoke(args: string[], rec: IRecorder): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const plugins = { rec: recordingPlugin(rec) };
  registerGenerateCommand(program, plugins);
  registerRunCommand(program, plugins);
  const sigs: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const before = sigs.map((s) => new Set(process.listeners(s)));
  try {
    await program.parseAsync(['node', 'apigen', ...args]);
  } finally {
    sigs.forEach((s, i) => {
      for (const fn of process.listeners(s)) {
        if (!before[i].has(fn)) process.removeListener(s, fn as (...a: unknown[]) => void);
      }
    });
  }
}

beforeAll(() => {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(SCRATCH_ROOT, `subproc-${String(seq++)}-`));
  process.env['APIGEN_LOG_LEVEL'] = 'silent';
  hoisted.events.length = 0;
  hoisted.launched.length = 0;
  hoisted.failWorker = false;
});

afterEach(() => {
  delete process.env['APIGEN_LOG_LEVEL'];
  const resolved = path.resolve(root);
  if (!resolved.startsWith(SCRATCH_ROOT + path.sep)) {
    throw new Error(`refusing to remove ${resolved}: outside ${SCRATCH_ROOT}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

const gen = (source: string, extra: string[] = []): string[] => [
  'generate', '--source', source, '--type', 'rec', '--out-dir', path.join(root, 'out'), '--namespace', 'svc', ...extra,
];

describe('T-R8 AC1/AC2: extractor selection by --opt extract.subprocess and result parity', () => {
  it('without the flag the launcher is never used; with it, it is used once and the operations deep-equal the in-process ones', async () => {
    const source = writeSource(path.join(root, 'src'));
    const inProcess: IRecorder = {};
    await invoke(gen(source), inProcess);
    expect(hoisted.launched).toHaveLength(0);
    expect(inProcess.operations?.map((o) => o.id).sort()).toHaveLength(2);

    const viaWorker: IRecorder = {};
    await invoke(gen(source, ['--opt', 'extract.subprocess=true']), viaWorker);
    expect(hoisted.launched).toHaveLength(1);
    const request = JSON.parse((hoisted.launched[0] as IExtractLaunchRequest).stdin) as {
      call: { source: string; host: string; namespace: string; extractorOptions: Record<string, unknown> };
    };
    expect(request.call.source).toBe(source);
    expect(request.call.host).toBe('ts');
    expect(request.call.namespace).toBe('svc');
    expect(request.call.extractorOptions).not.toHaveProperty('session');

    expect(JSON.parse(JSON.stringify(viaWorker.operations))).toEqual(
      JSON.parse(JSON.stringify(inProcess.operations))
    );
  });

  it('"1" selects the subprocess extractor too; "false" does not', async () => {
    const source = writeSource(path.join(root, 'src'));
    await invoke(gen(source, ['--opt', 'extract.subprocess=false']), {});
    expect(hoisted.launched).toHaveLength(0);
    await invoke(gen(source, ['--opt', 'extract.subprocess=1']), {});
    expect(hoisted.launched).toHaveLength(1);
  });
});

describe('T-R8 AC3: a failing worker surfaces its error', () => {
  it('a non-zero worker exit rejects the command with the worker stderr', async () => {
    const source = writeSource(path.join(root, 'src'));
    hoisted.failWorker = true;
    await expect(invoke(gen(source, ['--opt', 'extract.subprocess=true']), {})).rejects.toThrow(
      /ts-subprocess extractor failed.*exit 3.*worker exploded/s
    );
    expect(hoisted.events).toEqual([]);
  });
});

describe('T-R8 AC4: the process-lifetime ts-morph tier is released before serving', () => {
  it.each([
    ['in-process', [] as string[]],
    ['subprocess', ['--opt', 'extract.subprocess=true']],
  ])('run (%s extractor): release happens before the run plugin starts', async (_label, extra) => {
    const source = writeSource(path.join(root, 'src'));
    await invoke(['run', '--source', source, '--type', 'rec', '--namespace', 'svc', ...extra], {});
    expect(hoisted.events).toEqual(['release', 'run']);
  });

  it('generate does not release (it is not a serving path)', async () => {
    const source = writeSource(path.join(root, 'src'));
    await invoke(gen(source), {});
    expect(hoisted.events).toEqual(['generate']);
  });
});
