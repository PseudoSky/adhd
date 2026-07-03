/**
 * fixtures.ts — synthetic DagJson / IOptimizerDeps builders shared by
 * snapshot.spec.ts and optimize.spec.ts.
 *
 * Deliberately synthetic, hand-authored fixtures — never reads
 * docs/plan/**\/dag.json (that path sits outside this package's nx inputs
 * and would silently cache-hit; see DEBT-DISPATCH-007).
 */
import type {
  DagJson,
  DispatchLogEntry,
  IOptimizerDeps,
  MilestoneDag,
  OperationDag,
} from '@adhd/dispatch-spec';

/** Recommended cold-start defaults per SCOPE.md Open Decision #2. */
export function defaultDeps(overrides: Partial<IOptimizerDeps> = {}): IOptimizerDeps {
  return {
    bPerTier: { Haiku: 8000, Sonnet: 15000, Opus: 27000 },
    contextWindowPerTier: { Haiku: 200000, Sonnet: 200000, Opus: 200000 },
    ...overrides,
  };
}

export function miniMilestone(overrides: Partial<MilestoneDag> = {}): MilestoneDag {
  return {
    description: 'test milestone',
    authored_by: 'test',
    pending: null,
    triggered_by: null,
    phase: 'test',
    depends_on: [],
    agent: 'test-agent',
    model: 'Sonnet',
    effort: 'medium',
    two_stage: false,
    read_only: [],
    guard: null,
    ...overrides,
  };
}

export function miniOp(overrides: Partial<OperationDag> = {}): OperationDag {
  return {
    id: 'op.1',
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
    ki_estimate: null,
    ki_source: null,
    authored_by: 'test',
    status: 'pending',
    shape: null,
    ...overrides,
  };
}

const EMPTY_OPTIMIZATION: DagJson['optimization'] = {
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
};

export function miniDag(overrides: Partial<DagJson> = {}): DagJson {
  return {
    schema_version: 4,
    plan_kind: 'greenfield',
    description: 'test',
    problem: 'test',
    approach: 'test',
    executor: 'test',
    phases: ['test'],
    terminal: 'a',
    optimization: EMPTY_OPTIMIZATION,
    providers: {},
    effort_max_tokens: {},
    milestones: { a: miniMilestone() },
    operations: [],
    dispatch_log: [],
    ...overrides,
  };
}

/**
 * Recursively Object.freeze a value and everything reachable from it (own
 * enumerable keys only, arrays included). Functions are left unfrozen-and-
 * unrecursed — freezing them adds nothing and isn't needed to prove data
 * non-mutation.
 *
 * Used to prove snapshot()/optimize()/computeTokensNaive() honor their "does
 * not mutate its input" contract: ES module code runs in strict mode, so any
 * in-place write to a frozen object throws a TypeError instead of silently
 * no-oping — a mutation bug turns into a failing test, not a passing one.
 */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object') return value;
  const obj = value as unknown as Record<string, unknown>;
  if (seen.has(obj)) return value;
  seen.add(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key], seen);
  }
  return Object.freeze(obj) as T;
}

/** A dispatch_log entry recording a passed guard for `${slug}.guard`. */
export function passingGuardEntry(
  slug: string,
  overrides: Partial<DispatchLogEntry> = {}
): DispatchLogEntry {
  const guardId = `${slug}.guard`;
  return {
    id: `dispatch.${slug}`,
    kind: 'execution',
    provider: 'anthropic',
    model: 'claude-sonnet',
    agent: 'test-agent',
    effort: 'medium',
    started_at: '2026-01-01T00:00:00Z',
    completed_at: '2026-01-01T00:05:00Z',
    operations: [guardId],
    turns: [{ turn: 1, input_tokens: 1000, output_tokens: 500, t: '2026-01-01T00:01:00Z' }],
    results: [
      {
        op_id: guardId,
        status: 'complete',
        guard_result: 'pass',
        guard_output: 'ok',
        guard_ran_at: '2026-01-01T00:05:00Z',
      },
    ],
    notes: [],
    ...overrides,
  };
}
