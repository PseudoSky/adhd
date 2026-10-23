/**
 * config.echo.test.ts — R9-hist S5c (AC10 caps): the provider-echo persistence limits are configured
 * through the Environment cascade (`echo.maxMessageBytes`, `echo.maxSessionBytes`,
 * `echo.serverResultTtlMinutes`), default to 128 KiB / 4 MiB / 10 min, pass through
 * `toEngineConfig()` in the engine's `EchoCaps` shape, and fail loud on a negative or non-numeric
 * value. Pure: no process, no network, no provider call.
 *
 * guards: the provider-echo persistence caps ignore the Environment cascade, lose the 128 KiB / 4 MiB / 10 min defaults or the
 *   minutes-to-milliseconds conversion, fail to reach toEngineConfig(), or accept a negative or non-numeric value silently.
 * tier: S (pure config resolution; no process, no network, no provider call)
 * cites: R9-hist S5c AC10 (this file names no backlog uid).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Environment } from '@adhd/environment';

import {
  agentMcpEnvironmentSpec,
  DEFAULT_ECHO_MAX_MESSAGE_BYTES,
  DEFAULT_ECHO_MAX_SESSION_BYTES,
  DEFAULT_ECHO_SERVER_RESULT_TTL_MINUTES,
  parseEchoLimit,
  resolveEchoCaps,
  toEngineConfig,
  type AgentMcpConfig,
} from '../../src/config.js';

const KEYS = [
  'ADHD_AGENT_ECHO_MAX_MESSAGE_BYTES',
  'ADHD_AGENT_ECHO_MAX_SESSION_BYTES',
  'ADHD_AGENT_ECHO_SERVER_RESULT_TTL_MINUTES',
] as const;
const cleanup: string[] = [];

function mk(): Environment<AgentMcpConfig> {
  const base = join(__dirname, '..', '..', '..', '..', 'tmp', 'agent-mcp', 'echo-config-test');
  mkdirSync(base, { recursive: true });
  const adhdRoot = mkdtempSync(join(base, 'root-'));
  const cwd = mkdtempSync(join(tmpdir(), 'adhd-agent-mcp-cwd-'));
  cleanup.push(adhdRoot, cwd);
  return new Environment<AgentMcpConfig>('agent-mcp', agentMcpEnvironmentSpec, {
    namespace: 'production',
    scope: 'global',
    adhdRoot,
    cwd,
  });
}

function withEnv(vars: Partial<Record<(typeof KEYS)[number], string>>): () => void {
  const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  return () => {
    for (const k of KEYS) {
      const v = prev[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

afterEach(() => {
  while (cleanup.length > 0) {
    const d = cleanup.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('R9-hist S5c defaults', () => {
  it('128 KiB per message, 4 MiB per session, 10 minute server-result TTL, default provenance', () => {
    const restore = withEnv({});
    try {
      const target = mk();
      expect(DEFAULT_ECHO_MAX_MESSAGE_BYTES).toBe(131_072);
      expect(DEFAULT_ECHO_MAX_SESSION_BYTES).toBe(4_194_304);
      expect(DEFAULT_ECHO_SERVER_RESULT_TTL_MINUTES).toBe(10);
      expect(resolveEchoCaps(target)).toEqual({
        maxMessageBytes: 131_072,
        maxSessionBytes: 4_194_304,
        serverResultTtlMs: 600_000,
      });
      for (const key of ['maxMessageBytes', 'maxSessionBytes', 'serverResultTtlMinutes']) {
        expect(target.get(`provenance.echo.${key}`)).toMatchObject({ source: 'default' });
      }
    } finally {
      restore();
    }
  });
});

describe('R9-hist S5c cascade resolution', () => {
  it('env vars override every limit and the TTL is converted from minutes to milliseconds', () => {
    const restore = withEnv({
      ADHD_AGENT_ECHO_MAX_MESSAGE_BYTES: '2048',
      ADHD_AGENT_ECHO_MAX_SESSION_BYTES: '65536',
      ADHD_AGENT_ECHO_SERVER_RESULT_TTL_MINUTES: '60',
    });
    try {
      const target = mk();
      expect(resolveEchoCaps(target)).toEqual({
        maxMessageBytes: 2048,
        maxSessionBytes: 65_536,
        serverResultTtlMs: 3_600_000,
      });
      expect(target.get('provenance.echo.serverResultTtlMinutes')).toMatchObject({
        source: 'env',
        env: 'ADHD_AGENT_ECHO_SERVER_RESULT_TTL_MINUTES',
      });
    } finally {
      restore();
    }
  });

  it('TTL 0 is accepted and yields serverResultTtlMs 0 (server results never persisted)', () => {
    const restore = withEnv({ ADHD_AGENT_ECHO_SERVER_RESULT_TTL_MINUTES: '0' });
    try {
      expect(resolveEchoCaps(mk()).serverResultTtlMs).toBe(0);
    } finally {
      restore();
    }
  });

  it('toEngineConfig() carries the resolved caps to the engine', () => {
    // The process singleton reads the real process env: with no ADHD_AGENT_ECHO_* set it is the defaults.
    const restore = withEnv({});
    try {
      expect(toEngineConfig().echo).toEqual({
        maxMessageBytes: DEFAULT_ECHO_MAX_MESSAGE_BYTES,
        maxSessionBytes: DEFAULT_ECHO_MAX_SESSION_BYTES,
        serverResultTtlMs: DEFAULT_ECHO_SERVER_RESULT_TTL_MINUTES * 60_000,
      });
    } finally {
      restore();
    }
  });
});

describe('R9-hist S5c invalid values fail loud', () => {
  const bad: ReadonlyArray<readonly [string, string]> = [
    ['negative', '-1'],
    ['fraction', '1.5'],
    ['garbage', 'abc'],
    ['trailing junk', '10x'],
    ['empty', ''],
    ['whitespace', '   '],
    ['exponent', '1e3'],
  ];
  const targets = [
    ['echo.maxMessageBytes', 'ADHD_AGENT_ECHO_MAX_MESSAGE_BYTES'],
    ['echo.maxSessionBytes', 'ADHD_AGENT_ECHO_MAX_SESSION_BYTES'],
    ['echo.serverResultTtlMinutes', 'ADHD_AGENT_ECHO_SERVER_RESULT_TTL_MINUTES'],
  ] as const;

  for (const [key, envName] of targets) {
    it.each(bad)(`${key}: %s (%j) throws naming the key and env var`, (_label, value) => {
      const restore = withEnv({ [envName]: value });
      try {
        const target = mk();
        expect(() => resolveEchoCaps(target)).toThrow(RangeError);
        expect(() => resolveEchoCaps(target)).toThrow(new RegExp(`${key.replace('.', '\\.')}.*${envName}`));
      } finally {
        restore();
      }
    });
  }

  it('parseEchoLimit rejects non-string, non-number, NaN, infinite, unsafe and negative numbers', () => {
    for (const raw of [undefined, null, {}, [], true, Number.NaN, Infinity, -1, 1.5, 2 ** 60]) {
      expect(() => parseEchoLimit('echo.x', 'E', raw)).toThrow(RangeError);
    }
    expect(parseEchoLimit('echo.x', 'E', 0)).toBe(0);
    expect(parseEchoLimit('echo.x', 'E', ' 42 ')).toBe(42);
    expect(parseEchoLimit('echo.x', 'E', 7)).toBe(7);
  });
});
