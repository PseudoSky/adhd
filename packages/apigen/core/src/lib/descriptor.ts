// The canonical descriptor (SPEC §4).
//
// This is THE neutral contract of apigen: every extractor (any host language)
// emits `Operation` records, and every plugin (mcp / http / grpc / cli / clients)
// consumes them. Nothing downstream sees source — only this descriptor. Keep it
// faithful to SPEC §4/§5; downstream correctness depends on it.
//
// Naming note: this file follows the existing apigen-core convention of plain
// PascalCase type names (no `I` prefix) — matching `GeneratedSchemas`,
// `ComposedSchemas`, `OutputPlugin`, etc. in ./types.ts.

/**
 * A JSON-Schema-2020-12 document fragment.
 *
 * The apigen type IR **is** JSON Schema 2020-12 with `$defs`/`$ref` — there is
 * no separate or abstract type model and no new IR (SPEC §4, §16). Named types,
 * discriminated unions / enum-with-data / `Result`/`Option` (`oneOf` + a `const`
 * tag + `$ref`), nominal/branded types (a named `$def`), and recursion (`$ref`)
 * are all represented here faithfully — exactly what `ts-json-schema-generator`
 * and `schemars` already emit.
 *
 * Conventions baked into this IR:
 * - **Big-int / decimal wire convention:** 64-bit integers and decimals exceed
 *   JSON's `f64`, so they are **string-encoded** as `{ type: 'string', format:
 *   'int64' }` (a serialization convention, not a schema-expressiveness gap).
 * - **Optional extractor-derived hints** live under `x-apigen-*` keys (see
 *   {@link ApigenSchemaHints}) and exist only so codegen can emit idiomatic
 *   (vs accurate-but-verbose) clients; they are never required for correctness
 *   and are never sourced from a source annotation (Tenet 1).
 *
 * Modeled as an open record because a JSON Schema is, structurally, an arbitrary
 * keyword object. This mirrors how `input`/`output` are already typed in
 * {@link GeneratedSchemas} / {@link ComposedSchemas} (`Record<string, unknown>`).
 */
export type JSONSchema = Record<string, unknown> & {
  /** Reusable type definitions referenced via `$ref` (`#/$defs/Name`). */
  $defs?: Record<string, JSONSchema>
  /** Reference to a definition, e.g. `#/$defs/User` (enables recursion). */
  $ref?: string
} & ApigenSchemaHints

/**
 * Optional, **extractor-derived** codegen hints carried inline on a
 * {@link JSONSchema} (SPEC §4). These are advisory: a plugin MAY use them to
 * emit idiomatic clients (e.g. a real enum, a branded type) and a codegen MAY
 * warn on an unresolved generic — but correctness never depends on them, and
 * they are never required. They are computed by the extractor, never written by
 * a human in source (Tenet 1).
 */
export interface ApigenSchemaHints {
  /**
   * Marks a `$def` that originated from a nominal / branded type. Validation
   * deliberately does NOT enforce nominality — on the wire a branded type *is*
   * its base type — but codegen can re-introduce the brand for ergonomics.
   */
  'x-apigen-nominal'?: boolean
  /**
   * How an enum-like type should be represented in idiomatic codegen, e.g. a
   * native enum vs a string-literal union. Advisory only.
   */
  'x-apigen-enum-repr'?: 'enum' | 'union' | string
  /**
   * Fidelity of this schema fragment relative to the source type:
   * - `'full'`   — the schema captures the source type without loss.
   * - `'lossy'`  — the source type could not be fully represented (the only
   *   true residual is generic *factoring*: an unconstrained generic operation
   *   isn't serializable, so it is out of scope by physics). Codegen MAY warn.
   *
   * Optional; absence means `'full'`.
   */
  fidelity?: 'full' | 'lossy'
}

/**
 * A casing-neutral name segment (SPEC §4/§5).
 *
 * Identity is carried by the tokenized `words`; the original `raw` spelling is
 * preserved so a same-host plugin can reproduce it, but every transport derives
 * its own casing from `words` via `@adhd/apigen-naming` (kebab for HTTP/CLI,
 * `_`-joined for MCP, Pascal for gRPC). Casing is therefore per-plugin, never
 * baked into the descriptor.
 */
export interface Segment {
  /** Original spelling as it appeared in source, e.g. `'humanizeBytes'`. */
  raw: string
  /** Tokenized, lower-cased words, e.g. `['humanize', 'bytes']`. */
  words: string[]
}

/**
 * Language-tagged textual rendering of a type — optional same-host *sugar*
 * (SPEC §4). For a TypeScript host this is the literal TS source of the type;
 * non-host targets ignore it and rely on {@link JSONSchema} (`input`/`output`)
 * instead. `null` when no textual form is available/relevant.
 */
export interface TypeText {
  /** Language tag for `input`/`output` text, e.g. `'ts'`. */
  lang: string
  /** Textual rendering of the input/params type. */
  input: string
  /** Textual rendering of the output/return type (unwrapped). */
  output: string
}

/**
 * Classification of an exported binding (SPEC §4).
 *
 * - `'action'`          — a callable export (function declaration, or an
 *   arrow/const function). Served by invoking it.
 * - `'query'`           — a **serializable-data** const (primitive or plain
 *   serializable object/array — no functions / non-serializable values). Served
 *   **live**: the descriptor carries the const's *type* (schema), not its value,
 *   so env-/compute-dependent consts are never stale-at-extract.
 * - `'constructor'`     — a class constructor (class export; see SPEC §10).
 * - `'instance-method'` — a method on an exported class instance (SPEC §10).
 *
 * A non-serializable, non-callable export is **skipped + warned**, never
 * emitted as an operation.
 */
export type OperationKind =
  | 'action'
  | 'query'
  | 'constructor'
  | 'instance-method'

/**
 * The canonical operation descriptor — the neutral contract every extractor
 * emits and every plugin consumes (SPEC §4).
 *
 * One `Operation` corresponds to one selected export (an `action`, a live
 * `query`, or a class member per §10). The descriptor is host-agnostic: a
 * TypeScript extractor, a Python extractor, and a Rust extractor all emit the
 * same shape, and a single plugin can project a merged set of `Operation`s into
 * any transport.
 *
 * @remarks
 * The type IR for `input`/`output`/`envelope` is JSON Schema 2020-12 with
 * `$defs`/`$ref` (see {@link JSONSchema}) — there is no separate IR.
 */
export interface Operation {
  /**
   * The canonical fully-qualified slug and cross-plugin reference key, derived
   * purely from `namespace`/`path`, e.g. `'transform/humanize/humanize-bytes'`.
   * Globally unique within a merged descriptor and never re-cased.
   *
   * **Deterministic, NOT refactor-stable.** Because `id` is a pure function of
   * `namespace`/`path`, the same source always yields the same `id` — but moving
   * or renaming a file/export re-mints it (and thus breaks any pinned
   * `--exclude` id or generated client that referenced the old slug). This is
   * accepted and documented; refactor-stability is an explicit **non-goal**. It
   * is deliberately **not** papered over with a source `@id` annotation, which
   * Tenet 1 forbids.
   */
  id: string

  /**
   * The owning language runtime / host for this operation, e.g. `'ts'`,
   * `'py'`, `'rust'`. Identifies which host's extractor produced it and which
   * host can serve it same-process. Polyglot descriptors mix hosts.
   */
  host: string

  /**
   * The package segment — sourced from `--namespace` or the tsconfig folder
   * (SPEC §4/§5). Casing-neutral; transports derive their own casing from
   * {@link Segment.words}.
   */
  namespace: Segment

  /**
   * The hierarchical identity path: file → export… (SPEC §4/§5). For example a
   * named export is `[file, name]`; a single default function is `[file]`; a
   * default *object* is `[file, 'default', ...keys]` recursing into nested
   * props. `index.*` drops its file segment. Each element is casing-neutral.
   */
  path: Segment[]

  /** Classification of the underlying export — see {@link OperationKind}. */
  kind: OperationKind

  /** True if the export is async (returns a `Promise`). */
  async: boolean

  /**
   * True if the export returns an `AsyncIterable` / `Generator` / `Stream`
   * (streaming is implemented in v2, SPEC §11). The `output` schema describes
   * the per-chunk element type with streaming unwrapped.
   */
  streaming: boolean

  /**
   * Idempotent / no-side-effects hint (SPEC §4/§5).
   *
   * **Defaults from `kind`** (`query` → `true`, `action` → `false`) and is
   * **overridable at projection time via config** (`--opt http.verb.<id>=GET`
   * or `apigen.config`), never via a source annotation (Tenet 1). Drives the
   * HTTP verb + cacheability (safe → GET, unsafe → POST) and gRPC
   * idempotency-level (SPEC §5), decoupling the wire method from `kind`.
   */
  safe: boolean

  /**
   * The params object as JSON Schema 2020-12 (see {@link JSONSchema}).
   *
   * This is the operation's input type directly: the `ctx` first param is
   * excluded (by name match only, per the `ctx-name-only` invariant) and the
   * middleware `data`-wrapper is **dissolved** — `input` is the bare domain
   * params object, not the composed envelope. The request-side envelope lives
   * separately in `envelope`.
   */
  input: JSONSchema

  /**
   * The return type as JSON Schema 2020-12 (see {@link JSONSchema}), with
   * `Promise<T>` and stream wrappers **unwrapped to `T`**. For a streaming
   * operation this is the per-chunk element type.
   */
  output: JSONSchema

  /**
   * The effective request-side envelope as JSON Schema 2020-12 — the
   * middleware-contributed side-channel for this operation (e.g. a `session`
   * field), merged across the active middleware with overrides applied. Empty
   * (no envelope fields) when no middleware contributes to this operation.
   */
  envelope: JSONSchema

  /**
   * Optional language-tagged textual type rendering (same-host sugar). `null`
   * when unavailable; non-host targets ignore it. See {@link TypeText}.
   */
  typeText: TypeText | null
}
