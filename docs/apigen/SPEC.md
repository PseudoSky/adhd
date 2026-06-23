<!-- markdownlint-disable MD013 MD033 MD024 -->
# apigen — Canonical Spec (v2: code-first, polyglot, transport-neutral)

> **Status:** Finalized from the design Q&A (2026‑06‑22). Decisions are locked unless marked
> **[v2.1]** (roadmapped) or **[OPT]** (optional/optimization).
> **Supersedes** the v1 design in `docs/plan/apigen-client-generation/` (TS-only). v1 remains the
> working implementation and the first host; this is the target standard. See §15.

---

## 0. Tenet 0 — Code-first is the objective  *(the acceptance test for everything)*

> A developer writes ordinary, idiomatic functions in their host language, with normal types, and
> *nothing else*. The tool **extracts** a neutral operation descriptor from that source and
> **projects** it to every transport and target (MCP, HTTP, gRPC, CLI, clients, proto, docs — any
> language). **The source functions are the single source of truth.** No hand-authored IDL, no
> stub to implement, no annotation required for basic exposure. Everything downstream is derived.
> Any feature that forces the developer to stop writing plain functions and instead maintain a
> spec or wire generated stubs **violates the objective** and must be rejected or redesigned.

## Tenet 1 — Source is never modified; configuration is out-of-source  *(the corollary)*

> **The developer's source — functions and their types — is the only source of truth, and it is
> never modified, annotated, or decorated to drive generation.** This extends Tenet 0 from *basic
> exposure* to *everything*: there is **no required source annotation, ever** — not for exposure,
> not for exclusion, not for projection overrides. Every configuration has a **standardized
> out-of-source mechanism**, consumed at extract / generate / run time:
> - **Exposure / exclusion** → don't-`export`, or out-of-source `--include <glob>` / `--exclude <id>`
>   (§3). Source-level `_`-prefix / `@internal` may exist as a convenience but are never the *only* way.
> - **Projection overrides** (HTTP verb, route, name, casing, mount) → CLI flags / plugin `--opt` /
>   a project config file, owned by the projection/plugin layer (§5, §7) — never a source annotation.
> - **Descriptor metadata** (e.g. the optional `x-apigen-*` type hints, §4) is **extractor-derived**,
>   never hand-authored.
>
> Acceptance test: *if achieving a behavior requires editing the source for any reason other than
> changing what the functions actually do, the design is wrong — move it out-of-source.* This closes
> the "just one tasteful annotation" question permanently: the answer is always the out-of-source seam.

---

## 1. Architecture — one CLI front, three stages, a neutral seam

```
                         adhd-apigen   (ONE user-facing CLI / orchestrator)
                              │
  ┌──────── EXTRACT ─────────┼──────── PROJECT ───────────────────────────┐
  │  detect lang per file    │                                            │
  │  shell to per-lang        │   CANONICAL DESCRIPTOR (neutral JSON)      │
  │  EXTRACTOR (subprocess,   │   operations[] (each tagged host:"ts"|… )  │
  │  JSON out) → MERGE        │   + type IR (JSON Schema)                  │
  └──────────────────────────┤                                            │
                             ┌┴┐                                          │
                    generate │ │ run                                      │
                             ▼ ▼                                          │
            target/codegen plugins      HARNESS(es) per host:            │
            (mcp/http/cli/proto/         invoke = Layers → validate →     │
             openapi/jsonschema/docs/    dispatch  (+ gateway if mixed)   │
             clients)                                                     │
  ────────────────────────────────────────────────────────────────────────
```

- The **canonical descriptor** is the single neutral contract; extractors emit it, everything
  else consumes it.
- **Three stages**: **extract** (per-language extractors → merged descriptor) · **generate**
  (descriptor → artifacts) · **run** (descriptor + harness → live server).
- **Extract & generate unify trivially** across languages (protoc-plugin model: shell to
  `apigen-<lang>-extractor`, merge JSON; codegen is descriptor-driven). **Run** is the only stage
  with a topology choice (§13).

---

## 2. Hosts & polyglot scope  *(first-class polyglot server hosts)*

Non-TS languages are first-class **server hosts**, not just client targets. Neutral layers
(descriptor, type IR, naming rules, error taxonomy, plugin *contract*, wire protocols, codegen) are
shared; executable layers (extractor, runtime/harness, server plugins, dispatch) are per-language.
**Design rule:** specify every contract to satisfy **Rust** (strictest host) → it satisfies
TS/Python/Go/Java.

- **Dynamic hosts** (TS, Python) dispatch reflectively at runtime.
- **Static hosts** (Rust, Go, Java) dispatch via **codegen-woven glue** (deserialize → typed
  params → call → serialize). Both code-first — the tool generates the glue; the developer never
  writes it.

---

## 3. Selection — what becomes an operation

Every **export** is exposed. Opt-out ladder (most→least Tenet-0-pure):
1. **don't `export`** it (non-exports are private) — primary.
2. **`--exclude <id|glob…>` / `--include <glob>`** at run/generate (zero source change).
3. **`_`-prefixed** name, or standard **`@internal`** TSDoc — source-level.

Opt-out never violates Tenet 0: exposure is the zero-ceremony default; markers only *withhold*.

**Identity note:** `--exclude` accepts **either a derived `id` or a source-glob**. An `id` selector
re-mints under refactor (§4 — `id` is deterministic, not refactor-stable); a **glob or source-level
marker is refactor-stable**. Prefer a glob when you need a selector that survives file/export moves.

---

## 4. The canonical descriptor

```jsonc
Operation = {
  "id":        "transform/humanize/humanize-bytes",  // deterministic (derivation-stable), globally-unique slug
  "host":      "ts",                                  // owning language runtime
  "namespace": Segment,            // package (from --namespace / tsconfig folder)
  "path":      Segment[],          // file → export… (hierarchical identity)
  "kind":      "action" | "query" | "constructor" | "instance-method",
  "async":     boolean,
  "streaming": boolean,            // AsyncIterable/Generator/Stream return
  "safe":      boolean,            // idempotent/no-side-effects; default query=true,action=false; override via projection config (§5)
  "input":     JSONSchema,         // params object (ctx excluded); data-wrapper dissolved
  "output":    JSONSchema,         // Promise<T>/stream unwrapped → T
  "envelope":  JSONSchema,         // effective request side-channel (middleware-contributed)
  "typeText":  { "lang": "ts", "input": "...", "output": "..." } | null  // language-tagged, optional
}
Segment = { "raw": "humanizeBytes", "words": ["humanize","bytes"] }   // casing-neutral
```

- **`id`** = the canonical fully-qualified slug; the cross-plugin reference key; never re-cased.
  **Deterministic, not refactor-stable:** `id` is a pure function of `namespace/path`, so the same
  source always yields the same `id`, but moving/renaming a file or export re-mints it (and thus
  breaks any pinned `--exclude` id or client). This is accepted and documented — **not** papered over
  with a source `@id` annotation, which Tenet 1 forbids. Refactor-stability is a non-goal.
- **`kind`**: `action` = callable export (function decl or arrow/const fn); `query` = a
  **serializable-data** const (primitive or plain serializable object/array — no functions/
  non-serializable). `constructor`/`instance-method` → §10. Non-serializable, non-callable export
  → **skipped + warned**. A `query` is served **live** — the descriptor carries its *type* (schema),
  **not** its value; the running runtime reads the current binding at request time, so
  env-/compute-dependent consts are never stale-at-extract.
- **`safe`** = idempotent / no-side-effects hint; **defaults from `kind`** (`query`→true,
  `action`→false) and is **overridable at projection time via config**, never a source annotation
  (Tenet 1). Drives HTTP verb + cacheability and gRPC idempotency-level (§5) — decoupling the method
  from `kind`.
- **Type IR = JSON Schema 2020‑12 + `$defs`/`$ref`** (`input`/`output`/`envelope`) — this **is** the
  type IR; there is **no separate/abstract type model and no new IR**. Named types, discriminated
  unions / enum‑with‑data / `Result`/`Option` (`oneOf` + a `const` tag + `$ref` — exactly what
  `schemars` / `ts-json-schema-generator` already emit), nominal/branded types (a named `$def`;
  validation correctly does not enforce nominality because on the wire it *is* the base type), and
  recursion (`$ref`) are all represented **faithfully** — no accuracy gap. `input` is the params
  object directly; `ctx` first‑param excluded. **Wire convention:** 64‑bit ints / decimals are
  **string‑encoded** (`type:string, format:int64`), since they exceed JSON's `f64` (a serialization
  convention, not a schema‑expressiveness gap). The only true residual is **codegen ergonomics**
  (generic *factoring* — `Page<User>`/`Page<Order>` lower to two accurate concrete `$defs`; an
  unconstrained generic *operation* isn't serializable, so it's out of scope by physics).
  **Optional, extractor‑*derived*** `x-apigen-*` hints (`nominal`, `enum-repr`) + an **optional**
  `fidelity:"full"|"lossy"` flag exist *only* so codegen can emit idiomatic (vs accurate‑but‑verbose)
  clients and warn on the rare unresolved generic — never required for correctness, and never a
  source annotation. **`typeText`** is optional same‑host sugar (non‑host targets ignore it).
- **`async`** + **`streaming`** flags (streaming implemented in v2, §11).

---

## 5. Naming & per-transport projection

One canonical identity projects to each target's idiom; **casing is per-plugin** (helpers in
`@adhd/apigen-naming`: `toKebab/toPascal/toSnake/toCamel` + tokenizer).

`namespace=transform`, `path=[humanize, humanizeBytes]`, `kind=action`:

| Target | Projection | Result |
|---|---|---|
| HTTP | `/` + kebab segments; **verb from `safe`**: unsafe→POST, safe→GET (query-string params, cacheable) | `POST /transform/humanize/humanize-bytes` |
| MCP | flat name, segments joined with **`_`** | `transform_humanize_humanize_bytes` |
| gRPC | package=lower.dotted; service=Pascal(file); method=Pascal(export) | `transform.Humanize / HumanizeBytes` |
| CLI | nested kebab commands | `… transform humanize humanize-bytes` |

**Locked rules:**
- **Verb is a function of `safe`, not `kind`:** unsafe→POST, safe→GET; the default `safe` comes from
  `kind` (§4) and is overridable per-op via **projection config** (`--opt http.verb.<id>=GET` or
  `apigen.config`), never a source annotation (Tenet 1). gRPC consumes `safe` as idempotency-level.
- **File-name normalize:** strip extension; dots/underscores→hyphens (`file.name.ts`→`file-name`).
- **Default export:** single default fn → `path=[file]`; default **object** →
  `path=[file,"default",…keys]`, recursing nested props; named exports coexist at `[file,name]`.
- **Multi-file:** `--source` = file(s) or dir; dir globs `**/*.{ext}` excluding
  `*.spec.*`/`*.test.*`/`*.d.ts`; `index.*` drops its file segment.
- **Uniqueness invariant:** two distinct `id`s MUST project to **distinct** targets in *every*
  transport (no two ops may share an MCP flat name, HTTP route, gRPC method, or CLI command path).
  `@adhd/apigen-naming` runs a collision check **once over the merged descriptor**; a collision is a
  **hard extract-time error**, never silent last-writer-wins. (Guards the default-object recursion +
  multi-file glob cases.)

---

## 6. Typing & validation — a fan-out from one core IR

```
source → extractor → DESCRIPTOR (JSON-Schema IR, produced ONCE)
                               ├── harness validation Layer (run + generate-time)
                               ├── target/codegen plugins (mcp/http/proto/openapi/clients)
                               └── jsonschema plugin (emits the IR to files)
```

- The IR is a **core artifact**; validation and *all* plugins fan out from it (not a linear chain;
  `jsonschema` is just one emitter).
- **Validation is a built-in Layer** (§8): validate `data` vs `input` and `envelope` vs `envelope`
  once, before dispatch, with the host's validator (AJV / pydantic / schemars). Fail →
  `ApiError{invalid_argument}`. No per-plugin validation, no route-bound AJV quirks.
- **Validation is necessary, not sufficient:** JSON-Schema validation is a fast-fail **pre-filter**,
  not the host's native type guarantee — it can accept values the native deserializer would coerce or
  reject (number precision, extra properties, date strings, `Option` vs missing). The **authoritative**
  boundary is the host's typed dispatch (for static hosts, the codegen-woven deserialize→typed-params
  step, §2). Hosts MUST NOT treat "validated" as "safe to transmute."

---

## 7. Plugins — terminology, interface, examples

**Terminology (locked):** the distributable unit is a **plugin** (matches `@adhd/apigen-*-plugin-*`).
A plugin declares **capabilities**; **`Layer`** is the precise name for the wrap primitive
("onion"/"middleware" = informal aliases only). CLI: **`--type <plugin>`** picks the target;
**`--use <plugin>`** loads `layer`/`mount`/`envelope` plugins (accepts a **package specifier OR a
local path**).

### 7.1 The plugin interface

```ts
interface Plugin {
  id: string                              // "@adhd/apigen-ts-plugin-logger" | short "logger"
  capabilities: {
    target?:   TargetCapability           // project descriptor → a transport/format
    layer?:    LayerCapability            // wrap operations (the onion)
    mount?:    MountCapability            // ADD operations
    envelope?: EnvelopeCapability         // declare side-channel fields
  }
}

// --- target: project the descriptor (generate) and/or host it (run) ---
interface TargetCapability {
  name: string                            // --type value, e.g. "mcp"
  generate(d: Descriptor, opts): File[]   // descriptor → emitted files
  serve?(d: Descriptor, h: Harness, opts): Promise<Server>   // run a live server (host plugins)
}

// --- layer: wrap (own the continuation) ---
interface LayerCapability {
  envelopeFields?: Record<string, JSONSchema>   // merged into effective request envelope
  layer(call: Call, next: Next): Promise<Result> | AsyncIterable<Chunk>
}
type Call = {
  operation: Operation, data: Record<string,unknown>, envelope: Record<string,unknown>,
  ctx: Extensions,        // typed request-extensions (insert/read), threaded mw→mw→fn
  transport: 'http'|'grpc'|'mcp'|'cli', signal: AbortSignal, raw?: unknown   // raw = escape hatch
}
type Next = () => Promise<Result> | AsyncIterable<Chunk>

// --- mount: add operations (each flows through harness + projection like extracted ops) ---
interface MountCapability {
  operations(d: Descriptor, opts): MountedOperation[]
}
type MountedOperation = Operation & { transports?: Transport[]; handler: (call: Call) => unknown }

// --- envelope: declare request/response side-channel fields (header convention: x-<id>-* / x-adhd-*) ---
interface EnvelopeCapability { request?: Record<string,JSONSchema>; response?: Record<string,JSONSchema> }
```

Hook sugar (`onRequest/onResponse/onError`) compiles to a `LayerCapability` (one execution model).

### 7.2 Worked examples (these nail the interface)

**(a) `ts-plugin-logger` — a Layer (the dogfood test case):**
```ts
export default {
  id: 'logger',
  capabilities: { layer: {
    layer: async (call, next) => {
      const t = Date.now()
      call.ctx.get(Logger).info({ op: call.operation.id }, `→ ${call.operation.id}`)
      try { const r = await next(); call.ctx.get(Logger).info({ op: call.operation.id, ms: Date.now()-t }, 'ok'); return r }
      catch (e) { call.ctx.get(Logger).error({ op: call.operation.id, err: e }, 'fail'); throw e }
    },
  }},
}
```

**(b) `ts-plugin-openapi` — a mount over neutral content:**
```ts
import { toOpenApi } from '@adhd/apigen-openapi'   // COMMON: descriptor → OpenAPI doc
export default {
  id: 'openapi',
  capabilities: { mount: { operations: (d) => [{
    id: '_meta/openapi', host: d.host, namespace: seg('meta'), path: [seg('openapi')],
    kind: 'query', async: false, streaming: false, transports: ['http'],
    input: {}, output: { type: 'object' }, envelope: {},
    handler: () => toOpenApi(d),         // GET /meta/openapi → the doc, derived from the descriptor
  }] }},
}
```

**(c) `ts-plugin-health` — a mount:**
```ts
export default {
  id: 'health',
  capabilities: { mount: { operations: () => [{
    id: '_meta/health', kind: 'query', transports: ['http','grpc'],
    input: {}, output: { type:'object', properties:{ status:{const:'ok'} } }, envelope: {},
    handler: () => ({ status: 'ok' }),
  }] }},
}
```

These prove: a plugin can **wrap** (logger), **add** (openapi/health), reuse **common** content
(`toOpenApi`), be **transport-scoped** (`transports`), and read **typed `ctx`** — all via one
manifest. Usage: `adhd-apigen run --source api.ts --type http-fastify --use logger --use openapi --use health`.

---

## 8. The harness (Layer model) & how runtimes generalize

- **One harness per host language**: `createInvoker(plugins) → invoke(op, call)` runs the composed
  **Layer** stack around `dispatch` (resolve fn → build args → call). Transports are **thin
  adapters**: marshal `data`+`envelope` in from native carriers → `invoke` → marshal result/error
  out. Today's `buildContext` becomes the ctx step; `EventBus`/observers become a built-in Layer.
- **`ctx` = typed request-extensions** (type-keyed map; insert/read), NOT a mutable bag — required
  by Rust's borrow checker, better for all hosts.
- **Realized per host idiomatically**: TS/Python `async (call,next)` closures; **Rust = Tower
  `Layer`+`Service` (for HTTP *and* gRPC — tonic is Tower-based)**. **Not gRPC *interceptors*** —
  they are metadata-only / per-RPC and cannot wrap streamed messages; a metadata-only Layer may use
  one as a convenience, but the primitive is the Tower layer. The contract is abstract (Layer
  *semantics* + `Call`, see §8.1), not a literal closure signature.
- **Composition time**: dynamic hosts compose at runtime; static hosts (Rust/Go) **weave** at
  codegen. Same semantics.
- Middleware/plugins are **operator-supplied at run/generate** (`--use`), declare their envelope
  fields (merged into the effective descriptor), and are never inferred from the API source.

### 8.1 Layer semantics *(normative — the contract every host honors)*

The **logger Layer in two hosts** (proof-of-dual; both must hold before a host is "first-class"):

```ts
// TS / Python — closure over the continuation
layer: async (call, next) => {
  const t = Date.now(); call.ctx.get(Logger).info({ op: call.operation.id }, '→')
  try { const r = await next(); call.ctx.get(Logger).info({ ms: Date.now()-t }, 'ok'); return r }
  catch (e) { call.ctx.get(Logger).error({ err: e }, 'fail'); throw e }
}
```
```rust
// Rust — Tower Layer + Service (same primitive for HTTP and gRPC)
impl<S, Req: HasOperation> Service<Req> for LoggerService<S> where S: Service<Req> {
  type Response = S::Response; type Error = S::Error; type Future = /* wrapped */;
  fn poll_ready(&mut self, cx: &mut Context) -> Poll<Result<(), S::Error>> { self.inner.poll_ready(cx) }
  fn call(&mut self, req: Req) -> Self::Future {
    let (op, t) = (req.operation_id(), Instant::now());
    let fut = self.inner.call(req);                 // short-circuit = don't call this
    async move { match fut.await {
      Ok(r)  => { info!(op, ms = ?t.elapsed(), "ok"); Ok(r) }
      Err(e) => { error!(op, "fail"); Err(e) }      // error unwinds outward == throw
    }}
  }
}
```

1. **Short-circuit:** a Layer that returns a `Result` without invoking `next` skips **all** downstream
   Layers **and** dispatch.
2. **Error propagation:** an error unwinds **outward** through each enclosing Layer (`throw` / `Err`),
   which may catch and map it to a §9 `ApiError`.
3. **`ctx`:** a typed-extension map (type-keyed; insert/read) **owned by the request** and threaded
   `mw→mw→fn` — i.e. Tower/`http::Extensions`. This is why §8 chose typed extensions over a mutable
   bag: it is the only `ctx` shape expressible under Rust's borrow checker.
4. **Backpressure (`poll_ready`):** a **host-optional** capability *outside* the base Layer contract.
   Hosts that have it (Rust/Tower) expose it for load-shed/rate-limit Layers; Layers that don't need
   it delegate to inner; dynamic hosts (TS/Python) omit it entirely.
5. **Streaming:** a Layer wraps the **response stream** (start / each-chunk / end / error), which is
   *why* the Rust mapping is a Tower layer over the gRPC `Service` (whose body is the stream) and
   **not** an interceptor. Full stream-lifecycle contract: §11.
6. **Composition time:** dynamic hosts compose at runtime; static hosts (Rust/Go) **weave** at
   codegen — same semantics 1–5.

---

## 9. Envelope & errors

- **Request envelope** = typed side-channel from transport-native **metadata** (HTTP headers, gRPC
  metadata, CLI flags/env, MCP `_meta`), **not the body**. Canonical identity is
  **`(pluginId, field)`** (builtin = `adhd`), declared once in the plugin's `EnvelopeCapability` and
  carried in the descriptor `envelope` schema; each adapter re-surfaces it per the **binding table
  (§9.1)** — every k/v carrier shares the `x-<pluginId>-<field>` key; **CLI** alone re-surfaces as a
  flag/env because it has no metadata channel.
- **Response envelope** = a typed wrapper (standard builtin fields + plugin-extensible) around
  results **by default**, with a **complete opt-out** → raw passthrough (inferred response types).
- **Errors:** the harness throws `ApiError{ code, message, details }` using the **gRPC canonical
  code set**; each adapter maps `code` → native status:

| code | HTTP | gRPC | MCP | CLI |
|---|---|---|---|---|
| invalid_argument | 400 | INVALID_ARGUMENT | error | 2 |
| unauthenticated | 401 | UNAUTHENTICATED | error | 3 |
| permission_denied | 403 | PERMISSION_DENIED | error | 3 |
| not_found | 404 | NOT_FOUND | error | 4 |
| internal | 500 | INTERNAL | error | 1 |

### 9.1 Envelope binding *(normative — mirrors the error table)*

Canonical identity = **`(pluginId, field)`** (builtin → `adhd`). The logical name is transport-agnostic;
each adapter owns the surface syntax. Example field `session` of plugin `auth`:

| Transport | Request surface | Response surface |
|---|---|---|
| **HTTP** | header `x-auth-session: <v>` | response header `x-auth-session` |
| **gRPC** | metadata key `x-auth-session` (ASCII; binary value → key `x-auth-session-bin`, base64) | trailer `x-auth-session` |
| **CLI** | flag `--auth-session <v>` **+** env `APIGEN_AUTH_SESSION` (flag > env) | stderr / exit per the error table |
| **MCP** | `_meta["x-auth-session"]` (header-shaped key in the structured `_meta`) | `_meta["x-auth-session"]` |

**Rules:** (1) all **k/v carriers** (HTTP, gRPC, MCP) use the **same `x-<pluginId>-<field>` key** — one
mental model. (2) **CLI** is the sole carrier that re-surfaces (no metadata channel): flag
`--<pluginId>-<field>` + env `APIGEN_<PLUGINID>_<FIELD>`, flag taking precedence. (3) builtin fields
drop the plugin segment → `x-adhd-<field>` / `--adhd-<field>` / `APIGEN_<FIELD>`. (4) the response
envelope uses the same table in the response direction (header → trailer → `_meta` → exit/stderr).

---

## 10. Class exports

- **Static methods** *(in scope now)*: each → an operation at `path=[file, class-name, method]`.
- **Instances** *(in scope now, **opt-in**)*: `kind:"constructor"` op (`POST …/class-name`, ctor
  params) → returns `{ instanceId }`; the server holds the instance in a registry;
  `kind:"instance-method"` ops dispatch with `instanceId` (path segment or `x-adhd-instance`
  envelope). Requires a **lifecycle** (TTL + `dispose`) and is **stateful** → does not scale
  horizontally without sticky routing / external store. Off unless opted in.

---

## 11. Streaming *(full — in scope now)*

A `streaming:true` operation returns an async stream (`AsyncIterable`/generator · Rust `Stream` · gRPC
server-stream) instead of a value; the harness result is **value or stream**, and the **full Layer
stream-lifecycle is in scope now** (not deferred). Projections: gRPC server-streaming · HTTP
SSE/chunked · MCP progressive · CLI line-stream.

**Layer stream contract (extends §8.1).** A Layer wraps the response **stream** and may act at:
- **start** — before the first chunk (may still short-circuit or fail with a normal §9 status);
- **each chunk** — observe / transform / drop (per-chunk map·filter); may end the stream early;
- **end** — after the last chunk (finalize, metrics);
- **error** — see the in-band table below.

```ts
// per-chunk Layer (e.g. redact) — wraps the stream, preserves backpressure
layer: async function* (call, next) {
  try { for await (const chunk of next()) yield redact(chunk) }   // each-chunk
  catch (e) { throw toApiError(e) }                               // in-band if already flushed
}
```
Realized as: TS/Python `async function*` wrapping `next()`; **Rust = a Tower layer over the streaming
`Service` body** (§8.1) — never a gRPC interceptor.

**Backpressure:** streams are **consumer-pull** — `for await` (TS/Python) / `Stream`+`poll_next`
(Rust) slow the producer to the consumer; Layers must not buffer unboundedly.

**Cancellation:** `call.signal` (AbortSignal · cancellation token · gRPC cancel · Rust drop) flows
through every Layer to the producer; a cancelled stream runs each Layer's **end** path, not **error**.

**Errors — the status-already-sent problem.** Once the first chunk is flushed the status line is gone,
so an error **after** the first chunk is delivered **in-band**. apigen **adopts Connect's
streaming-error semantics** (do not reinvent). The `ApiError{code,message,details}` payload (§9
taxonomy) is identical across transports; only the carrier differs:

| When | HTTP (SSE/chunked) | gRPC | MCP | CLI |
|---|---|---|---|---|
| **before** first chunk | normal §9 status (e.g. 400) | normal §9 status | error result | nonzero exit, empty stdout |
| **after** first chunk | terminal `event: error` frame carrying the `ApiError` (or chunked trailer) | **trailing status** (native gRPC trailers) | progressive **error notification** | flush partial stdout, write `ApiError` to **stderr**, **nonzero exit** |

Reactive operators (first-class map/merge/retry stream combinators) remain an **[OPT]**
target-specific add-on, never the base.

---

## 12. Packaging — common vs per-language

**Rule:** *descriptor-in → artifact-out (never touches host functions/runtime) = **common**;
touches host functions or runs in its server = **per-language**.*

```
apigen/
  core/                                   # COMMON (neutral; the contract + neutral codegen)
    @adhd/apigen-core            # descriptor model + its JSON Schema
    @adhd/apigen-naming          # tokenizer + casing + route/id projection rules
    @adhd/apigen-errors          # ApiError codes + transport status-mapping tables
    @adhd/apigen-schema          # JSON-Schema utils + transforms (→proto/openapi/ts/cli-flags)
    @adhd/apigen-conformance     # cross-language conformance vectors (every host must pass)
    @adhd/apigen-gateway         # neutral router for mixed-host `run` (§13)
    codegen/                              # neutral generators (descriptor → standard artifact)
      @adhd/apigen-openapi · @adhd/apigen-proto · @adhd/apigen-jsonschema · @adhd/apigen-docs
      @adhd/apigen-client-<lang>          # client SDK generators (emit ANY target language)
  cli/  @adhd/apigen-cli          # the ONE user-facing orchestrator (detect→extract→merge→gen/run)
  ts/                                     # PER-LANGUAGE (a host)
    @adhd/apigen-ts-core         # TS impl of neutral helpers/types (passes conformance vectors)
    @adhd/apigen-ts-extractor    # TS source → descriptor (drivable subprocess)
    @adhd/apigen-ts-runtime      # the HARNESS (invoke/Layer/validate/dispatch/ctx)
    plugins/
      @adhd/apigen-ts-plugin-{mcp,http-fastify,http-express,cli}   # target/server (host fns)
      @adhd/apigen-ts-plugin-{openapi,health}                      # mount (thin shell over common codegen)
      @adhd/apigen-ts-plugin-logger                                # layer (dogfood)
  python/  @adhd/apigen-python-*          # mirror: -core, -extractor, -runtime, plugins/*
  rust/    @adhd/apigen-rust-*
  java/    @adhd/apigen-java-*
```

A new host language reimplements only **-core, -extractor, -runtime, + its server plugins**; it
inherits core, naming, errors, schema, conformance, the gateway, and *all* neutral codegen.
**Mount plugins split**: neutral content generator (`@adhd/apigen-openapi`) + thin per-host shell
(`@adhd/apigen-ts-plugin-openapi`).

---

## 13. Unified CLI & run topologies

`adhd-apigen` is **one** orchestrator binary. It detects each source's language, drives the
per-language **extractor** (subprocess → JSON), merges into one descriptor (ops tagged `host`),
then:
- **generate** → runs target/codegen plugins on the unified descriptor (mixed-language is free).
- **run** → presents one API; picks the **simplest viable topology** (cost function + failure model: §13.1):
  - **all one host** → a single in-process runtime (zero overhead; today's path).
  - **mixed hosts** → **sidecar gateway** *(general, confirmed default)*: spawn a per-language
    runtime per host + `@adhd/apigen-gateway` presenting one transport and routing each op to its
    owning runtime over local IPC.
  - **[OPT]** in-process WASM/FFI co-host when all sources are WASM/FFI-compatible.

`--source humanize.ts ping.rs` → merged descriptor → gateway routes `/transform/humanize/*` to the
TS runtime, `/…/ping` to the Rust runtime, behind one HTTP/MCP/… surface. Layers/plugins are
host-agnostic (the `Call` carries `operation.host`).

### 13.1 Gateway failure model *(normative — a mixed-host `run` is a distributed system)*

- **Partial availability:** a down host fails **only its own ops** → §9 `unavailable` (HTTP 503 /
  gRPC UNAVAILABLE) for those routes; every other host keeps serving. Never whole-surface failure.
- **Readiness:** each sidecar exposes the §7.2c `_meta/health` mount; the gateway routes a host's ops
  **only after** it reports ready (startup-ordering safe). The gateway's own aggregate `_meta/health`
  reports **per-host** status (`ready | degraded | down`).
- **Supervision:** the gateway spawns, monitors, and **restarts** sidecars with backoff; a crash is
  isolated to that host and the gateway process stays up (the host's ops report `unavailable` until it
  is ready again).
- **Deadlines & cancellation:** every cross-host op carries a deadline (from `call.signal` or a
  default); a hung sidecar → §9 `deadline_exceeded`; cancellation propagates over IPC, and streaming
  preserves consumer-pull backpressure (§11).
- **Cost function (drives topology selection):** single-host = **in-process, zero hop**; mixed-host =
  **one local-IPC round-trip per op** (serialize → IPC → deserialize), paid only when sources span
  hosts; WASM/FFI co-host **[OPT]** removes the hop. The "simplest viable topology" selector
  minimizes this cost: prefer in-process; pay the hop only for a genuinely mixed-host run.

---

## 14. The host-SDK / extractor contract (to be a first-class host)

A language is a first-class **server host** when it ships:
1. **Extractor** — source → canonical descriptor (drivable: `apigen-<lang>-extractor <files>` →
   JSON), naming functions by **exported symbol** (honoring `as` aliases; handling default/
   anonymous/CJS shapes), populating `typeText`.
2. **Runtime/harness** — Layer composition + JSON-Schema validation + dispatch + typed-extension
   `ctx`, per §8; passes `@adhd/apigen-conformance` vectors.
3. **Server plugins** — at least one transport target that hosts functions in-process.
4. **Gateway adapter** — expose its runtime over the IPC the gateway routes to (for mixed `run`).

A **client/codegen target** needs none of the above — only to read the descriptor + speak the wire.

---

## 15. Relationship to v1 & migration

v1 (`docs/plan/apigen-client-generation/`) is the **first TS host**, already realizing the
foundation: `@adhd/apigen-core/runtime` (extraction, `dispatch`, `buildFnTable`, `createLogger`,
middleware), 5 TS plugins, the standalone CLI. Known gaps this spec closes (v1 ledger findings):
- **F28/F29** — name drift between extraction (declaration name) and runtime (export/CJS-wrap),
  and broken default/anonymous/renamed/CJS shapes → §4–§5 (name by exported symbol; canonical
  segments + `id`).
- Envelope-in-body, no central validation, TS-closure middleware → §6, §8, §9, §7 (Layer plugins,
  validation Layer, metadata envelope).

**Migration:** make the canonical descriptor explicit; refactor the TS extractor to emit it (by
exported symbol); generalize `dispatch`→`invoke` (Layer harness + central validation); move
envelope to metadata; restructure packages per §12 (the 5 plugins become `apigen-ts-plugin-*`,
logger becomes a Layer plugin); stand up the unified `adhd-apigen` CLI + gateway. New hosts
implement §14 against the same descriptor. The v1 plan's integration/DoD are re-authored against
this contract (see the replan).

---

## 16. Decision log (locked)

Polyglot server hosts (B) · Tenet 0 · **Tenet 1 (source never modified; all config out-of-source;
no required annotations, ever)** · all-exports selection + `--exclude`/`_`/`@internal` ·
deterministic (not refactor-stable) unique `id` · `kind` action/query/constructor/instance-method ·
**JSON-Schema 2020‑12 + `$defs` IR (no new IR; big-int string-encoded; optional extractor-derived
`x-apigen-*` hints; `typeText` optional)**
· kebab/per-plugin casing · default→`[file]`, default-object→`[file,"default",…]` · multi-file dir
glob · MCP sep `_` · central validation Layer · **plugin** unit + **Layer** primitive +
capabilities{target,layer,mount,envelope} · `--type`/`--use` · plugins wrap+mount+envelope ·
request+response envelopes, metadata source, strict `x-<id>-*` · gRPC error codes · classes
(static now, instance opt-in) · **full streaming now** (Layer stream-lifecycle; Connect
error-after-first-chunk) · common vs per-language packaging + neutral codegen
· **one CLI orchestrator** + sidecar-gateway run topology (WASM [OPT]).
