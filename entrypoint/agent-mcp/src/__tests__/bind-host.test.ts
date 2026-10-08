/**
 * Bind-host default (backlog 5989ed90 S9 "binds all interfaces"; placeholder
 * id `host-default-localhost`). Pure resolution tests — no socket is bound
 * (ADR-0009: real-socket proof lives in the e2e lane).
 *
 * Root cause being guarded: through @adhd/agent-mcp 2.3.6 `server.ts` called
 * `httpServer.listen(port)` with NO host, which Node binds on every interface
 * (`*:port`). Node does the same for an empty-string host, so the resolver
 * must also treat ""/whitespace as unset.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Environment } from '@adhd/environment';

import { agentMcpEnvironmentSpec, type AgentMcpConfig } from '../config.js';
import {
  DEFAULT_BIND_HOST,
  isLoopbackHost,
  resolveBindHost,
} from '../bind-host.js';

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** Fresh cascade from the REAL spec, isolated from ~/.adhd and this repo's .adhd. */
function makeEnv() {
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), 'adhd-bind-host-'));
    dirs.push(d);
    return d;
  };
  return new Environment<AgentMcpConfig>('agent-mcp', agentMcpEnvironmentSpec, {
    namespace: 'production',
    scope: 'global',
    adhdRoot: mk(),
    cwd: mk(),
  });
}

describe('[host-default-localhost] cascade default for the listening hosts', () => {
  it('transport.host and sse.host default to 127.0.0.1 with no env and no files', () => {
    setEnv('ADHD_AGENT_HOST', undefined);
    setEnv('ADHD_AGENT_SSE_HOST', undefined);
    const env = makeEnv();
    expect(env.config.transport.host).toBe('127.0.0.1');
    expect(env.config.sse.host).toBe('127.0.0.1');
    expect(env.get('provenance.transport.host')).toMatchObject({ source: 'default' });
    expect(resolveBindHost(env.config.transport.host, 'x')).toBe(DEFAULT_BIND_HOST);
  });

  it('an explicit ADHD_AGENT_HOST / ADHD_AGENT_SSE_HOST override still selects 0.0.0.0', () => {
    setEnv('ADHD_AGENT_HOST', '0.0.0.0');
    setEnv('ADHD_AGENT_SSE_HOST', '::');
    const env = makeEnv();
    expect(env.config.transport.host).toBe('0.0.0.0');
    expect(resolveBindHost(env.config.transport.host, 'x')).toBe('0.0.0.0');
    expect(resolveBindHost(env.config.sse.host, 'x')).toBe('::');
  });

  it('an EMPTY ADHD_AGENT_HOST can never reach listen() as "" (which Node binds on all interfaces)', () => {
    setEnv('ADHD_AGENT_HOST', '');
    const env = makeEnv();
    // Whatever the cascade yields for "", the resolved bind host is loopback.
    expect(resolveBindHost(env.config.transport.host, 'x')).toBe('127.0.0.1');
  });
});

describe('[host-default-localhost] resolveBindHost', () => {
  it.each([undefined, '', '   '])('falls back to 127.0.0.1 for %j', (v) => {
    expect(resolveBindHost(v, 'MCP')).toBe('127.0.0.1');
  });

  it('keeps an explicit loopback host verbatim and does NOT warn', () => {
    const warn = vi.fn();
    expect(resolveBindHost('localhost', 'MCP', { warn })).toBe('localhost');
    expect(resolveBindHost(' ::1 ', 'MCP', { warn })).toBe('::1');
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a warning naming the host and listener when binding non-loopback', () => {
    const warn = vi.fn();
    expect(resolveBindHost('0.0.0.0', 'MCP http transport', { warn })).toBe('0.0.0.0');
    expect(warn).toHaveBeenCalledTimes(1);
    const [obj, msg] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(obj).toMatchObject({ host: '0.0.0.0', listener: 'MCP http transport' });
    expect(msg).toMatch(/non-loopback/);
    expect(msg).toMatch(/unauthenticated/);
  });

  it('the default never warns', () => {
    const warn = vi.fn();
    resolveBindHost(undefined, 'MCP', { warn });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('[host-default-localhost] isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]', '::ffff:127.0.0.1'])(
    'treats %s as loopback',
    (h) => expect(isLoopbackHost(h)).toBe(true)
  );
  it.each(['0.0.0.0', '::', '[::]', '192.168.1.5', '10.0.0.1', '8.8.8.8', 'example.com', '127.0.0', '::ffff:10.0.0.1'])(
    'treats %s as NOT loopback',
    (h) => expect(isLoopbackHost(h)).toBe(false)
  );
});
