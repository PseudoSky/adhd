/**
 * no-auto-create-dispatch.spec.ts — backlog f1dbd0f2.
 *
 * A DAG milestone names an agent via its `agent` field. If that persona was
 * imported and later `agent_delete`d, `AgentMcpRunner.ensureAgent` used to
 * `agent_create` it again (empty/default systemPrompt) — so the run silently
 * used a DIFFERENT agent than the operator named. With no-auto-create active
 * (the production dispatch mode), the unit must FAIL `AGENT_NOT_FOUND`.
 *
 * Drives the REAL `orchestrateCycle` + a REAL `AgentMcpRunner` (the only test
 * double is the MCP client — the external boundary), and asserts the
 * consumer-visible outcome: the run rejects with AGENT_NOT_FOUND and ZERO
 * `agent_create` calls. The negative control (createAgentsIfMissing:true)
 * proves the mode is what fails the run — reverting it re-creates the persona.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type {
  DagJson,
  MilestoneDag,
  OperationDag,
  ProviderConfig,
} from '@adhd/dispatch-base-spec';
import { createDagClient } from '@adhd/dispatch-core-client';
import { createJsonFileSerializer } from '@adhd/dispatch-serializer-json';
import { snapshot, optimize } from '@adhd/dispatch-core-optimizer';

import { AgentMcpRunner, type IDispatchAgentRunner } from '../lib/agent-runner.js';
import { orchestrateCycle, type OrchestratorDeps } from '../lib/orchestrator.js';
import {
  FakeMcpToolClient,
  mcpError,
} from './helpers/fake-mcp-client.js';

const TMP_ROOT = path.join(
  process.cwd(),
  'tmp',
  'dispatch-orchestrator',
  'no-auto-create-spec'
);

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

function providerConfig(): ProviderConfig {
  return {
    type: 'claudecli',
    model_id: 'claude-sonnet-test',
    env_secret: null,
    base_url: null,
    timeout_ms: 30_000,
    retry_config: { retries: 0, min_timeout: 0, max_timeout: 0, factor: 1 },
  };
}

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

function makeDag(agentName: string): DagJson {
  return {
    schema_version: 4,
    plan_kind: 'greenfield',
    description: 'no-auto-create plan',
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
    providers: { Sonnet: providerConfig() },
    effort_max_tokens: { medium: 4096 },
    milestones: { a: milestone(agentName) },
    operations: [op()],
    dispatch_log: [],
  };
}

async function setup(
  name: string,
  agentName: string,
  runner: IDispatchAgentRunner
): Promise<{ deps: OrchestratorDeps }> {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const dagPath = path.join(dir, 'dag.json');
  const serializer = createJsonFileSerializer(dagPath);
  const client = createDagClient(serializer);
  await client.saveDag(makeDag(agentName));

  let idN = 0;
  const deps: OrchestratorDeps = {
    client,
    optimizer: { snapshot, optimize },
    runner,
    clock: (() => {
      let n = 0;
      return () => `2026-01-01T00:00:${String(n++).padStart(2, '0')}Z`;
    })(),
    idFactory: () => `test-dispatch-${idN++}`,
    sleep: async () => {
      /* zero-delay */
    },
    poll: { intervalMs: 0, timeoutMs: 10_000 },
    // Surface the run failure to the test instead of swallowing it.
    continueOnError: false,
  };
  return { deps };
}

describe('no-auto-create dispatch mode (f1dbd0f2)', () => {
  it('AC2: a DAG naming a missing (deleted) persona fails AGENT_NOT_FOUND and never re-creates it', async () => {
    const client = new FakeMcpToolClient({
      agent_read: () =>
        mcpError('AGENT_NOT_FOUND', "Agent 'deleted-persona' not found"),
    });
    const runner = new AgentMcpRunner({
      command: 'unused-in-test',
      clientFactory: () => client,
      createAgentsIfMissing: false,
    });

    const { deps } = await setup('no-auto-create', 'deleted-persona', runner);

    await expect(orchestrateCycle(deps)).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
    });
    // Teeth: the deleted persona was read (miss) and NEVER re-created.
    expect(client.calls.map((c) => c.name)).toEqual(['agent_read']);
  });

  it('NEGATIVE CONTROL: createAgentsIfMissing:true re-creates the persona and the run proceeds', async () => {
    const client = new FakeMcpToolClient({
      agent_read: () =>
        mcpError('AGENT_NOT_FOUND', "Agent 'deleted-persona' not found"),
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
      clientFactory: () => client,
      createAgentsIfMissing: true,
    });

    const { deps } = await setup('auto-create-control', 'deleted-persona', runner);
    const result = await orchestrateCycle(deps);

    expect(client.calls.some((c) => c.name === 'agent_create')).toBe(true);
    expect(result.dispatched[0]?.taskStatus).toBe('completed');
  });
});
