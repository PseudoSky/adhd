/**
 * orchestrator.spec.ts — integration tests for the minimal dispatch loop.
 *
 * Real components throughout: real `createJsonFileSerializer` writing to a
 * synthetic dag.json under `tmp/dispatch-orchestrator/orchestrator-spec/`,
 * real `DagClient`, real `snapshot()`/`optimize()` from
 * `@adhd/dispatch-core-optimizer`, real `node:child_process` guard execution
 * against cheap real commands (`node -e "process.exit(0|1)"`). The only test
 * double is `MockAgentRunner` — the documented external boundary (a real
 * agent-mcp dispatch is a paid third-party model call; see
 * packages/dispatch/dispatch-orchestrator/src/test/helpers/mock-agent-runner.ts).
 *
 * Every assertion targets a CONSUMER-VISIBLE outcome: what's actually written
 * to the dag.json file on disk, re-read through a fresh client/serializer —
 * never internal call counts alone.
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

import { MockAgentRunner } from './helpers/mock-agent-runner.js';
import type {
  DispatchTaskStatus,
  IDispatchAgentRunner,
  RealUsageTurn,
} from '../lib/agent-runner.js';
import {
  orchestrate,
  orchestrateCycle,
  type CycleResult,
  type OrchestratorDeps,
} from '../lib/orchestrator.js';

// Repo-canonical ephemeral root (CLAUDE.md "Test/ephemeral artifacts"):
// tmp/<package>/<test-scoped>/ — gitignored, fully removed on teardown.
// Matches MockAgentRunner's own process.cwd()-relative convention.
const TMP_ROOT = path.join(
  process.cwd(),
  'tmp',
  'dispatch-orchestrator',
  'orchestrator-spec'
);

beforeAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ── Fixtures ─────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

const PASS_GUARD = 'node -e "process.exit(0)"';
const FAIL_GUARD = 'node -e "process.exit(1)"';

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
    description: 'test milestone',
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

/** A fixed, monotonic (never wall-clock) fake ISO clock for deterministic tests. */
function makeFakeClock(): () => string {
  let n = 0;
  return () => {
    const cur = n++;
    const m = String(Math.floor(cur / 60)).padStart(2, '0');
    const s = String(cur % 60).padStart(2, '0');
    return `2026-01-01T00:${m}:${s}Z`;
  };
}

async function setupScenario(
  name: string,
  dag: DagJson,
  runnerOverride?: MockAgentRunner
): Promise<{ dagPath: string; deps: OrchestratorDeps; runner: MockAgentRunner }> {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const dagPath = path.join(dir, 'dag.json');

  const client = createDagClient(createJsonFileSerializer(dagPath));
  await client.saveDag(dag);

  const runner =
    runnerOverride ?? new MockAgentRunner({ debugDir: path.join(dir, 'mock-debug') });
  let idN = 0;
  const deps: OrchestratorDeps = {
    client,
    optimizer: { snapshot, optimize },
    runner,
    clock: makeFakeClock(),
    idFactory: () => `test-dispatch-${idN++}`,
    sleep: async () => {
      /* zero-delay — never a real wall-clock wait */
    },
    poll: { intervalMs: 0, timeoutMs: 0 },
  };
  return { dagPath, deps, runner };
}

function reload(dagPath: string): Promise<DagJson> {
  return createDagClient(createJsonFileSerializer(dagPath)).load();
}

// ---------------------------------------------------------------------------
// (1) dispatch_log entry with synthesized turns (incl. model_calls) + ops flipped
// ---------------------------------------------------------------------------

describe('orchestrateCycle — real agent dispatch', () => {
  it('writes a dispatch_log entry to disk with synthesized turns (incl. model_calls), flips op + guard results, and resolves provider/resolved_max_tokens', async () => {
    const { dagPath, deps, runner } = await setupScenario('basic', makeDag());

    const result = await orchestrateCycle(deps);

    expect(result.terminal).toBe(false);
    expect(result.persisted).toBe(true);
    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0]?.taskStatus).toBe('completed');
    expect(result.dispatched[0]?.milestones).toEqual(['a']);

    // orchestrator-core enriches DispatchUnit.provider/.resolved_max_tokens
    // from dag.providers/effort_max_tokens (optimize() always leaves them
    // null — see resolveUnitProviderAndTokens doc comment). Proven via the
    // unit MockAgentRunner actually received.
    expect(runner.firedUnits).toHaveLength(1);
    expect(runner.firedUnits[0]?.provider).toEqual(makeProviderConfig());
    expect(runner.firedUnits[0]?.resolved_max_tokens).toBe(4096);

    // CONSUMER OUTCOME: read the dag file back from disk via a FRESH client.
    const reloaded = await reload(dagPath);
    expect(reloaded.dispatch_log).toHaveLength(1);
    const entry = reloaded.dispatch_log[0] as DispatchLogEntry;

    expect(entry.operations).toEqual(expect.arrayContaining(['a.1', 'a.guard']));
    expect(entry.turns).toHaveLength(1);
    expect(entry.turns[0]?.turn).toBe(1);
    expect(entry.turns[0]?.input_tokens).toBe(100); // MockAgentRunner DEFAULT_TASK_RESULT
    expect(entry.turns[0]?.output_tokens).toBe(50);
    expect(entry.turns[0]?.model_calls).toBe(1);

    const opResult = entry.results.find((r) => r.op_id === 'a.1');
    expect(opResult?.status).toBe('complete');

    const guardResult = entry.results.find((r) => r.op_id === 'a.guard');
    expect(guardResult?.status).toBe('complete');
    expect(guardResult?.guard_result).toBe('pass');
    expect(guardResult?.guard_output).toBe(''); // exit 0, no stdout/stderr

    // Re-derive via the REAL, unmodified snapshot() — proves the write is in
    // the shape snapshot.ts's synthesizeGuardOp/deriveMilestoneStatus expect.
    const snap2 = snapshot(reloaded, { bPerTier: {}, contextWindowPerTier: {} });
    expect(snap2.milestones['a']?.status).toBe('complete');

    runner.cleanup();
  });
});

// ---------------------------------------------------------------------------
// (2) guard failure -> correction milestone injected with triggered_by;
//     original milestone NOT marked complete
// ---------------------------------------------------------------------------

describe('orchestrateCycle — guard failure / replan injection', () => {
  it('injects a correction milestone with triggered_by on guard failure, and does not mark the milestone complete', async () => {
    const { dagPath, deps } = await setupScenario(
      'guard-fail',
      makeDag({ milestones: { a: makeMilestone({ guard: FAIL_GUARD }) } })
    );

    const result = await orchestrateCycle(deps);

    expect(result.injectedMilestones).toEqual(['a-correction-1']);
    const outcome = result.dispatched[0]?.guardOutcomes[0];
    expect(outcome?.milestone).toBe('a');
    expect(outcome?.guardResult).toBe('fail');
    expect(outcome?.injectedCorrection).toBe('a-correction-1');

    const reloaded = await reload(dagPath);
    const dispatchId = result.dispatched[0]?.dispatchLogEntryId;
    expect(dispatchId).toBeTruthy();

    const injected = reloaded.milestones['a-correction-1'];
    expect(injected).toBeDefined();
    expect(injected?.triggered_by).toBe(dispatchId);
    expect(injected?.pending).toBeNull();
    expect(injected?.agent).toBe('workflow-researcher');
    expect(injected?.description).toContain('a');

    const injectedOp = (reloaded.operations as OperationDag[]).find(
      (op) => op.milestone === 'a-correction-1'
    );
    expect(injectedOp).toBeDefined();
    expect(injectedOp?.type).toBe('generative');

    // Original milestone must NOT be marked complete.
    const snap2 = snapshot(reloaded, { bPerTier: {}, contextWindowPerTier: {} });
    expect(snap2.milestones['a']?.status).toBe('failed');
    expect(snap2.milestones['a']?.status).not.toBe('complete');
    // The injected correction is itself freshly eligible next cycle.
    expect(snap2.milestones['a-correction-1']?.status).toBe('pending');
    expect(snap2.milestones['a-correction-1']?.eligible).toBe(true);
  });

  it('does not inject a correction for a guard-only milestone that fails (no agent to dispatch to)', async () => {
    const { deps } = await setupScenario(
      'guard-only-fail',
      makeDag({
        milestones: {
          a: makeMilestone({ agent: null, model: null, effort: null, guard: FAIL_GUARD }),
        },
        operations: [],
      })
    );

    const result = await orchestrateCycle(deps);

    expect(result.injectedMilestones).toEqual([]);
    const outcome = result.dispatched[0]?.guardOutcomes[0];
    expect(outcome?.guardResult).toBe('fail');
    expect(outcome?.injectedCorrection).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (3) resumption — a pre-completed milestone (per dispatch_log) is never
//     re-dispatched
// ---------------------------------------------------------------------------

describe('orchestrateCycle — resumption', () => {
  it('never re-dispatches a milestone already marked complete via a pre-existing dispatch_log entry', async () => {
    const preExisting: DispatchLogEntry = {
      id: 'pre-existing-1',
      kind: 'execution',
      provider: 'local',
      model: null,
      agent: 'backfill:pre-log-execution',
      effort: null,
      started_at: '2025-01-01T00:00:00Z',
      completed_at: '2025-01-01T00:00:01Z',
      operations: ['a.1', 'a.guard'],
      turns: [],
      results: [
        { op_id: 'a.1', status: 'complete', guard_result: null, guard_output: null, guard_ran_at: null },
        {
          op_id: 'a.guard',
          status: 'complete',
          guard_result: 'pass',
          guard_output: 'ok',
          guard_ran_at: '2025-01-01T00:00:01Z',
        },
      ],
      notes: [],
    };

    const { dagPath, deps, runner } = await setupScenario(
      'resume',
      makeDag({
        milestones: {
          a: makeMilestone(),
          b: makeMilestone({ depends_on: ['a'] }),
        },
        operations: [makeOp(), makeOp({ id: 'b.1', milestone: 'b' })],
        dispatch_log: [preExisting],
        terminal: 'b',
      })
    );

    const result = await orchestrateCycle(deps);

    // Only 'b' should be dispatched this cycle — 'a' is already complete.
    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0]?.milestones).toEqual(['b']);
    expect(runner.firedUnits.map((u) => u.milestones)).toEqual([['b']]);
    expect(runner.ensureAgentCalls.map((u) => u.milestones)).toEqual([['b']]);

    const reloaded = await reload(dagPath);
    expect(reloaded.dispatch_log).toHaveLength(2); // pre-existing + this cycle's

    // 'a' has exactly the ONE pre-existing entry referencing it — proves no
    // second dispatch was appended for it.
    const aEntries = reloaded.dispatch_log.filter((e) => e.operations.includes('a.1'));
    expect(aEntries).toHaveLength(1);
    expect(aEntries[0]?.id).toBe('pre-existing-1');

    const bEntries = reloaded.dispatch_log.filter((e) => e.operations.includes('b.1'));
    expect(bEntries).toHaveLength(1);
    expect(bEntries[0]?.results.find((r) => r.op_id === 'b.guard')?.guard_result).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// (4) orchestrate() — multi-cycle AsyncIterable, cycles until terminal
// ---------------------------------------------------------------------------

describe('orchestrate()', () => {
  it('cycles until a terminal CycleResult, dispatching dependency-ordered milestones one wave per cycle', async () => {
    const { deps, runner } = await setupScenario(
      'multi-cycle',
      makeDag({
        milestones: {
          a: makeMilestone(),
          b: makeMilestone({ depends_on: ['a'] }),
        },
        operations: [makeOp(), makeOp({ id: 'b.1', milestone: 'b' })],
        terminal: 'b',
      })
    );

    const cycles: CycleResult[] = [];
    for await (const result of orchestrate(deps)) {
      cycles.push(result);
    }

    // b depends_on a, so b is not eligible until a's completion is
    // persisted and re-snapshotted — this forces exactly 3 cycles: dispatch
    // a, dispatch b, then a terminal cycle with nothing left.
    expect(cycles).toHaveLength(3);
    expect(cycles[0]?.terminal).toBe(false);
    expect(cycles[0]?.dispatched[0]?.milestones).toEqual(['a']);
    expect(cycles[1]?.terminal).toBe(false);
    expect(cycles[1]?.dispatched[0]?.milestones).toEqual(['b']);
    expect(cycles[2]?.terminal).toBe(true);
    expect(cycles[2]?.terminalReason).toBe('all-complete');
    expect(cycles[2]?.dispatched).toEqual([]);

    expect(runner.firedUnits.map((u) => u.milestones)).toEqual([['a'], ['b']]);
  });

  it('stops at maxCycles with a synthesized terminal result when corrections never resolve', async () => {
    const { deps } = await setupScenario(
      'max-cycles',
      makeDag({ milestones: { a: makeMilestone({ guard: FAIL_GUARD }) } })
    );
    deps.maxCycles = 2;

    const cycles: CycleResult[] = [];
    for await (const result of orchestrate(deps)) {
      cycles.push(result);
    }

    // maxCycles caps REAL cycles at 2 (each keeps failing and injecting a
    // fresh correction: a -> a-correction-1 -> a-correction-2 -> ...), then
    // orchestrate() yields one further SYNTHETIC terminal result rather than
    // running a 3rd real cycle — 3 entries total, not 2.
    expect(cycles).toHaveLength(3);
    expect(cycles[0]?.terminal).toBe(false); // a fails, injects a-correction-1
    expect(cycles[0]?.injectedMilestones).toEqual(['a-correction-1']);
    // a-correction-1 fails too; the NEXT injection is named relative to
    // WHICHEVER milestone just failed (a-correction-1), not the original.
    expect(cycles[1]?.terminal).toBe(false);
    expect(cycles[1]?.injectedMilestones).toEqual(['a-correction-1-correction-1']);
    expect(cycles[2]?.terminal).toBe(true);
    expect(cycles[2]?.terminalReason).toBe('max-cycles-reached');
    expect(cycles[2]?.dispatched).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (5) guard-only milestones (D-12) — zero operations, agent: null
// ---------------------------------------------------------------------------

describe('orchestrateCycle — guard-only milestones (D-12)', () => {
  it('runs a guard-only milestone directly, without ever calling ensureAgent/fire', async () => {
    const { dagPath, deps, runner } = await setupScenario(
      'guard-only-pass',
      makeDag({
        milestones: { a: makeMilestone({ agent: null, model: null, effort: null }) },
        operations: [],
      })
    );

    const result = await orchestrateCycle(deps);

    expect(result.dispatched[0]?.taskId).toBeNull();
    expect(result.dispatched[0]?.taskStatus).toBeNull();
    expect(runner.ensureAgentCalls).toHaveLength(0);
    expect(runner.firedUnits).toHaveLength(0);
    expect(result.dispatched[0]?.guardOutcomes[0]?.guardResult).toBe('pass');

    const reloaded = await reload(dagPath);
    expect(reloaded.dispatch_log[0]?.provider).toBe('local');
    expect(reloaded.dispatch_log[0]?.turns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (6) tool-call-only units — BUG-DISPATCH-EXEC-001: real execution.
//
// Prior to the fix, EVERY tool-call op — regardless of action/args — was
// blanket-marked 'skipped' with a "@adhd/dispatch-tools is not wired in"
// warning and NOTHING was ever actually done: no dag mutation, no file
// touched, no real outcome recorded. These tests drive the REAL
// `orchestrateCycle` (real DagClient, real snapshot/optimize, real
// dispatch_log persistence to disk) and assert the CONSUMER-VISIBLE outcome:
// the dag.json on disk is actually mutated / the file actually moved, exists,
// or was deleted, AND `DispatchResult.tool_result` carries the real payload
// — never a bare 'skipped'.
//
// NEGATIVE CONTROL (verified manually against the pre-fix orchestrator.ts via
// a throwaway `git worktree add .worktrees/negctrl-exec001 HEAD` checkout of
// this exact test file): every `it` below that asserts `status === 'complete'`
// with a populated `tool_result` FAILS against the old code — the old loop
// always set every non-generative op's status to the single literal
// 'skipped' and never called any executor, so `tool_result` never exists and
// `status` is never 'complete'. Worktree removed after verification.
// ---------------------------------------------------------------------------

describe('orchestrateCycle — real tool-call execution (BUG-DISPATCH-EXEC-001)', () => {
  it('dag.set-field: really mutates the persisted dag and records a real tool_result', async () => {
    const { dagPath, runner, deps } = await setupScenario(
      'tool-call-set-field',
      makeDag({
        operations: [
          makeOp({
            type: 'tool-call',
            action: 'dag.set-field',
            args: { path: 'milestones.a.pending', value: 'blocked-by-review' },
            shape: null,
          }),
        ],
      })
    );

    await orchestrateCycle(deps);

    expect(runner.firedUnits).toHaveLength(0); // no generative content -> no agent dispatch

    const reloaded = await reload(dagPath);

    // CONSUMER OUTCOME 1: the field was really set on the persisted dag.
    expect(reloaded.milestones['a']?.pending).toBe('blocked-by-review');

    // CONSUMER OUTCOME 2: the op's own dispatch_log result reflects real
    // execution, never the old blanket 'skipped'.
    const opResult = reloaded.dispatch_log[0]?.results.find((r) => r.op_id === 'a.1');
    expect(opResult?.status).toBe('complete');
    expect(opResult?.tool_result).toEqual({
      path: 'milestones.a.pending',
      value: 'blocked-by-review',
    });

    const guardResult = reloaded.dispatch_log[0]?.results.find((r) => r.op_id === 'a.guard');
    expect(guardResult?.guard_result).toBe('pass'); // guard still runs independently
  });

  it('dag.clear-pending: really clears a DIFFERENT milestone\'s pending field', async () => {
    // A milestone that is itself pending is 'pending-surfaced', never
    // 'pending' (deriveMilestoneStatus), so selectPackableMilestones excludes
    // it from packing — it cannot carry the op that clears its OWN pending
    // field in the same cycle. Real usage is exactly this shape: a distinct
    // (non-pending, eligible) milestone carries the `dag.clear-pending` op
    // that targets the blocked one by slug (e.g. a human-answer-resolution
    // milestone clearing the milestone it unblocks).
    const { dagPath, deps } = await setupScenario(
      'tool-call-clear-pending',
      makeDag({
        milestones: {
          a: makeMilestone({ pending: 'needs-human-review' }),
          clearer: makeMilestone({ depends_on: [] }),
        },
        operations: [
          makeOp({
            id: 'clearer.1',
            milestone: 'clearer',
            type: 'tool-call',
            action: 'dag.clear-pending',
            args: { milestone: 'a' },
            shape: null,
          }),
        ],
        terminal: ['a', 'clearer'],
      })
    );

    await orchestrateCycle(deps);

    const reloaded = await reload(dagPath);
    expect(reloaded.milestones['a']?.pending).toBeNull();
    const opResult = reloaded.dispatch_log[0]?.results.find((r) => r.op_id === 'clearer.1');
    expect(opResult?.status).toBe('complete');
    expect(opResult?.tool_result).toEqual({ milestone: 'a', pending: null });
  });

  it('dag.add-milestone: really adds a new milestone to the persisted dag', async () => {
    const { dagPath, deps } = await setupScenario(
      'tool-call-add-milestone',
      makeDag({
        operations: [
          makeOp({
            type: 'tool-call',
            action: 'dag.add-milestone',
            args: {
              slug: 'b',
              milestone: { description: 'injected milestone', phase: 'test', guard: PASS_GUARD },
            },
            shape: null,
          }),
        ],
      })
    );

    await orchestrateCycle(deps);

    const reloaded = await reload(dagPath);
    expect(reloaded.milestones['b']).toBeDefined();
    expect(reloaded.milestones['b']?.description).toBe('injected milestone');
    expect(reloaded.milestones['b']?.guard).toBe(PASS_GUARD);

    const opResult = reloaded.dispatch_log[0]?.results.find((r) => r.op_id === 'a.1');
    expect(opResult?.status).toBe('complete');
    expect(opResult?.tool_result).toEqual({ slug: 'b' });
  });

  it('dag.add-milestone: fails cleanly (no throw) when the slug already exists', async () => {
    const { dagPath, deps } = await setupScenario(
      'tool-call-add-milestone-conflict',
      makeDag({
        operations: [
          makeOp({
            type: 'tool-call',
            action: 'dag.add-milestone',
            args: { slug: 'a', milestone: { description: 'dup' } },
            shape: null,
          }),
        ],
      })
    );

    await orchestrateCycle(deps);

    const reloaded = await reload(dagPath);
    const opResult = reloaded.dispatch_log[0]?.results.find((r) => r.op_id === 'a.1');
    expect(opResult?.status).toBe('failed');
    expect(opResult?.tool_result).toEqual({ error: "milestone 'a' already exists" });
  });

  it('dag.append-dispatch-log: really appends an extra entry to dispatch_log', async () => {
    const { dagPath, deps } = await setupScenario(
      'tool-call-append-log',
      makeDag({
        operations: [
          makeOp({
            type: 'tool-call',
            action: 'dag.append-dispatch-log',
            args: { entry: { agent: 'injected-by-tool-call' } },
            shape: null,
          }),
        ],
      })
    );

    await orchestrateCycle(deps);

    const reloaded = await reload(dagPath);
    // The tool-injected entry PLUS this unit's own real dispatch_log entry.
    expect(reloaded.dispatch_log).toHaveLength(2);
    expect(reloaded.dispatch_log.some((e) => e.agent === 'injected-by-tool-call')).toBe(true);

    const opResult = reloaded.dispatch_log[1]?.results.find((r) => r.op_id === 'a.1');
    expect(opResult?.status).toBe('complete');
    expect(opResult?.tool_result).toHaveProperty('id');
  });

  it('fs.scaffold: really writes a file to disk under the configured tools root', async () => {
    const name = 'tool-call-fs-scaffold';
    const dir = path.join(TMP_ROOT, name);
    const { dagPath, deps } = await setupScenario(
      name,
      makeDag({
        operations: [
          makeOp({
            type: 'tool-call',
            action: 'fs.scaffold',
            args: { path: 'scaffolded/hello.txt', content: 'hello from a real tool-call' },
            shape: null,
          }),
        ],
      })
    );
    deps.toolsRoot = dir;

    await orchestrateCycle(deps);

    const written = path.join(dir, 'scaffolded', 'hello.txt');
    expect(fs.existsSync(written)).toBe(true);
    expect(fs.readFileSync(written, 'utf-8')).toBe('hello from a real tool-call');

    const reloaded = await reload(dagPath);
    const opResult = reloaded.dispatch_log[0]?.results.find((r) => r.op_id === 'a.1');
    expect(opResult?.status).toBe('complete');
    expect(opResult?.tool_result).toEqual({
      path: written,
      bytes: Buffer.byteLength('hello from a real tool-call', 'utf8'),
    });
  });

  it('fs.move: really moves a file on disk', async () => {
    const name = 'tool-call-fs-move';
    const dir = path.join(TMP_ROOT, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'source.txt'), 'move me', 'utf-8');

    const { dagPath, deps } = await setupScenario(
      name,
      makeDag({
        operations: [
          makeOp({
            type: 'tool-call',
            action: 'fs.move',
            args: { from: 'source.txt', to: 'moved/destination.txt' },
            shape: null,
          }),
        ],
      })
    );
    deps.toolsRoot = dir;

    await orchestrateCycle(deps);

    expect(fs.existsSync(path.join(dir, 'source.txt'))).toBe(false);
    const moved = path.join(dir, 'moved', 'destination.txt');
    expect(fs.existsSync(moved)).toBe(true);
    expect(fs.readFileSync(moved, 'utf-8')).toBe('move me');

    const reloaded = await reload(dagPath);
    const opResult = reloaded.dispatch_log[0]?.results.find((r) => r.op_id === 'a.1');
    expect(opResult?.status).toBe('complete');
  });

  it('fs.delete: really deletes a file on disk', async () => {
    const name = 'tool-call-fs-delete';
    const dir = path.join(TMP_ROOT, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'doomed.txt'), 'delete me', 'utf-8');

    const { dagPath, deps } = await setupScenario(
      name,
      makeDag({
        operations: [
          makeOp({ type: 'tool-call', action: 'fs.delete', args: { path: 'doomed.txt' }, shape: null }),
        ],
      })
    );
    deps.toolsRoot = dir;

    await orchestrateCycle(deps);

    expect(fs.existsSync(path.join(dir, 'doomed.txt'))).toBe(false);
    const reloaded = await reload(dagPath);
    const opResult = reloaded.dispatch_log[0]?.results.find((r) => r.op_id === 'a.1');
    expect(opResult?.status).toBe('complete');
  });

  it('fs.delete: rejects a path that escapes the configured tools root — never executes it', async () => {
    const name = 'tool-call-fs-delete-escape';
    const dir = path.join(TMP_ROOT, name);
    const { dagPath, deps } = await setupScenario(
      name,
      makeDag({
        operations: [
          makeOp({
            type: 'tool-call',
            action: 'fs.delete',
            args: { path: '../../../etc/hosts' },
            shape: null,
          }),
        ],
      })
    );
    deps.toolsRoot = dir;

    await orchestrateCycle(deps);

    const reloaded = await reload(dagPath);
    const opResult = reloaded.dispatch_log[0]?.results.find((r) => r.op_id === 'a.1');
    expect(opResult?.status).toBe('failed');
    expect((opResult?.tool_result as { error?: string } | null)?.error).toContain('escapes tools root');
  });

  it('an op missing required args fails cleanly with a real error, never a silent skip', async () => {
    const { dagPath, deps } = await setupScenario(
      'tool-call-missing-args',
      makeDag({
        operations: [
          makeOp({ type: 'tool-call', action: 'dag.set-field', args: null, shape: null }),
        ],
      })
    );

    await orchestrateCycle(deps);

    const reloaded = await reload(dagPath);
    const opResult = reloaded.dispatch_log[0]?.results.find((r) => r.op_id === 'a.1');
    expect(opResult?.status).toBe('failed');
    expect((opResult?.tool_result as { error?: string } | null)?.error).toContain(
      "missing required string arg 'path'"
    );
    // Guard still runs independently even though the tool-call op failed —
    // the milestone guard remains the authoritative verification signal.
    const guardResult = reloaded.dispatch_log[0]?.results.find((r) => r.op_id === 'a.guard');
    expect(guardResult?.guard_result).toBe('pass');
  });

  it('an unregistered tool-call action (reserved/future AST-executor case) fails cleanly, never crashes the cycle', async () => {
    const { dagPath, deps } = await setupScenario(
      'tool-call-unregistered-action',
      makeDag({
        operations: [makeOp({ type: 'tool-call', action: 'create', args: {}, shape: null })],
      })
    );

    await expect(orchestrateCycle(deps)).resolves.toBeDefined();

    const reloaded = await reload(dagPath);
    const opResult = reloaded.dispatch_log[0]?.results.find((r) => r.op_id === 'a.1');
    expect(opResult?.status).toBe('failed');
    expect((opResult?.tool_result as { error?: string } | null)?.error).toContain(
      "no registered executor"
    );
  });
});

// ---------------------------------------------------------------------------
// (7) bounded poll deadline — a task that never reaches a terminal status is
//     given up on after poll.timeoutMs, never polled forever
// ---------------------------------------------------------------------------

describe('orchestrateCycle — bounded poll deadline', () => {
  class StuckRunner implements IDispatchAgentRunner {
    pollCalls = 0;
    async ensureAgent(): Promise<void> {
      /* no-op */
    }
    async fire(): Promise<{ taskId: string }> {
      return { taskId: 'stuck-task' };
    }
    async poll(): Promise<{ status: DispatchTaskStatus; usage: undefined }> {
      this.pollCalls += 1;
      return { status: 'running', usage: undefined };
    }
    async cancel(): Promise<void> {
      /* no-op */
    }
    // DEBT-DISPATCH-026: dispatchUnit() calls queryTurns() unconditionally
    // (before the polled.timedOut check below), so even a runner whose
    // scenario always times out must return validly here.
    async queryTurns(): Promise<RealUsageTurn[]> {
      return [];
    }
  }

  it('marks operations failed and skips milestone guards once the poll deadline is exceeded, without ever wall-clock sleeping', async () => {
    const dir = path.join(TMP_ROOT, 'poll-timeout');
    fs.mkdirSync(dir, { recursive: true });
    const dagPath = path.join(dir, 'dag.json');
    const client = createDagClient(createJsonFileSerializer(dagPath));
    await client.saveDag(makeDag());

    const runner = new StuckRunner();
    let sleepCalls = 0;
    const deps: OrchestratorDeps = {
      client,
      optimizer: { snapshot, optimize },
      runner,
      clock: makeFakeClock(),
      idFactory: () => 'test-dispatch-timeout',
      sleep: async () => {
        sleepCalls += 1;
      },
      poll: { intervalMs: 1, timeoutMs: 3 },
    };

    const result = await orchestrateCycle(deps);

    expect(result.dispatched[0]?.taskStatus).toBe('running');
    expect(sleepCalls).toBeGreaterThan(0); // proves the bounded loop actually iterated
    expect(runner.pollCalls).toBeGreaterThan(1);

    const outcome = result.dispatched[0]?.guardOutcomes[0];
    expect(outcome?.guardResult).toBe('fail');
    expect(outcome?.guardOutput).toMatch(/did not complete/);
    expect(outcome?.injectedCorrection).toBe('a-correction-1'); // still gets a correction — agent is non-null

    const reloaded = await reload(dagPath);
    const opResult = reloaded.dispatch_log[0]?.results.find((r) => r.op_id === 'a.1');
    expect(opResult?.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// (DEBT-DISPATCH-015) uncaught dispatch failure persistence
// ---------------------------------------------------------------------------

describe('orchestrateCycle — uncaught dispatch failure persistence (DEBT-DISPATCH-015)', () => {
  /**
   * `fire()` throws unconditionally — simulates an uncaught error from the
   * real dispatch path (e.g. a transport failure) so `orchestrateCycle`'s
   * `catch` block builds `failEntry` for the sole/last unit in the cycle.
   */
  class ThrowingAgentRunner extends MockAgentRunner {
    async fire(): Promise<{ taskId: string }> {
      throw new Error('injected fire() failure -- DEBT-DISPATCH-015 regression proof');
    }
  }

  it(
    'persists the failure entry to disk (continueOnError=false, cycle rejects) so a ' +
      'FRESH client.load() still sees it -- not just the in-memory dag orchestrateCycle mutated',
    async () => {
      const throwingRunner = new ThrowingAgentRunner({
        debugDir: path.join(TMP_ROOT, 'throw-persist-reject', 'mock-debug'),
      });
      const { dagPath, deps } = await setupScenario(
        'throw-persist-reject',
        makeDag({ milestones: { a: makeMilestone() } }),
        throwingRunner
      );

      await expect(
        orchestrateCycle({ ...deps, continueOnError: false })
      ).rejects.toThrow('injected fire() failure');

      // The critical assertion: reload from a BRAND NEW client/serializer —
      // never the in-memory `dag` object orchestrateCycle mutated — proving
      // the failEntry actually reached disk, not just this function's local
      // reference (the exact gap DEBT-DISPATCH-015 fixes).
      const reloaded = await reload(dagPath);
      expect(reloaded.dispatch_log).toHaveLength(1);
      const entry = reloaded.dispatch_log[0] as DispatchLogEntry;
      expect(entry.notes.some((n) => n.text.includes('injected fire() failure'))).toBe(
        true
      );
      expect(entry.results.some((r) => r.status === 'failed')).toBe(true);
    }
  );

  it(
    'persists the failure entry to disk (continueOnError default true, cycle resolves) so a ' +
      'FRESH client.load() still sees it -- not just the in-memory dag orchestrateCycle mutated',
    async () => {
      const throwingRunner = new ThrowingAgentRunner({
        debugDir: path.join(TMP_ROOT, 'throw-persist-continue', 'mock-debug'),
      });
      const { dagPath, deps } = await setupScenario(
        'throw-persist-continue',
        makeDag({ milestones: { a: makeMilestone() } }),
        throwingRunner
      );

      const result = await orchestrateCycle(deps);

      expect(result.dispatched[0]?.dispatchLogEntryId).toBeTruthy();

      const reloaded = await reload(dagPath);
      expect(reloaded.dispatch_log).toHaveLength(1);
      const entry = reloaded.dispatch_log[0] as DispatchLogEntry;
      expect(entry.notes.some((n) => n.text.includes('injected fire() failure'))).toBe(
        true
      );
      expect(entry.results.some((r) => r.status === 'failed')).toBe(true);
    }
  );
});
