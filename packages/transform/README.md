
# @adhd/transform

[![npm version](https://img.shields.io/npm/v/@adhd/transform.svg)](https://www.npmjs.com/package/@adhd/transform)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Build Status](https://img.shields.io/github/actions/workflow/status/nix/adhd-transform/ci.yml?branch=main)](https://github.com/nix/adhd-transform/actions)

A comprehensive TypeScript utility library for transforming, filtering, analyzing, and manipulating data structures. Designed for use in data pipelines, analytics, and application logic.

---

## Why Use `@adhd/transform`?

- **Modular**: Includes collections, filters, functions, objects, stats, and text utilities.
- **Type-Safe**: Built with TypeScript for reliable development and autocompletion.
- **Expressive**: Provides high-level helpers for common data operations.
- **Efficient**: Uses optimized native methods and patterns.
- **Extensible**: Easily compose and extend with your own utilities.

---

## Installation

```bash
npm install @adhd/transform
# or
pnpm add @adhd/transform
```

---




## Function Outline

### Transform: Collections
| Function (params) | Description |
|-------------------|-------------|
| [difference(arrays: any[][])](#collections) | Elements in first array not in others |
| [intersection(arrays: any[][])](#collections) | Elements common to all arrays |
| [flattenDeep(arr: any[][])](#collections) | Deeply flattens nested arrays |
| [keyByArray(array: any[], key: string)](#collections) | Indexes array by a key |
| [keyBy(collection: Record<string, any> | [], key: string)](#collections) | Indexes array or object by a key |
| [omitBy(orig: ArrayOrObject, check: BooleanFilter)](#collections) | Omits entries where check returns true |
| [pickBy(orig: ArrayOrObject, check: BooleanFilter)](#collections) | Picks entries where check returns true |
| [pluck(arr: any[], key: string)](#collections) | Extracts values for a key from array |
| [minBy(collection: T[], selector: Selector<T>, compare?: ComparisonFunction<number>)](#collections) | Finds min by selector |
| [maxBy(collection: T[], selector: Selector<T>, compare?: ComparisonFunction<number>)](#collections) | Finds max by selector |
| [first(arr: any[])](#collections) | Returns first element |
| [last(arr: OneOfType<string, any[]>)](#collections) | Returns last element |
| [unique(arr: any[])](#collections) | Returns unique elements |
| [uniqueBy(arr: any[], props: string[])](#collections) | Unique by multiple properties |
| [indexBy(arr: any[], prop: string)](#collections) | Indexes array by property |
| [range(start: number, stop: number, step: number)](#collections) | Generates a range of numbers |

### Transform: Filters
| Function (params) | Description |
|-------------------|-------------|
| [isArray(x: unknown)](#filters) | Checks if value is array |
| [isString(x: unknown)](#filters) | Checks if value is string |
| [isDefined(x: unknown)](#filters) | Checks if value is not null/undefined |
| [isInt(x: unknown)](#filters) | Checks if value is integer |
| [isFloat(x: unknown)](#filters) | Checks if value is float |
| [isRegExp(x: unknown)](#filters) | Checks if value is RegExp |
| [isTrue(a: any)](#filters) | Checks if value is true |
| [isFalse(a: any)](#filters) | Checks if value is false |
| [isLessThan(a: number, b: number)](#filters) | Checks if a < b |
| [isGreaterThan(a: number, b: number)](#filters) | Checks if a > b |
| [isIn(a: any, b: OneOfType<string,any[]>)](#filters) | Checks if a in b |
| [isLike(a: string, b: string)](#filters) | Checks if a contains b |

### Transform: Objects
| Function (params) | Description |
|-------------------|-------------|
| [keys(obj: object)](#objects) | Returns object keys |
| [values(obj: object)](#objects) | Returns object values |
| [entries(obj: object)](#objects) | Returns object entries |
| [isEqual(a: unknown, b: any)](#objects) | Deep equality check |
| [stringify(obj: object)](#objects) | JSON stringify |
| [groupBy(arr: any[], props: string[])](#objects) | Groups array by properties |
| [deepCopy(object1: any)](#objects) | Deep copy object |

### Transform: Stats
| Function (params) | Description |
|-------------------|-------------|
| [range(list: number[])](#stats) | Min/max of list |
| [randomRange(a: number, b: number)](#stats) | Random float between a and b |
| [randomRangeInt(a: number, b: number)](#stats) | Random int between a and b |
| [roundToIncrement(x: number, increment: number)](#stats) | Rounds to increment |
| [getMin(a: number, b: number)](#stats) | Minimum of two numbers |
| [getMax(a: number, b: number)](#stats) | Maximum of two numbers |
| [histogram(iterable: any[])](#stats) | Histogram of values |

### Transform: Texts
| Function (params) | Description |
|-------------------|-------------|
| [capitalize(str: string)](#texts) | Capitalizes string |
| [trim(str: string, c?: string)](#texts) | Trims whitespace |
| [upperFirst(str: string)](#texts) | Uppercases first character |
| [lowerFirst(str: string)](#texts) | Lowercases first character |
| [trimStart(str: string, c?: string)](#texts) | Trims start |
| [trimEnd(str: string, c?: string)](#texts) | Trims end |
| [words(value: string)](#texts) | Splits into words |
| [hyphenCase(str: string)](#texts) | Converts to hyphen-case |
| [percent(n: number, precision?: number)](#texts) | Formats percent |

### Transform: Functions
| Function (params) | Description |
|-------------------|-------------|
| [compose(...funcs: Function[])](#functions) | Composes functions |
| [noop()](#functions) | No-op function |
| [extractThen(key: string, callback: Function)](#functions) | Extracts value and applies callback |
| [get(obj: object, path: string, defaultValue?: any)](#functions) | Gets value at path |
| [set(data: object, path: string, value: any)](#functions) | Sets value at path |
| [throttle(func: Function, timeFrame: number)](#functions) | Throttles function |



### Collections
```ts
import { Collections } from '@adhd/transform';

// difference: Elements in arr1 not in arr2
Collections.difference([[1, 2, 3], [2, 3, 4]]); // [1]

// intersection: Elements common to both arrays
Collections.intersection([[1, 2, 3], [2, 3, 4]]); // [2, 3]

// flattenDeep: Deeply flattens nested arrays
Collections.flattenDeep([[1, [2, [3]]], 4]); // [1, 2, 3, 4]

// keyByArray: Indexes array by a key
Collections.keyByArray([{ id: 1 }, { id: 2 }], 'id'); // { 1: { id: 1 }, 2: { id: 2 } }

// keyBy: Indexes array or object by a key
Collections.keyBy([{ id: 1 }, { id: 2 }], 'id'); // { 1: { id: 1 }, 2: { id: 2 } }

// omitBy: Omits entries where check returns true
Collections.omitBy({ a: 1, b: 2 }, v => v === 2); // { a: 1 }

// pickBy: Picks entries where check returns true
Collections.pickBy({ a: 1, b: 2 }, v => v === 2); // { b: 2 }

// pluck: Extracts values for a key from array
Collections.pluck([{ a: 1 }, { a: 2 }], 'a'); // [1, 2]

// minBy: Finds min by selector
Collections.minBy([{ x: 1 }, { x: 2 }], o => o.x); // { x: 1 }

// maxBy: Finds max by selector
Collections.maxBy([{ x: 1 }, { x: 2 }], o => o.x); // { x: 2 }

// first: Returns first element
Collections.first([1, 2, 3]); // 1

// last: Returns last element
Collections.last([1, 2, 3]); // 3

// unique: Returns unique elements
Collections.unique([1, 2, 2, 3]); // [1, 2, 3]

// uniqueBy: Unique by multiple properties
Collections.uniqueBy([{ a: 1, b: 2 }, { a: 1, b: 3 }], ['a']); // [{ a: 1, b: 2 }]

// indexBy: Indexes array by property
Collections.indexBy([{ id: 'a' }, { id: 'b' }], 'id'); // { a: { id: 'a' }, b: { id: 'b' } }

// range: Generates a range of numbers
Collections.range(1, 5, 1); // [1, 2, 3, 4, 5]
```

### Filters
```ts
import { Filters } from '@adhd/transform';

// isArray: Checks if value is array
Filters.isArray([1, 2, 3]); // true

// isString: Checks if value is string
Filters.isString('hello'); // true

// isDefined: Checks if value is not null/undefined
Filters.isDefined(undefined); // false

// isInt: Checks if value is integer
Filters.isInt(42); // true

// isFloat: Checks if value is float
Filters.isFloat(3.14); // true

// isRegExp: Checks if value is RegExp
Filters.isRegExp(/abc/); // true

// isTrue: Checks if value is true
Filters.isTrue(true); // true

// isFalse: Checks if value is false
Filters.isFalse(false); // true

// isLessThan: Checks if a < b
Filters.isLessThan(1, 2); // true

// isGreaterThan: Checks if a > b
Filters.isGreaterThan(2, 1); // true

// isIn: Checks if a in b
Filters.isIn(2, [1, 2, 3]); // true

// isLike: Checks if a contains b
Filters.isLike('hello world', 'world'); // true
```

### Objects
```ts
import { Objects } from '@adhd/transform';

// keys: Returns object keys
Objects.keys({ a: 1, b: 2 }); // ['a', 'b']

// values: Returns object values
Objects.values({ a: 1, b: 2 }); // [1, 2]

// entries: Returns object entries
Objects.entries({ a: 1, b: 2 }); // [['a', 1], ['b', 2]]

// isEqual: Deep equality check
Objects.isEqual({ x: 1 }, { x: 1 }); // true

// stringify: JSON stringify
Objects.stringify({ a: 1 }); // '{"a":1}'

// groupBy: Groups array by properties
Objects.groupBy([{ a: 1 }, { a: 2 }], ['a']); // { '1': [{ a: 1 }], '2': [{ a: 2 }] }

// deepCopy: Deep copy object
Objects.deepCopy({ a: 1 }); // { a: 1 }
```

### Stats
```ts
import { Stats } from '@adhd/transform';

// range: Min/max of list
Stats.range([1, 2, 3, 4, 5]); // { min: 1, max: 5 }

// randomRange: Random float between a and b
Stats.randomRange(10, 20); // e.g. 13.45

// randomRangeInt: Random int between a and b
Stats.randomRangeInt(1, 5); // e.g. 3

// roundToIncrement: Rounds to increment
Stats.roundToIncrement(7.3, 2); // 8

// getMin: Minimum of two numbers
Stats.getMin(3, 7); // 3

// getMax: Maximum of two numbers
Stats.getMax(3, 7); // 7

// histogram: Histogram of values
Stats.histogram([1, 2, 2, 3]); // { 1: 1, 2: 2, 3: 1 }
```

### Texts
```ts
import { Texts } from '@adhd/transform';

// capitalize: Capitalizes string
Texts.capitalize('hello world'); // 'Hello world'

// trim: Trims whitespace
Texts.trim('  hello  '); // 'hello'

// upperFirst: Uppercases first character
Texts.upperFirst('foo'); // 'Foo'

// lowerFirst: Lowercases first character
Texts.lowerFirst('Bar'); // 'bar'

// trimStart: Trims start
Texts.trimStart('  hello'); // 'hello'

// trimEnd: Trims end
Texts.trimEnd('hello  '); // 'hello'

// words: Splits into words
Texts.words('hello world'); // ['hello', 'world']

// hyphenCase: Converts to hyphen-case
Texts.hyphenCase('Hello World'); // 'hello-world'

// percent: Formats percent
Texts.percent(0.1234); // '12.34%'
```

### Functions
```ts
import { Functions } from '@adhd/transform';

// compose: Composes functions
const add = (a: number) => a + 1;
const double = (a: number) => a * 2;
const composed = Functions.compose(add, double);
composed(3); // add(double(3)) => add(6) => 7

// noop: No-op function
Functions.noop(); // null

// extractThen: Extracts value and applies callback
Functions.extractThen('id', (id: number) => id * 2)([{ id: 5 }]); // 10

// get: Gets value at path
Functions.get({ a: { b: 2 } }, 'a.b'); // 2

// set: Sets value at path
const obj = { a: { b: 2 } };
Functions.set(obj, 'a.b', 3); // obj.a.b === 3

// throttle: Throttles function
const throttled = Functions.throttle(() => console.log('hi'), 1000);
throttled();
```

---

## API Reference

- `Collections`: Array and object manipulation (difference, intersection, flatten, keyBy, omitBy, etc.)
- `Filters`: Type checks and comparison helpers (`isArray`, `isString`, `isDefined`, `isInt`, `isFloat`, `isRegExp`, `isTrue`, `isFalse`, `isLessThan`, `isGreaterThan`, `isIn`, `isLike`, etc.)
- `Objects`: Object utilities (`keys`, `values`, `entries`, `isEqual`, `stringify`, etc.)
- `Stats`: Math and statistics helpers (`range`, `randomRange`, `randomRangeInt`, `roundToIncrement`, `getMin`, `getMax`, etc.)
- `Texts`: String manipulation (`capitalize`, `trim`, `upperFirst`, `lowerFirst`, `trimStart`, `trimEnd`, etc.)
- `Functions`: Function composition and helpers (`compose`, `noop`, `extractThen`, etc.)

---

## File Structure

- `src/lib/collections.ts` – Array and object utilities
- `src/lib/filters.ts` – Type checks and comparisons
- `src/lib/function.ts` – Function helpers
- `src/lib/object.ts` – Object utilities
- `src/lib/stats.ts` – Math and statistics
- `src/lib/text.ts` – String utilities

---

## Testing

```bash
pnpm test
```

---

## Extending

- Add new utilities in the relevant module (collections, filters, etc.)
- Compose with existing helpers for advanced data transformations

---

## Contributing

Contributions are welcome! Please read the [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

---

## License

[MIT](LICENSE)

---

For more information, see the [API docs](./docs) or visit the [GitHub repository](https://github.com/nix/adhd-transform).
