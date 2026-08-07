/**
 * fixtures.ts — shared dag.json fixture builders for dispatch-cli's own
 * tests. Mirrors dispatch-orchestrator's proven `makeDag`/`makeMilestone`/
 * `makeOp` pattern (packages/dispatch/dispatch-orchestrator/src/test/orchestrator.spec.ts)
 * exactly, so the fixture shape is already known-good against the real
 * validator/optimizer/orchestrator stack.
 *
 * Used by BOTH `core.spec.ts` (imported as TS objects) and `cli-smoke.spec.ts`
 * (JSON.stringify'd to a real file the spawned CLI reads) — one fixture
 * shape, two consumers.
 */
import type {
  DagJson,
  DispatchLogEntry,
  MilestoneDag,
  OperationDag,
  ProviderConfig,
} from '@adhd/dispatch-base-spec';

/** A guard command that always passes — cheap, real, no network. */
export const PASS_GUARD = 'node -e "process.exit(0)"';

export function makeProviderConfig(): ProviderConfig {
  return {
    type: 'claudecli',
    model_id: 'claude-sonnet-test',
    env_secret: null,
    base_url: null,
    timeout_ms: 30000,
    retry_config: { retries: 0, min_timeout: 0, max_timeout: 0, factor: 1 },
  };
}

export function makeMilestone(overrides: Partial<MilestoneDag> = {}): MilestoneDag {
  return {
    description: 'fixture milestone',
    authored_by: 'test',
    pending: null,
    triggered_by: null,
    phase: 'test',
    depends_on: [],
    agent: 'dispatch-cli-fixture-agent',
    model: 'Sonnet',
    effort: 'medium',
    two_stage: false,
    read_only: [],
    guard: PASS_GUARD,
    ...overrides,
  };
}

export function makeOp(overrides: Partial<OperationDag> = {}): OperationDag {
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
      description: 'do the fixture thing',
      objective: 'the fixture thing is done',
      required_sections: [],
    },
    ...overrides,
  };
}

/**
 * A small synthetic 3-milestone chain `a -> b -> c` (terminal `c`), each
 * with one operation and a real, cheap, always-passing guard — matches the
 * cli milestone's smoke-fixture spec ("2-3 milestones, one guard
 * `node -e \"process.exit(0)\"`").
 */
export function makeFixtureDag(overrides: Partial<DagJson> = {}): DagJson {
  return {
    schema_version: 4,
    plan_kind: 'greenfield',
    description: 'dispatch-cli fixture plan',
    problem: 'fixture',
    approach: 'fixture',
    executor: 'test',
    phases: ['test'],
    terminal: 'c',
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
    effort_max_tokens: { medium: 4096 },
    milestones: {
      a: makeMilestone(),
      b: makeMilestone({ depends_on: ['a'] }),
      c: makeMilestone({ depends_on: ['b'] }),
    },
    operations: [
      makeOp({ id: 'a.1', milestone: 'a', depends_on: [] }),
      makeOp({ id: 'b.1', milestone: 'b', depends_on: ['a.1'] }),
      makeOp({ id: 'c.1', milestone: 'c', depends_on: ['b.1'] }),
    ],
    dispatch_log: [],
    ...overrides,
  };
}

/**
 * A `dispatch_log` entry recording `slug` as done under BOTH completion
 * rules this package's commands rely on: `DagClient.isMilestoneComplete`
 * (`getEligibleMilestones`, used by `eligibleCore`) requires every one of
 * the milestone's own operation ids to have a `status: 'complete'` result;
 * `@adhd/dispatch-core-optimizer`'s `deriveMilestoneStatus` (`snapshot()`, used
 * by `snapshotCore`/`optimizeCore`/`statusCore`) requires a `'<slug>.guard'`
 * result with `guard_result: 'pass'`. A REAL orchestrator cycle
 * (`dispatchUnit` in `@adhd/dispatch-orchestrator`) always writes both in
 * one entry — this mirrors that exact shape so fixtures agree with real
 * dispatch output under every completion rule in this package's surface.
 */
export function makeCompletionLogEntry(slug: string, opIds: string[]): DispatchLogEntry {
  return {
    id: `fixture-completion-${slug}`,
    kind: 'execution',
    provider: 'local',
    model: null,
    agent: 'fixture',
    effort: null,
    started_at: '2026-01-01T00:00:00Z',
    completed_at: '2026-01-01T00:00:01Z',
    operations: [...opIds, `${slug}.guard`],
    turns: [],
    results: [
      ...opIds.map((id) => ({
        op_id: id,
        status: 'complete' as const,
        guard_result: null,
        guard_output: null,
        guard_ran_at: null,
      })),
      {
        op_id: `${slug}.guard`,
        status: 'complete' as const,
        guard_result: 'pass' as const,
        guard_output: '',
        guard_ran_at: '2026-01-01T00:00:01Z',
      },
    ],
    notes: [],
  };
}
