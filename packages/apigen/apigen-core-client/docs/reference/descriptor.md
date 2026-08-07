# descriptor

The canonical neutral contract between extractors and plugins (SPEC §4). Every extractor emits `Operation` records; every plugin consumes them.

## Types

### `Operation`

One exported binding from a source file — the fundamental unit apigen transports.

```ts
interface Operation {
  id: string;             // globally-unique slug: e.g. 'myapp/api/getUser'
  host: string;           // owning language runtime: 'ts', 'py', 'rust', …
  namespace: Segment;     // from --namespace or tsconfig folder
  path: Segment[];        // hierarchical identity: [file, exportName, …]
  kind: OperationKind;    // 'action' | 'query' | 'constructor' | 'instance-method'
  async: boolean;         // true if returns Promise
  streaming: boolean;     // true if returns AsyncIterable/Generator/Stream (v2 SPEC §11)
  safe: boolean;          // idempotent hint (query→true, action→false; overridable via config)
  input: JSONSchema;      // params as JSON Schema 2020-12 (ctx excluded, envelope dissolved)
  output: JSONSchema;     // return type as JSON Schema 2020-12 (Promise<T> unwrapped)
  envelope: JSONSchema;   // middleware-contributed side-channel fields
  typeText: TypeText | null;  // optional same-host TypeScript sugar
}
```

**`id` determinism:** `id` is a pure function of `namespace/path`. Same source always yields the same `id`. Moving/renaming a file re-mints it — refactor-stability is an explicit non-goal. Never papered over with a source annotation (Tenet 1).

**`safe` defaults:** Derived from `kind` — `query` → `true`, `action` → `false`. Overridable at projection time via `--opt http.verb.<id>=GET` or `apigen.config`. Never from a source annotation (Tenet 1).

### `OperationKind`

```ts
type OperationKind = 'action' | 'query' | 'constructor' | 'instance-method';
```

- **`action`** — callable export (function, arrow/const fn, or static class method)
- **`query`** — serializable-data const (primitive or plain object/array). Served live: the descriptor carries the type (schema), never the value.
- **`constructor`** — class constructor (SPEC §10)
- **`instance-method`** — method on an exported class instance (SPEC §10)

A non-serializable, non-callable export is skipped with a warning.

### `Segment`

A casing-neutral name segment — identity carried by tokenized words.

```ts
interface Segment {
  raw: string;      // original spelling: 'humanizeBytes'
  words: string[];  // tokenized lower-case: ['humanize', 'bytes']
}
```

When a caller passes `namespace: 'myapp'` (a string) to `extract` or `extractClasses`, the extractor converts it to a `Segment` via `tokenize('myapp')` — producing `{ raw: 'myapp', words: ['myapp'] }`. The same string→Segment conversion applies to the `--namespace` CLI flag. This means `Operation.namespace` is always a `Segment` object, never a bare string.

Transports derive their own casing from `words` (kebab for HTTP/CLI, `_`-joined for MCP, Pascal for gRPC). Casing is per-plugin, never baked into the descriptor.

### `JSONSchema`

A JSON Schema 2020-12 document fragment. apigen's type IR **is** JSON Schema with `$defs`/`$ref` — no separate abstract type model (SPEC §4, §16).

```ts
type JSONSchema = Record<string, unknown> & {
  $defs?: Record<string, JSONSchema>;   // reusable definitions
  $ref?: string;                         // reference: '#/$defs/Name'
} & ApigenSchemaHints;
```

**Conventions baked into this IR:**
- **Big-int / decimal wire convention:** `{ type: 'string', format: 'int64' }` (serialization convention, not a schema gap).
- **`x-apigen-*` hints** — optional, extractor-derived advisory hints (see below). Never required for correctness, never from source annotations.

### `ApigenSchemaHints`

Advisory codegen hints — extractor-derived, never human-authored.

```ts
interface ApigenSchemaHints {
  'x-apigen-nominal'?: boolean;         // $def originated from branded type
  'x-apigen-enum-repr'?: 'enum' | 'union' | string;  // idiomatic enum representation
  fidelity?: 'full' | 'lossy';          // schema fidelity relative to source type
}
```

> **Note:** `x-apigen-nominal` is the *TypeScript interface property* in `ApigenSchemaHints`. The corresponding *serialized JSON key* in the emitted schema is `x-apigen-logical` (with value `'nominal'`), imported from `@adhd/apigen-base-logical`. Both refer to the same concept: marking a `$def` as originating from a branded/nominal type.

`fidelity: 'lossy'` means an unconstrained generic factored out — codegen may warn. Removing all `x-apigen-*` keys leaves a valid structural schema (`hints-advisory` invariant).

### `TypeText`

Language-tagged textual type rendering — same-host sugar.

```ts
interface TypeText {
  lang: string;    // 'ts', 'py', 'rust', …
  input: string;   // textual params type, e.g. '(id: string, name?: string)'
  output: string;  // textual return type (unwrapped), e.g. 'User'
}
```

`null` when no textual form is available. Non-host targets ignore it and use `input`/`output` JSON Schema instead.

## See Also

- [`extract`](./extract.md#extract) — produces `Operation[]` from TypeScript source
- [Plugin reference](./plugin.md) — `Descriptor`, `Call`, layer contract
