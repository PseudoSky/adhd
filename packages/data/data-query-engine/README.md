# @adhd/data-query-engine

[![npm version](https://img.shields.io/npm/v/@adhd/data-query-engine.svg)](https://www.npmjs.com/package/@adhd/data-query-engine)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Build Status](https://img.shields.io/github/actions/workflow/status/nix/adhd-data-query-engine/ci.yml?branch=main)](https://github.com/nix/adhd-data-query-engine/actions)

Advanced, efficient, and chainable data data-query-engineing utilities for TypeScript/JavaScript. Supports deep property access, filtering, sorting, and expression evaluation with dot notation and composable APIs.

---

## Why Use `@adhd/data-query-engine`?

- **Chainable**: Query API for arrays and objects
- **Dot Notation**: Deep property access (e.g. `user.profile.age`)
- **Powerful**: Filtering, sorting, limiting, distinct, and computed fields
- **Efficient**: Optimized for large in-memory datasets
- **Type-Safe**: TypeScript types for safety and autocompletion
- **Extensible**: Compose with your own logic and operators

---

## Installation

```bash
npm install @adhd/data-query-engine
# or
pnpm add @adhd/data-query-engine
```

---

## Function Outline

### Query API

Every `QueryExpression` slot has a fluent builder (each returns `this`):

| Function (params)                     | Slot                            |
| ------------------------------------- | ------------------------------- |
| `.from(source: string)`               | `source` (input binding)        |
| `.as(name: string)`                   | `name` (output identity)        |
| `.aggregate(expr)`                    | `aggregate` (leaf value)        |
| `.where(predicate)`                   | `where` (pre + post-group)      |
| `.qualify(predicate)`                 | `qualify` (post-window)         |
| `.groupBy(items)`                     | `group_by`                      |
| `.keep({ n, other: true })`           | `keep` (top-N + `_other`)       |
| `.select(items)`                      | `select`                        |
| `.orderBy(sort)`                      | `order_by`                      |
| `.distinctOn(fields)`                 | `distinct_on`                   |
| `.offset(n)` / `.limit(n)`            | `offset` / `limit`              |
| `.rollup(...dims)` / `.cube(...dims)` | grouping sets (as `select` relations) |
| `.view()` / `.toJson()`               | run / serialise                 |

`rollup('region','product')` and `cube('region','product')` build a parent query
with no `group_by` whose `select` lists one relation per grouping set (the
aggregates are the query's existing `groupBy(...)` items, or a `_count` default):

```ts
new DataView(rows)
  .groupBy([{ name: 'amount', aggregate: { _sum: 'amount' } }])
  .cube('region', 'product')
  .view();
// → [{ region_product: [...], region: [{east,3},{west,4}], product: [{x,5},{y,2}], total: [{7}] }]
```

### Operators

| Operator                                     | Description                   |
| -------------------------------------------- | ----------------------------- |
| `_eq`, `_ne`, `_neq`                         | Equal, not equal              |
| `_gt`, `_lt`, `_gte`, `_lte`                 | Greater/less than (and equal) |
| `_in`, `_nin`                                | In/not in array               |
| `_like`, `_nlike`, `_ilike`, `_nilike`       | String pattern matching       |
| `_similar`, `_nsimilar`                      | Similarity matching           |
| `_regex`, `_iregex`, `_nregex`, `_niregex`   | Regex matching                |
| `_contains`, `_contained_in`                 | Array/object containment      |
| `_has_key`, `_has_keys_any`, `_has_keys_all` | Object key existence          |
| `_is_null`                                   | Null checks                   |

### Logical Operators

| Operator | Description                 |
| -------- | --------------------------- |
| `_and`   | All conditions must be true |
| `_or`    | Any condition must be true  |
| `_not`   | Negate a condition          |

---

## Query Language Mechanics

The data-query-engine language is inspired by GraphQL/Hasura and supports expressive, composable queries for filtering, sorting, and selecting data. Queries are defined as plain JavaScript objects using a set of operators and logical expressions.

**Structure:**

- `where`: Defines filters using field names and operators
- `order_by`: Specifies sorting order for fields
- `limit`/`offset`: Controls pagination
- `distinct_on`: Removes duplicates based on fields

**Operators:** See table above for supported operators.

**Logical Expressions:** Combine filters using `_and`, `_or`, `_not`.

**Dot Notation:** Query deeply nested properties using dot notation, e.g. `{ where: { 'profile.score': { _gt: 80 } } }`

**Execution:**

- Where clauses are compiled once into predicate functions (not re-parsed per row)
- Sorting is applied using parsed order expressions
- Distinct, offset, and limit are applied in sequence
- The result is a filtered, sorted, and paginated view of the data

---

## Example Usage

```ts
import { DataView } from '@adhd/data-query-engine';
import data from './test-data.json';

// DataView accepts an optional generic type parameter
const dv = new DataView(data);

// With types: DataView<MyRow> gives typed .view() returns
interface MyRow {
  name: string;
  value: number;
}
const typed = new DataView<MyRow>(data);

// 1. Basic Filtering
dv.where({ age: 30 }).view();

// 2. Deep Property Filtering
dv.where({ 'profile.status': 'active' }).view();

// 3. Sorting
dv.orderBy([{ 'profile.score': 'desc' }]).view();

// 4. Limiting Results
dv.limit(5).view();

// 5. Chaining Multiple Operations
dv.where({ 'user.active': true })
  .orderBy([{ 'profile.score': 'desc' }])
  .limit(10)
  .view();

// 6. Expression-Based Filtering
dv.where((row) => row.profile.score > 80).view();

// 7. Distinct On
dv.distinctOn(['user.id']).view();

// 8. Offset and Pagination
dv.offset(10).limit(10).view();

// 9. Regex Matching
dv.where({ email: { _iregex: '@example\\.com$' } }).view();

// 10. Negated Regex
dv.where({ name: { _nregex: '^test' } }).view();
```

---

## API Reference

- `DataView`: Chainable data-query-engine wrapper for arrays/objects
- `QueryExpression`: Query object structure
- `Operators`: Expression helpers (`_eq`, `_gt`, `_lt`, `_in`, etc.)
- `Dot Notation`: Deep property access (`get(obj, 'a.b.c')`)
- `Expression Engine`: Evaluate computed fields and filters

---

## File Structure

- `src/lib/data-query-engine.ts` – Query engine and DataView
- `src/lib/expressions.ts` – Query/Boolean/OrderBy expression types
- `src/lib/parser.ts` – Query parser and logical resolution
- `src/lib/operators.ts` – Operator definitions
- `src/lib/filters.ts` – Operator implementations

---

## Query Language Mechanics

The data-query-engine language is inspired by GraphQL/Hasura and supports expressive, composable queries for filtering, sorting, and selecting data. Queries are defined as plain JavaScript objects using a set of operators and logical expressions.

### Structure

- **Where Clause**: Defines filters using field names and operators.
- **Order By**: Specifies sorting order for fields.
- **Limit/Offset**: Controls pagination.
- **Distinct On**: Removes duplicates based on fields.

### Operators

Supported operators for filtering fields:

- `_eq`, `_ne`, `_neq`: Equal, not equal
- `_gt`, `_lt`, `_gte`, `_lte`: Greater/less than (and equal)
- `_in`, `_nin`: In/not in array
- `_like`, `_nlike`, `_ilike`, `_nilike`: String pattern matching (case-sensitive/insensitive)
- `_similar`, `_nsimilar`: Similarity matching
- `_regex`, `_iregex`, `_nregex`, `_niregex`: Regex matching
- `_contains`, `_contained_in`: Array/object containment
- `_has_key`, `_has_keys_any`, `_has_keys_all`: Object key existence
- `_is_null`: Null checks

### Logical Expressions

Combine filters using logical operators:

- `_and`: All conditions must be true
- `_or`: Any condition must be true
- `_not`: Negate a condition

---

## The query grammar

`DataView` is ONE class with ONE grammar (`QueryExpression`) — the self-similar,
position-typed model. There is no second syntax and no alias layer:

- `group_by` and `select` hold queries; a leaf is a query carrying an `aggregate`
  (a fold or arithmetic expression).
- `where` carries BOTH the pre-group and post-group predicate in one tree, split
  by the **phase rule** (a leaf's phase is decided by reference); `qualify` is the
  post-scan filter; `keep` folds a top-N tail into one `_other` row.
- A running / sliding aggregate is `_scan` on a fold — a **fold-mode**, not a
  phase and not a query-level key. `_scan: { order_by, frame?, partition_by? }`
  where `frame` is `'running'` (default), a sliding size `n`, or `{ where }` (the
  frame is the partition rows matching the predicate). It broadcasts one value
  per row.
- `_filter` scopes a fold's input (orthogonal to `_scan`).

Every classic operation is expressed directly in this grammar:

| want | write |
| ---- | ----- |
| HAVING | a post-group leaf in `where`, e.g. `{ where: { total: { _gt: 0 } } }` |
| time-scoped aggregate | `_filter` on the fold, e.g. `{ _sum: 'cost', _filter: { t: { _period: 'P1D' } } }` |
| running / sliding aggregate | `_scan` on a fold, e.g. `{ _sum: 'cost', _scan: { order_by: 't', frame: 'running' } }` |
| broadcast (`SUM(x) OVER (PARTITION BY g)`) | a `_scan` fold in `select` + `qualify` |
| top-N | `order_by` + `limit`; with an `_other` tail, `keep: { n, other: true }` |
| hierarchical grouping | a nested `select` (a query nested under its `name`) |
| time bucket | `group_by: [{ _bucket: { field: 't', unit: 'hour' } }]` |

A grouping-set family (`_rollup`/`_cube`) is expressed as `select` relations — see
`DataView.rollup(...)`/`cube(...)`.

### `canonical.ts` — plan identity

| Export                     | Meaning                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `canonicalizePredicate(p)` | Structural string of a predicate: object keys sorted; `_and`/`_or` sorted; `_in`/`_nin` sorted+deduped.                             |
| `planKey(q)`               | Full query key (includes `name`/`source`). Stable across object-key and commutative-array order.                                   |
| `computeKey(q)`            | `planKey` with `name` normalized away — the CSE identity (`execute` never reads a node's `name`).                                   |

Order-SENSITIVE slots are **not** reordered: `order_by`, `distinct_on`, `select`, and the arithmetic operand arrays (`_add`/`_sub`/`_mul`/`_div`/`_coalesce`/`_round`) keep their order — evaluation depends on it (float summation order).

### `plan.ts` — access-path selection

- `AccessPath = { kind: 'scan' } | { kind: 'index', ids }`.
- `computeAccessPath(pre, index)` — `index` when `index.candidates(pre)` narrows, else `scan`.
- `planQuery(query, { indexFor, defaultSource })` — walks the self-similar tree (root + `select`-nested + `_in`/`_nin` subqueries), splits each `where` with the **phase rule**, and derives the access path from the **PRE (raw-row) predicate only** — a post-group output name can never select an index. Returns a `PhysicalPlan` (`root` + a `computeKey`→node map = the CSE lookup).

### `execute.ts` — `executePlanned`

`executePlanned(plan, rows, ctx?, indexFor?, source?)` installs the plan + index lookup on the eval context, applies the root access path (index candidate-narrowing — the exact predicate is still re-checked, so an index can only speed things up), and delegates to the unchanged reference executor. CSE scopes: `_in` subquery operands are memoized globally by `computeKey`; `select`-nested evaluations are memoized **per parent call** (cross-group sharing is unsound and intentionally omitted).

### `DataView` index configuration

```ts
const dv = new DataView(
  [{ name: 'sales', data: rows }],
  { indexes: { sales: [{ field: 'region', kind: 'eq' }, { field: 'amount', kind: 'range' }] } }
);
dv.query({ source: 'sales', where: { region: { _eq: 'west' }, amount: { _gte: 100 } } });
```

Equality (`PostingIndex`), range (B+ tree), and low-cardinality (`RoaringBitmap`) indexes are maintained across `insert`/`append`/`remove`; the planner picks among them and falls back to a scan for any non-indexable disjunct.

**Notes.** `group_by` output key order is unspecified — canonicalization treats `group_by` items as an order-independent set, so two queries differing only in item order share one incremental cache. A range index over a field that has held a non-finite number (NaN/±Infinity) or a non-number falls back to a scan, so the index can never change a result. `_scan` is O(partition) for the monoid folds (`_sum`/`_count`/`_avg`/`_ratio_of_sums` via prefix sums, `_min`/`_max` via a monotonic deque; running and sliding). The holistic folds (`_distinct_count`/`_quantile`) have no fast path and fall back to a per-row frame fold — documented, not silent. A predicate frame is position-independent (one filtered set per partition).


Example:

```js
{
  where: {
    _and: [{ age: { _gte: 18 } }, { status: { _eq: 'active' } }, { _or: [{ country: { _eq: 'US' } }, { country: { _eq: 'CA' } }] }];
  }
}
```

### Dot Notation

You can data-query-engine deeply nested properties using dot notation:

```js
{ where: { 'profile.score': { _gt: 80 } } }
```

### Execution

Queries are parsed and executed by the `DataView` class:

- Where clauses are compiled once into predicate functions (not re-parsed per row)
- Sorting is applied using parsed order expressions
- Distinct, offset, and limit are applied in sequence
- The result is a filtered, sorted, and paginated view of the data

---

## Testing

```bash
pnpm test
# or
nx test data-query-engine
```

---

## Extending

- Add new operators in `filters.ts` and `operators.ts`
- Compose with your own logic for advanced queries

---

## Contributing

Contributions are welcome! Please read the [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

---

## License

[MIT](LICENSE)

---

For more information, see the [API docs](./docs) or visit the [GitHub repository](https://github.com/nix/adhd-data-query-engine).
