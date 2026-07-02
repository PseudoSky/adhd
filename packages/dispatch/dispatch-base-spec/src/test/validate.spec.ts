import { describe, it, expect } from 'vitest';
import { validateDagJson, validateSnapshot } from '../lib/validate.js';
import { migrateDag } from '../lib/migrate.js';
import type { ValidationError } from '../lib/types.js';

function miniDag(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    description: 'test',
    problem: 'test',
    approach: 'test',
    executor: 'test',
    schema_version: 4,
    plan_kind: 'greenfield',
    phases: ['test'],
    terminal: 'a',
    dispatch_log: [],
    optimization: {},
    providers: {},
    effort_max_tokens: {},
    milestones: {
      a: {
        description: 'a',
        depends_on: [],
        authored_by: 'test',
        phase: 'test',
        read_only: [],
      },
    },
    operations: [],
    ...overrides,
  };
}

describe('validateDagJson', () => {
  it('rejects non-object root', () => {
    expect(validateDagJson('not').valid).toBe(false);
  });
  it('rejects missing fields', () => {
    expect(validateDagJson({ schema_version: 4 }).valid).toBe(false);
  });
  it('rejects invalid plan_kind', () => {
    expect(validateDagJson(miniDag({ plan_kind: 'invalid' })).valid).toBe(
      false
    );
  });
  it('catches cycle', () => {
    const d = miniDag({
      milestones: {
        a: {
          description: 'a',
          depends_on: ['b'],
          authored_by: 't',
          phase: 't',
          read_only: [],
        },
        b: {
          description: 'b',
          depends_on: ['a'],
          authored_by: 't',
          phase: 't',
          read_only: [],
        },
      },
    });
    const r = validateDagJson(d);
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e: ValidationError) => e.message.includes('cycle'))
    ).toBe(true);
  });
  it('catches missing terminal ref', () => {
    expect(validateDagJson(miniDag({ terminal: 'nonexistent' })).valid).toBe(
      false
    );
  });
  it('catches orphan op', () => {
    const d = miniDag({
      operations: [
        {
          id: 'op.1',
          milestone: 'nonexistent',
          depends_on: [],
          type: 'generative',
          action: 'create',
          authored_by: 't',
          status: 'pending',
        },
      ],
    });
    expect(validateDagJson(d).valid).toBe(false);
  });
  it('catches invalid model tier', () => {
    const d = miniDag({
      milestones: {
        a: {
          description: 'a',
          depends_on: [],
          authored_by: 't',
          phase: 't',
          model: 'GPT5',
          read_only: [],
        },
      },
    });
    expect(validateDagJson(d).valid).toBe(false);
  });
  it('catches invalid shape kind', () => {
    const d = miniDag({
      operations: [
        {
          id: 'op.1',
          milestone: 'a',
          depends_on: [],
          type: 'generative',
          action: 'create',
          authored_by: 't',
          status: 'pending',
          shape: { kind: 'not-a-kind' },
        },
      ],
    });
    expect(validateDagJson(d).valid).toBe(false);
  });
  it('catches invalid op/kind combo', () => {
    const d = miniDag({
      operations: [
        {
          id: 'op.1',
          milestone: 'a',
          depends_on: [],
          type: 'generative',
          action: 'create',
          authored_by: 't',
          status: 'pending',
          shape: {
            kind: 'interface',
            ops: [{ op: 'add-column', target: 'x', to: 'string' }],
          },
        },
      ],
    });
    expect(validateDagJson(d).valid).toBe(false);
  });
  it('catches missing op dep', () => {
    const d = miniDag({
      operations: [
        {
          id: 'op.1',
          milestone: 'a',
          depends_on: ['op.999'],
          type: 'generative',
          action: 'create',
          authored_by: 't',
          status: 'pending',
        },
      ],
    });
    expect(validateDagJson(d).valid).toBe(false);
  });
  it('validates minimal correct dag', () => {
    expect(validateDagJson(miniDag()).valid).toBe(true);
  });
});

const baseSnap = {
  snapshot_at: '2026-01-01T00:00:00Z',
  snapshot_version: 1,
  plan: 'test',
  schema_version: 4,
  plan_kind: 'greenfield',
  description: 'test',
  problem: 'test',
  approach: 'test',
  executor: 'test',
  phases: ['test'],
  terminal: 'a',
  optimization: {
    sentinel_fanout: {
      enabled: true,
      write_multiplier: 1.25,
      read_multiplier: 0.1,
      hit_probability: 0.9,
    },
    b_per_tier: {},
    context_window_per_tier: {},
    b_eff_per_tier: {},
    context_window_override: null,
    b_override: null,
  },
  milestones: {
    a: {
      description: 'a',
      authored_by: 't',
      pending: null,
      triggered_by: null,
      phase: 't',
      depends_on: [],
      agent: null,
      model: null,
      effort: null,
      two_stage: false,
      read_only: [],
      guard: null,
      context: 'ctx/a.md',
      wave: 0,
      eligible: true,
      status: 'pending',
      started_at: null,
      completed_at: null,
      guard_result: null,
      guard_output: null,
      artifacts: [],
      si_bytes: 0,
      ki_estimate: 0,
      tokens_estimated: null,
      tokens_actual: null,
    },
  },
  operations: [],
  pairwise_overlap: {},
  open_questions: [],
};

describe('validateSnapshot', () => {
  it('validates correct snapshot', () => {
    expect(validateSnapshot(baseSnap).valid).toBe(true);
  });
  it('catches D-07 violation', () => {
    const b = JSON.parse(JSON.stringify(baseSnap));
    b.milestones.a.pending = 'q';
    expect(
      validateSnapshot(b).errors.some((e: ValidationError) =>
        e.message.includes('D-07')
      )
    ).toBe(true);
  });
  it('catches invalid status', () => {
    const b = JSON.parse(JSON.stringify(baseSnap));
    b.milestones.a.status = 'bad';
    expect(validateSnapshot(b).valid).toBe(false);
  });
  it('catches negative wave', () => {
    const b = JSON.parse(JSON.stringify(baseSnap));
    b.milestones.a.wave = -1;
    expect(validateSnapshot(b).valid).toBe(false);
  });
  it('rejects missing fields', () => {
    expect(validateSnapshot({}).valid).toBe(false);
  });
});

describe('migrateDag', () => {
  it('migrates v2 to v4', () => {
    const dag: Record<string, unknown> = {
      schema_version: 2,
      description: 'x',
      problem: 'x',
      approach: 'x',
      executor: 'x',
      plan_kind: 'greenfield',
      phases: ['x'],
      terminal: 'a',
      dispatch_log: [],
      nodes: {
        a: { description: 'a', depends_on: [], authored_by: 't', phase: 't' },
      },
      operations: {
        'op.1': {
          id: 'op.1',
          milestone: 'a',
          depends_on: [],
          action: 'create',
        },
      },
    };
    migrateDag(2, 4, dag);
    expect(dag['schema_version']).toBe(4);
    expect(dag['milestones']).toBeDefined();
    expect(dag['nodes']).toBeUndefined();
    expect(Array.isArray(dag['operations'])).toBe(true);
  });
  it('no-op on same version', () => {
    const dag = { schema_version: 4 };
    migrateDag(4, 4, dag);
    expect(dag['schema_version']).toBe(4);
  });
});
