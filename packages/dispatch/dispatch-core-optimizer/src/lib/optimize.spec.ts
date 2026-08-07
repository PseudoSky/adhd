import { describe, expect, it } from 'vitest';
import type { DagSnapshot } from '@adhd/dispatch-base-spec';

import { snapshot } from './snapshot.js';
import { DISPATCH_AGENT_SYSTEM_PREAMBLE, computeTokensNaive, optimize } from './optimize.js';
import {
  deepFreeze,
  defaultDeps,
  miniDag,
  miniMilestone,
  miniOp,
  passingGuardEntry,
} from '../test/fixtures.js';

const FUNCTION_SHAPE = {
  kind: 'function' as const,
  ops: [
    { op: 'add-export' as const, target: 'foo', to: 'bar', position: null, required: true },
  ],
};

const DOC_SHAPE = {
  kind: 'doc' as const,
  description: 'a doc',
  objective: 'explain things',
  required_sections: ['intro'],
};

const FUNCTION_SHAPE_WITH_TYPE_SPEC = {
  kind: 'function' as const,
  ops: [
    {
      op: 'add-export' as const,
      target: 'field',
      to: null,
      position: null,
      required: true,
      type_spec: { config: 'ProviderConfig' },
    },
  ],
};

function buildSnapshot(overrides: Parameters<typeof miniDag>[0] = {}): DagSnapshot {
  return snapshot(miniDag(overrides), defaultDeps());
}

// ---------------------------------------------------------------------------
// (a) window feasibility — an over-W unit is rejected
// ---------------------------------------------------------------------------

describe('optimize() window feasibility', () => {
  function fixture() {
    return buildSnapshot({
      milestones: {
        small: miniMilestone({ model: 'Sonnet' }),
        huge: miniMilestone({ model: 'Sonnet' }),
      },
      operations: [
        miniOp({ id: 'small.1', milestone: 'small', shape: FUNCTION_SHAPE, ki_estimate: 1000 }),
        miniOp({ id: 'huge.1', milestone: 'huge', shape: FUNCTION_SHAPE, ki_estimate: 999999 }),
      ],
    });
  }

  it('drops a milestone whose own tokens_estimated exceeds the context window', () => {
    const snap = fixture();
    const units = optimize(snap, defaultDeps());

    const allPacked = units.flatMap((u) => u.milestones);
    expect(allPacked).toContain('small');
    expect(allPacked).not.toContain('huge');
  });

  it('never returns a unit whose tokens_estimated exceeds the window', () => {
    const snap = fixture();
    const units = optimize(snap, defaultDeps());
    for (const unit of units) {
      const w = snap.optimization.context_window_per_tier[unit.model ?? ''] ?? Infinity;
      if (unit.tokens_estimated !== null) {
        expect(unit.tokens_estimated).toBeLessThanOrEqual(w);
      }
    }
  });

  it('keeps a normal-sized milestone as fits_context_window: true', () => {
    const snap = fixture();
    const units = optimize(snap, defaultDeps());
    const smallUnit = units.find((u) => u.milestones.includes('small'));
    expect(smallUnit?.fits_context_window).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) partition — never mix shape.kind family or model tier in one unit
// ---------------------------------------------------------------------------

describe('optimize() partitioning', () => {
  it('never packs a doc-family milestone with a code-config-family milestone', () => {
    const snap = buildSnapshot({
      milestones: {
        code1: miniMilestone({ model: 'Sonnet' }),
        code2: miniMilestone({ model: 'Sonnet' }),
        doc1: miniMilestone({ model: 'Sonnet' }),
      },
      operations: [
        miniOp({ id: 'code1.1', milestone: 'code1', shape: FUNCTION_SHAPE, ki_estimate: 100 }),
        miniOp({ id: 'code2.1', milestone: 'code2', shape: FUNCTION_SHAPE, ki_estimate: 100 }),
        miniOp({ id: 'doc1.1', milestone: 'doc1', shape: DOC_SHAPE, ki_estimate: 100 }),
      ],
    });
    const units = optimize(snap, defaultDeps());

    for (const unit of units) {
      const hasDoc = unit.milestones.includes('doc1');
      const hasCode = unit.milestones.some((m) => m === 'code1' || m === 'code2');
      expect(hasDoc && hasCode).toBe(false);
    }
  });

  it('never packs different model tiers into one unit', () => {
    const snap = buildSnapshot({
      milestones: {
        sonnetA: miniMilestone({ model: 'Sonnet' }),
        sonnetB: miniMilestone({ model: 'Sonnet' }),
        opusA: miniMilestone({ model: 'Opus' }),
      },
      operations: [
        miniOp({ id: 'sonnetA.1', milestone: 'sonnetA', shape: FUNCTION_SHAPE, ki_estimate: 100 }),
        miniOp({ id: 'sonnetB.1', milestone: 'sonnetB', shape: FUNCTION_SHAPE, ki_estimate: 100 }),
        miniOp({ id: 'opusA.1', milestone: 'opusA', shape: FUNCTION_SHAPE, ki_estimate: 100 }),
      ],
    });
    const units = optimize(snap, defaultDeps());

    for (const unit of units) {
      const hasOpus = unit.milestones.includes('opusA');
      const hasSonnet = unit.milestones.some((m) => m === 'sonnetA' || m === 'sonnetB');
      expect(hasOpus && hasSonnet).toBe(false);
      // and the unit's own model tag matches every packed milestone's declared tier
      if (hasOpus) expect(unit.model).toBe('Opus');
      if (hasSonnet) expect(unit.model).toBe('Sonnet');
    }
  });
});

// ---------------------------------------------------------------------------
// (c) greedy fill order — ki_estimate ascending
// ---------------------------------------------------------------------------

describe('optimize() greedy fill order', () => {
  it('packs milestones into a unit in ki_estimate-ascending order, not authoring or slug order', () => {
    // Slugs deliberately alphabetize in the OPPOSITE order of their ki_estimate,
    // so a bug that sorts by slug instead of ki would flip this assertion.
    const snap = buildSnapshot({
      milestones: {
        a_big: miniMilestone({ model: 'Sonnet' }),
        m_mid: miniMilestone({ model: 'Sonnet' }),
        z_small: miniMilestone({ model: 'Sonnet' }),
      },
      operations: [
        miniOp({ id: 'a_big.1', milestone: 'a_big', shape: FUNCTION_SHAPE, ki_estimate: 3000 }),
        miniOp({ id: 'm_mid.1', milestone: 'm_mid', shape: FUNCTION_SHAPE, ki_estimate: 2000 }),
        miniOp({ id: 'z_small.1', milestone: 'z_small', shape: FUNCTION_SHAPE, ki_estimate: 1000 }),
      ],
    });
    const units = optimize(snap, defaultDeps());

    expect(units).toHaveLength(1);
    expect(units[0]?.milestones).toEqual(['z_small', 'm_mid', 'a_big']);
  });
});

// ---------------------------------------------------------------------------
// (d) tokens_naive arithmetic
// ---------------------------------------------------------------------------

describe('computeTokensNaive', () => {
  it('sums b_per_tier[model] + ki_estimate across packable milestones', () => {
    const deps = defaultDeps();
    const snap = buildSnapshot({
      milestones: {
        a: miniMilestone({ model: 'Sonnet' }),
        b: miniMilestone({ model: 'Opus' }),
      },
      operations: [
        miniOp({ id: 'a.1', milestone: 'a', shape: FUNCTION_SHAPE, ki_estimate: 500 }),
        miniOp({ id: 'b.1', milestone: 'b', shape: FUNCTION_SHAPE, ki_estimate: 700 }),
      ],
    });

    const expected =
      (deps.bPerTier['Sonnet'] ?? 0) + 500 + ((deps.bPerTier['Opus'] ?? 0) + 700);
    expect(computeTokensNaive(snap, deps)).toBe(expected);
  });

  it('uses the raw b_per_tier, not the Sentinel-Fanout-adjusted b_eff_per_tier', () => {
    const deps = defaultDeps();
    const dag = miniDag({
      optimization: {
        sentinel_fanout: {
          enabled: true,
          write_multiplier: 1.25,
          read_multiplier: 0.1,
          hit_probability: 0.9,
        },
        b_per_tier: { Sonnet: 15000 },
        context_window_per_tier: {},
        context_window_override: null,
        b_override: null,
      },
      milestones: { a: miniMilestone({ model: 'Sonnet' }) },
      operations: [miniOp({ id: 'a.1', milestone: 'a', shape: FUNCTION_SHAPE, ki_estimate: 1000 })],
    });
    const snap = snapshot(dag, deps);

    // b_eff would be scaled down by caching; tokens_naive must ignore that.
    expect(snap.optimization.b_eff_per_tier['Sonnet']).not.toBe(15000);
    expect(computeTokensNaive(snap, deps)).toBe(15000 + 1000);
  });

  it('excludes milestones that are not eligible (D-07) or already dispatched', () => {
    const deps = defaultDeps();
    const snap = buildSnapshot({
      milestones: {
        packable: miniMilestone({ model: 'Sonnet' }),
        blocked: miniMilestone({ model: 'Sonnet', pending: 'unanswered question' }),
        already_done: miniMilestone({ model: 'Sonnet' }),
      },
      operations: [
        miniOp({ id: 'packable.1', milestone: 'packable', shape: FUNCTION_SHAPE, ki_estimate: 500 }),
        miniOp({ id: 'blocked.1', milestone: 'blocked', shape: FUNCTION_SHAPE, ki_estimate: 900 }),
        miniOp({ id: 'already_done.1', milestone: 'already_done', shape: FUNCTION_SHAPE, ki_estimate: 900 }),
      ],
      dispatch_log: [passingGuardEntry('already_done')],
    });

    expect(computeTokensNaive(snap, deps)).toBe((deps.bPerTier['Sonnet'] ?? 0) + 500);
  });
});

// ---------------------------------------------------------------------------
// optimize() — no packable milestones
// ---------------------------------------------------------------------------

describe('optimize() empty input', () => {
  it('returns [] when there are no eligible, pending milestones', () => {
    const snap = buildSnapshot({
      milestones: { a: miniMilestone({ pending: 'blocked forever' }) },
    });
    expect(optimize(snap, defaultDeps())).toEqual([]);
  });

  it('excludes an already-complete milestone from packing (no re-dispatch)', () => {
    const snap = buildSnapshot({
      milestones: { a: miniMilestone() },
      operations: [miniOp({ id: 'a.1', milestone: 'a', shape: FUNCTION_SHAPE })],
      dispatch_log: [passingGuardEntry('a')],
    });
    const units = optimize(snap, defaultDeps());
    expect(units.flatMap((u) => u.milestones)).not.toContain('a');
  });
});

// ---------------------------------------------------------------------------
// optimize() / computeTokensNaive() — non-mutation contract
// ---------------------------------------------------------------------------

describe('optimize() / computeTokensNaive() non-mutation contract', () => {
  it('does not mutate a deep-frozen snapshot or deps', () => {
    const snap = buildSnapshot({
      milestones: {
        a: miniMilestone({ model: 'Sonnet' }),
        b: miniMilestone({ model: 'Sonnet' }),
      },
      operations: [
        miniOp({ id: 'a.1', milestone: 'a', shape: FUNCTION_SHAPE, ki_estimate: 500 }),
        miniOp({ id: 'b.1', milestone: 'b', shape: FUNCTION_SHAPE, ki_estimate: 700 }),
      ],
    });
    const frozenSnap = deepFreeze(snap);
    const frozenDeps = deepFreeze(defaultDeps());

    // Both inputs are frozen at every level; if optimize() or
    // computeTokensNaive() (or any helper either calls) ever wrote back onto
    // its input instead of building fresh output, these calls would throw a
    // TypeError under ESM strict mode.
    const units = optimize(frozenSnap, frozenDeps);
    const naive = computeTokensNaive(frozenSnap, frozenDeps);

    expect(units.length).toBeGreaterThan(0);
    expect(units.flatMap((u) => u.milestones).sort()).toEqual(['a', 'b']);
    expect(naive).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (e) DispatchUnit.systemPrompt/prompt split + execution_mode
//     (DEBT-DISPATCH-012, DEBT-DISPATCH-005/BL-102)
// ---------------------------------------------------------------------------

describe('optimize() DispatchUnit systemPrompt/prompt split + execution_mode', () => {
  it('bakes DISPATCH_AGENT_SYSTEM_PREAMBLE into systemPrompt and the compiled milestone body into prompt — never duplicated — for a real model dispatch', () => {
    const snap = buildSnapshot({
      milestones: {
        a: miniMilestone({
          model: 'Sonnet',
          agent: 'test-agent',
          description: 'Implement the widget factory.',
        }),
      },
      operations: [
        miniOp({
          id: 'a.1',
          milestone: 'a',
          type: 'generative',
          shape: FUNCTION_SHAPE,
          ki_estimate: 100,
        }),
      ],
    });
    const units = optimize(snap, defaultDeps());
    expect(units).toHaveLength(1);
    const [unit] = units;
    expect(unit).toBeDefined();

    expect(unit?.execution_mode).toBe('model-dispatch');
    expect(unit?.systemPrompt).toBe(DISPATCH_AGENT_SYSTEM_PREAMBLE);
    expect(unit?.prompt).toContain('Implement the widget factory.');
    // NEGATIVE-CONTROL: previously agent-runner.ts's ensureAgent baked
    // `unit.prompt` — not `unit.systemPrompt` — into every agent_create call,
    // billing the same text twice per dispatch. This equality check proves
    // the two ARE genuinely distinct strings today, not just both non-null;
    // it would pass trivially (and hide the bug) if systemPrompt were ever
    // computed as `= prompt` again.
    expect(unit?.prompt).not.toBe(unit?.systemPrompt);
  });

  it('marks a D-12 guard-only milestone (agent: null, model: null, zero ops) as guard-only with both prompt fields null', () => {
    const snap = buildSnapshot({
      milestones: {
        a: miniMilestone({ agent: null, model: null, effort: null }),
      },
      operations: [],
    });
    const units = optimize(snap, defaultDeps());
    expect(units).toHaveLength(1);
    const [unit] = units;
    expect(unit).toBeDefined();

    expect(unit?.execution_mode).toBe('guard-only');
    expect(unit?.systemPrompt).toBeNull();
    expect(unit?.prompt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (f) compilePrompt nested type_spec inlining (BL-104)
// ---------------------------------------------------------------------------

describe('optimize() compilePrompt nested type_spec inlining', () => {
  it('inlines a ShapeOpDag.type_spec as a nested "- field: Type" line under its op', () => {
    const snap = buildSnapshot({
      milestones: {
        a: miniMilestone({ model: 'Sonnet', agent: 'test-agent' }),
      },
      operations: [
        miniOp({
          id: 'a.1',
          milestone: 'a',
          type: 'generative',
          shape: FUNCTION_SHAPE_WITH_TYPE_SPEC,
          ki_estimate: 100,
        }),
      ],
    });
    const units = optimize(snap, defaultDeps());
    expect(units).toHaveLength(1);
    const prompt = units[0]?.prompt;

    expect(prompt).not.toBeNull();
    // Case-sensitive substring match, per acceptance criteria: the nested
    // type_spec line itself satisfies both '- config' and the fuller
    // '- config: ProviderConfig' substring.
    expect(prompt).toContain('- config');
    expect(prompt).toContain('- config: ProviderConfig');
  });
});

// ---------------------------------------------------------------------------
// (g) fits_context_window JSON round-trip (DEBT-DISPATCH-014)
// ---------------------------------------------------------------------------

describe('optimize() DispatchUnit.fits_context_window JSON round-trip', () => {
  it('serializes fits_context_window as a plain boolean when a model tier has no known context window in either the snapshot or deps', () => {
    const deps = defaultDeps({
      // Haiku deliberately absent from deps.contextWindowPerTier.
      contextWindowPerTier: { Sonnet: 200000, Opus: 200000 },
    });
    const dag = miniDag({
      milestones: {
        a: miniMilestone({ model: 'Haiku', agent: 'test-agent' }),
      },
      operations: [
        miniOp({
          id: 'a.1',
          milestone: 'a',
          type: 'generative',
          shape: FUNCTION_SHAPE,
          ki_estimate: 100,
        }),
      ],
    });
    // Built with the SAME restricted `deps` (not defaultDeps()) so
    // snapshot()'s own resolveContextWindowPerTier fallback doesn't
    // silently backfill Haiku from a full deps object — see buildSnapshot(),
    // which always uses defaultDeps() and would mask this precondition.
    const snap = snapshot(dag, deps);
    // Precondition: Haiku is absent from BOTH sources of context_window_per_tier.
    expect(snap.optimization.context_window_per_tier['Haiku']).toBeUndefined();
    expect(deps.contextWindowPerTier['Haiku']).toBeUndefined();

    const units = optimize(snap, deps);
    expect(units).toHaveLength(1);

    const json = JSON.stringify(units);
    // NEGATIVE-CONTROL: if fits_context_window ever held the raw (Infinity)
    // window value instead of the computed boolean, JSON.stringify silently
    // turns Infinity into the literal `null` (JSON has no Infinity token) —
    // both of these checks would catch that regression.
    expect(json).not.toContain('"fits_context_window":null');
    expect(json).not.toContain('Infinity');

    const parsed = JSON.parse(json) as typeof units;
    expect(typeof parsed[0]?.fits_context_window).toBe('boolean');
    expect(parsed[0]?.fits_context_window).toBe(true);
  });
});
