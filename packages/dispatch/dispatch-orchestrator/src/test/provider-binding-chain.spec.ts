/**
 * provider-binding-chain.spec.ts — d3f1f787 / b578a483 (D-G(1)) AC4, driven
 * through the REAL consumer path.
 *
 * A legacy v4 `.dag.json` (snake_case `providers`, as already on disk in user
 * repos) is written raw to disk, then loaded by the real
 * `createJsonFileSerializer` + `createDagClient`, optimized, and dispatched by
 * the real `orchestrateCycle` with a real `AgentMcpRunner`. The only double is
 * the MCP client (the external boundary). Asserted outcome: the
 * `agent_create` wire payload carries every provider field intact.
 *
 * Teeth: removing `upgradeDagToCurrent` from the serializer's readDag turns the
 * v4 test red (the runner would receive snake_case keys and send an empty
 * claudecli default) — see the dispatch evidence in the return report.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type {
  DagJson,
  MilestoneDag,
  OperationDag,
} from '@adhd/dispatch-base-spec';
import { createDagClient } from '@adhd/dispatch-core-client';
import { createJsonFileSerializer } from '@adhd/dispatch-serializer-json';
import { snapshot, optimize } from '@adhd/dispatch-core-optimizer';

import { AgentMcpRunner } from '../lib/agent-runner.js';
import { orchestrateCycle, type OrchestratorDeps } from '../lib/orchestrator.js';
import { FakeMcpToolClient, mcpError } from './helpers/fake-mcp-client.js';

const TMP_ROOT = path.join(process.cwd(), 'tmp', 'dispatch-orchestrator', 'provider-binding-chain');

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

function milestone(agentName: string): MilestoneDag {
  return {
    description: 'deleted-persona milestone',
    authored_by: 'test',
    pending: null,
    triggered_by: null,
    phase: 'test',
    depends_on: [],
    agent: agentName,
    model: 'Sonnet',
    effort: 'medium',
    two_stage: false,
    read_only: [],
    guard: 'node -e "process.exit(0)"',
  };
}

function op(): OperationDag {
  return {
    id: 'a.1',
    milestone: 'a',
    depends_on: [],
    type: 'generative',
    action: 'create',
    file: null,
    symbol: null,
    provenance: 'manual',
    confidence: 'documented',
    audit_check: null,
    criteria: [],
    tool: null,
    args: null,
    guard: null,
    to_file: null,
    to_symbol: null,
    ki_estimate: 50,
    ki_source: 'estimate',
    authored_by: 'test',
    status: 'pending',
    shape: { kind: 'doc', description: 'do it', objective: 'done', required_sections: [] },
  };
}


function baseDag(): Record<string, unknown> {
  const dag: DagJson = {
    schema_version: 5,
    plan_kind: 'greenfield',
    description: 'provider binding chain plan',
    problem: 'x',
    approach: 'y',
    executor: 'test',
    phases: ['test'],
    terminal: 'a',
    optimization: {
      sentinel_fanout: { enabled: false, write_multiplier: 1.25, read_multiplier: 0.1, hit_probability: 0.9 },
      b_per_tier: {},
      context_window_per_tier: {},
      context_window_override: null,
      b_override: null,
    },
    providers: {},
    effort_max_tokens: { medium: 4096 },
    milestones: { a: milestone('chain-agent') },
    operations: [op()],
    dispatch_log: [],
  };
  return dag as unknown as Record<string, unknown>;
}

const V4_SONNET = {
  type: 'openai',
  model_id: 'deepseek-chat',
  env_secret: 'ADHD_AGENT_DEEPSEEK_SECRET',
  base_url: 'https://api.deepseek.com/v1',
  timeout_ms: 180000,
  retry_config: { retries: 2, min_timeout: 1000, max_timeout: 5000, factor: 2 },
};

const V5_SONNET = {
  providerType: 'openai',
  modelRef: 'deepseek-chat',
  env: { secret: 'ADHD_AGENT_DEEPSEEK_SECRET' },
  baseURL: 'https://api.deepseek.com/v1',
  timeoutMs: 180000,
  retryConfig: { retries: 2, minTimeout: 1000, maxTimeout: 5000, factor: 2 },
};

const EXPECTED_WIRE = {
  type: 'openai',
  model: 'deepseek-chat',
  baseURL: 'https://api.deepseek.com/v1',
  env: { secret: 'ADHD_AGENT_DEEPSEEK_SECRET' },
  timeoutMs: 180000,
  retryConfig: { retries: 2, minTimeout: 1000, maxTimeout: 5000, factor: 2 },
};

async function dispatchFromFile(
  name: string,
  version: number,
  sonnet: Record<string, unknown>
): Promise<FakeMcpToolClient> {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const dagPath = path.join(dir, 'dag.json');
  const raw = baseDag();
  raw['schema_version'] = version;
  raw['providers'] = { Sonnet: sonnet };
  fs.writeFileSync(dagPath, JSON.stringify(raw, null, 2), 'utf-8');

  const mcp = new FakeMcpToolClient({
    agent_read: () => mcpError('AGENT_NOT_FOUND', "Agent 'chain-agent' not found"),
    agent_create: (args) => ({
      ...args,
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    task: () => ({ task_id: 't1', status: 'completed', result: 'ok' }),
    result: () => ({ id: 't1', status: 'completed' }),
    usage_query: () => ({ rows: [] }),
  });
  const runner = new AgentMcpRunner({
    command: 'unused-in-test',
    clientFactory: () => mcp,
    createAgentsIfMissing: true,
  });
  let idN = 0;
  const deps: OrchestratorDeps = {
    client: createDagClient(createJsonFileSerializer(dagPath)),
    optimizer: { snapshot, optimize },
    runner,
    clock: (() => {
      let n = 0;
      return () => `2026-01-01T00:00:${String(n++).padStart(2, '0')}Z`;
    })(),
    idFactory: () => `chain-dispatch-${idN++}`,
    sleep: async () => {
      /* zero-delay */
    },
    poll: { intervalMs: 0, timeoutMs: 10_000 },
    continueOnError: false,
  };
  const result = await orchestrateCycle(deps);
  expect(result.dispatched[0]?.taskStatus).toBe('completed');
  return mcp;
}

describe('provider binding chain (d3f1f787 AC4)', () => {
  it('d3f1f787 AC4 — a legacy v4 snake_case dag.json on disk reaches agent_create with every provider field intact', async () => {
    const mcp = await dispatchFromFile('v4-on-disk', 4, V4_SONNET);
    const create = mcp.calls.find((c) => c.name === 'agent_create');
    expect(create?.arguments?.['provider']).toEqual(EXPECTED_WIRE);
  });

  it('d3f1f787 AC4 — a native v5 camelCase dag.json yields the identical wire payload', async () => {
    const mcp = await dispatchFromFile('v5-on-disk', 5, V5_SONNET);
    const create = mcp.calls.find((c) => c.name === 'agent_create');
    expect(create?.arguments?.['provider']).toEqual(EXPECTED_WIRE);
  });
});
