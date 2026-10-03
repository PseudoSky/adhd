import util from 'util';
import { BooleanExpression, QueryExpression } from './expressions';
import DataView from './query';
import largeSample from './test-data-large.json';
import testingData from './test-data.json';
const data = [
  { name: 'B', value: 18 },
  { name: 'A', value: 8 },
  { name: 'E', value: 18000 },
  { name: 'D', value: 128 },
  { name: 'C', value: 100 },
];

describe('query', () => {
  it('(0) nested similarity filter over a large sample', () => {
    const dv = new DataView(largeSample as [], undefined, true).orderBy([
      { unit_price: 'asc' },
    ]);

    dv.where({ details: { summary: { _similar: '@' } } });
    expect(dv.view().length).toEqual(22);
  });
  it('(1) filter using provided raw query', () => {
    const query: QueryExpression = {
      where: { value: { _gt: 100 } },
      order_by: [{ value: 'asc' }],
    };
    const dv = new DataView(data, query, true);
    console.log(
      util.inspect(query, { showHidden: false, depth: null, colors: true })
    );
    expect(dv.view()).toEqual([
      { name: 'D', value: 128 },
      { name: 'E', value: 18000 },
    ]);
  });
  it('(2) logical and to work', () => {
    const dv = new DataView(data, undefined, true).orderBy([{ value: 'asc' }]);
    const query: BooleanExpression = {
      _and: [{ name: { _eq: 'D' } }, { value: { _eq: 128 } }],
    };
    dv.where(query);
    console.log(
      util.inspect(query, { showHidden: false, depth: null, colors: true })
    );
    expect(dv.view()).toEqual([{ name: 'D', value: 128 }]);
  });
  it('(3) logical not to work', () => {
    const dv = new DataView(data, undefined, true).orderBy([{ value: 'asc' }]);
    const query: BooleanExpression = { _not: { name: { _eq: 'D' } } };
    dv.where(query);
    console.log(
      util.inspect(query, { showHidden: false, depth: null, colors: true })
    );
    expect(dv.view()).toEqual(
      data.filter((e) => e.name !== 'D').sort((a, b) => a.value - b.value)
    );
  });
  it('(3) logical not to work', () => {
    const dv = new DataView(data, undefined, true).orderBy([{ value: 'asc' }]);
    const query: BooleanExpression = {
      name: { _eq: 'D' },
      value: {
        _gt: 0,
        _lt: 10000,
        _gte: 1,
        _lte: 9999,
      },
    };
    dv.where(query);
    console.log(
      util.inspect(query, { showHidden: false, depth: null, colors: true })
    );
    expect(dv.view()).toEqual([{ name: 'D', value: 128 }]);
  });
  it('(4) logical tripple and', () => {
    const dv = new DataView(data, undefined, true).orderBy([{ value: 'asc' }]);
    const query: BooleanExpression = {
      _and: [{ _and: [{ _and: [{ name: { _eq: 'D' } }] }] }],
    };
    dv.where(query);
    console.log(
      util.inspect(query, { showHidden: false, depth: null, colors: true })
    );
    expect(dv.view()).toEqual([{ name: 'D', value: 128 }]);
  });
  it('(5) logical and or and', () => {
    const dv = new DataView(data, undefined, true).orderBy([{ value: 'asc' }]);
    const query: BooleanExpression = {
      _and: [{ _or: [{ _and: [{ name: { _eq: 'D' } }] }] }],
    };
    dv.where(query);
    console.log(
      util.inspect(query, { showHidden: false, depth: null, colors: true })
    );
    expect(dv.view()).toEqual([{ name: 'D', value: 128 }]);
  });
  it('(6) logical and or and 2 keys', () => {
    const dv = new DataView(data, undefined, true).orderBy([{ value: 'asc' }]);
    const query: BooleanExpression = {
      _and: [
        { _or: [{ _and: [{ name: { _eq: 'D' }, value: { _eq: 128 } }] }] },
      ],
    };
    dv.where(query);
    console.log(
      util.inspect(query, { showHidden: false, depth: null, colors: true })
    );
    expect(dv.view()).toEqual([{ name: 'D', value: 128 }]);
  });
  it('(7) logical and or not 2 keys', () => {
    const dv = new DataView(data, undefined, true).orderBy([{ value: 'asc' }]);
    const query: BooleanExpression = {
      _and: [{ _or: [{ _not: { name: { _eq: 'D' }, value: { _eq: 128 } } }] }],
    };
    dv.where(query);
    console.log(
      util.inspect(query, { showHidden: false, depth: null, colors: true })
    );
    expect(dv.view()).toEqual([
      { name: 'A', value: 8 },
      { name: 'B', value: 18 },
      { name: 'C', value: 100 },
      { name: 'E', value: 18000 },
    ]);
  });
  it('(8) logical and or(2 entries) not(2 keys)', () => {
    const dv = new DataView(data, undefined, true).orderBy([{ value: 'asc' }]);
    const query: BooleanExpression = {
      _and: [
        {
          _or: [
            { name: { _eq: 'D' } },
            { _not: { name: { _eq: 'D' }, value: { _eq: 128 } } },
          ],
        },
      ],
    };
    dv.where(query);
    console.log(
      util.inspect(query, { showHidden: false, depth: null, colors: true })
    );
    expect(dv.view()).toEqual([
      { name: 'A', value: 8 },
      { name: 'B', value: 18 },
      { name: 'C', value: 100 },
      { name: 'D', value: 128 },
      { name: 'E', value: 18000 },
    ]);
  });
  it('(9) logical or to work', () => {
    const dv = new DataView(data, undefined, true).orderBy([{ value: 'asc' }]);
    const query: BooleanExpression = {
      _or: [{ name: { _eq: 'D' } }, { value: { _eq: 18000 } }],
    };
    dv.where(query);
    console.log(
      util.inspect(query, { showHidden: false, depth: null, colors: true })
    );
    expect(dv.view()).toEqual([
      { name: 'D', value: 128 },
      { name: 'E', value: 18000 },
    ]);
  });
  it('(10) logical complex or to work', () => {
    const dv = new DataView(data, undefined, true).orderBy([{ value: 'asc' }]);
    const query: BooleanExpression = {
      _or: [
        { _and: [{ name: { _eq: 'D' }, value: { _ne: 128 } }] }, // Not D
        { value: { _eq: 18000 } }, // IS E
      ],
    };
    dv.where(query);
    console.log(
      util.inspect(query, { showHidden: false, depth: null, colors: true })
    );
    expect(dv.view()).toEqual(
      data
        .filter((e) => (e.name === 'D' && e.value !== 128) || e.value === 18000)
        .sort((a, b) => a.value - b.value)
    );
  });
  it('(11) logical or with nested not to work', () => {
    const dv = new DataView(data, undefined, true).orderBy([{ value: 'asc' }]);
    const query: BooleanExpression = {
      _or: [
        { name: { _ne: 'D' }, value: { _gt: 128 } }, // Only E
        { _not: { value: { _in: [18, 8, 18000, 100] } } }, // Only D
      ],
    };
    dv.where(query);
    console.log(
      util.inspect(query, { showHidden: false, depth: null, colors: true })
    );
    expect(dv.view()).toEqual([
      { name: 'D', value: 128 },
      { name: 'E', value: 18000 },
    ]);
  });
  it('(11.1) nested properties', () => {
    const dv = new DataView(
      [
        { a: { b: { c: 1000 } } },
        { a: { b: { c: 2000 } } },
        { a: { b: { c: 1 } } },
        { a: { b: { c: -100 } } },
      ],
      undefined,
      true
    ); //.orderBy([{"value": "asc"}]);
    const query: BooleanExpression = {
      a: { b: { c: { _lt: 1001, _gt: 10 } } },
    };
    dv.where(query);
    console.log(
      util.inspect(query, { showHidden: false, depth: null, colors: true })
    );
    expect(dv.view()).toEqual([{ a: { b: { c: 1000 } } }]);
  });
  it('(12) logical or with and to work', () => {
    const dv = new DataView(data, undefined, true).orderBy([{ value: 'asc' }]);
    const query: BooleanExpression = {
      _or: [
        { name: { _ne: 'D' }, value: { _gt: 128 } },
        {
          _and: [
            { value: { _in: [18, 8, 18000, 100] } },
            { name: { _in: ['B', 'A', 'E'] } },
          ],
        },
      ],
    };
    dv.where(query);
    console.log(
      util.inspect(query, { showHidden: false, depth: null, colors: true })
    );
    expect(dv.view()).toEqual([
      { name: 'A', value: 8 },
      { name: 'B', value: 18 },
      { name: 'E', value: 18000 },
    ]);
  });
  it('produce a serialized version of a query from fluent interface', () => {
    const dv = new DataView(testingData, undefined);
    dv.orderBy([{ title: 'asc' }]);
    expect(dv.limit(1).view()[0].title).toEqual('Appian Connected Claims');
    expect(dv.offset(1).view()[0].title).toEqual('Appian Connected KYC');
    dv.orderBy([{ title: 'desc' }]);
    expect(dv.offset(0).view()[0].title).toEqual('WordPress');
    expect(dv.offset(1).view()[0].title).toEqual(
      'Vertica by the Hour, Red Hat'
    );
    // TEST: limit can be unset
    dv.limit().offset(0);
    // TEST: check the or count
    expect(
      dv
        .where({
          _or: [
            { company_name: { _eq: 'Freshworks Inc.' } },
            { product_id: { _eq: 'prodview-h54kdzendnnkm' } },
          ],
        })
        .view().length
    ).toEqual(5);
    // TEST: check the and + or filters
    expect(
      dv
        .where({
          _and: [
            {
              _not: {
                reviews_aws_value: { _eq: 0 },
              },
            },
            {
              _or: [
                { company_name: { _eq: 'Freshworks Inc.' } },
                { product_id: { _eq: 'prodview-h54kdzendnnkm' } },
              ],
            },
          ],
        })
        .view().length
    ).toEqual(1);
  });
});
describe('query ordering', () => {
  const items = [
    { column1: 'B', column2: 2, data: { nested: 2 } },
    { column1: 'A', column2: 3, data: { nested: 3 } },
    { column1: 'C', column2: null, data: { nested: null } },
    { column1: 'A', column2: 1, data: { nested: 1 } },
    { column1: 'B', column2: 1, data: { nested: 1 } },
    { column1: null, column2: 1, data: { nested: 1 } },
  ];
  const dv = new DataView(items, undefined, true);
  it('asc_nulls_first and desc', () => {
    dv.orderBy([{ column1: 'asc_nulls_first' }, { column2: 'desc' }]);
    expect(dv.view()).toEqual([
      { column1: null, column2: 1, data: { nested: 1 } },
      { column1: 'A', column2: 3, data: { nested: 3 } },
      { column1: 'A', column2: 1, data: { nested: 1 } },
      { column1: 'B', column2: 2, data: { nested: 2 } },
      { column1: 'B', column2: 1, data: { nested: 1 } },
      { column1: 'C', column2: null, data: { nested: null } },
    ]);
  });
  it('array of sorts nulls first', () => {
    dv.orderBy([{ column1: 'asc_nulls_first' }]);
    expect(dv.view()).toEqual([
      { column1: null, column2: 1, data: { nested: 1 } },
      { column1: 'A', column2: 3, data: { nested: 3 } },
      { column1: 'A', column2: 1, data: { nested: 1 } },
      { column1: 'B', column2: 2, data: { nested: 2 } },
      { column1: 'B', column2: 1, data: { nested: 1 } },
      { column1: 'C', column2: null, data: { nested: null } },
    ]);
  });
  it('array with single sort', () => {
    dv.orderBy([{ column1: 'asc_nulls_last' }]);
    expect(dv.view()).toEqual([
      { column1: 'A', column2: 3, data: { nested: 3 } },
      { column1: 'A', column2: 1, data: { nested: 1 } },
      { column1: 'B', column2: 2, data: { nested: 2 } },
      { column1: 'B', column2: 1, data: { nested: 1 } },
      { column1: 'C', column2: null, data: { nested: null } },
      { column1: null, column2: 1, data: { nested: 1 } },
    ]);
  });
  it('array of sorts', () => {
    dv.orderBy([{ column1: 'asc_nulls_last' }, { column2: 'asc_nulls_last' }]);
    expect(dv.view()).toEqual([
      { column1: 'A', column2: 1, data: { nested: 1 } },
      { column1: 'A', column2: 3, data: { nested: 3 } },
      { column1: 'B', column2: 1, data: { nested: 1 } },
      { column1: 'B', column2: 2, data: { nested: 2 } },
      { column1: 'C', column2: null, data: { nested: null } },
      { column1: null, column2: 1, data: { nested: 1 } },
    ]);
  });
  it('nested data', () => {
    dv.orderBy([
      { column1: 'asc_nulls_last' },
      { data: { nested: 'asc_nulls_last' } },
    ]);
    expect(dv.view()).toEqual([
      { column1: 'A', column2: 1, data: { nested: 1 } },
      { column1: 'A', column2: 3, data: { nested: 3 } },
      { column1: 'B', column2: 1, data: { nested: 1 } },
      { column1: 'B', column2: 2, data: { nested: 2 } },
      { column1: 'C', column2: null, data: { nested: null } },
      { column1: null, column2: 1, data: { nested: 1 } },
    ]);
  });
});

describe('query has_more', () => {
  const items = [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 5 }];
  it('should be true when more items exist beyond limit', () => {
    const dv = new DataView(items);
    dv.limit(3).view();
    expect(dv.has_more).toEqual(true);
  });
  it('should be false when items exactly equal limit', () => {
    const dv = new DataView(items);
    dv.limit(5).view();
    expect(dv.has_more).toEqual(false);
  });
  it('should be false when fewer items than limit', () => {
    const dv = new DataView([{ v: 1 }, { v: 2 }]);
    dv.limit(5).view();
    expect(dv.has_more).toEqual(false);
  });
});

describe('query sort mutation', () => {
  it('should not mutate original data when sorting without where', () => {
    const original = [{ v: 3 }, { v: 1 }, { v: 2 }];
    const copy = [...original];
    const dv = new DataView(original);
    dv.orderBy([{ v: 'asc' }]).view();
    expect(original).toEqual(copy);
  });
});

describe('regex operators', () => {
  const items = [
    { name: 'Alice', email: 'alice@example.com' },
    { name: 'Bob', email: 'bob@test.org' },
    { name: 'Charlie', email: 'CHARLIE@EXAMPLE.COM' },
  ];
  it('_regex matches case-sensitive pattern', () => {
    const dv = new DataView(items);
    dv.where({ email: { _regex: '@example\\.com$' } });
    expect(dv.view()).toEqual([items[0]]);
  });
  it('_iregex matches case-insensitive pattern', () => {
    const dv = new DataView(items);
    dv.where({ email: { _iregex: '@example\\.com$' } });
    expect(dv.view().length).toEqual(2);
  });
  it('_nregex excludes matching rows', () => {
    const dv = new DataView(items);
    dv.where({ email: { _nregex: '@example\\.com$' } });
    expect(dv.view().length).toEqual(2);
  });
  it('_niregex excludes case-insensitive matches', () => {
    const dv = new DataView(items);
    dv.where({ email: { _niregex: '@example\\.com$' } });
    expect(dv.view()).toEqual([items[1]]);
  });
});

// Regression: an empty/absent `where` must not clear the `dirty` flag that
// `setData()` raised. Before the fix, `setQuery()` overwrote `this.dirty` with
// the inner diff result (false for a no-op empty where), so `commit()` early-
// returned and `view()` handed back the initial empty `dataview` instead of the
// rows. Each assertion below is binary and independent of `data`'s ordering.
describe('query empty-where dirty flag', () => {
  it('returns every row for a queryless DataView', () => {
    expect(new DataView(data).view()).toEqual(data);
  });
  it('returns every row when where is an empty object', () => {
    expect(new DataView(data, { where: {} }).view()).toEqual(data);
  });
  it('returns every row when the query object is empty', () => {
    expect(new DataView(data, {}).view()).toEqual(data);
  });
  it('returns every row when a where deep-equal to {} is applied twice via setQuery', () => {
    const dv = new DataView(data);
    dv.setQuery({ where: {} });
    dv.setQuery({ where: {} });
    expect(dv.view()).toEqual(data);
  });
  it('still filters correctly for a non-empty where', () => {
    const dv = new DataView(data, {
      where: { value: { _gt: 100 } },
      order_by: [{ value: 'asc' }],
    });
    expect(dv.view()).toEqual([
      { name: 'D', value: 128 },
      { name: 'E', value: 18000 },
    ]);
  });
  it('returns an empty array for empty data', () => {
    expect(new DataView([]).view()).toEqual([]);
  });
});

// Regression for defect 24948077: `setOrderBy` defaulted `order_by` to `[]`, and
// `_.isEqual([], undefined) === false` let that default through the change guard,
// so the `orderBy` factory installed a truthy comparator whose empty loop could
// only ever `return 0`. The execute path's `if (this.query.order_by)` guard
// therefore ran `res.sort()` UNCONDITIONALLY — a full O(n·log n) no-op on every
// query that asked for no ordering at all. The fix returns `undefined` from the
// factory when there are zero order operations, so the guard genuinely skips the
// sort. The assertions below intercept `Array.prototype.sort` itself and attribute
// each call by receiver, so the no-op is provably gone rather than assumed from
// the output.
//
// Receiver attribution is required because engine internals also call `.sort()`:
// `compileWhere` sorts a small operator list on every commit, so a raw
// `not.toHaveBeenCalled()` would be tripped by that and not the data sort.
// `commit()` always builds its result as `[...this.data]` and stores it as
// `dataview`, so the array returned by `view()` is exactly the receiver an ORDER
// BY data sort acts on — that receiver is the discriminator used below.
describe('query no-op sort elimination (defect 24948077)', () => {
  const rows = [
    { name: 'B', value: 18 },
    { name: 'A', value: 8 },
    { name: 'C', value: 100 },
  ];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not sort the result for a queryless DataView', () => {
    const sortSpy = vi.spyOn(Array.prototype, 'sort');
    const dv = new DataView(rows);
    const result = dv.view();
    expect(sortSpy.mock.contexts.filter((c) => c === result)).toHaveLength(0);
  });

  it('does not sort the result when order_by is absent but a where is present', () => {
    const sortSpy = vi.spyOn(Array.prototype, 'sort');
    const dv = new DataView(rows, { where: { value: { _gt: 0 } } });
    const result = dv.view();
    expect(sortSpy.mock.contexts.filter((c) => c === result)).toHaveLength(0);
  });

  it('does not sort the result when order_by is an empty array', () => {
    const sortSpy = vi.spyOn(Array.prototype, 'sort');
    const dv = new DataView(rows, { order_by: [] });
    const result = dv.view();
    expect(sortSpy.mock.contexts.filter((c) => c === result)).toHaveLength(0);
  });

  it('installs no comparator for absent, empty-array, or empty-object order_by', () => {
    // `{}` is asserted structurally, not via the spy: `parseOrderBy` itself calls
    // `.sort()` on the (empty) key list for the object form, so a spy on
    // `Array.prototype.sort` cannot cleanly attribute that call. The engine-level
    // comparator is what must be absent, and it is — for all three empty shapes.
    // The object form is not in the typed API (`order_by` is `OrderByExpression[]`),
    // so it can only arrive from untyped JSON; model that path via JSON.parse.
    const objectForm: QueryExpression = JSON.parse('{"order_by":{}}');
    expect(new DataView(rows).query.order_by).toBeUndefined();
    expect(new DataView(rows, { order_by: [] }).query.order_by).toBeUndefined();
    expect(new DataView(rows, objectForm).query.order_by).toBeUndefined();
  });

  it('sorts the result exactly once, with the query comparator, when an ordering is requested', () => {
    const sortSpy = vi.spyOn(Array.prototype, 'sort');
    const dv = new DataView(rows, { order_by: [{ value: 'asc' }] });
    const result = dv.view();
    const dataSortCalls = sortSpy.mock.calls.filter(
      (_args, i) => sortSpy.mock.contexts[i] === result
    );
    // Exactly one data sort happened, and it used the query's own comparator —
    // proving both that a real ordering still sorts and that this spy isolates it.
    expect(dataSortCalls).toHaveLength(1);
    expect(dataSortCalls[0][0]).toBe(dv.query.order_by);
  });

  it('still sorts correctly for a multi-key ordering', () => {
    const dv = new DataView(
      [
        { a: 2, b: 1 },
        { a: 1, b: 2 },
        { a: 1, b: 1 },
        { a: 2, b: 2 },
      ],
      { order_by: [{ a: 'asc' }, { b: 'desc' }] }
    );
    expect(dv.view()).toEqual([
      { a: 1, b: 2 },
      { a: 1, b: 1 },
      { a: 2, b: 2 },
      { a: 2, b: 1 },
    ]);
  });

  it('applies order_by before distinct_on (first row in sorted order wins)', () => {
    const dv = new DataView(
      [
        { k: 'x', v: 2 },
        { k: 'y', v: 9 },
        { k: 'x', v: 1 },
        { k: 'y', v: 4 },
      ],
      { order_by: [{ v: 'asc' }], distinct_on: ['k'] }
    );
    // sorted by v asc -> x/1, x/2, y/4, y/9; first per k -> x/1, y/4
    expect(dv.view()).toEqual([
      { k: 'x', v: 1 },
      { k: 'y', v: 4 },
    ]);
  });

  it('applies order_by before limit (first N in sorted order)', () => {
    const dv = new DataView(
      [{ v: 3 }, { v: 1 }, { v: 4 }, { v: 2 }],
      { order_by: [{ v: 'asc' }], limit: 2 }
    );
    expect(dv.view()).toEqual([{ v: 1 }, { v: 2 }]);
  });
});
