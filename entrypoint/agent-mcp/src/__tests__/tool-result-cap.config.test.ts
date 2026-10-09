/**
 * tool-result-cap.config.test.ts — backlog 3ad735bb (BK1), plan 9ed453c1,
 * AC1.3: the cap is configurable through the Environment cascade
 * (`agent.toolResult.maxChars` / `ADHD_AGENT_TOOL_RESULT_MAX_CHARS`), `0`
 * disables, and an invalid value fails loud before any task runs.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Environment } from '@adhd/environment';
import { parseToolResultMaxChars } from '@adhd/agent-engine-orchestrator';

import { agentMcpEnvironmentSpec, type AgentMcpConfig } from '../config.js';

const ENV = 'ADHD_AGENT_TOOL_RESULT_MAX_CHARS';
const cleanup: string[] = [];

function mk(): Environment<AgentMcpConfig> {
  const base = join(__dirname, '..', '..', '..', '..', 'tmp', 'agent-mcp', 'tool-result-cap-config-test');
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

function withEnv(value: string | undefined): () => void {
  const prev = process.env[ENV];
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  return () => {
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  };
}

afterEach(() => {
  while (cleanup.length > 0) {
    const d = cleanup.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('3ad735bb AC1.3 agent.toolResult.maxChars through the Environment cascade (plan 9ed453c1)', () => {
  it('defaults to 20000 with no env var and records default provenance', () => {
    const restore = withEnv(undefined);
    try {
      const env = mk();
      expect(parseToolResultMaxChars(env.config.agent.toolResult.maxChars)).toBe(20_000);
      expect(env.get('provenance.agent.toolResult.maxChars')).toMatchObject({ source: 'default' });
    } finally {
      restore();
    }
  });

  it('ADHD_AGENT_TOOL_RESULT_MAX_CHARS overrides it; 0 is a valid value (disabled)', () => {
    let restore = withEnv('5000');
    try {
      const env = mk();
      expect(parseToolResultMaxChars(env.config.agent.toolResult.maxChars)).toBe(5_000);
      expect(env.get('provenance.agent.toolResult.maxChars')).toMatchObject({ source: 'env', env: ENV });
    } finally {
      restore();
    }
    restore = withEnv('0');
    try {
      expect(parseToolResultMaxChars(mk().config.agent.toolResult.maxChars)).toBe(0);
    } finally {
      restore();
    }
  });

  it.each(['-1', 'abc', '1.5', 'NaN', '20000abc', '', '  ', '1e3'])('invalid env value %p fails loud, never a silent default or a silent disable', (bad) => {
    const restore = withEnv(bad);
    try {
      const resolve = (): number => {
        return parseToolResultMaxChars(mk().config.agent.toolResult.maxChars);
      };
      expect(resolve).toThrow();
    } finally {
      restore();
    }
  });
});
