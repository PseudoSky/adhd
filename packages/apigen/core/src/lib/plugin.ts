// v2 Plugin interface (SPEC §7) — transport-neutral, polyglot, capability-based.
//
// Every output plugin implements `Plugin<Opts>`.  A plugin declares a set of
// orthogonal **capabilities** (`target`, `layer`, `mount`, `envelope`) and the
// runtime fans those capabilities out across the harness at compose time.
//
// Design goals:
//   1. A plugin implements only the capabilities it needs — all four are optional.
//   2. The v1 `OutputPlugin` contract (generate/run on `PluginInput`) lives on in
//      `TargetCapability` so existing v1 plugins migrate with minimal changes.
//   3. All types are parameterised; consumers can narrow `opts` at their boundary
//      without casting to `unknown`.
//
// Relationship to SPEC §7.1 verbatim types:
//   - `Call`, `Next`, `Result`, `Chunk`   → see §7.1 / §11 layer stream contract
//   - `Transport`                          → the four canonical carriers
//   - `Extensions`                         → type-keyed request-extensions map
//   - `Server`                             → opaque server handle returned by `serve()`
//   - `Harness`                            → runtime harness injected to `serve()`
//   - `Descriptor`                         → the merged canonical descriptor (§4)
//   - `File`                               → `{ path, content }` emitted by `generate()`
//
// NOTE: `Operation`, `JSONSchema`, and `Segment` are imported from `./descriptor`
// so this file has zero schema-model duplication. `Operation` is the shape every
// extractor emits and every plugin consumes.

import type { Operation, JSONSchema } from './descriptor'

// ---------------------------------------------------------------------------
// §7 — canonical transport identifiers (SPEC §5/§7)
// ---------------------------------------------------------------------------

/**
 * The four canonical transport carriers apigen knows about (SPEC §5/§7/§9.1).
 *
 * A `MountedOperation` may opt in to a subset — `transports` omitted → all.
 */
export type Transport = 'http' | 'grpc' | 'mcp' | 'cli'

// ---------------------------------------------------------------------------
// §7 — typed request-extensions map (SPEC §8 / §8.1)
// ---------------------------------------------------------------------------

/**
 * A type-keyed, mutable-during-compose map threaded through every Layer and
 * into the dispatch function as `ctx` (SPEC §8.1).
 *
 * Layers insert typed values with a class or symbol key and downstream layers /
 * the function implementation read them back — the same mental model as
 * `http::Extensions` (Rust) and `AsyncLocalStorage` (Node).
 *
 * @example
 * ```ts
 * // insert (in a Layer):
 * call.ctx.set(Logger, new Logger({ level: 'info' }))
 * // read (in a Layer or dispatch):
 * const log = call.ctx.get(Logger)
 * ```
 */
export interface Extensions {
  /**
   * Retrieve the value stored under the given class constructor or symbol key.
   * Returns `undefined` when the key has not been set.
   */
  get<T>(key: abstract new (...args: never[]) => T): T | undefined
  /**
   * Store a value under the given class constructor or symbol key.
   * Overwrites any existing value for that key.
   */
  set<T>(key: abstract new (...args: never[]) => T, value: T): void
}

// ---------------------------------------------------------------------------
// §7 — call / result / chunk / next (layer contract, SPEC §7.1 / §8 / §11)
// ---------------------------------------------------------------------------

/**
 * The inbound call descriptor passed to every layer and ultimately to dispatch
 * (SPEC §7.1 / §8.1).
 *
 * `data` contains the bare domain params (envelope dissolved); `envelope`
 * contains transport-native side-channel fields (session, auth tokens, …).
 * `raw` is an escape hatch for transport-specific adapters that need access to
 * the native request object — ordinary plugins should never need it.
 */
export interface Call {
  /** The operation being invoked (from the merged canonical descriptor). */
  operation: Operation
  /** Bare domain params (the `data`-wrapper is dissolved; ctx excluded). */
  data: Record<string, unknown>
  /**
   * Side-channel metadata from the transport-native carrier, keyed as
   * `x-<pluginId>-<field>` (SPEC §9 / §9.1).
   */
  envelope: Record<string, unknown>
  /**
   * Typed request-extensions map — threaded `mw → mw → fn` (SPEC §8.1).
   * Layers insert context values; downstream layers and the domain function
   * read them back.
   */
  ctx: Extensions
  /** Which transport delivered this call. */
  transport: Transport
  /**
   * Cancellation signal — wired to the transport's native cancellation
   * mechanism (HTTP abort, gRPC cancel, MCP cancel, Ctrl-C for CLI).
   * Layers must propagate it to any async work they initiate (SPEC §11).
   */
  signal: AbortSignal
  /**
   * Transport-native request object — escape hatch for adapters that need
   * raw access to e.g. a Fastify `Request` or an MCP `CallToolRequest`.
   * Ordinary plugins must NOT depend on this; it degrades portability.
   */
  raw?: unknown
}

/**
 * A single chunk emitted by a streaming operation (SPEC §11).
 *
 * The type is intentionally open (`unknown`) because the per-chunk element
 * type is described by `operation.output` (JSON Schema) — static typing is
 * achieved per-plugin via generics when the element type is known.
 */
export type Chunk = unknown

/**
 * The non-streaming result of a Layer invocation — the value that flows
 * back out to the transport adapter.
 */
export type Result = unknown

/**
 * The continuation function passed to a Layer.
 *
 * Calling `next()` invokes the **remaining** layers and ultimately `dispatch`.
 * A Layer may call it at most once per request.  Not calling it short-circuits
 * all downstream layers and dispatch (SPEC §8.1 rule 1).
 *
 * The return type is a union to support both unary and streaming operations
 * from a single `LayerCapability.layer` signature (SPEC §11).
 */
export type Next = () => Promise<Result> | AsyncIterable<Chunk>

// ---------------------------------------------------------------------------
// §7 — emitted file (generate output unit)
// ---------------------------------------------------------------------------

/**
 * A single emitted file produced by {@link TargetCapability.generate}.
 *
 * `content` is always a UTF-8 string — plugins emit source code, config,
 * or structured text in any language (TS, Python, proto, YAML, …).
 * Nothing in core restricts the language (SPEC [inv:language-agnostic-output]).
 */
export interface File {
  /** Relative or absolute path where the file should be written. */
  path: string
  /** UTF-8 string content to write. */
  content: string
}

// ---------------------------------------------------------------------------
// §7 — server / harness (run-time side)
// ---------------------------------------------------------------------------

/**
 * Opaque handle returned by {@link TargetCapability.serve}.
 *
 * The minimal contract is `close()` for graceful shutdown.  Plugins may
 * extend this with transport-specific members (e.g. `port`, `url`).
 */
export interface Server {
  /** Gracefully shut down the server and release all resources. */
  close(): Promise<void>
}

/**
 * The runtime harness injected into {@link TargetCapability.serve}.
 *
 * Provides `invoke` — the composed Layer stack that wraps `dispatch`.
 * Transports call `harness.invoke(op, partialCall)` once per inbound request;
 * the harness threads the active plugins' layers around the operation and
 * returns/streams the result (SPEC §8).
 */
export interface Harness {
  /**
   * Invoke the full composed-Layer stack for `op` with the given call context.
   * Partial — the harness fills in `operation`, `ctx`, and wires `signal`.
   *
   * Returns a `Promise<Result>` for unary operations or an
   * `AsyncIterable<Chunk>` for streaming operations (SPEC §11).
   */
  invoke(
    op: Operation,
    call: Omit<Call, 'operation' | 'ctx'>,
  ): Promise<Result> | AsyncIterable<Chunk>
}

// ---------------------------------------------------------------------------
// §7 — the canonical descriptor (SPEC §4 / §7)
// ---------------------------------------------------------------------------

/**
 * The merged canonical descriptor: the full set of `Operation`s produced by
 * merging one or more per-language extractors (SPEC §4).
 *
 * Plugins receive a `Descriptor` at generate/serve time; they **must not**
 * modify it — it is the single source of truth.
 */
export interface Descriptor {
  /** All extracted operations, across all host languages, in insertion order. */
  operations: Operation[]
  /**
   * The host tag of the primary language runtime, e.g. `'ts'`, `'py'`.
   * Plugins may use this to restrict generated code to the primary host.
   */
  host: string
  /**
   * Optional namespace segment from `--namespace` or the tsconfig root folder.
   * Typically the npm package name or a short domain slug.
   */
  namespace?: string
}

// ---------------------------------------------------------------------------
// §7.1 — the four capability interfaces
// ---------------------------------------------------------------------------

/**
 * **`target`** capability — project the descriptor to a transport or format
 * (SPEC §7.1).
 *
 * A `TargetCapability` is selected by `--type <name>` at CLI time.  It
 * optionally both *generates* (emits static files) and *serves* (runs a live
 * server hosting the domain functions in-process).
 *
 * @typeParam Opts - Plugin-specific options, validated via `optionsSchema`.
 *
 * @remarks
 * **v1 compatibility:** The v1 `OutputPlugin` interface (`generate(PluginInput)`)
 * is the direct precursor.  v2 `TargetCapability.generate` receives a
 * `Descriptor` instead of `PluginInput` — the richer, host-agnostic contract.
 * v1 plugins migrate by wrapping their `PluginInput` construction in the new
 * `generate` signature.  `serve()` is the new addition for live server targets.
 */
export interface TargetCapability<Opts = Record<string, unknown>> {
  /**
   * Short identifier for this target — the value the user passes to `--type`.
   * Examples: `'mcp'`, `'http-fastify'`, `'http-express'`, `'cli'`, `'proto'`.
   */
  name: string

  /**
   * Project the descriptor to a set of static files (generate mode).
   *
   * Called once per `apigen generate` invocation with the full merged
   * descriptor and the resolved plugin options.  The returned `File[]` is
   * written to the output directory by the CLI.
   *
   * @param descriptor - The merged canonical descriptor (read-only).
   * @param opts       - Plugin-specific options (already validated).
   * @returns           Array of files to emit (may be empty; never `null`).
   */
  generate(descriptor: Descriptor, opts: Opts): File[] | Promise<File[]>

  /**
   * Start a live server hosting the domain functions in-process (run mode).
   *
   * Called once per `apigen run` invocation.  The transport adapter wires the
   * harness's `invoke()` to the native request/response cycle.
   *
   * Optional — omit for codegen-only plugins (clients, proto, docs).
   *
   * @param descriptor - The merged canonical descriptor (read-only).
   * @param harness    - The composed Layer stack; call `harness.invoke()` per request.
   * @param opts       - Plugin-specific options (already validated).
   * @returns           A {@link Server} handle; the CLI calls `server.close()` on SIGINT/SIGTERM.
   */
  serve?(descriptor: Descriptor, harness: Harness, opts: Opts): Promise<Server>
}

/**
 * **`layer`** capability — wrap operations (the onion) (SPEC §7.1 / §8 / §8.1).
 *
 * A `LayerCapability` is loaded via `--use <plugin>` and is composed by the
 * harness around the `dispatch` call.  Hook sugar (`onRequest`/`onResponse`/
 * `onError`) compiles to a `LayerCapability` — one execution model (SPEC §7.1).
 *
 * @remarks
 * **Streaming:** `layer` may return an `AsyncIterable<Chunk>` — making it an
 * `async function*` that wraps `next()` with `for await … yield` — to
 * participate in the full per-chunk stream lifecycle (SPEC §11).
 */
export interface LayerCapability {
  /**
   * Extra envelope fields this layer needs on the request side — merged into
   * the effective descriptor's envelope schema before serving begins.
   *
   * Keys are bare field names; values are JSON Schema fragments.
   * Example: `{ session: { type: 'string', description: 'session token' } }`.
   */
  envelopeFields?: Record<string, JSONSchema>

  /**
   * The layer function — owns the continuation.
   *
   * Call `next()` to invoke the remaining layers and `dispatch`.  Not calling
   * `next()` short-circuits all downstream layers (SPEC §8.1 rule 1).
   *
   * For streaming operations, return an `AsyncIterable<Chunk>` wrapping the
   * iterable returned by `next()` (SPEC §11).
   *
   * @param call - The inbound call descriptor.
   * @param next - The continuation — call at most once.
   * @returns     `Promise<Result>` for unary operations; `AsyncIterable<Chunk>`
   *              for streaming operations.
   */
  layer(call: Call, next: Next): Promise<Result> | AsyncIterable<Chunk>
}

/**
 * **`mount`** capability — add synthetic operations to the descriptor
 * (SPEC §7.1 / §7.2b / §7.2c).
 *
 * A `MountCapability` is loaded via `--use <plugin>` and contributes extra
 * `Operation`-like entries (with an in-process `handler`) that flow through the
 * harness and Layer stack exactly like extracted operations.  Typical uses:
 * `/meta/openapi`, `/meta/health`, version endpoints.
 */
export interface MountCapability {
  /**
   * Return the set of synthetic operations this plugin contributes.
   *
   * `MountedOperation` extends `Operation` with an in-process `handler` and
   * an optional `transports` filter (default: all transports).
   *
   * @param descriptor - The current merged descriptor (read-only).
   * @param opts       - Plugin-specific options.
   * @returns           Array of `MountedOperation`s; may be empty.
   */
  operations(
    descriptor: Descriptor,
    opts?: Record<string, unknown>,
  ): MountedOperation[]
}

/**
 * A synthetic operation contributed by a {@link MountCapability}.
 *
 * Extends the base {@link Operation} with:
 * - `transports` — optional filter to restrict which transports expose this
 *   operation (default: all four, matching the host plugin's transport set).
 * - `handler`    — the in-process function called when a request arrives.
 *   Called with the same {@link Call} context as extracted operations; the
 *   returned value is marshalled by the transport adapter.
 */
export type MountedOperation = Operation & {
  /**
   * Optional transport filter.  When omitted the operation is exposed on all
   * transports supported by the active target plugin.
   */
  transports?: Transport[]

  /**
   * The in-process handler for this synthetic operation.
   *
   * Called with the full {@link Call} context (same as extracted operations)
   * after the composed Layer stack has run.  The return value is serialised by
   * the transport adapter and may be a `Promise` or an `AsyncIterable` for
   * streaming mounts.
   */
  handler(call: Call): unknown | Promise<unknown> | AsyncIterable<Chunk>
}

/**
 * **`envelope`** capability — declare request/response side-channel fields
 * (SPEC §7.1 / §9 / §9.1).
 *
 * A plugin with an `envelope` capability advertises the transport-agnostic
 * side-channel fields it reads from (request) or writes to (response) without
 * wrapping the operation in a Layer.  The harness merges these schemas into the
 * effective descriptor's envelope before serving.
 *
 * Canonical field identity is `(pluginId, field)` (SPEC §9.1); fields declared
 * here are surfaced by each transport adapter per the binding table:
 * - HTTP/gRPC/MCP: `x-<pluginId>-<field>` header/metadata/`_meta` key
 * - CLI: `--<pluginId>-<field>` flag + `APIGEN_<PLUGINID>_<FIELD>` env var
 */
export interface EnvelopeCapability {
  /**
   * JSON Schema fragments for fields this plugin reads from the incoming
   * transport-native metadata (HTTP headers, gRPC metadata, MCP `_meta`,
   * CLI flags/env).
   *
   * Keys are bare field names (e.g. `'session'`); the adapter prepends
   * `x-<pluginId>-` when surfacing on k/v carriers.
   */
  request?: Record<string, JSONSchema>

  /**
   * JSON Schema fragments for fields this plugin writes to the outgoing
   * transport-native metadata (response headers, trailers, `_meta`, stderr).
   *
   * Keys follow the same `x-<pluginId>-<field>` convention as `request`.
   */
  response?: Record<string, JSONSchema>
}

// ---------------------------------------------------------------------------
// §7.1 — the top-level Plugin interface (assembled from capabilities)
// ---------------------------------------------------------------------------

/**
 * The v2 plugin interface (SPEC §7.1).
 *
 * Every apigen plugin is an object that satisfies this interface.  A plugin
 * declares one or more **capabilities** — the harness fans them out at compose
 * time.  All four capability slots are optional; a minimal "noop" plugin omits
 * all of them (useful as a template).
 *
 * @typeParam Opts - Plugin-specific CLI options, validated against
 *   `capabilities.target.optionsSchema` (if present) before being passed to
 *   `generate` / `serve` / `mount.operations`.
 *
 * @example Logger layer (SPEC §7.2a)
 * ```ts
 * export default {
 *   id: 'logger',
 *   capabilities: {
 *     layer: {
 *       layer: async (call, next) => {
 *         const t = Date.now()
 *         console.error(`→ ${call.operation.id}`)
 *         try { const r = await next(); console.error(`← ${call.operation.id} ${Date.now()-t}ms`); return r }
 *         catch (e) { console.error(`✗ ${call.operation.id}`); throw e }
 *       },
 *     },
 *   },
 * } satisfies Plugin
 * ```
 *
 * @example OpenAPI mount (SPEC §7.2b)
 * ```ts
 * import { toOpenApi } from '@adhd/apigen-openapi'
 * export default {
 *   id: 'openapi',
 *   capabilities: {
 *     mount: {
 *       operations: (d) => [{
 *         ...syntheticOp('_meta/openapi', d),
 *         handler: () => toOpenApi(d),
 *       }],
 *     },
 *   },
 * } satisfies Plugin
 * ```
 */
export interface Plugin<Opts = Record<string, unknown>> {
  /**
   * Canonical fully-qualified plugin identifier (SPEC §7.1).
   *
   * Use the package name (e.g. `'@adhd/apigen-ts-plugin-logger'`) or a short
   * slug (e.g. `'logger'`).  The CLI accepts either as the `--use` / `--type`
   * argument.  The id is also used as the `pluginId` in envelope field naming
   * (`x-<id>-<field>`, SPEC §9.1).
   */
  id: string

  /**
   * Optional human-readable description shown in `apigen plugins list` output
   * and generated documentation.
   */
  description?: string

  /**
   * Optional JSON Schema for plugin-specific options.
   *
   * When provided, the CLI validates the `--opt` values supplied via
   * `--use <plugin> --opt key=value` before constructing `opts`.
   */
  optionsSchema?: Record<string, unknown>

  /**
   * The set of capabilities this plugin contributes.  All four are optional.
   *
   * At least one capability is expected in practice; the harness warns
   * (at debug level) when a loaded plugin declares no capabilities.
   */
  capabilities: {
    /**
     * Target capability — project the descriptor to a transport/format and/or
     * host domain functions in-process (SPEC §7.1 / §5).
     *
     * Selected by `--type <plugin>`.
     */
    target?: TargetCapability<Opts>

    /**
     * Layer capability — wrap all operations in the onion (SPEC §7.1 / §8).
     *
     * Loaded by `--use <plugin>` when the plugin declares this capability.
     */
    layer?: LayerCapability

    /**
     * Mount capability — add synthetic operations to the descriptor
     * (SPEC §7.1).  Typical uses: `/meta/openapi`, `/meta/health`.
     *
     * Loaded by `--use <plugin>`.
     */
    mount?: MountCapability

    /**
     * Envelope capability — declare request/response side-channel fields
     * (SPEC §7.1 / §9.1).  Loaded by `--use <plugin>`.
     *
     * A plugin may combine `envelope` with `layer` to both *declare* the
     * fields it needs and *read/write* them in its layer function.
     */
    envelope?: EnvelopeCapability
  }
}

// ---------------------------------------------------------------------------
// v1 backward-compatibility re-exports
// ---------------------------------------------------------------------------
//
// The v1 `OutputPlugin` / `PluginInput` / `PluginOutput` / `RunInput` types
// remain the primary interface for all existing v1 plugins.  They are defined
// in `./types.ts` and re-exported from the package root.  Nothing here
// modifies or overrides them — they coexist with the v2 `Plugin` interface.
//
// Migration path (v1 → v2):
//   1. Wrap your existing `generate(PluginInput)` in a `TargetCapability.generate`
//      that constructs a `PluginInput` from the incoming `Descriptor`.
//   2. Move the `id` and `description` fields from `OutputPlugin` to `Plugin`.
//   3. Set `capabilities.target = { name: '<your-type>', generate, serve? }`.
//   4. Export the object as `Plugin` (or `satisfies Plugin`).
//   The v1 types remain available for the duration of the migration window.
