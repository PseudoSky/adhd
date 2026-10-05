/**
 * hitl-suspension.spec.ts — deterministic, NON-PAID proof of the HITL
 * suspend/resume mechanics reachable from the dispatch orchestrator
 * (backlog 03145a46).
 *
 * Real components throughout: real `createJsonFileSerializer` + `DagClient`,
 * real `snapshot()`/`optimize()`, real `orchestrateCycle`, real
 * `AgentMcpRunner`. The ONLY double is the MCP client —
 * `FakeMcpToolClient`, which is the documented external boundary (a real
 * agent-mcp process/real model is a paid third-party call; the live proof is
 * owned by `entrypoint/dispatch-cli`'s env-gated `live-dispatch-five-acs`).
 *
 * WHAT THIS PROVES (the consumer outcome, not the implementation shape)
 *   A sessioned unit fires with `background:true`; the existing poll observes
 *   `awaiting_input`; the unit is parked (NOT failed, NO correction injected)
 *   with the suspension (task id + resumeToken) persisted on the dag.json's
 *   dispatch_log entry; and agent-mcp's `task_resume` drives the task to
 *   `completed`.
 *
 * NEGATIVE CONTROL (teeth, run in this file)
 *   `PreFixSyncFireRunner` reproduces the PRE-FIX `fire()` — a sessioned task
 *   with NO `background` — and the fake MCP client rejects such a call exactly
 *   the way the real MCP SDK does once the engine blocks on
 *   `await userInputPromise`: `-32001 Request timed out`. The second test
 *   asserts that cycle REJECTS, i.e. the suspension is unobservable without the
 *   `background:true` fix. Reverting `fire()`'s `background:true` turns the
 *   first test red (its `task` call would be rejected the same way).
 *
 * Deterministic without timing: the poll uses `intervalMs:0, timeoutMs:0`, so
 * it terminates on the first `result` read; the fake's `result` handler flips
 * to `completed` only after `task_resume` is called, so no `sleep`/wall-clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  DagJson,
  DispatchUnit,
  MilestoneDag,
  OperationDag,
  ProviderConfig,
} from '@adhd/dispatch-base-spec';
import { createDagClient } from '@adhd/dispatch-core-client';
import { createJsonFileSerializer } from '@adhd/dispatch-serializer-json';
import { snapshot, optimize } from '@adhd/dispatch-core-optimizer';

import { AgentMcpRunner } from '../lib/agent-runner.js';
import { orchestrateCycle, type OrchestratorDeps } from '../lib/orchestrator.js';
import {
  FakeMcpToolClient,
  type FakeToolHandler,
} from './helpers/fake-mcp-client.js';

const TMP_ROOT = path.join(
  process.cwd(),
  'tmp',
  'dispatch-orchestrator',
  'hitl-suspension-spec'
);

beforeAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
});
afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const RESUME_TOKEN = '44444444-4444-4444-8444-444444444444';

interface HitlState {
  resumed: boolean;
  taskArgs: Record<string, unknown> | undefined;
  /** When true, `result` rejects (simulates a transient poll failure). */
  resultThrows?: boolean;
}

/**
 * The fake agent-mcp tool surface for a HITL task. `task` returns an immediate
 * `{task_id, status:'pending'}` ONLY when `background:true` is sent; a
 * synchronous sessioned call (no background) is rejected with the MCP client's
 * request-timeout error, exactly as the real client aborts once the engine
 * blocks on `await userInputPromise` past 60s.
 */
function makeHitlHandlers(state: HitlState): Record<string, FakeToolHandler> {
  return {
    agent_read: () => ({ name: 'hitl-agent' }),
    task: (args) => {
      state.taskArgs = args;
      if (args?.['background'] !== true) {
        throw new Error('MCP error -32001: Request timed out');
      }
      return { task_id: TASK_ID, status: 'pending' };
    },
    result: () => {
      if (state.resultThrows) {
        throw new Error('MCP error -32000: transient poll failure');
      }
      return state.resumed
        ? { status: 'completed', result: 'approved and done' }
        : { status: 'awaiting_input', resumeToken: RESUME_TOKEN };
    },
    task_resume: (args) => {
      if (args?.['resumeToken'] !== RESUME_TOKEN) {
        return {
          __mcpError: { code: 'VALIDATION_ERROR', message: 'Invalid resumeToken' },
        };
      }
      state.resumed = true;
      return { success: true, taskId: args?.['taskId'] };
    },
    // dispatchUnit always reconciles turns after a poll; return an empty set.
    usage_query: () => ({ rows: [] }),
  };
}

function makeProviderConfig(): ProviderConfig {
  return {
    type: 'claudecli',
    model_id: 'claude-sonnet-test',
    env_secret: null,
    base_url: null,
    timeout_ms: 30_000,
    retry_config: { retries: 0, min_timeout: 0, max_timeout: 0, factor: 1 },
  };
}

function makeMilestone(overrides: Partial<MilestoneDag> = {}): MilestoneDag {
  return {
    description: 'HITL milestone',
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
    guard: 'node -e "process.exit(0)"',
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

function makeDag(): DagJson {
  return {
    schema_version: 4,
    plan_kind: 'greenfield',
    description: 'HITL test plan',
    problem: 'test',
    approach: 'test',
    executor: 'test',
    phases: ['test'],
    terminal: 'a',
    session_id: SESSION_ID,
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
  };
}

function makeFakeClock(): () => string {
  let n = 0;
  return () => {
    const cur = n++;
    const m = String(Math.floor(cur / 60)).padStart(2, '0');
    const s = String(cur % 60).padStart(2, '0');
    return `2026-01-01T00:${m}:${s}Z`;
  };
}

async function setup(
  name: string,
  runner: AgentMcpRunner
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
    runner,
    clock: makeFakeClock(),
    idFactory: () => `hitl-dispatch-${idN++}`,
    sleep: async () => {
      /* zero-delay — deterministic, never wall-clock */
    },
    poll: { intervalMs: 0, timeoutMs: 0 },
    continueOnError: false,
  };
  return { dagPath, deps };
}

function reload(dagPath: string): Promise<DagJson> {
  return createDagClient(createJsonFileSerializer(dagPath)).load();
}

/** PRE-FIX `fire()`: a sessioned task fired synchronously (no `background`). */
class PreFixSyncFireRunner extends AgentMcpRunner {
  override async fire(unit: DispatchUnit): Promise<{ taskId: string }> {
    const args: Record<string, unknown> = {
      agent_name: unit.agent_name,
      prompt: unit.prompt,
    };
    if (unit.session_id) args['session_id'] = unit.session_id;
    const result = await this.callTool<{ task_id: string }>('task', args);
    return { taskId: result.task_id };
  }
}

describe('HITL suspension from dispatch (03145a46)', () => {
  it('parks a sessioned HITL unit at awaiting_input, persists the suspension, and task_resume completes it', async () => {
    const state: HitlState = { resumed: false, taskArgs: undefined };
    const client = new FakeMcpToolClient(makeHitlHandlers(state));
    const runner = new AgentMcpRunner({
      command: 'unused-in-test',
      clientFactory: () => client,
    });
    const { dagPath, deps } = await setup('positive', runner);

    try {
      const cycle = await orchestrateCycle(deps);

      expect(cycle.dispatched).toHaveLength(1);
      const dispatched = cycle.dispatched[0];
      expect(dispatched?.taskStatus).toBe('awaiting_input');
      expect(dispatched?.suspension).toEqual({
        taskId: TASK_ID,
        resumeToken: RESUME_TOKEN,
      });
      // The fix: a sessioned task is fired in the background.
      expect(state.taskArgs?.['background']).toBe(true);
      expect(state.taskArgs?.['session_id']).toBe(SESSION_ID);
      // A suspension is not a failure: no correction milestone was injected.
      expect(cycle.injectedMilestones).toEqual([]);

      // CONSUMER OUTCOME: the suspension is on disk, readable by a fresh client
      // (a separate `dispatch-cli status` process).
      const reloaded = await reload(dagPath);
      const suspensionEntry = reloaded.dispatch_log.find((e) => e.suspension);
      expect(suspensionEntry?.suspension).toEqual({
        taskId: TASK_ID,
        resumeToken: RESUME_TOKEN,
      });
      // Guards were NOT run and NOT marked failed.
      const guardResult = suspensionEntry?.results.find(
        (r) => r.op_id === 'a.guard'
      );
      expect(guardResult?.status).toBe('skipped');
      expect(guardResult?.guard_result).toBeNull();

      // Resume through the REAL runner path (agent-mcp's task_resume), then
      // poll -> completed. Proves `task_resume` completes the suspended task.
      await runner.callTool('task_resume', {
        taskId: TASK_ID,
        resumeToken: RESUME_TOKEN,
        userInput: 'approved',
      });
      const polled = await runner.poll(TASK_ID);
      expect(polled.status).toBe('completed');
    } finally {
      await runner.close();
    }
  });

  it('reconciles a resumed HITL task back into the DAG — the milestone leaves awaiting_input and completes (48b14ec1)', async () => {
    const state: HitlState = { resumed: false, taskArgs: undefined };
    const client = new FakeMcpToolClient(makeHitlHandlers(state));
    const runner = new AgentMcpRunner({
      command: 'unused-in-test',
      clientFactory: () => client,
    });
    const { dagPath, deps } = await setup('reconcile', runner);

    try {
      // Cycle 1: the sessioned task parks at awaiting_input.
      const cycle1 = await orchestrateCycle(deps);
      expect(cycle1.dispatched[0]?.taskStatus).toBe('awaiting_input');

      // The operator resumes the task (agent-mcp `task_resume`) — this
      // completes the TASK, but on its own it does NOT touch the DAG.
      await runner.callTool('task_resume', {
        taskId: TASK_ID,
        resumeToken: RESUME_TOKEN,
        userInput: 'approved',
      });

      // NEGATIVE CONTROL / boundary: resuming ALONE leaves the DAG stale — the
      // latest entry still carries the suspension and the milestone still
      // derives `awaiting_input`. Only the reconcile cycle below advances it,
      // so removing the reconcile step turns the assertions in this test red.
      const staleDag = await reload(dagPath);
      expect(staleDag.dispatch_log.at(-1)?.suspension).toEqual({
        taskId: TASK_ID,
        resumeToken: RESUME_TOKEN,
      });
      expect(
        snapshot(staleDag, { bPerTier: {}, contextWindowPerTier: {} }).milestones[
          'a'
        ]?.status
      ).toBe('awaiting_input');

      // Cycle 2: reconciles the completed task, runs the milestone guard, and
      // marks the milestone complete — WITHOUT re-firing the agent.
      const cycle2 = await orchestrateCycle(deps);
      const reconciledSummary = cycle2.dispatched.find((d) =>
        d.milestones.includes('a')
      );
      expect(reconciledSummary?.taskStatus).toBe('completed');
      expect(reconciledSummary?.suspension).toBeNull();
      // The single milestone is now done, so the cycle is terminal.
      expect(cycle2.persisted).toBe(true);
      expect(cycle2.terminal).toBe(true);
      expect(cycle2.terminalReason).toBe('all-complete');

      const reconciledDag = await reload(dagPath);
      const last = reconciledDag.dispatch_log.at(-1);
      // The completion entry no longer carries a suspension…
      expect(last?.suspension).toBeUndefined();
      // …and its guard actually ran and passed.
      const guardResult = last?.results.find((r) => r.op_id === 'a.guard');
      expect(guardResult?.guard_result).toBe('pass');
      expect(guardResult?.status).toBe('complete');

      // CONSUMER OUTCOME: the derived milestone status is now complete, not
      // awaiting_input.
      expect(
        snapshot(reconciledDag, { bPerTier: {}, contextWindowPerTier: {} })
          .milestones['a']?.status
      ).toBe('complete');
    } finally {
      await runner.close();
    }
  });

  it('does not abort the cycle when a suspended task poll fails — the milestone stays parked (48b14ec1 hardening)', async () => {
    const state: HitlState = { resumed: false, taskArgs: undefined };
    const client = new FakeMcpToolClient(makeHitlHandlers(state));
    const runner = new AgentMcpRunner({
      command: 'unused-in-test',
      clientFactory: () => client,
    });
    const { dagPath, deps } = await setup('poll-error', runner);

    try {
      const cycle1 = await orchestrateCycle(deps);
      expect(cycle1.dispatched[0]?.taskStatus).toBe('awaiting_input');

      // The operator resumes; the NEXT cycle's reconcile poll now fails
      // transiently (e.g. the task row is gone after a store reset, or the MCP
      // call errors). This must not tear down the whole cycle.
      state.resultThrows = true;
      await runner.callTool('task_resume', {
        taskId: TASK_ID,
        resumeToken: RESUME_TOKEN,
        userInput: 'approved',
      });

      const cycle2 = await orchestrateCycle(deps);
      // Resolves (does not reject) with no eligible work; the milestone is parked.
      expect(cycle2.terminal).toBe(true);
      expect(cycle2.terminalReason).toBe('no-eligible-work');

      const dag = await reload(dagPath);
      // No completion entry was appended — the suspension entry is still latest.
      expect(dag.dispatch_log.at(-1)?.suspension).toEqual({
        taskId: TASK_ID,
        resumeToken: RESUME_TOKEN,
      });
      expect(
        snapshot(dag, { bPerTier: {}, contextWindowPerTier: {} }).milestones['a']
          ?.status
      ).toBe('awaiting_input');
    } finally {
      await runner.close();
    }
  });

  it('NEGATIVE CONTROL: a sessioned fire WITHOUT background never observes the suspension', async () => {
    const state: HitlState = { resumed: false, taskArgs: undefined };
    const client = new FakeMcpToolClient(makeHitlHandlers(state));
    const runner = new PreFixSyncFireRunner({
      command: 'unused-in-test',
      clientFactory: () => client,
    });
    const { deps } = await setup('negative', runner);

    try {
      // The pre-fix synchronous sessioned `task` call is rejected by the MCP
      // client (the real -32001 abort). The cycle therefore CANNOT park at
      // awaiting_input — the suspension is unobservable. This is exactly what
      // the `background:true` fix prevents.
      await expect(orchestrateCycle(deps)).rejects.toThrow(/-32001|timed out/);
    } finally {
      await runner.close();
    }
  });
});
