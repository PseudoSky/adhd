/**
 * Edge-case / boundary suite for the v2 query engine.
 *
 * Scope (authored after an audit for "boundaries the suite never asserts, so a
 * footgun passes green"): reference-routing name collisions; phase-rule purity
 * across the group boundary; index-vs-scan equivalence for every index kind and
 * narrowing predicate (incl. non-finite / heterogeneous values, empty sets, and
 * `_and`/`_or` mixes); window/frame edges on tiny and degenerate partitions;
 * type handling (null / undefined / NaN / Infinity / numeric strings / Date) in
 * `where`, `order_by`, `_is_null` and folds; empty/degenerate inputs; and
 * incremental-view exactness (retract-to-empty, reopen-equivalence,
 * interleaving, null operands).
 *
 * Every behavioural `it` drives the real `DataView` seam (the consumer entry).
 * Tests with `it.fails` document a confirmed, filed bug; they are green today
 * and flip red the moment the bug is fixed, forcing the assertion to be updated.
 */
import { describe, it, expect } from 'vitest';
import {
  DataView,
  IndexStore,
  PhaseRuleError,
  execute,
  type EvalCtx,
  type IndexField,
} from './index';
import type {
  Fold,
  QueryExpression,
  Row,
  WindowFrame,
  WindowSpec,
} from './index';

// ── helpers ─────────────────────────────────────────────────────────────────
const shallow = (rows: readonly Row[]): Row[] => rows.map((r) => ({ ...r }));

/** A plain (un-indexed) DataView over a single source named `s`. */
const plain = (rows: readonly Row[]): DataView =>
  new DataView([{ name: 's', data: shallow(rows) }]);

/** An index-enabled DataView over a single source named `s`. */
const indexed = (rows: readonly Row[], fields: IndexField[]): DataView =>
  new DataView([{ name: 's', data: shallow(rows) }], { indexes: { s: fields } });

/** Assert the index-accelerated result is identically the scan result for `q`. */
function expectIndexMatchesScan(
  rows: Row[],
  fields: IndexField[],
  q: QueryExpression
): void {
  const viaIndex = indexed(rows, fields).query(q);
  const viaScan = plain(rows).query(q);
  expect(viaIndex, `index diverged from scan for ${JSON.stringify(q.where)}`).toEqual(
    viaScan
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Reference-routing boundaries
// ════════════════════════════════════════════════════════════════════════════
describe('reference routing — raw field shadowed by a group-output name (pinned footgun)', () => {
  const rows: Row[] = [
    { agent: 'a', cost: -5, cost_usd: 1 },
    { agent: 'a', cost: 100, cost_usd: 2 },
  ];
  const shadowQuery: QueryExpression = {
    group_by: ['agent', { name: 'cost', aggregate: { _sum: 'cost_usd' } }],
    where: { cost: { _gt: 0 } },
  };
  const reachableQuery: QueryExpression = {
    group_by: ['agent', { name: 'cost', aggregate: { _sum: 'cost_usd' } }],
    where: { cost_usd: { _gt: 1 } },
  };

  it('a `where` leaf naming a group OUTPUT resolves post-group — the raw field is unreachable', () => {
    // `where.cost` is classified POST (cost is a group-output name), so it filters
    // the COMPUTED sum (3), not the raw `cost` column. A query author who meant the
    // raw pre-filter silently gets the HAVING result. This boundary was never
    // asserted; `validateQuery` cannot see it without a schema (phase.ts).
    expect(plain(rows).query(shadowQuery)).toEqual([{ agent: 'a', cost: 3 }]);
  });

  it('the identical intent is reversed when the raw field name does NOT collide', () => {
    expect(plain(rows).query(reachableQuery)).toEqual([{ agent: 'a', cost: 2 }]);
  });

  it('NEGATIVE CONTROL: the shadowed vs pre-filtered results differ (assertion has teeth)', () => {
    const shadowed = plain(rows).query(shadowQuery).map((r) => r['cost']);
    const preFiltered = plain(rows).query(reachableQuery).map((r) => r['cost']);
    expect(shadowed).not.toEqual(preFiltered);
  });
});

describe('phase-rule purity across the group boundary', () => {
  const grouped = (where: QueryExpression['where']): QueryExpression => ({
    where,
    group_by: [{ name: 'cost', aggregate: { _sum: 'c' } }],
  });

  it('a mixed-phase `_not` is a compile error (no WHERE-then-HAVING form)', () => {
    expect(() =>
      plain([{ a: 1, c: 1 }]).query(
        grouped({ _not: { _and: [{ a: { _eq: 1 } }, { cost: { _gt: 0 } }] } })
      )
    ).toThrow(PhaseRuleError);
  });

  it('a nested mixed-phase `_or` (inside an `_and`) is a compile error', () => {
    expect(() =>
      plain([{ a: 1, c: 1 }]).query(
        grouped({
          _and: [
            { a: { _eq: 1 } },
            { _or: [{ a: { _eq: 2 } }, { cost: { _gt: 0 } }] },
          ],
        })
      )
    ).toThrow(PhaseRuleError);
  });

  it('a phase-pure POST `_or` is allowed and behaves as a HAVING disjunction', () => {
    const rows: Row[] = [
      { a: 'keep', c: 5 },
      { a: 'low', c: -5 },
      { a: 'mid', c: -101 },
    ];
    const out = plain(rows).query({
      group_by: ['a', { name: 'cost', aggregate: { _sum: 'c' } }],
      where: { _or: [{ cost: { _gt: 0 } }, { cost: { _lt: -100 } }] },
      order_by: [{ a: 'asc' }],
    });
    // keep: 5 > 0 ✓ ; low: -5 matches neither ✓ ; mid: -101 < -100 ✓
    expect(out).toEqual([
      { a: 'keep', cost: 5 },
      { a: 'mid', cost: -101 },
    ]);
  });

  it('a bucket group key colliding with an output name throws', () => {
    expect(() =>
      plain([{ t: 0, x: 1 }]).query({
        group_by: [
          { _bucket: { field: 't', unit: 'hour' } },
          { name: 't', aggregate: { _sum: 'x' } },
        ],
      })
    ).toThrow(/collision/);
  });

  it('the reference executor rejects a duplicate group item name', () => {
    expect(() =>
      execute(
        {
          group_by: [
            { name: 'x', aggregate: { _sum: 'a' } },
            { name: 'x', aggregate: { _sum: 'b' } },
          ],
        },
        [{ a: 1, b: 2 }]
      )
    ).toThrow(/duplicate/i);
  });

  // CONFIRMED BUG (filed): `DataView.query` short-circuits to the incremental cache
  // for a plain grouped monoid query and never calls `validateQuery`, so the two
  // errors the reference executor raises are silently accepted — and for a name/
  // field collision the group KEY is overwritten by the same-named aggregate.
  it.fails(
    'BUG: DataView.query must reject a duplicate group name (incremental path skips validation)',
    () => {
      expect(() =>
        new DataView([{ name: 's', data: [{ a: 1, b: 2 }] }]).query({
          source: 's',
          group_by: [
            { name: 'x', aggregate: { _sum: 'a' } },
            { name: 'x', aggregate: { _sum: 'b' } },
          ],
        })
      ).toThrow(/duplicate/i);
    }
  );

  it.fails(
    'BUG: DataView.query must reject a name/field collision (incremental path skips validation)',
    () => {
      const dv = new DataView([
        { name: 's', data: [{ g: 'a', v: 1 }, { g: 'b', v: 2 }] },
      ]);
      expect(() =>
        dv.query({ source: 's', group_by: ['g', { name: 'g', aggregate: { _sum: 'v' } }] })
      ).toThrow(/collision/);
    }
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Index-vs-scan equivalence
// ════════════════════════════════════════════════════════════════════════════
describe('index vs scan equivalence', () => {
  const ALL_FIELDS: IndexField[] = [
    { field: 'a', kind: 'eq' },
    { field: 'g', kind: 'bitmap' },
    { field: 'v', kind: 'range' },
  ];
  /** Deliberately heterogeneous: non-finite numbers, a numeric string, a Date, null. */
  const MIXED: Row[] = [
    { a: 'x', g: 3, v: 1 },
    { a: 'y', g: 1, v: 5 },
    { a: 'x', g: 3, v: '3' },
    { a: 'z', g: 2, v: 10 },
    { a: 'x', g: 1, v: -2 },
    { a: 'y', g: 3, v: new Date(0) },
    { a: 'x', g: 3, v: 0 },
    { a: 'y', g: 2, v: 7 },
  ];

  const PREDICATES: QueryExpression['where'][] = [
    { g: { _eq: 3 } },
    { g: { _in: [1, 3] } },
    { a: { _eq: 'x' } },
    { a: { _in: ['x', 'z'] } },
    { a: { _ne: 'x' } },
    { a: { _nin: ['x'] } },
    { a: { _eq: 'nope' } }, // empty result set
    { v: { _gt: 3 } },
    { v: { _gte: 0 } },
    { v: { _lt: 5 } },
    { v: { _lte: 7 } },
    { v: { _between: [2, 8] } },
    { v: { _gt: '3' } }, // a string operand → range cannot narrow
    { _and: [{ v: { _gt: -1 } }, { g: { _eq: 3 } }] },
    { _or: [{ v: { _lt: 6 } }, { g: { _eq: 2 } }] },
    { _or: [{ a: { _eq: 'x' } }, { v: { _gte: 5 } }] }, // eq ∥ range
    { _not: { g: { _eq: 1 } } },
    { _and: [{ _not: { g: { _eq: 1 } } }, { v: { _gt: -1 } }] },
    { v: { _gt: 0 }, g: { _eq: 2 } }, // implicit AND of a range + bitmap leaf
  ];

  it('every narrowing predicate yields identical rows to a scan (mixed/impure values)', () => {
    for (const where of PREDICATES) {
      expectIndexMatchesScan(MIXED, ALL_FIELDS, { source: 's', where });
    }
  });

  it('pure numeric range: the index actually narrows (candidates is defined), and matches a scan', () => {
    const rows: Row[] = [{ v: 1 }, { v: 5 }, { v: 9 }, { v: -2 }, { v: 0 }];
    const store = new IndexStore([{ field: 'v', kind: 'range' }]);
    for (const r of rows) store.add(r);
    expect(store.candidates({ v: { _gte: 5 } })).toBeDefined();
    for (const where of [
      { v: { _gt: 3 } },
      { v: { _gte: 5 } },
      { v: { _lt: 5 } },
      { v: { _lte: 0 } },
      { v: { _between: [0, 5] } },
      { _and: [{ v: { _gte: 0 } }, { v: { _lte: 5 } }] },
    ] as QueryExpression['where'][]) {
      expectIndexMatchesScan(rows, [{ field: 'v', kind: 'range' }], {
        source: 's',
        where,
      });
    }
  });

  it('bitmap index narrows `_eq` / `_in` and matches a scan', () => {
    const rows: Row[] = [{ g: 'a' }, { g: 'b' }, { g: 'a' }, { g: 'c' }];
    const fields: IndexField[] = [{ field: 'g', kind: 'bitmap' }];
    expectIndexMatchesScan(rows, fields, { source: 's', where: { g: { _eq: 'a' } } });
    expectIndexMatchesScan(rows, fields, {
      source: 's',
      where: { g: { _in: ['a', 'c'] } },
    });
    expectIndexMatchesScan(rows, fields, { source: 's', where: { g: { _eq: 'zzz' } } });
  });

  // CONFIRMED BUG (filed): IndexStore narrows `_eq: undefined` to the rows whose
  // field IS undefined, but the exact matcher skips an undefined operand entirely
  // (a no-op). The scan (all rows) and the index (a subset) therefore diverge —
  // violating indexing.ts's own contract ("an index can never change the result").
  it.fails(
    'BUG: `_eq: undefined` (a no-op leaf) must not be narrowed by the index',
    () => {
      const rows: Row[] = [{ a: 1 }, { b: 2 }, { a: undefined }];
      expectIndexMatchesScan(rows, [{ field: 'a', kind: 'eq' }], {
        source: 's',
        where: { a: { _eq: undefined } },
      });
      expectIndexMatchesScan(rows, [{ field: 'a', kind: 'bitmap' }], {
        source: 's',
        where: { a: { _eq: undefined } },
      });
    }
  );

  it('NEGATIVE CONTROL: the equivalence assertion detects a one-field difference', () => {
    const rows: Row[] = [{ a: 'x' }, { a: 'y' }];
    const q: QueryExpression = { source: 's', where: { a: { _eq: 'x' } } };
    const mutated = plain(rows).query(q);
    mutated[0] = { ...mutated[0], extra: 1 };
    expect(indexed(rows, [{ field: 'a', kind: 'eq' }]).query(q)).not.toEqual(mutated);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Frame / window edges
// ════════════════════════════════════════════════════════════════════════════
describe('window / frame edges', () => {
  const winQuery = (fold: Fold, spec: WindowSpec, forceFallback: boolean): QueryExpression => ({
    select: [
      {
        name: 'w',
        aggregate: forceFallback
          ? { ...fold, _window: spec, _filter: {} }
          : { ...fold, _window: spec },
      },
    ],
  });
  const run = (fold: Fold, spec: WindowSpec, rows: Row[], fb: boolean): unknown[] =>
    plain(rows)
      .query(winQuery(fold, spec, fb))
      .map((r) => r['w']);

  const MONOID_FOLDS: Fold[] = [
    { _sum: 'v' },
    { _count: true },
    { _avg: 'v' },
    { _min: 'v' },
    { _max: 'v' },
  ];
  const FRAMES: WindowFrame[] = [
    [-1, 1],
    [0, 0],
    [0, -1], // empty frame
    [-2, 0],
    ['unbounded', 'unbounded'],
  ];

  it('tiny partitions (n = 1, 2, 3): fast path == materializing fallback for every monoid fold × frame', () => {
    for (const n of [1, 2, 3]) {
      const rows: Row[] = Array.from({ length: n }, (_, i) => ({ ts: i, v: i === 0 ? 1 : i }));
      for (const fold of MONOID_FOLDS) {
        for (const frame of FRAMES) {
          const spec: WindowSpec = { field: 'ts', frame_mode: 'rows', frame };
          const label = `n=${n} ${JSON.stringify(fold)} ${JSON.stringify(frame)}`;
          expect(run(fold, spec, rows, false), label).toEqual(run(fold, spec, rows, true));
        }
      }
    }
  });

  it('order_by may reference a computed window column', () => {
    const rows: Row[] = [
      { t: 1, c: 1 },
      { t: 3, c: 3 },
      { t: 2, c: 2 },
    ];
    const out = plain(rows).query({
      select: [
        't',
        {
          name: 'running',
          aggregate: { _sum: 'c', _window: { field: 't', frame: ['unbounded', 0] } },
        },
      ],
      order_by: [{ running: 'desc' }],
    });
    expect(out.map((r) => r['running'])).toEqual([6, 3, 1]);
  });

  it('a window fold with no `partition_by` spans the whole partition (the field doc says group_by — filed)', () => {
    const rows: Row[] = [
      { g: 'a', t: 1, c: 1 },
      { g: 'b', t: 2, c: 5 },
    ];
    const out = plain(rows).query({
      group_by: ['g', { name: 'tot', aggregate: { _sum: 'c' } }],
      select: [
        'g',
        'tot',
        { name: 'r', aggregate: { _sum: 'tot', _window: { field: 't' } } },
      ],
    });
    // Actual: both records see the whole partition (sum of all group totals = 6).
    // `WindowSpec.partition_by`'s doc ("Defaults to the query's `group_by`") would
    // instead give r = tot per group. The divergence is filed.
    expect(out.map((r) => r['r'])).toEqual([6, 6]);
  });

  // Extends the known tie bug (already filed) to an EXPLICIT unbounded frame: the
  // fast path keeps the LAST compareOrder-equal value, the materializer the FIRST.
  it.fails('BUG: window fast-path `_min` tie divergence under an explicit frame', () => {
    const rows: Row[] = [
      { ts: 0, v: 1 },
      { ts: 1, v: '1' },
    ];
    const out = plain(rows).query({
      select: [
        {
          name: 'w',
          aggregate: {
            _min: 'v',
            _window: { field: 'ts', frame_mode: 'rows', frame: ['unbounded', 'unbounded'] },
          },
        },
      ],
    });
    expect(out.map((r) => r['w'])).toEqual([1, 1]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Types in where / order_by / _is_null / folds
// ════════════════════════════════════════════════════════════════════════════
describe('type edges', () => {
  it('order_by places nullish values per the direction contract (ASC → last, DESC → first)', () => {
    const rows: Row[] = [
      { id: 1, v: 2 },
      { id: 2, v: null },
      { id: 3, v: 1 },
      { id: 4 }, // missing
    ];
    const ids = (q: QueryExpression): unknown[] =>
      plain(rows).query(q).map((r) => r['id']);
    expect(ids({ order_by: [{ v: 'asc' }] })).toEqual([3, 1, 2, 4]);
    expect(ids({ order_by: [{ v: 'asc_nulls_first' }] })).toEqual([2, 4, 3, 1]);
    expect(ids({ order_by: [{ v: 'desc' }] })).toEqual([2, 4, 1, 3]);
    expect(ids({ order_by: [{ v: 'desc_nulls_last' }] })).toEqual([1, 3, 2, 4]);
  });

  it('NaN sorts last among numbers (and is not treated as nullish)', () => {
    const rows: Row[] = [
      { id: 1, v: 2 },
      { id: 2, v: NaN },
      { id: 3, v: 1 },
    ];
    expect(plain(rows).query({ order_by: [{ v: 'asc' }] }).map((r) => r['id'])).toEqual([
      3, 1, 2,
    ]);
  });

  it('compareOrder-equal ties preserve input order (stable) in both directions', () => {
    const rows: Row[] = [
      { id: 1, v: 1 },
      { id: 2, v: '1' },
      { id: 3, v: 1 },
    ];
    expect(
      plain(rows).query({ order_by: [{ v: 'asc' }] }).map((r) => r['id'])
    ).toEqual([1, 2, 3]);
    expect(
      plain(rows).query({ order_by: [{ v: 'desc' }] }).map((r) => r['id'])
    ).toEqual([1, 2, 3]);
  });

  it('`_is_null` distinguishes nullish from a present value; `_eq: null` matches only explicit null', () => {
    const rows: Row[] = [{ id: 1, a: null }, { id: 2 }, { id: 3, a: 5 }];
    const ids = (like: QueryExpression['where']): unknown[] =>
      plain(rows).query({ where: like, select: ['id'] }).map((r) => r['id']);
    expect(ids({ a: { _is_null: true } })).toEqual([1, 2]);
    expect(ids({ a: { _is_null: false } })).toEqual([3]);
    expect(ids({ a: { _eq: null } })).toEqual([1]);
  });

  it('folds over nullish and numeric-string operands', () => {
    const rows: Row[] = [
      { g: 'x', v: 5 },
      { g: 'x', v: null },
      { g: 'x' },
      { g: 'y', v: '3' },
      { g: 'y', v: '4' },
    ];
    const out = plain(rows).query({
      group_by: [
        'g',
        { name: 'rows', aggregate: { _count: true } },
        { name: 'nonNull', aggregate: { _count: 'v' } },
        { name: 'sum', aggregate: { _sum: 'v' } },
        { name: 'avg', aggregate: { _avg: 'v' } },
        { name: 'lo', aggregate: { _min: 'v' } },
      ],
      order_by: [{ g: 'asc' }],
    });
    expect(out).toEqual([
      // v2 rule: `_avg` counts EVERY row (null operand contributes 0, is in the denom).
      { g: 'x', rows: 3, nonNull: 1, sum: 5, avg: 5 / 3, lo: 5 },
      // numeric strings coerce to 0 in the NUMERIC folds (`_sum`/`_avg`), but `_min`
      // ranks by `compareOrder` (string form), so it returns the string itself.
      { g: 'y', rows: 2, nonNull: 2, sum: 0, avg: 0, lo: '3' },
    ]);
  });

  it('`_min` over an all-missing operand is null, not undefined', () => {
    expect(
      plain([{ a: 1 }, { a: 2 }]).query({
        group_by: [{ name: 'm', aggregate: { _min: 'x' } }],
      })
    ).toEqual([{ m: null }]);
  });

  it('`_eq` compares Dates by instant', () => {
    const rows: Row[] = [{ id: 1, t: new Date(1000) }, { id: 2, t: new Date(2000) }];
    expect(
      plain(rows).query({ where: { t: { _eq: new Date(1000) } }, select: ['id'] })
    ).toEqual([{ id: 1 }]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Empty / degenerate inputs
// ════════════════════════════════════════════════════════════════════════════
describe('empty / degenerate inputs', () => {
  it('empty input: a filter and a grouped aggregate both yield no rows (groups form from rows)', () => {
    expect(plain([]).query({ select: ['a'] })).toEqual([]);
    expect(
      plain([]).query({ group_by: [{ name: 'c', aggregate: { _count: true } }] })
    ).toEqual([]);
  });

  it('single row: group of one', () => {
    expect(
      plain([{ g: 'a', v: 7 }]).query({
        group_by: ['g', { name: 'c', aggregate: { _count: true } }, { name: 's', aggregate: { _sum: 'v' } }],
      })
    ).toEqual([{ g: 'a', c: 1, s: 7 }]);
  });

  it('limit: 0 returns no rows but flags has_more; a limit ≥ length does not', () => {
    const dv = new DataView([{ a: 1 }, { a: 2 }] as Row[], { limit: 0, select: ['a'] });
    dv.commit();
    expect(dv.view()).toEqual([]);
    expect(dv.has_more).toBe(true);

    const dv2 = new DataView([{ a: 1 }, { a: 2 }] as Row[], { limit: 9, select: ['a'] });
    dv2.commit();
    expect(dv2.view()).toHaveLength(2);
    expect(dv2.has_more).toBe(false);
  });

  it('offset beyond the result length is an empty page', () => {
    expect(plain([{ a: 1 }]).query({ offset: 5, select: ['a'] })).toEqual([]);
  });

  it('distinct_on collapses null and a missing field to one key (JSON array-hole semantics, pinned)', () => {
    // `JSON.stringify([undefined])` is `'[null]'`, so an absent field and an explicit
    // null share a distinct key. Pinned: a consumer expecting them to differ would be
    // surprised; the behaviour is a consequence of the JSON key, not a schema choice.
    expect(plain([{ a: null }, { a: null }, { b: 1 }]).query({ distinct_on: ['a'] })).toEqual([
      { a: null },
    ]);
  });

  it('keep: { n: 0 } folds every group into a single `_other` row', () => {
    const out = plain([
      { g: 'a', c: 1 },
      { g: 'b', c: 2 },
    ]).query({
      group_by: ['g', { name: 'c', aggregate: { _sum: 'c' } }],
      order_by: [{ c: 'desc' }],
      keep: { n: 0, other: true },
    });
    expect(out).toEqual([{ _other: true, c: 3 }]);
  });

  it('a `select` aggregate item with no group_by nests the rows as a relation (pinned)', () => {
    // Surprising but by-design (§15.10 relation-valued select): `{name, aggregate}`
    // in `select` without a `group_by` is a RELATION over the source and its
    // `aggregate` is not evaluated. Pinned so a change is visible.
    expect(
      plain([{ a: 1 }, { a: 2 }]).query({
        select: [{ name: 'n', aggregate: { _count: true } }],
      })
    ).toEqual([{ n: [{ a: 1 }, { a: 2 }] }]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Incremental view exactness
// ════════════════════════════════════════════════════════════════════════════
describe('incremental view exactness', () => {
  const q: QueryExpression = {
    source: 's',
    group_by: [
      'g',
      { name: 'sum', aggregate: { _sum: 'v' } },
      { name: 'n', aggregate: { _count: true } },
      { name: 'nn', aggregate: { _count: 'v' } },
      { name: 'avg', aggregate: { _avg: 'v' } },
    ],
  };
  const sortByG = (rows: Row[]): Row[] =>
    [...rows].sort((a, b) => String(a['g']).localeCompare(String(b['g'])));
  const reference = (dv: DataView): Row[] => {
    const src = dv.get('s');
    const ctx: EvalCtx = { sourceRows: src, sources: new Map([['s', src]]), memo: new Map() };
    return sortByG(execute(q, src, ctx));
  };

  it('retracting every row empties the result exactly', () => {
    const dv = new DataView([{ name: 's', data: [{ g: 'x', v: 1 }, { g: 'x', v: 2 }] }]);
    expect(dv.query(q)).toEqual([{ g: 'x', sum: 3, n: 2, nn: 2, avg: 1.5 }]);
    dv.remove('s', { g: 'x', v: 1 });
    dv.remove('s', { g: 'x', v: 2 });
    expect(dv.query(q)).toEqual([]);
    expect(reference(dv)).toEqual([]);
  });

  it('interleaved append/insert/remove with NULL operands stays exact vs a reference recompute', () => {
    const dv = new DataView([
      { name: 's', data: [{ g: 'a', v: 5 }, { g: 'a', v: null }, { g: 'b', v: 3 }] },
    ]);
    dv.query(q); // warm the cache
    const ops: Array<() => void> = [
      () => dv.insert('s', { g: 'a', v: 2 }),
      () => dv.append('s', [{ g: 'b', v: null }, { g: 'b', v: 4 }]),
      () => dv.remove('s', { g: 'a', v: null }),
      () => dv.insert('s', { g: 'c', v: 1 }),
      () => dv.remove('s', { g: 'c', v: 1 }),
    ];
    for (const op of ops) {
      op();
      expect(sortByG(dv.query(q)), 'incremental diverged from reference').toEqual(
        reference(dv)
      );
    }
  });

  it('an incrementally-maintained view equals a fresh DataView over the same rows (reopen-equivalence)', () => {
    const dv = new DataView([{ name: 's', data: [{ g: 'x', v: 1 }, { g: 'x', v: 2 }] }]);
    dv.query(q);
    dv.insert('s', { g: 'x', v: 5 });
    const incremental = sortByG(dv.query(q));

    const reopened = new DataView([
      { name: 's', data: [{ g: 'x', v: 1 }, { g: 'x', v: 2 }, { g: 'x', v: 5 }] },
    ]);
    expect(incremental).toEqual(sortByG(reopened.query(q)));
  });

  it('retracting the last row of a group removes the group entirely', () => {
    const dv = new DataView([{ name: 's', data: [{ g: 'x', v: 4 }] }]);
    expect(dv.query(q)).toEqual([{ g: 'x', sum: 4, n: 1, nn: 1, avg: 4 }]);
    dv.remove('s', { g: 'x', v: 4 });
    expect(dv.query(q)).toEqual([]);
  });

  it('NEGATIVE CONTROL: the incremental/reference comparison detects a changed accumulator', () => {
    const dv = new DataView([{ name: 's', data: [{ g: 'x', v: 1 }, { g: 'x', v: 2 }] }]);
    const live = dv.query(q);
    const tampered = live.map((r) => ({ ...r, sum: 999 }));
    expect(live).not.toEqual(tampered);
  });
});
