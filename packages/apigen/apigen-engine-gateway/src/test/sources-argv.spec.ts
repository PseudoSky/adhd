/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs index arrays/maps the test has just arranged; a miss would fail the very next assertion */
// bin: argv fallback (D-07) — "Put a policy in front of any command" as the gateway sees it
// (T13 @S3.1 @S3.2 @S3.3 gateway side, REVIEW-FIXES G9). The launcher is the recording
// fake: "the command ran" is `started.length === 1`, "refused" is `started.length === 0`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@adhd/apigen-base-errors';
import { LayerContext, createPackageInvoker } from '@adhd/apigen-engine-runtime';
import type { Call, UsePlugin } from '@adhd/apigen-engine-runtime';
import {
  TRUNCATION_MARKER,
  buildArgvOperation,
  createArgvInvoker,
  resolveSource,
  type IResolvedSource,
} from '../index';
import { createFakeLauncher } from './helpers/fake-launcher';
import { flush } from './helpers/flush';


type SeenCall = { id: unknown; args: unknown; transport: unknown; safe: unknown };

/** A `--use` Layer plugin that records what it sees and decides by cwd, like a policy keyed on {argv, cwd}. */
function gate(allowedCwd: string): { plugin: UsePlugin; seen: SeenCall[] } {
  const seen: SeenCall[] = [];
  const plugin: UsePlugin = {
    id: 'gate',
    capabilities: {
      layer: {
        layer: async (callLike, next) => {
          const call = callLike as Call;
          seen.push({
            id: call.operation.id,
            args: structuredClone(call.domainArgs),
            transport: call.transport,
            safe: call.operation.safe,
          });
          if ((call.domainArgs['cwd'] as string) !== allowedCwd) {
            throw new ApiError('permission_denied', `cwd ${String(call.domainArgs['cwd'])} is not allowed`);
          }
          return next();
        },
      },
    },
  };
  return { plugin, seen };
}

/** Invokes the resolved argv operation through the Layer stack the way an apigen host does. */
function invokeThrough(resolved: IResolvedSource, plugin: UsePlugin, args: { argv: string[]; cwd: string }) {
  const invoke = createPackageInvoker(resolved.pkg.schemas, [plugin]);
  const op = resolved.operations[0]!;
  const call: Call = {
    operation: op,
    ctx: new LayerContext(),
    envelope: {},
    domainArgs: args,
    transport: 'cli',
  };
  return invoke(op.id, call, {
    fns: resolved.pkg.fns,
    createClient: resolved.pkg.createClient,
    schemas: resolved.pkg.schemas,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Feature: the argv fallback operation (D-07)', () => {
  it('@S3.1 is ONE action named after the command, input {argv, cwd}, and never safe', () => {
    const { operation, fnName } = buildArgvOperation('/usr/bin/touch');
    expect(fnName).toBe('touch');
    expect(operation).toMatchObject({ id: 'touch', kind: 'action', async: true, streaming: false, safe: false });
    expect(operation.input).toEqual({
      type: 'object',
      required: ['argv', 'cwd'],
      additionalProperties: false,
      properties: { argv: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' } },
    });
  });
});

describe('Feature: Put a policy in front of any command — gateway side of run bin:', () => {
  it('@S3.1 a developer in the write root: the Layer sees {argv, cwd}, the launcher starts exactly once with them', async () => {
    const launcher = createFakeLauncher(() => ({ exit: 0, stdout: 'made\n', stderr: '' }));
    const resolved = await resolveSource({ kind: 'bin', command: 'touch' }, 'run', { launcher, cwd: '/demo/work/out' });
    const { plugin, seen } = gate('/demo/work/out');

    const result = await invokeThrough(resolved, plugin, { argv: ['made-by-dev.txt'], cwd: '/demo/work/out' });

    expect(seen).toEqual([
      {
        id: 'touch',
        args: { argv: ['made-by-dev.txt'], cwd: '/demo/work/out' },
        transport: 'cli',
        safe: false,
      },
    ]);
    expect(launcher.started).toEqual([{ command: 'touch', args: ['made-by-dev.txt'], cwd: '/demo/work/out' }]);
    expect(result).toEqual({ exitCode: 0, stdout: 'made\n', stderr: '' });
  });

  it('@S3.1 the exit code is the child\'s own', async () => {
    const launcher = createFakeLauncher(() => ({ exit: 7, stderr: 'boom' }));
    const resolved = await resolveSource({ kind: 'bin', command: 'touch' }, 'run', { launcher, cwd: '/w' });
    const { plugin } = gate('/w');
    await expect(invokeThrough(resolved, plugin, { argv: [], cwd: '/w' })).resolves.toEqual({
      exitCode: 7,
      stdout: '',
      stderr: 'boom',
    });
  });

  it.each([
    ['outside the write root', '/demo/work'],
    ['inside .ssh', '/demo/home/.ssh'],
  ])('@S3.2 a refused call never starts the command (%s)', async (_label, cwd) => {
    const launcher = createFakeLauncher();
    const resolved = await resolveSource({ kind: 'bin', command: 'touch' }, 'run', { launcher, cwd });
    const { plugin, seen } = gate('/demo/work/out');

    await expect(invokeThrough(resolved, plugin, { argv: ['x.txt'], cwd })).rejects.toMatchObject({
      code: 'permission_denied',
    });

    expect(seen).toHaveLength(1);
    expect(launcher.started).toHaveLength(0);
  });

  it('@S3.3 the Layer runs on EVERY invocation: the second, refused call starts nothing', async () => {
    const launcher = createFakeLauncher();
    const resolved = await resolveSource({ kind: 'bin', command: 'touch' }, 'run', { launcher, cwd: '/w' });
    const { plugin, seen } = gate('/demo/work/out');

    await invokeThrough(resolved, plugin, { argv: ['a'], cwd: '/demo/work/out' });
    await expect(invokeThrough(resolved, plugin, { argv: ['b'], cwd: '/demo/work' })).rejects.toBeInstanceOf(ApiError);

    expect(seen).toHaveLength(2);
    expect(launcher.started).toHaveLength(1);
    expect(launcher.started[0]?.args).toEqual(['a']);
  });

  it('@S3.1 malformed positional input is rejected before anything starts', async () => {
    const launcher = createFakeLauncher();
    const resolved = await resolveSource({ kind: 'bin', command: 'touch' }, 'run', { launcher, cwd: '/w' });
    const fn = resolved.pkg.fns['touch']!;
    await expect(fn(['ok', 5], '/w')).rejects.toThrow(/argv must be an array of strings/);
    await expect(fn(['ok'], 42)).rejects.toThrow(/cwd must be a string/);
    expect(launcher.started).toHaveLength(0);
  });
});

describe('Feature: captured output (1 MiB per stream)', () => {
  it('@output a signal-less null exit code is reported as -1', async () => {
    const launcher = createFakeLauncher();
    const invoke = createArgvInvoker('x', {
      async start(spec) {
        const handle = await launcher.start(spec);
        return { ...handle, exited: Promise.resolve({ code: null, signal: null }) };
      },
    });
    await expect(invoke({ argv: [], cwd: '/w' })).resolves.toEqual({ exitCode: -1, stdout: '', stderr: '' });
  });

  it('@output a stream over the cap is cut at the cap and ends with the truncation marker', async () => {
    const big = 'a'.repeat(1024 * 1024 + 500);
    const launcher = createFakeLauncher(() => ({ stdout: big, stderr: 'small' }));
    const result = await createArgvInvoker('x', launcher)({ argv: [], cwd: '/w' });
    expect(result.stdout.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(result.stdout.length).toBe(1024 * 1024 + TRUNCATION_MARKER.length);
    expect(result.stderr).toBe('small');
  });

  it('@output truncation never splits a multi-byte character', async () => {
    const launcher = createFakeLauncher(() => ({ stdout: '€'.repeat(400_000) })); // 3 bytes each: 1.2 MB
    const result = await createArgvInvoker('x', launcher)({ argv: [], cwd: '/w' });
    expect(result.stdout.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(result.stdout).not.toContain('�');
    const body = result.stdout.slice(0, -TRUNCATION_MARKER.length);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(1024 * 1024);
    expect(/^€+$/.test(body)).toBe(true);
  });
});

describe('Feature: cancellation and timeout kill the process (G9)', () => {
  it('@G9 an already-aborted signal rejects without starting anything', async () => {
    const launcher = createFakeLauncher();
    const ac = new AbortController();
    ac.abort(new Error('cancelled before start'));
    await expect(createArgvInvoker('x', launcher)({ argv: [], cwd: '/w' }, ac.signal)).rejects.toThrow(
      'cancelled before start'
    );
    expect(launcher.started).toHaveLength(0);
  });

  it('@G9 aborting a running call sends SIGTERM and reports {exitCode:-1, signal}', async () => {
    const launcher = createFakeLauncher(() => ({ exit: 'hang' }));
    const ac = new AbortController();
    const pending = createArgvInvoker('x', launcher)({ argv: [], cwd: '/w' }, ac.signal);
    await flush();
    expect(launcher.started).toHaveLength(1);
    expect(launcher.processes[0]!.kills).toEqual([]);

    ac.abort();
    const result = await pending;

    expect(result).toMatchObject({ exitCode: -1, signal: 'SIGTERM' });
    expect(launcher.processes[0]!.kills[0]).toBe('SIGTERM');
  });

  it('@G9 the per-call signal wins over options.signal; options.signal alone also cancels', async () => {
    const optionAbort = new AbortController();
    const callAbort = new AbortController();
    const launcher = createFakeLauncher(() => ({ exit: 'hang' }));
    const invoke = createArgvInvoker('x', launcher, { signal: optionAbort.signal });

    const first = invoke({ argv: [], cwd: '/w' }, callAbort.signal);
    await flush();
    optionAbort.abort(); // ignored: the per-call signal is the one in force
    await flush();
    expect(launcher.processes[0]!.kills).toEqual([]);
    callAbort.abort();
    await expect(first).resolves.toMatchObject({ exitCode: -1, signal: 'SIGTERM' });

    const launcher2 = createFakeLauncher(() => ({ exit: 'hang' }));
    const optionAbort2 = new AbortController();
    const second = createArgvInvoker('x', launcher2, { signal: optionAbort2.signal })({ argv: [], cwd: '/w' });
    await flush();
    optionAbort2.abort();
    await expect(second).resolves.toMatchObject({ exitCode: -1, signal: 'SIGTERM' });
  });

  it('@G9 exceeding timeoutMs kills the process (SIGTERM) and reports the signal', async () => {
    vi.useFakeTimers();
    const launcher = createFakeLauncher(() => ({ exit: 'hang' }));
    const pending = createArgvInvoker('x', launcher, { timeoutMs: 100 })({ argv: [], cwd: '/w' });
    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.processes[0]!.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(99);
    expect(launcher.processes[0]!.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ exitCode: -1, signal: 'SIGTERM' });
    expect(launcher.processes[0]!.kills[0]).toBe('SIGTERM');
  });

  it('@G9 a process that ignores SIGTERM is SIGKILLed after the grace period', async () => {
    vi.useFakeTimers();
    const launcher = createFakeLauncher(() => ({ exit: 'hang', process: { ignoreSigterm: true } }));
    const pending = createArgvInvoker('x', launcher, { timeoutMs: 50 })({ argv: [], cwd: '/w' });
    await vi.advanceTimersByTimeAsync(50);
    expect(launcher.processes[0]!.kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1999);
    expect(launcher.processes[0]!.kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ exitCode: -1, signal: 'SIGKILL' });
    expect(launcher.processes[0]!.kills).toContain('SIGKILL');
  });

  it('@G9 timeoutMs: 0 disables the limit', async () => {
    vi.useFakeTimers();
    const launcher = createFakeLauncher(() => ({ exit: 'hang' }));
    const pending = createArgvInvoker('x', launcher, { timeoutMs: 0 })({ argv: [], cwd: '/w' });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(launcher.processes[0]!.kills).toEqual([]);
    launcher.processes[0]!.exit(0);
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
  });

  it('@G9 resolveSource passes argvTimeoutMs and signal through to the invocation', async () => {
    vi.useFakeTimers();
    const launcher = createFakeLauncher(() => ({ exit: 'hang' }));
    const resolved = await resolveSource({ kind: 'bin', command: 'sleepy' }, 'run', {
      launcher,
      cwd: '/w',
      argvTimeoutMs: 30,
    });
    const pending = resolved.pkg.fns['sleepy']!(['1'], '/w') as Promise<unknown>;
    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).resolves.toMatchObject({ exitCode: -1, signal: 'SIGTERM' });

    const ac = new AbortController();
    const launcher2 = createFakeLauncher(() => ({ exit: 'hang' }));
    const resolved2 = await resolveSource({ kind: 'bin', command: 'sleepy' }, 'run', {
      launcher: launcher2,
      cwd: '/w',
      signal: ac.signal,
    });
    const pending2 = resolved2.pkg.fns['sleepy']!([], '/w') as Promise<unknown>;
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    await expect(pending2).resolves.toMatchObject({ exitCode: -1, signal: 'SIGTERM' });
  });
});
