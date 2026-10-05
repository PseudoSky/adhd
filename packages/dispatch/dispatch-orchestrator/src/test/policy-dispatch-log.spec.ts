/**
 * policy-dispatch-log.spec.ts — backlog 4e829a08 AC4.
 *
 * Proves a policy enforcement stop survives the dispatch→agent-mcp boundary
 * and is SURFACED IN `dispatch_log` (the residual AC after AC1–AC3 landed the
 * engine-side PolicyEngine contract test, see
 * agent-engine-orchestrator/src/__tests__/policy-delegation.test.ts).
 *
 * Real components: the dispatch loop (`orchestrateCycle`), the real
 * `AgentMcpRunner` wire-parsing path, and the REAL `PolicyEngine` (never the
 * no-op stub `real-turn-telemetry.spec.ts` used). The only fake is the MCP
 * transport (`FakeMcpToolClient`) — the documented external boundary — whose
 * `result` handler runs the real `PolicyEngine.check()` and, on a violation,
 * returns the same `{status:'failed', error:'[CODE] message'}` payload
 * agent-mcp persists on a task. Nothing under test (the dispatch-side error
 * plumbing) is mocked.
 *
 * NEGATIVE CONTROL: raising the limit / adding the agent to the allowlist
 * makes the identical chain succeed and leaves NO policy code in
 * `dispatch_log` — so the assertion has teeth.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  DagJson,
  DispatchLogEntry,
  MilestoneDag,
  OperationDag,
  ProviderConfig,
} from '@adhd/dispatch-base-spec';
import { createDagClient } from '@adhd/dispatch-core-client';
import { createJsonFileSerializer } from '@adhd/dispatch-serializer-json';
import { snapshot, optimize } from '@adhd/dispatch-core-optimizer';
import {
  PolicyEngine,
  ToolError,
  type ExecutionContext,
} from '@adhd/agent-engine-orchestrator';

import { AgentMcpRunner } from '../lib/agent-runner.js';
import { orchestrateCycle, type OrchestratorDeps } from '../lib/orchestrator.js';
import { FakeMcpToolClient, mcpError } from './helpers/fake-mcp-client.js';

const TMP_ROOT = path.join(
  process.cwd(),
  'tmp',
  'dispatch-orchestrator',
  'policy-dispatch-log-spec'
);

beforeAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures (mirror orchestrator.spec.ts's shape, kept local on purpose)
// ---------------------------------------------------------------------------

const PASS_GUARD = 'node -e "process.exit(0)"';
const TARGET_AGENT = 'forbidden-agent';

function makeProviderConfig(): ProviderConfig {
  return {
    type: 'claudecli',
    model_id: 'claude-sonnet-test',
    env_secret: null,
    base_url: null,
    timeout_ms: 30000,
    retry_config: { retries: 0, min_timeout: 0, max_timeout: 0, factor: 1 },
  };
}

function makeMilestone(overrides: Partial<MilestoneDag> = {}): MilestoneDag {
  return {
    description: 'dispatch a delegating milestone',
    authored_by: 'test',
    pending: null,
    triggered_by: null,
    phase: 'test',
    depends_on: [],
    agent: 'workflow-researcher',
    model: 'Sonnet',
    effort: 'medium',
    two_stage: false,
    read_only: [],
    guard: PASS_GUARD,
    ...overrides,
  };
}

function makeOp(overrides: Partial<OperationDag> = {}): OperationDag {
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
    ki_estimate: 100,
    ki_source: 'estimate',
    authored_by: 'test',
    status: 'pending',
    shape: {
      kind: 'doc',
      description: 'do the thing',
      objective: 'the thing is done',
      required_sections: [],
    },
    ...overrides,
  };
}

function makeDag(overrides: Partial<DagJson> = {}): DagJson {
  return {
    schema_version: 4,
    plan_kind: 'greenfield',
    description: 'test plan',
    problem: 'test',
    approach: 'test',
    executor: 'test',
    phases: ['test'],
    terminal: 'a',
    optimization: {
      sentinel_fanout: {
        enabled: false,
        write_multiplier: 1.25,
        read_multiplier: 0.1,
        hit_probability: 0.9,
      },
      b_per_tier: {},
      context_window_per_tier: {},
      context_window_override: null,
      b_override: null,
    },
    providers: { Sonnet: makeProviderConfig() },
    effort_max_tokens: { medium: 4096, high: 8192 },
    milestones: { a: makeMilestone() },
    operations: [makeOp()],
    dispatch_log: [],
    ...overrides,
  };
}

function makeExecutionContext(recursionDepth: number): ExecutionContext {
  return {
    taskId: 'seed-task',
    sessionId: 'seed-session',
    agentName: 'dispatch-agent',
    agentDefinition: {
      name: 'dispatch-agent',
      version: 1,
      provider: { type: 'claudecli' },
      mcpServers: {},
      permissions: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    recursionDepth,
    toolCallCount: 0,
  } as unknown as ExecutionContext;
}

/**
 * Build a real `AgentMcpRunner` over a `FakeMcpToolClient` whose `result`
 * handler runs the REAL `PolicyEngine.check()`. On a violation it returns the
 * payload agent-mcp persists on the task (`status:'failed'` +
 * `error:'[CODE] message'`); otherwise the task completes.
 */
function makeRunner(policy: PolicyEngine, ctx: ExecutionContext): AgentMcpRunner {
  const fake = new FakeMcpToolClient({
    agent_read: () => mcpError('AGENT_NOT_FOUND', 'not found'),
    agent_create: () => ({ ok: true }),
    task: () => ({ task_id: 'task-1' }),
    usage_query: () => ({ rows: [] }),
    result: () => {
      try {
        policy.check({
          executionContext: ctx,
          targetTool: 'agent-mcp__agent',
          targetAgentName: TARGET_AGENT,
        });
        return { status: 'completed', result: 'delegation permitted', usage: undefined };
      } catch (err) {
        if (err instanceof ToolError) {
          return { status: 'failed', error: `[${err.code}] ${err.message}` };
        }
        throw err;
      }
    },
  });
  return new AgentMcpRunner({ command: 'unused-in-test', clientFactory: () => fake });
}

async function setupScenario(
  name: string,
  policy: PolicyEngine,
  ctx: ExecutionContext
): Promise<{ dagPath: string; deps: OrchestratorDeps }> {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const dagPath = path.join(dir, 'dag.json');
  const client = createDagClient(createJsonFileSerializer(dagPath));
  await client.saveDag(makeDag());

  let idN = 0;
  const deps: OrchestratorDeps = {
    client,
    optimizer: { snapshot, optimize },
    runner: makeRunner(policy, ctx),
    clock: (() => {
      let n = 0;
      return () => `2026-01-01T00:00:${String(n++).padStart(2, '0')}Z`;
    })(),
    idFactory: () => `test-dispatch-${idN++}`,
    sleep: async () => {
      /* zero-delay — never a real wall-clock wait */
    },
    poll: { intervalMs: 0, timeoutMs: 0 },
  };
  return { dagPath, deps };
}

function reload(dagPath: string): Promise<DagJson> {
  return createDagClient(createJsonFileSerializer(dagPath)).load();
}

function logText(entry: DispatchLogEntry): string {
  return [
    ...entry.notes.map((n) => n.text),
    ...entry.results.map((r) => r.guard_output ?? ''),
    ...entry.results.map((r) => (r.tool_result ? JSON.stringify(r.tool_result) : '')),
  ].join('\n');
}

describe('dispatch_log surfaces a policy violation (4e829a08 AC4)', () => {
  it('records a DELEGATION_NOT_ALLOWED stop in dispatch_log', async () => {
    const policy = new PolicyEngine({
      serverMaxDepth: 5,
      serverMaxToolLoops: 50,
      serverAllowedAgents: ['some-other-agent'],
    });
    const { dagPath, deps } = await setupScenario(
      'delegation-not-allowed',
      policy,
      makeExecutionContext(0)
    );

    const result = await orchestrateCycle(deps);
    expect(result.dispatched[0]?.taskStatus).toBe('failed');

    // Reload from a FRESH client — the consumer-visible dispatch_log on disk.
    const reloaded = await reload(dagPath);
    const entry = reloaded.dispatch_log[0] as DispatchLogEntry;

    expect(logText(entry)).toContain('DELEGATION_NOT_ALLOWED');
    expect(logText(entry)).toContain(TARGET_AGENT);
    expect(entry.results.some((r) => r.status === 'failed')).toBe(true);
  });

  it('records a MAX_DEPTH_EXCEEDED stop in dispatch_log', async () => {
    const policy = new PolicyEngine({
      serverMaxDepth: 1,
      serverMaxToolLoops: 50,
    });
    const { dagPath, deps } = await setupScenario(
      'max-depth',
      policy,
      // recursionDepth === serverMaxDepth triggers the depth stop first.
      makeExecutionContext(1)
    );

    const result = await orchestrateCycle(deps);
    expect(result.dispatched[0]?.taskStatus).toBe('failed');

    const reloaded = await reload(dagPath);
    const entry = reloaded.dispatch_log[0] as DispatchLogEntry;
    expect(logText(entry)).toContain('MAX_DEPTH_EXCEEDED');
  });

  it('NEGATIVE CONTROL: allowlisting the agent lets the same chain succeed with no policy code', async () => {
    const policy = new PolicyEngine({
      serverMaxDepth: 5,
      serverMaxToolLoops: 50,
      // The previously-forbidden target is now allowed.
      serverAllowedAgents: [TARGET_AGENT],
    });
    const { dagPath, deps } = await setupScenario(
      'delegation-allowed',
      policy,
      makeExecutionContext(0)
    );

    const result = await orchestrateCycle(deps);
    expect(result.dispatched[0]?.taskStatus).toBe('completed');

    const reloaded = await reload(dagPath);
    const entry = reloaded.dispatch_log[0] as DispatchLogEntry;
    const text = logText(entry);
    expect(text).not.toContain('DELEGATION_NOT_ALLOWED');
    expect(text).not.toContain('MAX_DEPTH_EXCEEDED');
    expect(entry.results.find((r) => r.op_id === 'a.1')?.status).toBe('complete');
  });
});
