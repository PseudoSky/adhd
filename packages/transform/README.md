# @adhd/transform

[![npm version](https://img.shields.io/npm/v/@adhd/transform.svg)](https://www.npmjs.com/package/@adhd/transform)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Build Status](https://img.shields.io/github/actions/workflow/status/PseudoSky/adhd/ci.yml?branch=main)](https://github.com/PseudoSky/adhd/actions)

**155 shipped functions across 10 modules — in one `Transform` import.** The utility library that ships the deep-diff engine, path enumerator, auto-key-deriving Counter, range-to-regex, stats suite, and event-driven data structures that lodash, es-toolkit, and remeda never included.

---

## Why @adhd/transform?

You use lodash (or es-toolkit, or remeda) for `pick`, `omit`, and `isEqual`. But `isEqual` only tells you *if* two objects differ — not *what* changed. Same story for path enumeration, auto-key-deriving counters, numeric range to regex conversion, stats normalization, or event-driven data structures. You either write them from scratch or import 5+ separate libraries.

**@adhd/transform is the only TypeScript utility library that ships a built-in deep-diff engine, path enumeration, Counter with automatic key extraction, range-to-regex conversion, a stats suite, and 155 functions across 10 modules — in one typed import.**

---

## Installation

```bash
npm install @adhd/transform
# or
pnpm add @adhd/transform
```

---

## Quickstart

The `Transform` merged export gives you every function in a single namespace:

```ts
import { Transform } from '@adhd/transform';

// Deep diff two objects — only changed keys returned
Transform.Differ.map(
  { name: 'Alice', meta: { score: 10 }, tags: ['a', 'b'] },
  { name: 'Alice', meta: { score: 12 }, tags: ['b', 'c'] }
);
// => { meta: { score: 12 }, tags: { added: ['c'], deleted: ['a'] } }

// Enumerate all paths to primitive values
Transform.allPaths({ user: { name: 'Alice', scores: [95, 87] } });
// => [['user', 'name'], ['user', 'scores']]

// Compose functions into a pipeline
Transform.flowPipe(
  (a: number, b: number) => a + b,
  (sum: number) => sum * 2
)(3, 4); // => 14

// Track event counts with automatic key extraction
const counter = new Transform.Counter<{ type: string }>(e => e.type);
counter.increment({ type: 'click' }, 5);
counter.increment({ type: 'click' }, 3);
counter.toJson(); // => { click: 8 }
```

Prefer importing individual modules? Use `import { Collections, Filters, Structures } from '@adhd/transform'`.

---

## The six things no other library ships

### 1. `Differ.map` — deep-diff engine that tells you WHAT changed

Every utility library has boolean `isEqual`. None return a structured diff. `Differ.map` walks nested objects recursively and returns **only the changed keys** — or an empty object if they're identical. Array tracking shows `added`/`deleted`. Status constants let you classify changes.

```ts
import { Transform } from '@adhd/transform';

// Structured diff — only the keys that changed
Transform.Differ.map(
  { name: 'Alice', meta: { score: 10 }, tags: ['a', 'b'] },
  { name: 'Alice', meta: { score: 12 }, tags: ['b', 'c'] }
);
// => { meta: { score: 12 }, tags: { added: ['c'], deleted: ['a'] } }

// Identical objects return empty object
Transform.Differ.map({ a: 1 }, { a: 1 }); // => {}

// Status constants for classifying changes
Transform.Differ.VALUE_CREATED;    // 'created'
Transform.Differ.VALUE_UPDATED;    // 'updated'
Transform.Differ.VALUE_DELETED;    // 'deleted'
Transform.Differ.VALUE_UNCHANGED;  // 'unchanged'

// Lower-level building blocks
Transform.Differ.compareValues(5, 7);                         // 'updated'
Transform.Differ.getArrayDiffData([1, 2], [2, 3]);           // { added: [3], deleted: [1] }
```

### 2. `allPaths` — enumerate every value path in a nested object

Need to build a form that edits a nested config? Discover every field? Generate a JSON schema? Every other library makes you write BFS from scratch. `allPaths` does it in one call — with a customizable matcher for controlling where traversal stops.

```ts
// Built-in path enumerator
Transform.allPaths({
  server: { port: 3000, host: 'localhost' },
  debug: true
});
// => [['debug'], ['server', 'port'], ['server', 'host']]

// Custom matcher: stop at any array (don't recurse into it)
Transform.allPaths(
  { nested: { arr: [1, 2, 3] }, value: 5 },
  (key, path, obj) => Array.isArray(obj[key])
);
// => [['nested', 'arr']]
```

### 3. `Counter` with key extraction — auto-deriving counters

Counting events by type usually means writing a reduce. Every time. `Counter<T>` accepts an optional `countBy` extractor function — it auto-derives string keys from your typed data. `toJson()` dumps the counts.

```ts
import { Transform } from '@adhd/transform';

// Counter with automatic key derivation
const counter = new Transform.Counter<{ type: string }>(e => e.type);
counter.increment({ type: 'click' }, 5);
counter.increment({ type: 'scroll' }, 3);
counter.increment({ type: 'click' }, 3);
counter.toJson(); // => { click: 8, scroll: 3 }

// Query individual values
counter.value({ type: 'click' }); // => 8

// Without key extractor — single 'total' key
const total = new Transform.Counter<string>();
total.increment('anything', 5);
total.increment('anything', 3);
total.toJson(); // => { total: 8 }
```

### 4. `rangeToRegex` — numeric range to regex

Your form needs to validate "enter a number between 100 and 200." You hand-write a regex by breaking the range into character classes — or you let `rangeToRegex` generate it algorithmically. Handles unbounded ranges, negative numbers, and zero-padding.

```ts
// Generate regex from numeric range
Transform.rangeToRegex(100, 200);
// => /^(10[0-9]|1[1-9][0-9]|200)$/

Transform.rangeToRegex(-50, 50);
// => /^(-[1-9]|-?[1-4][0-9]|-?50|[0-9])$/

// Unbounded: match any positive number
Transform.rangeToRegex(0, null);
// => /^([0-9]+)$/

// Unbounded negative to positive
Transform.rangeToRegex(null, null);
// => /^(-?[0-9]+)$/
```

### 5. Stats suite — normalize, histogram, mostCommon, minMax

Dashboards, heatmaps, analytics — you need normalization, frequency counts, and range detection. Every other utility library makes you import `simple-statistics` or write it yourself. @adhd/transform bundles it all in one module.

```ts
// Normalize values to a target range
Transform.normalize([10, 50, 100], { min: 0, max: 1 });
// => [0, 0.44, 1]

// Frequency histogram
Transform.histogram(['a', 'b', 'a', 'c', 'b', 'a']);
// => Map { 'a' => 3, 'b' => 2, 'c' => 1 }

// Most frequent value
Transform.mostCommon(['a', 'b', 'a', 'c', 'b', 'a']);
// => 'a'

// One-pass min/max
Transform.minMax([10, 3, 47, 22]);
// => { min: 3, max: 47 }

// Reusable normalizer (pre-computes input range)
const gradeNormalizer = Transform.makeListNormalizer([10, 50, 100], 0, 100);
gradeNormalizer(50); // => 44.44
```

### 6. Event-driven Stack and Queue — live callbacks built in

You want to log pushes, emit metrics on pops, or trigger processing on dequeue. Without @adhd/transform, you wrap every call site or pull in RxJS. Stack and Queue accept optional event callbacks that fire automatically on mutations.

```ts
import { Transform } from '@adhd/transform';

// Stack with event callbacks
const stack = new Transform.Stack<number>({
  onPush: (v) => console.log('Pushed:', v),
  onPop: (v) => console.log('Popped:', v),
});
stack.push(1); // Logs: Pushed: 1
stack.push(2); // Logs: Pushed: 2
stack.pop();   // Logs: Popped: 2, returns 2
stack.peek();  // => 1

// Queue with initial data and callbacks
const queue = new Transform.Queue<string>(['a', 'b'], {
  onEnqueue: (v) => console.log('Enqueued:', v),
  onDequeue: (v) => console.log('Dequeued:', v),
});
queue.enqueue('c');  // fires onEnqueue('c')
queue.dequeue();     // => 'a', fires onDequeue('a')
```

---

## And everything else you'd expect

All in one `Transform` import — plus individual module imports when you only need a subset:

```ts
import { Transform } from '@adhd/transform';

// Collections: pick, omit, keyBy, uniqueBy, sortBy, flattenDeep, difference, range...
Transform.difference([[1, 2, 3], [2, 3, 4]]); // => [1]

// Filters: 33 type checks + comparisons
Transform.isDefined(maybeNull);          // type guard: excludes null | undefined
Transform.isMatch(obj, { status: 'active', role: 'admin' }); // deep partial match

// Functions: compose, flow, flowPipe, splitPipe, get/set by path
Transform.flowPipe(
  (a: number, b: number) => a + b,
  (sum: number) => sum * 2
)(3, 4); // => 14  — argument-spread-aware piping

Transform.get({ user: { address: { city: 'NYC' } } }, 'user.address.city', 'Unknown');
// => 'NYC'

// Texts: capitalize, hyphenCase, words (Unicode-aware), percent
Transform.hyphenCase('Hello World'); // => 'Hello-World'
Transform.percent(42.5);             // => '+42.50%'

// Humanize (direct import — not on Transform)
import { Humanize } from '@adhd/transform';
Humanize(1536); // => '1.5 KiB'

// Format dates
Transform.formatDate(new Date(2025, 0, 15), 'MMMM dd, yyyy'); // => 'January 15, 2025'
Transform.formatDate(new Date(2025, 0, 15, 15, 45), 'hh:mm a'); // => '03:45 PM'

// Duration between dates
Transform.humanDuration(new Date('2025-01-10'), new Date('2025-01-15'));
// => { count: 5, unit: 'days', text: '5 days from now' }

// Regex escaping
Transform.escapePattern('([a-z]+)'); // => '\(\[a\-z\]\+\)'

// Objects: deepCopy, deepEquals, objectDifference, groupBy, allPaths, toFlagMap
Transform.objectDifference(
  { name: 'Alice', age: 30, city: 'NYC' },
  { name: 'Alice', age: 31, city: 'NYC' }
);
// => { age: 30 }  — only keys where values differ (from first object)

Transform.toFlagMap(['a', 'b', 'c']);
// => { a: true, b: true, c: true }
```

**155 shipped functions. 10 modules. One import.** Collections, Filters, Functions (composition + diff), Objects (paths + deep copy), Stats (normalization + histograms), Texts, Humanize, Date, Regex, and Structures (Stack/Queue/Counter with event callbacks).

```bash
npm install @adhd/transform
```

---

## Key Features at a Glance

| If you need... | You'd normally... | With @adhd/transform |
|---------------|-------------------|---------------------|
| Deep diff (what changed) | Import `deep-diff` or write recursive comparator | `Transform.Differ.map(a, b)` — only changed keys |
| Path enumeration | Write recursive BFS from scratch | `Transform.allPaths(obj)` — every primitive-holding path |
| Counter with key extraction | Manual reduce or Map wrapper every time | `new Transform.Counter<T>(extractor)` → `counter.toJson()` |
| Numeric range → regex | Hand-write regex for each range | `Transform.rangeToRegex(100, 200)` — algorithmically generated |
| Stats normalization + histogram | Import `simple-statistics` | `Transform.normalize(data, 0, 100)` + `histogram` + `mostCommon` |
| Event-driven Stack/Queue | Wrap every call site or import RxJS | `new Transform.Stack<T>({ onPush, onPop })` — callbacks built in |
| Fan-out composition | Multiple `.map()` calls | `Transform.splitPipe(fn1, fn2)([input])` → `[result1, result2]` |
| Spread-aware piping | Manual destructuring between steps | `Transform.flowPipe(fn1, fn2)(a, b)` — auto-spreads |
| Object diff (structured) | Write recursive key-by-key comparison | `Transform.objectDifference(a, b)` — returns `Partial<T>` |
| Byte formatting | Import `filesize` or `pretty-bytes` | `Humanize(1536)` → `'1.5 KiB'` |
| Date formatting + durations | Import `date-fns` or `moment` | `Transform.formatDate(d, 'MMMM dd, yyyy')` |
| Deep partial match | Write custom filter logic | `Transform.isMatch(obj, { status: 'active' })` |

---

## Module Map

| Module | Purpose | Standout functions | Reference |
|--------|---------|--------------------|-----------|
| **Collections** | Array ops, deep matching | `difference`, `flattenDeep`, `keyBy`, `isMatch`, `uniqueBy`, `range` | [reference](./docs/reference/collections.md) |
| **Filters** | Type checks, comparisons | `isArray`, `isDefined`, `isEqual`, `isIn`, `isLike`, `isShallowEqual` | [reference](./docs/reference/filters.md) |
| **Functions** | Composition, path ops, diff | `compose`, `flow`, `flowPipe`, `splitPipe`, `get`/`set`, `Differ` | [reference](./docs/reference/functions.md) |
| **Objects** | Deep copy, diff, paths | `deepCopy`, `deepEquals`, `allPaths`, `omit`/`pick`, `groupBy` | [reference](./docs/reference/objects.md) |
| **Stats** | Math, normalization, histograms | `normalize`, `minMax`, `histogram`, `mostCommon`, `Counter` (Map) | [reference](./docs/reference/stats.md) |
| **Texts** | String manipulation | `capitalize`, `hyphenCase`, `words`, `percent` | [reference](./docs/reference/texts.md) |
| **Humanize** | Human-readable formatting | `Humanize(bytes)` → `'1.5 KiB'` (direct function, not on Transform) | [reference](./docs/reference/humanize.md) |
| **Date** | Date formatting & durations | `formatDate`, `humanDuration`, `timeFromNow`, `fromNow` | [reference](./docs/reference/date.md) |
| **Regex** | Regex construction utils | `escapePattern`, `mergePatterns`, `rangeToRegex` | [reference](./docs/reference/regex.md) |
| **Structures** | Data structures | `Stack<T>`, `Queue<T>`, `Counter<T>` | [reference](./docs/reference/structures.md) |

Every public function is documented exhaustively in the [API reference](./docs/reference/). The README shows the highlights — the reference has every signature, parameter, return type, and runnable example.

### How-To Guides

Cross-module task guides for common workflows:

- [Build Data Pipelines](./docs/how-to/build-data-pipelines.md) — `compose`, `flow`, `flowPipe`, `splitPipe`, `extractThen`
- [Diff and Compare Objects](./docs/how-to/diff-and-compare.md) — `Differ.map`, `objectDifference`, `isEqual`, `isMatch`
- [Count and Aggregate Data](./docs/how-to/count-and-aggregate.md) — `Counter`, `histogram`, `mostCommon`, `normalize`

---

## Data Structures

```ts
import { Transform } from '@adhd/transform';

// Stack: LIFO with event callbacks
const stack = new Transform.Stack<number>({
  onPush: (v) => console.log('Pushed:', v),
  onPop: (v) => console.log('Popped:', v),
});
stack.push(1);
stack.push(2);
stack.pop();   // Logs: Popped: 2, returns 2
stack.peek();  // => 1

// Queue: FIFO with event callbacks
const queue = new Transform.Queue<string>(['a', 'b'], {
  onEnqueue: (v) => console.log('Enqueued:', v),
  onDequeue: (v) => console.log('Dequeued:', v),
});
queue.enqueue('c');
queue.dequeue(); // => 'a'
```

> **Two Counter classes**: `Transform.Counter` (standalone) has `increment`/`decrement`/`toJson` with optional `countBy` extractor. `Stats.Counter` extends Map with `add()`/`setData()` — useful when you need Map iteration. See [structures reference](./docs/reference/structures.md) and [stats reference](./docs/reference/stats.md).

---

## Testing

```bash
pnpm test
```

---

## Contributing

Contributions are welcome! Please see the monorepo contribution guidelines for details.

---

## License

[MIT](./LICENSE)

---

For the complete API reference, see [docs/reference/](./docs/reference/). For task-oriented guides, see [docs/how-to/](./docs/how-to/). For the monorepo, visit [PseudoSky/adhd](https://github.com/PseudoSky/adhd).
