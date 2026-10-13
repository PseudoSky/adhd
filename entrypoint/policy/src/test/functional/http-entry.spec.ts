import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTTP_PORT_ENV_VAR } from '../../wrapper/http-port';
import { useScratchTelemetry } from '../helpers/capture';

useScratchTelemetry();

// Loading the entry builds the policy package (a cold live extraction takes seconds); it is setup, not a timing assertion.
vi.setConfig({ testTimeout: 60_000 });

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** A port nothing is listening on right now (the OS picked it for a probe server that is closed again). */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** Opens a TCP listener on a free port and keeps it, so the entry's bind to the same port fails. */
async function occupy(): Promise<{ port: number; server: Server }> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, server }));
  });
}

interface IEntered {
  /** Settles when the entry module finished (the server closed, or the start failed). */
  readonly done: Promise<void>;
  /** Delivers SIGTERM to the signal handlers the entry installed (not to anyone else's). */
  readonly terminate: () => void;
  readonly stderr: string[];
}

const realPort = process.env[HTTP_PORT_ENV_VAR];
const realWrite = process.stderr.write;
const realExitCode = process.exitCode;

afterEach(() => {
  if (realPort === undefined) delete process.env[HTTP_PORT_ENV_VAR];
  else process.env[HTTP_PORT_ENV_VAR] = realPort;
  process.stderr.write = realWrite;
  process.exitCode = realExitCode;
});

/** Imports the real `src/entry/http.ts` (what `adhd-policy-http` runs) with the port variable set to `port`. */
function enterHttp(port: string | undefined): IEntered {
  if (port === undefined) delete process.env[HTTP_PORT_ENV_VAR];
  else process.env[HTTP_PORT_ENV_VAR] = port;
  const stderr: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array): boolean => (stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')), true)) as typeof process.stderr.write;
  process.exitCode = undefined;
  const before = new Map(SIGNALS.map((signal) => [signal, process.listeners(signal)] as const));
  vi.resetModules();
  const done = import('../../entry/http').then(() => undefined);
  const installed = (): Array<() => void> => SIGNALS.flatMap((signal) => process.listeners(signal).filter((l) => !before.get(signal)?.includes(l))) as Array<() => void>;
  return { done, stderr, terminate: () => installed()[0]?.call(process) };
}

/** Polls (yielding whole event-loop turns, no timers) until `url` accepts a connection. */
async function untilUp(url: string, failed: Promise<void>): Promise<Response> {
  let finished = false;
  void failed.then(() => (finished = true));
  for (let attempt = 0; attempt < 2000 && !finished; attempt += 1) {
    try {
      return await fetch(url);
    } catch {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throw new Error(`${url} never came up`);
}

const post = (port: number, route: string, body: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('adhd-policy-http entry (src/entry/http.ts) in process', () => {
  it('serves the policy operations on the loopback port from ADHD_POLICY_HTTP_PORT, refuses over HTTP the way check does, and stops on the signal', async () => {
    const port = await freePort();
    const entered = enterHttp(String(port));
    try {
      const up = await untilUp(`http://127.0.0.1:${port}/policy/doctor`, entered.done);
      expect(up.status).toBe(200);
      const verify = await post(port, '/policy/verify', { data: { input: {} } });
      expect(verify.status).toBe(200);
      expect(await verify.json()).toMatchObject({ ok: true, errors: [], sources: ['built-in'] });
      const check = await post(port, '/policy/check', { data: { input: { tool: 'files.read', args: { path: '/x' } } } });
      expect(check.status).toBe(403);
      expect(JSON.stringify(await check.json())).toContain('permission_denied');
    } finally {
      entered.terminate();
      await entered.done;
    }
    await expect(fetch(`http://127.0.0.1:${port}/policy/doctor`)).rejects.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(entered.stderr.join('')).not.toContain('Error');
  });

  it('with the port variable unset the entry binds an OS-chosen ephemeral port and releases it on the signal', async () => {
    const servers = (): number => process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length;
    const before = servers();
    const entered = enterHttp(undefined);
    let finished = false;
    void entered.done.then(() => (finished = true));
    for (let attempt = 0; attempt < 2000 && !finished && servers() === before; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(finished).toBe(false);
    expect(servers()).toBe(before + 1);
    entered.terminate();
    await entered.done;
    for (let attempt = 0; attempt < 2000 && servers() !== before; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(servers()).toBe(before);
    expect(process.exitCode).toBeUndefined();
  });

  it('a signal removes both handlers, so the next one gets the default behaviour', async () => {
    const port = await freePort();
    const counts = SIGNALS.map((signal) => process.listenerCount(signal));
    const entered = enterHttp(String(port));
    await untilUp(`http://127.0.0.1:${port}/policy/doctor`, entered.done);
    expect(SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(counts.map((count) => count + 1));
    entered.terminate();
    await entered.done;
    expect(SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(counts);
  });

  for (const bad of ['abc', '-1', '70000', '80.5']) {
    it(`E6 a bad ${HTTP_PORT_ENV_VAR} ("${bad}") exits 2 naming the variable and binds nothing`, async () => {
      const entered = enterHttp(bad);
      await entered.done;
      expect(process.exitCode).toBe(2);
      expect(entered.stderr.join('')).toContain(HTTP_PORT_ENV_VAR);
      entered.terminate();
    });
  }

  it('E6 a port that is already taken exits 1 with the bind error on stderr and does not disturb the other listener', async () => {
    const taken = await occupy();
    try {
      const entered = enterHttp(String(taken.port));
      await entered.done;
      expect(process.exitCode).toBe(1);
      expect(entered.stderr.join('')).toMatch(/EADDRINUSE/);
      entered.terminate();
      expect(taken.server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => taken.server.close(() => resolve()));
    }
  });
});
