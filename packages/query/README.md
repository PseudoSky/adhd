# @adhd/query

[![npm version](https://img.shields.io/npm/v/@adhd/query.svg)](https://www.npmjs.com/package/@adhd/query)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Build Status](https://img.shields.io/github/actions/workflow/status/nix/adhd-query/ci.yml?branch=main)](https://github.com/nix/adhd-query/actions)

Advanced, efficient, and chainable data querying utilities for TypeScript/JavaScript. Supports deep property access, filtering, sorting, and expression evaluation with dot notation and composable APIs.

---

## Why Use `@adhd/query`?

- **Chainable**: Query API for arrays and objects
- **Dot Notation**: Deep property access (e.g. `user.profile.age`)
- **Powerful**: Filtering, sorting, limiting, distinct, and computed fields
- **Efficient**: Optimized for large in-memory datasets
- **Type-Safe**: TypeScript types for safety and autocompletion
- **Extensible**: Compose with your own logic and operators

---

## Installation

```bash
npm install @adhd/query
# or
pnpm add @adhd/query
```

---

## Function Outline

### Query API

| Function (params)                   | Description                        |
| ----------------------------------- | ---------------------------------- |
| `.where(filter: QueryExpression)`   | Filter data by object or predicate |
| `.where(filter: function)`          | Filter data by custom function     |
| `.orderBy(sort: OrderByExpression)` | Sort by fields                     |
| `.limit(n: number)`                 | Limit results                      |
| `.offset(n: number)`                | Skip results                       |
| `.distinctOn(fields: string[])`     | Remove duplicates by fields        |
| `.select(fields: string[])`         | Select fields (TODO)               |
| `.view()`                           | Get the result                     |

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

The query language is inspired by GraphQL/Hasura and supports expressive, composable queries for filtering, sorting, and selecting data. Queries are defined as plain JavaScript objects using a set of operators and logical expressions.

**Structure:**

- `where`: Defines filters using field names and operators
- `order_by`: Specifies sorting order for fields
- `limit`/`offset`: Controls pagination
- `distinct_on`: Removes duplicates based on fields

**Operators:** See table above for supported operators.

**Logical Expressions:** Combine filters using `_and`, `_or`, `_not`.

**Dot Notation:** Query deeply nested properties using dot notation, e.g. `{ where: { 'profile.score': { _gt: 80 } } }`

**Execution:**

- Filters are converted to predicate functions
- Sorting is applied using parsed order expressions
- Distinct, offset, and limit are applied in sequence
- The result is a filtered, sorted, and paginated view of the data

---

## Example Usage

```js
import { DataView } from '@adhd/query';
import data from './test-data.json';

const dv = new DataView(data);

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
```

---

## API Reference

- `DataView`: Chainable query wrapper for arrays/objects
- `QueryExpression`: Query object structure
- `Operators`: Expression helpers (`_eq`, `_gt`, `_lt`, `_in`, etc.)
- `Dot Notation`: Deep property access (`get(obj, 'a.b.c')`)
- `Expression Engine`: Evaluate computed fields and filters

---

## File Structure

- `src/lib/query.ts` – Query engine and DataView
- `src/lib/expressions.ts` – Query/Boolean/OrderBy expression types
- `src/lib/parser.ts` – Query parser and logical resolution
- `src/lib/operators.ts` – Operator definitions
- `src/lib/filters.ts` – Operator implementations

---

## Query Language Mechanics

The query language is inspired by GraphQL/Hasura and supports expressive, composable queries for filtering, sorting, and selecting data. Queries are defined as plain JavaScript objects using a set of operators and logical expressions.

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

Example:

```js
{
  where: {
    _and: [{ age: { _gte: 18 } }, { status: { _eq: 'active' } }, { _or: [{ country: { _eq: 'US' } }, { country: { _eq: 'CA' } }] }];
  }
}
```

### Dot Notation

You can query deeply nested properties using dot notation:

```js
{ where: { 'profile.score': { _gt: 80 } } }
```

### Execution

Queries are parsed and executed by the `DataView` class:

- Filters are converted to predicate functions
- Sorting is applied using parsed order expressions
- Distinct, offset, and limit are applied in sequence
- The result is a filtered, sorted, and paginated view of the data

---

## Testing

```bash
pnpm test
# or
nx test query
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

For more information, see the [API docs](./docs) or visit the [GitHub repository](https://github.com/nix/adhd-query).
