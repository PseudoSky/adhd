import { describe, expect, it } from 'vitest';

import { snapshot, topoSortMilestones } from './snapshot.js';
import {
  deepFreeze,
  defaultDeps,
  miniDag,
  miniMilestone,
  miniOp,
  passingGuardEntry,
} from '../test/fixtures.js';

// ---------------------------------------------------------------------------
// topoSortMilestones
// ---------------------------------------------------------------------------

describe('topoSortMilestones', () => {
  it('assigns wave 0 to milestones with no deps', () => {
    const { waves } = topoSortMilestones({
      a: miniMilestone({ depends_on: [] }),
    });
    expect(waves.get('a')).toBe(0);
  });

  it('assigns waves through a diamond dependency (a -> b,c -> d)', () => {
    const milestones = {
      a: miniMilestone({ depends_on: [] }),
      b: miniMilestone({ depends_on: ['a'] }),
      c: miniMilestone({ depends_on: ['a'] }),
      d: miniMilestone({ depends_on: ['b', 'c'] }),
    };
    const { order, waves } = topoSortMilestones(milestones);

    expect(waves.get('a')).toBe(0);
    expect(waves.get('b')).toBe(1);
    expect(waves.get('c')).toBe(1);
    expect(waves.get('d')).toBe(2);

    // deterministic: 'a' first, then b/c lexicographically, then 'd' last
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('throws with the cycle path on a circular dependency', () => {
    const milestones = {
      a: miniMilestone({ depends_on: ['b'] }),
      b: miniMilestone({ depends_on: ['a'] }),
    };
    expect(() => topoSortMilestones(milestones)).toThrow(/cycle detected/);
  });
});

// ---------------------------------------------------------------------------
// snapshot() — eligibility + waves from a diamond fixture
// ---------------------------------------------------------------------------

describe('snapshot() eligibility (diamond fixture)', () => {
  function diamondDag(dispatchLog: ReturnType<typeof passingGuardEntry>[] = []) {
    return miniDag({
      terminal: 'd',
      milestones: {
        a: miniMilestone({ depends_on: [] }),
        b: miniMilestone({ depends_on: ['a'] }),
        c: miniMilestone({ depends_on: ['a'] }),
        d: miniMilestone({ depends_on: ['b', 'c'] }),
      },
      operations: [
        miniOp({ id: 'a.1', milestone: 'a' }),
        miniOp({ id: 'b.1', milestone: 'b' }),
        miniOp({ id: 'c.1', milestone: 'c' }),
        miniOp({ id: 'd.1', milestone: 'd' }),
      ],
      dispatch_log: dispatchLog,
    });
  }

  it('before any dispatch: only the wave-0 milestone is eligible', () => {
    const snap = snapshot(diamondDag(), defaultDeps());

    expect(snap.milestones['a']?.wave).toBe(0);
    expect(snap.milestones['a']?.eligible).toBe(true);
    expect(snap.milestones['a']?.status).toBe('pending');

    expect(snap.milestones['b']?.eligible).toBe(false);
    expect(snap.milestones['c']?.eligible).toBe(false);
    expect(snap.milestones['d']?.eligible).toBe(false);
  });

  it('after a completes: both b and c become eligible, d does not', () => {
    const snap = snapshot(diamondDag([passingGuardEntry('a')]), defaultDeps());

    expect(snap.milestones['a']?.status).toBe('complete');
    expect(snap.milestones['a']?.eligible).toBe(true); // D-07 doesn't check own status

    expect(snap.milestones['b']?.eligible).toBe(true);
    expect(snap.milestones['b']?.status).toBe('pending');
    expect(snap.milestones['c']?.eligible).toBe(true);
    expect(snap.milestones['c']?.status).toBe('pending');

    expect(snap.milestones['d']?.eligible).toBe(false);
  });

  it('after a, b, c all complete: d becomes eligible', () => {
    const snap = snapshot(
      diamondDag([
        passingGuardEntry('a'),
        passingGuardEntry('b'),
        passingGuardEntry('c'),
      ]),
      defaultDeps()
    );

    expect(snap.milestones['d']?.eligible).toBe(true);
    expect(snap.milestones['d']?.status).toBe('pending');
  });

  it('a milestone with pending != null is never eligible even if deps are satisfied (D-07)', () => {
    const dag = diamondDag([passingGuardEntry('a')]);
    const withQuestion = {
      ...dag,
      milestones: {
        ...dag.milestones,
        b: miniMilestone({ depends_on: ['a'], pending: 'which approach?' }),
      },
    };
    const snap = snapshot(withQuestion, defaultDeps());
    expect(snap.milestones['b']?.eligible).toBe(false);
    expect(snap.milestones['b']?.status).toBe('pending-surfaced');
  });
});

// ---------------------------------------------------------------------------
// snapshot() — file sizes via deps.fileSizes, graceful degradation
// ---------------------------------------------------------------------------

describe('snapshot() file sizing', () => {
  function dagWithArtifact() {
    return miniDag({
      milestones: { a: miniMilestone({ model: 'Sonnet' }) },
      operations: [
        miniOp({
          id: 'a.1',
          milestone: 'a',
          action: 'create',
          file: 'src/foo.ts',
          ki_estimate: 100,
        }),
      ],
    });
  }

  it('sums resolved sizes into si_bytes and folds them into tokens_estimated', () => {
    const deps = defaultDeps({
      fileSizes: (paths) => new Map(paths.map((p) => [p, 630])),
    });
    const snap = snapshot(dagWithArtifact(), deps);

    expect(snap.milestones['a']?.si_bytes).toBe(630);
    // si_bytes -> tokens uses the 'default' cpt (4.0) since snapshot() never
    // passes a filePath to siBytesAsTokens (the sum may span multiple files).
    const expectedSiTokens = Math.ceil(630 / 4.0);
    const bEff = snap.optimization.b_eff_per_tier['Sonnet'];
    expect(bEff).not.toBeNull();
    expect(snap.milestones['a']?.tokens_estimated).toBe(
      (bEff ?? 0) + expectedSiTokens + 100
    );
  });

  it('degrades to 0 when deps.fileSizes is undefined', () => {
    const snap = snapshot(dagWithArtifact(), defaultDeps());
    expect(snap.milestones['a']?.si_bytes).toBe(0);
  });

  it('degrades to 0 for paths the callback does not return', () => {
    const deps = defaultDeps({ fileSizes: () => new Map() });
    const snap = snapshot(dagWithArtifact(), deps);
    expect(snap.milestones['a']?.si_bytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// snapshot() — cold-start defaults from deps
// ---------------------------------------------------------------------------

describe('snapshot() cold-start defaults', () => {
  it('falls back to deps.bPerTier when the dag has not calibrated a tier', () => {
    const dag = miniDag({
      optimization: {
        sentinel_fanout: {
          enabled: false,
          write_multiplier: 1,
          read_multiplier: 1,
          hit_probability: 0,
        },
        b_per_tier: { Sonnet: null },
        context_window_per_tier: {},
        context_window_override: null,
        b_override: null,
      },
    });
    const deps = defaultDeps();
    const snap = snapshot(dag, deps);

    expect(snap.optimization.b_per_tier['Sonnet']).toBe(deps.bPerTier['Sonnet']);
    // write_multiplier=1, read_multiplier=1, hit_probability=0 => b_eff === b (identity)
    expect(snap.optimization.b_eff_per_tier['Sonnet']).toBe(deps.bPerTier['Sonnet']);
  });

  it('prefers the dag-authored value over the deps default when both are present', () => {
    const dag = miniDag({
      optimization: {
        sentinel_fanout: {
          enabled: false,
          write_multiplier: 1,
          read_multiplier: 1,
          hit_probability: 0,
        },
        b_per_tier: { Sonnet: 99999 },
        context_window_per_tier: {},
        context_window_override: null,
        b_override: null,
      },
    });
    const snap = snapshot(dag, defaultDeps());
    expect(snap.optimization.b_per_tier['Sonnet']).toBe(99999);
  });

  it('falls back to deps.contextWindowPerTier when the tier is absent from the dag', () => {
    const dag = miniDag();
    const deps = defaultDeps();
    const snap = snapshot(dag, deps);
    expect(snap.optimization.context_window_per_tier['Sonnet']).toBe(
      deps.contextWindowPerTier['Sonnet']
    );
  });
});

// ---------------------------------------------------------------------------
// snapshot() — determinism
// ---------------------------------------------------------------------------

describe('snapshot() determinism', () => {
  it('produces identical output across two calls (modulo snapshot_at)', () => {
    const dag = miniDag({
      milestones: {
        a: miniMilestone({ depends_on: [] }),
        b: miniMilestone({ depends_on: ['a'] }),
        c: miniMilestone({ depends_on: ['a'] }),
      },
      operations: [
        miniOp({ id: 'a.1', milestone: 'a', file: 'x.ts', action: 'create' }),
        miniOp({ id: 'b.1', milestone: 'b', file: 'x.ts', action: 'modify-body' }),
        miniOp({ id: 'c.1', milestone: 'c' }),
      ],
    });
    const deps = defaultDeps({ fileSizes: (p) => new Map(p.map((x) => [x, 42])) });

    const snap1 = snapshot(dag, deps);
    const snap2 = snapshot(dag, deps);

    const strip = (s: typeof snap1) => ({ ...s, snapshot_at: '' });
    expect(strip(snap1)).toEqual(strip(snap2));
  });
});

// ---------------------------------------------------------------------------
// snapshot() — dispatchLog deps override
// ---------------------------------------------------------------------------

describe('snapshot() deps.dispatchLog override', () => {
  it('prefers deps.dispatchLog over dag.dispatch_log when provided', () => {
    const dag = miniDag({ dispatch_log: [] });
    const deps = defaultDeps({ dispatchLog: [passingGuardEntry('a')] });

    const snap = snapshot(dag, deps);
    expect(snap.milestones['a']?.status).toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// snapshot() — non-mutation contract
// ---------------------------------------------------------------------------

describe('snapshot() non-mutation contract', () => {
  it('does not mutate a deep-frozen dag or deps', () => {
    const dag = deepFreeze(
      miniDag({
        milestones: {
          a: miniMilestone(),
          b: miniMilestone({ depends_on: ['a'] }),
        },
        operations: [
          miniOp({
            id: 'a.1',
            milestone: 'a',
            file: 'a.ts',
            action: 'create',
            ki_estimate: 100,
          }),
          miniOp({ id: 'b.1', milestone: 'b', ki_estimate: 200 }),
        ],
        dispatch_log: [passingGuardEntry('a')],
      })
    );
    const deps = deepFreeze(
      defaultDeps({ fileSizes: (paths) => new Map(paths.map((p) => [p, 10])) })
    );

    // dag and deps are frozen at every level; if snapshot() (or any helper it
    // calls) ever wrote back onto its input instead of building fresh output,
    // this call would throw a TypeError under ESM strict mode.
    const snap = snapshot(dag, deps);

    expect(snap.milestones['a']?.status).toBe('complete');
    expect(snap.milestones['b']?.eligible).toBe(true);
    expect(snap.milestones['a']?.si_bytes).toBe(10);
  });
});
