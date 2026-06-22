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
2. **`--exclude <id…>` / `--include <glob>`** at run/generate (zero source change; uses §4 ids).
3. **`_`-prefixed** name, or standard **`@internal`** TSDoc — source-level.

Opt-out never violates Tenet 0: exposure is the zero-ceremony default; markers only *withhold*.

---

## 4. The canonical descriptor

```jsonc
Operation = {
  "id":        "transform/humanize/humanize-bytes",  // STABLE, globally-unique referential slug
  "host":      "ts",                                  // owning language runtime
  "namespace": Segment,            // package (from --namespace / tsconfig folder)
  "path":      Segment[],          // file → export… (hierarchical identity)
  "kind":      "action" | "query" | "constructor" | "instance-method",
  "async":     boolean,
  "streaming": boolean,            // AsyncIterable/Generator/Stream return
  "input":     JSONSchema,         // params object (ctx excluded); data-wrapper dissolved
  "output":    JSONSchema,         // Promise<T>/stream unwrapped → T
  "envelope":  JSONSchema,         // effective request side-channel (middleware-contributed)
  "typeText":  { "lang": "ts", "input": "...", "output": "..." } | null  // language-tagged, optional
}
Segment = { "raw": "humanizeBytes", "words": ["humanize","bytes"] }   // casing-neutral
```

- **`id`** = the canonical fully-qualified slug; the cross-plugin reference key; never re-cased.
- **`kind`**: `action` = callable export (function decl or arrow/const fn); `query` = a
  **serializable-data** const (primitive or plain serializable object/array — no functions/
  non-serializable). `constructor`/`instance-method` → §10. Non-serializable, non-callable export
  → **skipped + warned**.
- **Type IR = JSON Schema 2020‑12** (`input`/`output`/`envelope`). `input` is the params object
  directly; `ctx` first-param excluded. Optional **`typeText`** carries the host's native type
  expression for high-fidelity SDK regen (non-host targets ignore it).
- **`async`** + **`streaming`** flags (streaming implemented in v2, §11).

---

## 5. Naming & per-transport projection

One canonical identity projects to each target's idiom; **casing is per-plugin** (helpers in
`@adhd/apigen-naming`: `toKebab/toPascal/toSnake/toCamel` + tokenizer).

`namespace=transform`, `path=[humanize, humanizeBytes]`, `kind=action`:

| Target | Projection | Result |
|---|---|---|
| HTTP | `/` + kebab segments; **action→POST**, **query→GET** (query-string params) | `POST /transform/humanize/humanize-bytes` |
| MCP | flat name, segments joined with **`_`** | `transform_humanize_humanize_bytes` |
| gRPC | package=lower.dotted; service=Pascal(file); method=Pascal(export) | `transform.Humanize / HumanizeBytes` |
| CLI | nested kebab commands | `… transform humanize humanize-bytes` |

**Locked rules:**
- **File-name normalize:** strip extension; dots/underscores→hyphens (`file.name.ts`→`file-name`).
- **Default export:** single default fn → `path=[file]`; default **object** →
  `path=[file,"default",…keys]`, recursing nested props; named exports coexist at `[file,name]`.
- **Multi-file:** `--source` = file(s) or dir; dir globs `**/*.{ext}` excluding
  `*.spec.*`/`*.test.*`/`*.d.ts`; `index.*` drops its file segment.

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
  `Layer`+`Service`**; gRPC interceptors. The contract is abstract (Layer *semantics* + `Call`),
  not a literal closure signature.
- **Composition time**: dynamic hosts compose at runtime; static hosts (Rust/Go) **weave** at
  codegen. Same semantics.
- Middleware/plugins are **operator-supplied at run/generate** (`--use`), declare their envelope
  fields (merged into the effective descriptor), and are never inferred from the API source.

---

## 9. Envelope & errors

- **Request envelope** = typed side-channel from transport-native **metadata** (HTTP headers, gRPC
  metadata, CLI flags/env, MCP context), **not the body**. Field binding is **strict**:
  `x-<plugin-id>-<field>` (plugin-contributed) / `x-adhd-<field>` (builtin).
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

---

## 10. Class exports

- **Static methods** *(in scope now)*: each → an operation at `path=[file, class-name, method]`.
- **Instances** *(in scope now, **opt-in**)*: `kind:"constructor"` op (`POST …/class-name`, ctor
  params) → returns `{ instanceId }`; the server holds the instance in a registry;
  `kind:"instance-method"` ops dispatch with `instanceId` (path segment or `x-adhd-instance`
  envelope). Requires a **lifecycle** (TTL + `dispose`) and is **stateful** → does not scale
  horizontally without sticky routing / external store. Off unless opted in.

---

## 11. Streaming *(in scope now)*

`streaming` flag carried; harness result is value **or** async stream; Layers wrap the stream
lifecycle (start/each/end/error). Projections: gRPC server-streaming, HTTP SSE/chunked, MCP
progressive, CLI line-stream. Reactive operators are an **[OPT]** target-specific add-on, never the
base.

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
- **run** → presents one API; picks the **simplest viable topology**:
  - **all one host** → a single in-process runtime (zero overhead; today's path).
  - **mixed hosts** → **sidecar gateway** *(general, confirmed default)*: spawn a per-language
    runtime per host + `@adhd/apigen-gateway` presenting one transport and routing each op to its
    owning runtime over local IPC.
  - **[OPT]** in-process WASM/FFI co-host when all sources are WASM/FFI-compatible.

`--source humanize.ts ping.rs` → merged descriptor → gateway routes `/transform/humanize/*` to the
TS runtime, `/…/ping` to the Rust runtime, behind one HTTP/MCP/… surface. Layers/plugins are
host-agnostic (the `Call` carries `operation.host`).

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

Polyglot server hosts (B) · Tenet 0 · all-exports selection + `--exclude`/`_`/`@internal` ·
unique `id` · `kind` action/query/constructor/instance-method · JSON-Schema 2020‑12 IR + `typeText`
· kebab/per-plugin casing · default→`[file]`, default-object→`[file,"default",…]` · multi-file dir
glob · MCP sep `_` · central validation Layer · **plugin** unit + **Layer** primitive +
capabilities{target,layer,mount,envelope} · `--type`/`--use` · plugins wrap+mount+envelope ·
request+response envelopes, metadata source, strict `x-<id>-*` · gRPC error codes · classes
(static now, instance opt-in) · streaming now · common vs per-language packaging + neutral codegen
· **one CLI orchestrator** + sidecar-gateway run topology (WASM [OPT]).
