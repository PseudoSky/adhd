import type { DispatchUnit } from '@adhd/dispatch-base-spec';

/**
 * Builds a structurally-valid `DispatchUnit` for tests, with sane defaults
 * for every field `optimize()` would normally populate. Override only the
 * fields a given test cares about.
 */
export function makeUnit(overrides: Partial<DispatchUnit> = {}): DispatchUnit {
  return {
    id: 'unit-1',
    milestones: ['embedding-approach-decided'],
    operations: ['embedding-approach-decided.1'],
    model: 'Sonnet',
    effort: 'high',
    two_stage: false,
    provider: null,
    agent_name: 'workflow-researcher',
    execution_mode: 'model-dispatch',
    mcp_servers: null,
    resolved_max_tokens: 8192,
    background: true,
    systemPrompt: null,
    prompt: '## Milestone: embedding-approach-decided\n\nResearch: choose embedding model.',
    context_files: [],
    si_bytes: 0,
    tokens_estimated: 1000,
    fits_context_window: true,
    // NOTE: tests-real-e2e.md scenario 3 asserts `sentinel_role === "solo"`,
    // but @adhd/dispatch-base-spec's actual `SentinelRole` type only allows
    // 'prewarm' | 'payload' (types.ts) — a second dag/types.ts discrepancy
    // discovered alongside the Turn.model_calls gap (see agent-runner.ts
    // SynthesizedTurn doc comment). `null` ("not yet resolved by the
    // optimizer") is the only value valid under the real type that doesn't
    // assume either side of that gap.
    sentinel_role: null,
    dispatch_log_id: null,
    remote_task_id: null,
    result: null,
    status: 'pending',
    started_at: null,
    completed_at: null,
    tokens_actual: null,
    ...overrides,
  };
}
