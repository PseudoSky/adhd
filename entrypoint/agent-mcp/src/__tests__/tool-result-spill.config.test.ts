/**
 * tool-result-spill.config.test.ts — plan 9ed453c1, backlog 3ad735bb, bucket BK9 AC9.1 / AC9.6:
 * the spill mode is configured through the Environment cascade (`agent.toolResult.spill.*`), is OFF by
 * default, defaults its dir under the Environment-resolved agent-mcp temp root, and fails loud on a
 * relative / invalid dir or ttl. Pure: no process, no network, no spill file is written.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Environment } from '@adhd/environment';

import { agentMcpEnvironmentSpec, resolveLogRoots, resolveToolResultSpill, type AgentMcpConfig } from '../config.js';

const KEYS = [
  'ADHD_AGENT_TOOL_RESULT_SPILL_ENABLED',
  'ADHD_AGENT_TOOL_RESULT_SPILL_DIR',
  'ADHD_AGENT_TOOL_RESULT_SPILL_TTL_HOURS',
] as const;
const cleanup: string[] = [];

function mk(): Environment<AgentMcpConfig> {
  const base = join(__dirname, '..', '..', '..', '..', 'tmp', 'agent-mcp', 'tool-result-spill-config-test');
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

describe('9ed453c1 BK9 AC9.1 spill is OFF by default', () => {
  it('defaults: disabled, dir = <temp>/tool-results, ttl 24h, default provenance', () => {
    const restore = withEnv({});
    try {
      const target = mk();
      const spill = resolveToolResultSpill(target);
      expect(spill.enabled).toBe(false);
      expect(spill.dir).toBe(join(resolveLogRoots(target).temp, 'tool-results'));
      expect(spill.ttlMs).toBe(24 * 3_600_000);
      expect(target.get('provenance.agent.toolResult.spill.enabled')).toMatchObject({ source: 'default' });
    } finally {
      restore();
    }
  });
});

describe('9ed453c1 BK9 spill config through the Environment cascade', () => {
  it('env vars enable it and override dir and ttl', () => {
    const restore = withEnv({
      ADHD_AGENT_TOOL_RESULT_SPILL_ENABLED: 'true',
      ADHD_AGENT_TOOL_RESULT_SPILL_DIR: '/var/tmp/adhd-spill',
      ADHD_AGENT_TOOL_RESULT_SPILL_TTL_HOURS: '6',
    });
    try {
      const target = mk();
      expect(resolveToolResultSpill(target)).toEqual({ enabled: true, dir: '/var/tmp/adhd-spill', ttlMs: 6 * 3_600_000 });
      expect(target.get('provenance.agent.toolResult.spill.enabled')).toMatchObject({
        source: 'env',
        env: 'ADHD_AGENT_TOOL_RESULT_SPILL_ENABLED',
      });
    } finally {
      restore();
    }
  });
});

describe('9ed453c1 BK9 AC9.6 invalid values fail loud', () => {
  it.each([
    ['relative dir', { ADHD_AGENT_TOOL_RESULT_SPILL_DIR: 'spill/here' }, /spill\.dir.*absolute/],
    ['dot-dot dir', { ADHD_AGENT_TOOL_RESULT_SPILL_DIR: '/var/tmp/../etc' }, /\.\./],
    ['empty-ish dir', { ADHD_AGENT_TOOL_RESULT_SPILL_DIR: '   ' }, /non-empty absolute/],
    ['ttl zero', { ADHD_AGENT_TOOL_RESULT_SPILL_TTL_HOURS: '0' }, /ttlHours/],
    ['ttl fraction', { ADHD_AGENT_TOOL_RESULT_SPILL_TTL_HOURS: '1.5' }, /ttlHours/],
    ['ttl garbage', { ADHD_AGENT_TOOL_RESULT_SPILL_TTL_HOURS: '12h' }, /ttlHours/],
  ])('%s throws even while spill is disabled', (_n, vars, re) => {
    const restore = withEnv(vars);
    try {
      expect(() => resolveToolResultSpill(mk())).toThrow(re);
    } finally {
      restore();
    }
  });
});
