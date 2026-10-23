// guards: nodeProcessLauncher hands the OS a shell string, a non-detached group or an unintended child environment, or mishandles the child's exit, error and kill events
// tier: S
// cites: policy-core REMEDIATION-PLAN T-R7 AC1 (R7a), REVIEW-FIXES G1 G9 G10 G11
// teeth: red: npx vitest run src/test/sources-process.spec.ts -> exit 1; recorded in the sources-argv/passthrough runs: a spawn failure that is not typed unavailable fails the isGatewayError assertions here
// skip-expiry: 05f910a0 until 2027-03-31 the three process-group tests are POSIX-only; Windows group kill is not implemented

/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs index arrays/maps the test has just arranged; a miss would fail the very next assertion */
// nodeProcessLauncher (G1 G9 G10 G11) WITHOUT a real subprocess: `node:child_process.spawn`
// is replaced by a scripted fake child, so what is asserted is exactly what the launcher
// hands the OS (argv array, shell:false, detached group, the child environment) and how it
// reacts to the child's events. The unit lane starts no process.

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { isGatewayError, nodeProcessLauncher } from '../../src/index';
import { flush } from '../helpers/flush';

class FakeStream extends EventEmitter {
  encoding: string | undefined;
  setEncoding(e: string): void {
    this.encoding = e;
  }
}

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = Object.assign(new EventEmitter(), {
    chunks: [] as string[],
    ended: false,
    write(c: string) {
      this.chunks.push(c);
    },
    end() {
      this.ended = true;
    },
  });
  killed: string[] = [];
  kill(signal: string): boolean {
    this.killed.push(signal);
    return true;
  }
}

/** Arms `spawn` to return a child that "spawns" on the next turn. */
function armSpawn(configure: (child: FakeChild) => void = () => undefined): FakeChild {
  const child = new FakeChild();
  configure(child);
  spawnMock.mockImplementation(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  return child;
}

const SAVED = { ...process.env };
const ALLOWLIST = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'SHELL'];

beforeEach(() => {
  spawnMock.mockReset();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    PATH: '/usr/bin:/bin',
    HOME: '/home/dev',
    USER: 'dev',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TMPDIR: '/tmp/x',
    TERM: 'xterm',
    SHELL: '/bin/zsh',
    // ambient secrets and policy plumbing that must NOT reach the child (G10, E7)
    AWS_SECRET_ACCESS_KEY: 'top-secret',
    GITHUB_TOKEN: 'ghp_ambient',
    ADHD_POLICY_ATTRIBUTES: '{"role":"admin"}',
    NODE_OPTIONS: '--inspect',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, SAVED);
});

describe('Feature: the child environment is an allowlist (G10)', () => {
  it('@G10 the child gets PATH HOME USER LANG LC_ALL TMPDIR TERM SHELL and nothing else', async () => {
    armSpawn();
    await nodeProcessLauncher.start({ command: 'tool', args: [], cwd: '/w' });
    const env = spawnMock.mock.calls[0]![2].env as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual([...ALLOWLIST].sort());
    expect(env['PATH']).toBe('/usr/bin:/bin');
    expect(env['HOME']).toBe('/home/dev');
  });

  it('@G10 an ambient secret and the policy identity variable are absent from the child', async () => {
    armSpawn();
    await nodeProcessLauncher.start({ command: 'tool', args: [], cwd: '/w' });
    const env = spawnMock.mock.calls[0]![2].env as Record<string, string>;
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('ADHD_POLICY_ATTRIBUTES');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(JSON.stringify(env)).not.toContain('top-secret');
  });

  it('@G10 spec.env is added on top and wins over an allowlisted value', async () => {
    armSpawn();
    await nodeProcessLauncher.start({
      command: 'tool',
      args: [],
      cwd: '/w',
      env: { EXTRA_TOKEN: 'explicit', HOME: '/override' },
    });
    const env = spawnMock.mock.calls[0]![2].env as Record<string, string>;
    expect(env['EXTRA_TOKEN']).toBe('explicit');
    expect(env['HOME']).toBe('/override');
    expect(env['PATH']).toBe('/usr/bin:/bin');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
  });

  it('@G10 an allowlisted variable that is unset in the parent is not invented', async () => {
    delete process.env['LC_ALL'];
    delete process.env['SHELL'];
    armSpawn();
    await nodeProcessLauncher.start({ command: 'tool', args: [], cwd: '/w' });
    const env = spawnMock.mock.calls[0]![2].env as Record<string, string>;
    expect(env).not.toHaveProperty('LC_ALL');
    expect(env).not.toHaveProperty('SHELL');
    expect(Object.values(env)).not.toContain(undefined);
  });
});

describe('Feature: how the child is started', () => {
  it('@spawn command and args go to spawn as separate values with shell:false, piped stdio, in the requested cwd', async () => {
    armSpawn();
    await nodeProcessLauncher.start({ command: 'sh', args: ['-c', 'echo $HOME; rm x'], cwd: '/demo' });
    const [command, args, options] = spawnMock.mock.calls[0]!;
    expect(command).toBe('sh');
    expect(args).toEqual(['-c', 'echo $HOME; rm x']);
    expect(options).toMatchObject({ shell: false, cwd: '/demo', stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it.skipIf(process.platform === 'win32')('@G9 on POSIX the child leads its own process group (detached)', async () => {
    armSpawn();
    await nodeProcessLauncher.start({ command: 'tool', args: [], cwd: '/w' });
    expect(spawnMock.mock.calls[0]![2].detached).toBe(true);
  });

  it('@spawn a command that cannot start is the gateway unavailable ApiError for bin:<base> via the error event', async () => {
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit('error', new Error('spawn nope ENOENT')));
      return child;
    });
    const err = await nodeProcessLauncher.start({ command: 'nope', args: [], cwd: '/w' }).catch((e) => e);
    expect(isGatewayError(err)).toBe(true);
    expect(err).toMatchObject({ code: 'internal', details: { gatewayCode: 'unavailable', host: 'bin:nope' } });
    expect(err.message).toContain('nope');
  });

  it('@spawn a synchronous spawn throw is the gateway unavailable ApiError for bin:<base>', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const err = await nodeProcessLauncher.start({ command: 'x', args: [], cwd: '/w' }).catch((e) => e);
    expect(isGatewayError(err)).toBe(true);
    expect(err).toMatchObject({ code: 'internal', details: { gatewayCode: 'unavailable', host: 'bin:x' } });
    expect(err.message).toContain('EACCES');
  });
});

describe('Feature: the handle', () => {
  it('@handle output produced before anyone subscribes is replayed in order, then streamed', async () => {
    const child = armSpawn();
    const handle = await nodeProcessLauncher.start({ command: 'tool', args: [], cwd: '/w' });
    child.stdout.emit('data', 'one ');
    child.stdout.emit('data', 'two');
    child.stderr.emit('data', 'warn');
    const out: string[] = [];
    const err: string[] = [];
    handle.onStdout((c) => out.push(c));
    handle.onStderr((c) => err.push(c));
    expect(out).toEqual(['one ', 'two']);
    expect(err).toEqual(['warn']);
    child.stdout.emit('data', 'three');
    expect(out).toEqual(['one ', 'two', 'three']);
    expect(child.stdout.encoding).toBe('utf8');
  });

  it('@handle stdin writes go to the child and end ends it', async () => {
    const child = armSpawn();
    const handle = await nodeProcessLauncher.start({ command: 'tool', args: [], cwd: '/w' });
    handle.stdin.write('hello\n');
    handle.stdin.end();
    expect(child.stdin.chunks).toEqual(['hello\n']);
    expect(child.stdin.ended).toBe(true);
  });

  it('@handle exited reports code and signal from close (after the streams drained)', async () => {
    const child = armSpawn();
    const handle = await nodeProcessLauncher.start({ command: 'tool', args: [], cwd: '/w' });
    child.emit('exit', 9, null); // exit alone must not resolve
    let settled = false;
    void handle.exited.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    child.emit('close', null, 'SIGTERM');
    await expect(handle.exited).resolves.toEqual({ code: null, signal: 'SIGTERM' });
  });

  it('@G11 later child errors and an EPIPE on stdin are swallowed, never unhandled', async () => {
    const child = armSpawn();
    await nodeProcessLauncher.start({ command: 'tool', args: [], cwd: '/w' });
    expect(() => child.emit('error', new Error('kill EPERM'))).not.toThrow();
    expect(() => child.emit('error', new Error('stream fault'))).not.toThrow(); // more than one
    expect(() => child.stdin.emit('error', new Error('write EPIPE'))).not.toThrow();
  });
});

describe('Feature: killing the child kills its whole process group (G9)', () => {
  it.skipIf(process.platform === 'win32')('@G9 kill signals -pid (the group), default SIGTERM', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = armSpawn();
    const handle = await nodeProcessLauncher.start({ command: 'tool', args: [], cwd: '/w' });
    handle.kill();
    handle.kill('SIGKILL');
    expect(kill.mock.calls).toEqual([
      [-4242, 'SIGTERM'],
      [-4242, 'SIGKILL'],
    ]);
    expect(child.killed).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('@G9 when the group is already gone it falls back to the direct child kill', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const child = armSpawn();
    const handle = await nodeProcessLauncher.start({ command: 'tool', args: [], cwd: '/w' });
    handle.kill('SIGKILL');
    expect(child.killed).toEqual(['SIGKILL']);
  });

  it('@G9 a child kill that throws (already exited) is swallowed', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    armSpawn((c) => {
      c.kill = () => {
        throw new Error('already exited');
      };
    });
    const handle = await nodeProcessLauncher.start({ command: 'tool', args: [], cwd: '/w' });
    expect(() => handle.kill()).not.toThrow();
  });
});

describe('Feature: the package is tagged for the platform it needs (G1)', () => {
  it('@G1 the launcher imports node:child_process, so the project is platform:node, not platform:shared', () => {
    const project = JSON.parse(readFileSync(join(__dirname, '..', '..', 'project.json'), 'utf8')) as { tags: string[] };
    expect(project.tags).toContain('platform:node');
    expect(project.tags).not.toContain('platform:shared');
  });
});
