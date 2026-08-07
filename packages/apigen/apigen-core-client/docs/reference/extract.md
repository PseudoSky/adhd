# extract

The v2 symbol-based extractor — walks a TypeScript source module via ts-morph and produces canonical `Operation[]` descriptors.

## Exports

### `extract(opts: ExtractOptions): Promise<Operation[]>`

Walks `opts.sourceFile` and emits canonical `Operation[]` descriptors — one per exported callable or serializable-data binding.

Handles all six export shapes:
1. **Named function** — `export function foo(…)`
2. **Named const/arrow** — `export const foo = (…) => …`
3. **Named-object** — `export const api = { foo, bar }`
4. **Default-export named fn** — `export default function foo(…)`
5. **Anonymous default** — `export default () => …` / `export default function(){}`
6. **CJS** — `module.exports = { foo, bar }`

Plus renamed exports: `export { localFn as exportedName }` — the operation is named by the exported alias, never the local name (closes F28/F29 bugs).

**Skipped exports:**
- `__samples__` (fixture convention)
- Symbols starting with `__` (internal)
- Non-serializable, non-callable consts (skipped with a warning)

**`ctx` exclusion:** A first parameter named `ctx` is excluded from the schema by name match only — no type inspection (`ctx-name-only` invariant). The `hasCtx` flag is not set by `extract` (it is set by `generateSchemas` and carried through `composeSchemas` for dispatch).

```ts
import { extract } from '@adhd/apigen-core-client';

const operations = await extract({
  sourceFile: '/absolute/path/to/api.ts',
  namespace: 'myapi',     // optional — from --namespace or tsconfig folder
  tsconfig: '/absolute/path/to/tsconfig.json',  // optional
  session: mySession,     // optional — share cache with other extraction calls
});
```

### `ExtractOptions`

```ts
interface ExtractOptions {
  sourceFile: string;       // absolute path to source (.ts, .tsx, .mts, .cts)
  namespace?: string;        // defaults to ''
  tsconfig?: string;         // absolute path to tsconfig.json for type resolution
  session?: ExtractionSession; // per-run shared cache (optional)
}
```

### `tokenize(raw: string): string[]`

Tokenises a camelCase / PascalCase / kebab-case / snake_case identifier into lower-cased words. Used to build casing-neutral `Segment` records.

```ts
import { tokenize } from '@adhd/apigen-core-client';

tokenize('humanizeBytes');  // => ['humanize', 'bytes']
tokenize('my-util');        // => ['my', 'util']
tokenize('SOME_CONST');     // => ['some', 'const']
tokenize('HTMLParser');     // => ['html', 'parser']
```

Deterministic: same input always yields the same output. Hyphens and underscores are treated as word boundaries; PascalCase / camelCase transitions split into separate words.

## Operation Shape

Each operation produced by `extract` conforms to the [`Operation`](./descriptor.md#operation) type. Key fields:

- `id` — globally-unique slug, e.g. `myapi/filename/getUser`. Derived deterministically from namespace + path.
- `host` — always `'ts'` for this extractor.
- `kind` — `'action'` for callables, `'query'` for serializable-data consts.
- `safe` — `true` for queries, `false` for actions (derived from `kind`, overridable via config).
- `input` / `output` — JSON Schema 2020-12.
- `typeText` — same-host TypeScript sugar (`{ lang: 'ts', input, output }`) or `null`.

## See Also

- [`generateSchemas`](./schemas.md#generateschemas) — v1 schema extraction with three export modes
- [`extractClasses`](./extract-classes.md#extractclasses) — class export extraction
- [How-To: Extraction Pipeline](../how-to/extraction-pipeline.md)
