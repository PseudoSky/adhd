<!-- markdownlint-disable MD013 MD033 -->
# apigen-logical-types — Design (planner output, pre-authoring)

> **Status:** DESIGN ONLY — not yet an authored plan-state-machine plan. No `state.json`/`dag.json` yet.
> **Author role:** planner (design) · **Created:** 2026-06-23
> **Substrate research:** `~/.memory` → `reference_logical_type_serialization.md` (cross-language serialization finding)
> **Supersedes the design notes in:** `BACKLOG.md` → BUG-APIGEN-005

---

## 1. Goal

Give apigen **one** schema-driven, registry-based mechanism that round-trips every non-JSON-native value —
built-in well-known scalars (Date, int64, decimal, bytes, UUID, …) **and** user-defined classes and
discriminated unions — over the JSON wire, **identically across host languages** (TS + Python today;
Rust/Go/Java later), by binding to each language's **native** serialization hook rather than hand-rolling
per-type codecs.

**The unifying insight:** a `Date` is a class apigen *ships* a codec for; a `User` is a class apigen
*extracts* a codec for. Built-in scalars are pre-registered instances of the same registry. There is **one**
transcoder, not a "logical types" feature plus a separate "class serialization" feature.

## 2. Non-goals

- **Not** code/behavior mobility. We transport **state**, never methods. A decoded Python `User` has Python
  methods. (This is RPC marshalling, not RMI.)
- **Not** a new wire protocol. We use idiomatic JSON + JSON-Schema `format`/`$ref`/`oneOf` (ProtoJSON/OpenAPI
  conventions). A plain `curl`/`fetch` client still works.
- **Not** source annotations. Correctness must never *require* an `x-apigen-*` hint (Tenet 1) — hints are
  advisory; a missing hint falls back to structural schema projection.
- **Not** arbitrary-graph serialization. Cyclic object graphs are either ref-tracked (opt-in) or rejected in
  `strict` mode — not silently flattened.

## 3. Canonical wire encodings (the cross-host contract)

Industry-convergent (Protobuf ProtoJSON, OpenAPI, Avro logical types, Smithy all agree). apigen's existing
`int64`-as-string convention is already correct and is folded in here.

| Logical id | `format` / shape | Canonical wire | Native source-of-truth |
|---|---|---|---|
| `date-time` | `{type:string,format:date-time}` | RFC 3339 **UTC** string, ≥ms precision | `Date.prototype.toJSON` already emits this |
| `date` | `{type:string,format:date}` | `2024-01-15` | — |
| `time` | `{type:string,format:time}` | `12:00:00.000` | — |
| `duration` | `{type:string,format:duration}` | ISO-8601 `P1DT2H` (accept `"3.5s"`) | — |
| `int64` / `bigint` | `{type:string,format:int64}` | decimal string `"9007199254740993"` | avoids JS f64 precision loss |
| `decimal` | `{type:string,format:decimal}` | decimal string `"123.456"` (never float) | — |
| `byte` | `{type:string,format:byte}` | base64 **standard + padding** | — |
| `uuid` | `{type:string,format:uuid}` | lowercase hyphenated (RFC 4122) | — |
| `map` | `{type:array,...}` + `x-apigen-logical:map` | array of `[k,v]` pairs (keys codec-encoded) | non-string keys can't be object keys |
| `set` | `{type:array}` + `x-apigen-logical:set` | JSON array (order-normalized) | — |
| `nominal` (class) | `$ref:#/$defs/<Name>` | JSON object `{...fields}` | host `toJSON()`/`fromJSON()` |
| `union` (sum type) | `oneOf` + `discriminator` | object with const tag prop | host polymorphic seam |
| number specials | `{type:number}` subtype | string `"NaN"`/`"Infinity"`/`"-Infinity"` | `JSON.stringify` → `null` otherwise |

**Hard rules:** instants UTC-normalized; base64 = standard variant; `format` decode is mandatory (a wire
string is indistinguishable from a date string without the schema).

---

## 4. Standardized interfaces (the spine)

All interfaces are **normative** and **versioned**. The descriptor carries a `logicalTypeVersion`; a change to
the wire table or the extension vocabulary bumps it and regenerates the conformance vectors. Stability is
marked per symbol (`@stable` | `@experimental`).

### 4.1 Descriptor schema extension vocabulary (`core`)

The descriptor IR (JSON Schema 2020-12) is the **single source of truth**. Logical types are expressed with
standard keywords plus a small reserved `x-apigen-*` vocabulary. **Structure (`format`/`$ref`/`oneOf`) is
authoritative; the `x-apigen-*` keys are derivable hints that accelerate dispatch but are never required for
correctness.**

```jsonc
// scalar well-known type
{ "type": "string", "format": "date-time" }

// nominal class (reconstructable). Lives in $defs, referenced by $ref.
"User": {
  "type": "object",
  "properties": { "id": {"type":"string"}, "joinedAt": {"type":"string","format":"date-time"} },
  "required": ["id","joinedAt"],
  "x-apigen-logical": "nominal",   // scalar | nominal | union | map | set
  "x-apigen-codec":   "cli.User",  // stable LogicalTypeId (namespace-qualified)
  "x-apigen-ctor":    "fromJSON",  // OPTIONAL decode hint; absent ⇒ schema-projected construction
  "x-apigen-tojson":  "toJSON"     // OPTIONAL encode hint; absent ⇒ structural field projection
}

// polymorphic union (wire discriminator)
{
  "oneOf": [ {"$ref":"#/$defs/Dog"}, {"$ref":"#/$defs/Cat"} ],
  "discriminator": { "propertyName": "kind", "mapping": { "dog":"#/$defs/Dog", "cat":"#/$defs/Cat" } },
  "x-apigen-logical": "union"
}
```

Reserved keys (added to `descriptor.schema.json`, all optional): `x-apigen-logical`, `x-apigen-codec`,
`x-apigen-ctor`, `x-apigen-tojson`. **Invariant `[inv:hints-advisory]`:** the transcoder MUST produce
identical output with the `x-apigen-*` keys stripped (proven by a negative-control vector).

### 4.2 Core codec contract (`packages/apigen/core/src/lib/logical/contracts.ts`)

```ts
/** @stable Stable identifier for a logical type.
 *  Scalars: the JSON-Schema `format` (e.g. "date-time").
 *  Nominal/union: namespace-qualified id (e.g. "cli.User"). */
export type LogicalTypeId = string;

/** @stable */
export type LogicalKind = 'scalar' | 'nominal' | 'union' | 'map' | 'set';

/** @stable The wire alphabet — exactly JSON's value space. */
export type Wire = string | number | boolean | null | Wire[] | { [k: string]: Wire };

/** @stable A resolved (no-$ref-at-root) JSON Schema node. */
export type SchemaNode = Readonly<Record<string, unknown>>;

/** @stable Threaded through a transcode walk. */
export interface TranscodeCtx {
  readonly registry: LogicalTypeRegistry;
  readonly resolve: (ref: string) => SchemaNode;  // $ref → $def resolver (root-bound)
  readonly seen: WeakSet<object>;                  // cycle guard (encode side)
  readonly path: string;                           // JSON Pointer, for diagnostics
  readonly mode: 'strict' | 'lossy';               // strict: throw on unencodable; lossy: warn + best-effort
}

/** @stable Host-agnostic codec. One per logical type. Pure, deterministic, total over its domain. */
export interface LogicalTypeCodec<Host = unknown> {
  readonly id: LogicalTypeId;
  readonly kind: LogicalKind;
  /** Canonical schema fragment this codec owns (scalar: {type,format}; nominal: object $def). */
  readonly schema: SchemaNode;
  /** Structural, cheap test: does this codec own `node`? (e.g. format match, or x-apigen-codec===id). */
  matches(node: SchemaNode): boolean;
  /** Host → wire. MUST NOT mutate `value`; MUST be deterministic. */
  encode(value: Host, node: SchemaNode, ctx: TranscodeCtx): Wire;
  /** Wire → host. MUST validate-then-construct; MUST be the inverse of `encode` across the vectors. */
  decode(wire: Wire, node: SchemaNode, ctx: TranscodeCtx): Host;
}
```

### 4.3 Registry (`core`)

```ts
/** @stable Keyed by LogicalTypeId. Scalars register by `format`; nominal/union by qualified id. */
export interface LogicalTypeRegistry {
  /** Register a codec. Throws E_DUP_CODEC on a duplicate id unless `{override:true}`. */
  register(codec: LogicalTypeCodec, opts?: { override?: boolean }): void;
  /** Resolve the codec owning a RESOLVED schema node, or undefined for a plain JSON node. */
  resolve(node: SchemaNode): LogicalTypeCodec | undefined;
  /** Direct lookup (for $ref / discriminator resolution). */
  get(id: LogicalTypeId): LogicalTypeCodec | undefined;
  /** Introspection (codegen, debugging). */
  ids(): readonly LogicalTypeId[];
  /** Frozen snapshot, safe to share across dispatch calls. */
  freeze(): LogicalTypeRegistry;
}

/** @stable Factory: a registry pre-loaded with the well-known scalar codecs. */
export function createRegistry(opts?: { wellKnown?: boolean }): LogicalTypeRegistry;
```

### 4.4 Transcoder (`packages/apigen/runtime/src/lib/logical/transcoder.ts`) — **the missing piece**

> **⚠️ SUPERSEDED by §11 (codegen-first model).** The runtime schema-interpreting transcoder below is
> retained as the conceptual reference and the `run`-mode fallback only. The primary path **generates**
> direct (de)hydration glue from the §13 template columns at generate-time — no per-host runtime interpreter.
> Read §11–§14 for the model that is actually planned.

```ts
/** @stable Schema-walking transcoder. Walks `schema` and the value in lockstep; applies the registered
 *  codec at any node it owns; recurses through object properties, array items, $ref, and oneOf. */
export interface Transcoder {
  /** Host → wire. */
  encode(value: unknown, schema: SchemaNode, ctx?: Partial<TranscodeCtx>): Wire;
  /** Wire → host. Validates each node before constructing (decode is the only side that needs the schema). */
  decode(wire: Wire, schema: SchemaNode, ctx?: Partial<TranscodeCtx>): unknown;
}

export function createTranscoder(registry: LogicalTypeRegistry): Transcoder;
```

**Walk algorithm (identical in every host — this is the standardization that makes cross-language work):**

```
encode(v, node):
  codec = registry.resolve(node)
  if codec: return codec.encode(v, node, ctx)
  if node.$ref: return encode(v, ctx.resolve(node.$ref))
  if node.oneOf: pick by discriminator(v); return encode(v, chosenBranch)
  if node.type == 'array': return v.map((x,i) => encode(x, node.items))
  if node.type == 'object': return mapValues(node.properties, (s,k) => encode(v[k], s))
  if schema-less (type absent / additionalProperties): return envelopeEncode(v)   // self-describing fallback
  return v as Wire   // plain JSON passthrough
decode is the mirror (resolve → construct), validating per node first.
```

### 4.5 Self-describing envelope (schema-less positions only)

```ts
/** @stable Used ONLY where the schema cannot disambiguate (type:{} / any / heterogeneous Map value).
 *  Wire: { "$apigen": "<LogicalTypeId>", "v": <Wire> }. Plain JSON everywhere else. */
export const ENVELOPE_KEY = '$apigen' as const;
export interface ApigenEnvelope { readonly [ENVELOPE_KEY]: LogicalTypeId; readonly v: Wire; }
```

Rationale: keep the wire idiomatic (school A, schema-`format`-driven) for all typed positions; fall back to a
single self-describing convention (school B, superjson/EJSON-style) **only** at genuinely `any` positions, so
we never bloat or de-idiomatize a typed payload.

### 4.6 Per-host adapter contract (`packages/apigen/<host>`)

The **wire contract is identical across hosts** (pinned by §4.7 vectors); only the *binding to the native hook*
is host-local. Critical standardization fact: **every language's JSON reviver/`object_hook` is value-only and
cannot see the schema**, so **decode is schema-driven and explicit in every host** — the native hook is used
for *encode* (value-driven) and as the *construction primitive* during decode.

```ts
/** @stable A host binding maps a LogicalTypeId to that host's native encode/decode primitives. */
export interface HostBinding {
  readonly host: 'ts' | 'python' | 'rust' | 'go' | 'java';
  readonly logicalTypeVersion: string;
  /** The codecs this host provides, keyed by LogicalTypeId. Must cover every well-known id. */
  readonly codecs: ReadonlyMap<LogicalTypeId, LogicalTypeCodec>;
}
```

| Host | Encode seam | Decode seam (schema-driven) | Free win |
|---|---|---|---|
| TS/JS | `JSON.stringify(v, replacer)` + class `toJSON()` | `transcoder.decode` (NOT reviver — reviver is value-only) + static `fromJSON()`/ctor | `Date.prototype.toJSON` = RFC3339 UTC |
| Python | `json.JSONEncoder(default=fn)` / pydantic `model_dump` | schema-walking `decode()` mirror + `fromisoformat` / `model_validate` | `datetime.isoformat` |
| Rust | `serde::Serialize` + `serde_with::SerializeAs` | `Deserialize` + `DeserializeAs` (serde IS schema-bound at the type) | `chrono::DateTime<Utc>` |
| Java | Jackson `StdSerializer<T>` via `SimpleModule` | `StdDeserializer<T>` + `@JsonTypeInfo` for unions | `Instant.toString/parse` |
| Go | `json.Marshaler` (`MarshalJSON`) | `json.Unmarshaler` (`UnmarshalJSON`) | `time.Time` RFC3339Nano |

### 4.7 Conformance vector contract (`packages/apigen/conformance`) — the cross-host gate

```ts
/** @stable The cross-language contract. Each host harness MUST: encode its native `seed` to byte-equal `wire`;
 *  decode `wire` and satisfy `invariants`; and confirm `negativeControl` turns the vector RED. */
export interface LogicalTypeVector {
  readonly id: string;                       // "logical.date-time.roundtrip"
  readonly logicalType: LogicalTypeId;
  readonly schema: Record<string, unknown>;
  /** Host-neutral construction recipe so each host builds its native instance. */
  readonly seed: Wire | { $construct: LogicalTypeId; args: Wire[] };
  /** REQUIRED canonical wire bytes — every host MUST encode `seed` to exactly this. */
  readonly wire: Wire;
  /** Post-decode assertions (host-neutral). */
  readonly invariants?: ReadonlyArray<{ pointer: string; equals: Wire }>;
  /** The teeth: a mutation that MUST make the vector fail (proves the check isn't vacuous). */
  readonly negativeControl: { mutate: 'wire' | 'schema' | 'codec'; to: unknown };
}
```

---

## 5. Package layout / file map

```
packages/apigen/core/src/lib/logical/
  contracts.ts        # §4.2–4.5 interfaces (LogicalTypeId, codec, registry, transcoder iface, envelope)
  registry.ts         # §4.3 createRegistry + well-known auto-load
  descriptor-ext.ts   # x-apigen-logical/codec/ctor keyword constants + derivation helpers
packages/apigen/core/src/lib/schema-builders/   # EXTEND existing:
  ts-json-schema.ts   # map Date/bigint/Uint8Array/... → {type,format} BEFORE the {} fallthrough
  nominal.ts          # NEW: class → $def + $ref + x-apigen-* (reuses extract-classes.ts)
  union.ts            # NEW: discriminated union → oneOf + discriminator
packages/apigen/runtime/src/lib/logical/
  transcoder.ts       # §4.4 createTranscoder (the schema-walking encode/decode)
  codecs/             # well-known scalar codecs: datetime, int64, decimal, bytes, uuid, number-special, map, set
  nominal-codec.ts    # class encode(toJSON|project) / decode(validate→construct); opt-in-instances gate
  union-codec.ts      # discriminator dispatch
  host-ts.ts          # §4.6 TS HostBinding
packages/apigen/runtime/src/lib/dispatch.ts     # EXTEND: decode args / encode result
packages/apigen/python/                          # Python HostBinding mirror (JSONEncoder + schema-walk decode)
packages/apigen/conformance/src/lib/vectors.ts   # EXTEND: §4.7 LogicalTypeVector set + negative controls
packages/apigen/schema/                          # ajv-formats wiring for the validate-Layer
```

---

## 6. Proposed state breakdown (work / audit / human gate)

Phases ordered by the critical path; `[opus]` marks load-bearing decomposition/contract states.

### Phase 0 — Contracts (the interface spine)
- `lt-contracts` **[opus]** — author §4.2–4.5 interfaces + `descriptor.schema.json` extension keywords + `logicalTypeVersion` stamp. *Guard:* `nx tsc apigen-core` + the extended `descriptor.schema.json` self-validates. *artifacts:* `core/.../logical/contracts.ts`, `descriptor-ext.ts`, `descriptor.schema.json`.
- `lt-wire-spec` — write the canonical wire-encoding spec (§3) as `core` doc + author the §4.7 `LogicalTypeVector` schema + seed well-known scalar vectors (date-time, int64, decimal, byte, uuid, number-special) with negative controls. *Guard:* vectors typecheck + each declares a negativeControl.

### Phase 1 — Registry + transcoder
- `lt-registry` — implement §4.3 (`createRegistry`, dup-detection `E_DUP_CODEC`, `freeze`). dep: `lt-contracts`. *Guard:* unit (register/resolve/get/override).
- `lt-transcoder` **[opus]** — implement §4.4 walk (recursion, `$ref`, `oneOf`/discriminator, arrays, objects, cycle guard, envelope fallback, strict/lossy). dep: `lt-registry`. *Guard:* unit over a synthetic schema tree incl. nested + cyclic + schema-less.

### Phase 2 — Well-known scalar codecs
- `lt-scalars` — datetime/date/time/duration, int64/bigint, decimal, byte, uuid, NaN/±Inf, map, set. dep: `lt-transcoder`. *Guard:* every well-known vector round-trips + every negative control goes red (exit-code gated).

### Phase 3 — Extraction (schema side)
- `lt-extract-scalars` — schema-builders map built-in TS types → `{type,format}` (no more `{}`). dep: `lt-contracts`. *Guard:* extracting a Date-returning fixture yields `format:date-time`.
- `lt-extract-nominal` — class → `$def`+`$ref`+`x-apigen-*` (reuse `extract-classes.ts`). dep: `lt-contracts`. *Guard:* a `User` class yields a `$def` + `$ref` + `x-apigen-codec`.
- `lt-extract-union` — discriminated union → `oneOf`+`discriminator`. dep: `lt-extract-nominal`. *Guard:* `Dog|Cat` yields `oneOf` + discriminator mapping.

### Phase 4 — Nominal + polymorphic codecs
- `lt-nominal-codec` **[opus]** — class encode (`toJSON` hint else field-projection) / decode (validate→construct via ctor hint else schema projection); opt-in-instances gate; cycle handling. dep: `lt-transcoder`, `lt-extract-nominal`. *Guard:* `User` round-trips to a real instance; `[inv:hints-advisory]` proven (strip `x-apigen-*` ⇒ identical).
- `lt-union-codec` — discriminator dispatch. dep: `lt-nominal-codec`, `lt-extract-union`. *Guard:* union vector round-trips; drop-tag negative control red.

### Phase 5 — Host bindings (proves cross-language)
- `lt-host-ts` — §4.6 TS binding. dep: `lt-scalars`, `lt-nominal-codec`. *Guard:* TS harness passes the full vector set.
- `lt-host-python` — Python mirror (`JSONEncoder.default` + schema-walk decode). dep: `lt-wire-spec`, `lt-scalars`. *Guard:* Python harness passes the **same** vector set, **byte-equal** wire.

### Phase 6 — Pipeline integration
- `lt-dispatch-integration` — wire transcoder into `dispatch.ts` (decode args / encode result, recursively). dep: `lt-host-ts`.
- `lt-validate-formats` — enable `ajv-formats` in the validate-Layer. dep: `lt-scalars`.
- `lt-codegen-hints` — feed registry into `x-apigen-*` so TS client emits `Date`, Python emits `datetime`. dep: `lt-host-ts`, `lt-host-python`.

### Phase 7 — Gates
- `lt-conformance-crosshost` **[audit, opus]** — run the full vector set through **both** TS and Python: byte-equal wire + decode invariants + **every** negative control red. Mandatory halt on any vacuous/failed check.
- `lt-architect-review` **[review, opus]** — architecture-review gate on the §4 contracts specifically (interface cohesion, stability markers, versioning, host-binding symmetry). *Emphasized per requestor.*
- `lt-code-review` **[review, opus]** — diff-bounded review gate.
- `lt-final-audit` **[audit, opus]** — final DoD audit.
- `human-dod` **[human gate]** — DoD confirmation + stamp `dod_provenance`.
- `done` **[terminal]**.

---

## 7. Definition of Done (behavioral — entrypoint + observable + delivered-by + negative-control)

- `[dod.scalar]` A function param/return typed `Date` round-trips through the built bin over MCP/HTTP.
  - observable: `callTool(whenIso,{label})` → `{label, at}` where `at` is RFC3339 UTC; an input `Date` arrives as a real `Date` (`d.getTime()` works).
  - delivered-by: `lt-scalars`, `lt-extract-scalars`, `lt-transcoder`, `lt-dispatch-integration`.
  - negative-control: revert the date-time codec → `at` becomes `{}` / input stays a string → red.
- `[dod.int64]` An int64 beyond `Number.MAX_SAFE_INTEGER` round-trips without precision loss (closes the existing `validation.number-precision` vector).
  - negative-control: decode int64 as a JS number → value corrupts → red.
- `[dod.nominal]` A user `User` class round-trips **TS → wire → Python → wire → TS**, reconstructed as a real instance on **both** hosts.
  - delivered-by: `lt-nominal-codec`, `lt-extract-nominal`, `lt-host-ts`, `lt-host-python`.
  - negative-control: remove the constructor binding → decode yields a prototype-stripped object → `instanceof User` false → red.
- `[dod.union]` A `Dog | Cat` position dispatches to the correct variant by wire discriminator.
  - negative-control: drop the discriminator tag → wrong/ambiguous variant → red.
- `[dod.crosshost]` The full conformance vector set encodes **byte-equal** across TS and Python.
  - negative-control: change one Python codec's encoding → wire byte mismatch → red.
- `[dod.validate]` The validate-Layer (`ajv-formats`) rejects a malformed `date-time` (`2099-02-30`).
  - negative-control: disable `ajv-formats` → Feb 30 passes → red.
- `[dod.envelope]` A value at a schema-less `any` position round-trips a `Date` via the `$apigen` envelope.
  - negative-control: remove the envelope path → schema-less Date flattens to `{}` → red.
- `[dod.no-annotation]` (Tenet 1 / `[inv:hints-advisory]`) A source class with **no** apigen annotations transcodes correctly via schema projection.
  - negative-control: make the transcoder require `x-apigen-ctor` → unannotated class fails → red.

---

## 8. Risks / open questions (for the human gate)

1. **Map key encoding** — `[k,v]` array vs string-keyed object after key-codec. *Proposed:* `[k,v]` pairs (handles non-string keys uniformly). Confirm.
2. **Decimal host type** — TS has no native decimal; bind to `string` + a `Decimal`-ish branded type, or require `bigint`/lib? *Proposed:* keep `decimal` as branded string in TS, real `Decimal` in Python. Confirm acceptable asymmetry.
3. **Cycle policy** — `strict` rejects cycles; `lossy` ref-tracks (superjson-style `$ref` ids). *Proposed:* default `strict`, opt-in ref-tracking. Confirm.
4. **Nominal id stability across hosts** — qualified `<namespace>.<Class>`. The namespace must agree TS↔Python. *Proposed:* pin in the conformance vector. Confirm.
5. **Non-reconstructable classes** (sockets/closures) — gated by the extractor's existing opt-in-instances flag; encode-only or rejected. Confirm policy.
6. **`logicalTypeVersion` bump policy** — any wire-table change regenerates vectors; treat as a breaking change to generated clients. Confirm SemVer mapping.

---

## 9. Why this is the right altitude

- **One mechanism:** scalars and classes both flow through `LogicalTypeRegistry` + `Transcoder`. Adding a type = one codec + one vector.
- **Cross-language by construction:** the vector pins the **wire bytes**; each host binds its **native hook**; agreement is structural, not coincidental.
- **Schema-first fit:** decode *requires* the schema, and apigen always has the descriptor — the design exploits exactly what apigen already guarantees.
- **Standards-aligned:** wire encodings match ProtoJSON/OpenAPI/Avro; nothing invented.
- **Proven, not green:** every DoD clause names a real entrypoint + observable + a negative control that must turn it red (CLAUDE.md §6).

---

## 11. Architecture revision — codegen-first (supersedes the runtime transcoder in §4.4)

apigen is a **code generator** and always knows the schema at generate-time. So we do **not** ship a
schema-interpreting transcoder per host. Instead:

- **Encode** uses each host's **native hook** (`Date.prototype.toJSON`, `json.dumps(default=)`, serde,
  `MarshalJSON`, Jackson) — value-driven, nearly free.
- **Decode** is the only schema-dependent direction (native revivers are value-only and can't see the
  schema). The **generator walks the schema once** and emits direct, typed glue from a single table of
  per-language **template columns** (§13). No runtime interpreter.
- **One shared TS engine** in a new package `@adhd/apigen-logical` owns: the canonical table (§3 + §13), the
  generate-time walk/emitter, and a thin **`run`-mode closure builder** (compile-once-at-startup for the
  in-process TS host). Foreign hosts run *generated* code, so they never need a transcoder.

**New package:** `@adhd/apigen-logical` (the one source of truth — consumed by `core` extraction, the
generator, `runtime` run-mode, and codegen-hints; eliminates the four-way duplication noted in the LOC review).

LOC effect vs §4.4: removes `runtime/transcoder.ts` + the Python transcoder mirror (≈ −1,000 LOC); the schema
walk lives once in the generator.

---

## 12. Type inventory & per-language burden (the matrix)

Columns = modeled host languages. **✓** = the language's standard/idiomatic serializer (stdlib or de-facto
library, default config) round-trips the type to the canonical wire with **no apigen template entry**.
**✗** = needs a template-column entry — either **ᵈ** decode can't reconstruct the type (dynamic langs) or
**ʷ** native wire ≠ canonical (needs override).

| # | Type | Canonical wire | TS/JS | Python | Rust | Go | Java |
|--|------|----------------|:--:|:--:|:--:|:--:|:--:|
| 1 | string · number · bool · null · array · object(str-keys) | as-is | ✓ | ✓ | ✓ | ✓ | ✓ |
| 7 | date-time | RFC 3339 string | ✗ᵈ | ✗ᵈ | ✓ | ✓ | ✗ʷ |
| 8 | date | `2024-01-15` | ✗ᵈ | ✗ᵈ | ✓ | ✗ | ✗ʷ |
| 9 | time | `12:00:00.000` | ✗ᵈ | ✗ᵈ | ✓ | ✗ | ✗ʷ |
| 10 | duration | ISO-8601 `P1DT2H` | ✗ᵈ | ✗ᵈ | ✗ʷ | ✗ʷ | ✗ʷ |
| 11 | int64 / long | decimal **string** | ✗ʷ | ✗ʷ | ✗ʷ | ✗ʷ | ✗ʷ |
| 12 | bigint | decimal **string** | ✗ʷ | ✗ʷ | ✗ʷ | ✗ʷ | ✗ʷ |
| 13 | decimal / money | decimal **string** | ✗ | ✗ | ✗ʷ | ✗ | ✗ʷ |
| 14 | bytes | base64 string | ✗ʷ | ✗ᵈ | ✗ʷ | ✓ | ✓ |
| 15 | UUID | lowercase-hyphenated | ✓ | ✗ᵈ | ✓ | ✓ | ✓ |
| 16 | URL / URI | string | ✗ᵈ | ✗ᵈ | ✓ | ✗ | ✓ |
| 17 | NaN / ±Infinity | `"NaN"`/`"Infinity"` | ✗ʷ | ✗ʷ | ✗ʷ | ✗ʷ | ✗ʷ |
| 18 | Map (non-string keys) | array of `[k,v]` | ✗ʷ | ✗ʷ | ✗ʷ | ✗ʷ | ✗ʷ |
| 19 | Set | array | ✗ʷ | ✗ᵈ | ✓ | ✗ | ✓ |
| 20 | tuple | array | ✓ | ✗ᵈ | ✓ | ✗ | ✗ |
| 21 | enum (simple) | string | ✓ | ✗ᵈ | ✓ | ✓ | ✓ |
| 22 | tagged union / sum type | `{tag,…}` discriminator | ✓ | ✗ | ✗ʷ | ✗ | ✗ʷ |
| 23 | Option / nullable | `null` | ✓ | ✓ | ✓ | ✓ | ✓ |
| 24 | class/struct — plain data | object | ✗ᵈ | ✗ᵈ | ✓ | ✓ | ✓ |
| 25 | class — invariants/private (ctor) | object | ✗ | ✗ | ✗ | ✗ | ✗ |
| 26 | recursive / cyclic graph | object + `$ref` | ✗ | ✗ | ✗ | ✗ | ✗ |
| | **Template entries needed (of 20 rich rows)** | | **15** | **19** | **10** | **14** | **13** |

**Reading it:** custom **classes are ✓ on the static hosts** (serde/encoding-json/Jackson rebuild typed
structs) and ✗ on the dynamic hosts (decode yields a bare object/dict). **int64, bigint, decimal, NaN, and
non-string-key Maps are ✗ everywhere** — pure wire-format disagreements. Dynamic langs pay on decode; static
langs pay on wire mismatch. Python's `json` raises on nearly every rich type → 19 entries; Rust the fewest at 10.

---

## 13. The template column — cell spec + filled expressions

### 13.1 Cell shape (extended to carry deps + imports)

A cell is no longer just an expression — it also declares what the generator must import and depend on:

```ts
/** @stable One language's handling of one logical type. */
export interface TemplateCell {
  /** Native expression; `$` = the value being transformed (composes — see §4 of DESIGN). */
  encode: string;          // host value → wire,  e.g. "$.toISOString()"
  decode: string;          // wire → host value,  e.g. "new Date($)"
  imports?: string[];      // import/use statements the glue needs
  dep?: { name: string; version: string };  // 3rd-party manifest entry (absent ⇒ stdlib)
  mode: 'native' | 'lib' | 'branded';        // branded = zero-dep primitive wrapper (no rich behavior)
  construct?: string;      // nominal only: build instance from decoded field bag, e.g. "new {T}({fields})"
  toJSON?: string;         // nominal only: instance → field bag,            e.g. "{v}.toJSON()"
}
```

The generator uses `encode`/`decode`/`construct` for glue, `imports` for file headers, and `dep` to compute
the generated package's dependency manifest (§14). `mode:'branded'` is the zero-dependency escape hatch.

### 13.2 Filled columns for the ✗ cells

`$` = current value expression. `b64`/helpers are emitted inline by the engine. Stdlib unless a `dep` is shown.

**TypeScript / JS**

| Type | encode | decode | dep / mode |
|---|---|---|---|
| date-time | `$.toISOString()` | `new Date($)` | stdlib |
| date / time / duration | `$` (validated) | `$` (validated) | **branded** (or `luxon` if rich) |
| int64 / bigint | `String($)` | `BigInt($)` | stdlib (`BigInt`) |
| decimal | `$.toString()` | `new Decimal($)` | **dep: `decimal.js`** |
| bytes | `Buffer.from($).toString('base64')` | `new Uint8Array(Buffer.from($,'base64'))` | stdlib |
| NaN/±Inf | `numToWire($)` | `wireToNum($)` | stdlib helper |
| Map(non-str) | `[...$].map(([k,v])=>[encK(k),encV(v)])` | `new Map($.map(([k,v])=>[decK(k),decV(v)]))` | stdlib |
| Set | `[...$]` | `new Set($)` | stdlib |
| class (nominal) | `$.toJSON?.() ?? {...$}` | `new {T}({fields})` / `{T}.fromJSON($)` | user type |

**Python** — *every entry is stdlib (zero 3rd-party deps)*

| Type | encode | decode | import |
|---|---|---|---|
| date-time / date / time | `$.isoformat()` | `datetime.fromisoformat($)` (resp. `date`/`time`) | `datetime` |
| duration | `iso8601($)` | `parse_iso8601($)` | stdlib helper (~10 lines; or `isodate`) |
| int64 / bigint | `str($)` | `int($)` | — |
| decimal | `str($)` | `Decimal($)` | `decimal` |
| bytes | `b64encode($).decode()` | `b64decode($)` | `base64` |
| uuid | `str($)` | `UUID($)` | `uuid` |
| Set | `list($)` | `set($)` | — |
| enum | `$.value` | `{T}($)` | — |
| class (nominal) | `asdict($)` | `{T}(**$)` / `{T}.from_json($)` | `dataclasses` |

**Rust** (`#[serde(with=…)]` attributes; crates are de-facto standard)

| Type | mechanism | crate (dep) |
|---|---|---|
| duration | `#[serde(with="…iso8601")]` | `iso8601` / hand |
| int64 / bigint | `#[serde_as(as="DisplayFromStr")]` | **`serde_with`** / `num-bigint` |
| decimal | `#[serde(with="rust_decimal::serde::str")]` | **`rust_decimal`** |
| bytes | `#[serde_as(as="Base64")]` | **`serde_with`** |
| NaN/Inf | custom `serialize_with` | — |
| Map(non-str) | `#[serde_as(as="Vec<(_,_)>")]` | **`serde_with`** |
| tagged union | `#[serde(tag="kind")]` | — (attribute) |
| class+invariants | hand `impl Deserialize` | — |

**Go** (`MarshalJSON`/`UnmarshalJSON` or struct tags)

| Type | mechanism | dep |
|---|---|---|
| date / time-only | wrapper type + `time.Format/Parse` | stdlib `time` |
| duration | custom `MarshalJSON` → ISO string | stdlib |
| int64 / bigint | struct tag `json:"x,string"` / `math/big` | stdlib |
| decimal | `shopspring/decimal` (marshals to string) | **`github.com/shopspring/decimal`** |
| NaN/Inf · Map(non-str) · Set | custom marshaller | stdlib |
| tagged union | interface + custom marshal | stdlib |
| uuid | `google/uuid` | **`github.com/google/uuid`** |

**Java** (Jackson modules + annotations)

| Type | mechanism | dep |
|---|---|---|
| date-time/date/time/duration | `java.time` + `@JsonFormat` | **`jackson-datatype-jsr310`** (module) |
| int64 / bigint / decimal | `@JsonSerialize(using=ToStringSerializer)` / `@JsonFormat(shape=STRING)` | stdlib Jackson |
| NaN/Inf · Map(non-str) | custom `StdSerializer` | stdlib Jackson |
| tagged union | `@JsonTypeInfo(use=NAME, property="kind")` | stdlib Jackson |
| class+invariants | `@JsonCreator` ctor | stdlib Jackson |

### 13.3 "No empty cells" = the §10 enforcement
Each ✗ above is a required cell. Add a logical type → a new row → every language column must fill it or the
completeness gate (§10) goes red. Add a language → a new column → fill the ~10–19 ✗ cells + go green on the
conformance harness.

---

## 14. Third-party dependencies — codegen & run implications

**Yes, some ✗ cells require non-stdlib deps — but it is sharply language-dependent:**

| Language | 3rd-party deps introduced | Notes |
|---|---|---|
| **Python** | **none** | `datetime`, `decimal`, `uuid`, `base64`, `enum` all stdlib (duration helper hand-rolled or optional `isodate`) |
| **Java** | `jackson-datatype-jsr310` | one Jackson module; int64/decimal/union all stdlib Jackson |
| **TS/JS** | `decimal.js` (decimal) | date-only/time-only/duration default to **branded strings** (zero-dep); `BigInt`/base64 stdlib |
| **Go** | `shopspring/decimal`, `google/uuid` | rest stdlib (`time`, `math/big`, `encoding/base64`) |
| **Rust** | `serde_with`, `rust_decimal`, `num-bigint`, `chrono`, `uuid`, `url`, `base64` | normal for Rust's small-stdlib model |

### 14.1 Codegen (generate mode)

1. **Per-surface minimal manifest.** The generator collects the **set of logical types actually used** by the
   operations in a surface, unions their `dep` entries, and emits **only those** into the generated
   `package.json` / `Cargo.toml` / `go.mod` / `pom.xml` / `requirements.txt`. A surface with no `Decimal`
   never pulls `decimal.js`.
2. **Imports.** The cell's `imports` are emitted at the top of each generated file (dedup'd).
3. **Couples to BUG-APIGEN-002.** These become **real deps** of the generated package — folded into the
   Option-A publish model / `--link-workspace` story (generated output already declares `@adhd/apigen-runtime`
   + `@modelcontextprotocol/sdk`; logical-type deps are added to that same manifest).
4. **Version pinning is part of the wire contract.** The wire is partly produced by the lib (chrono's RFC3339,
   shopspring's `String()`). The generator pins compatible versions, and the **host-manifest records
   `logicalType → {lib, version}`** so the §10 conformance gate runs against the pinned libs — a lib upgrade
   that changes the wire is caught by the vectors, not in production.

### 14.2 Run mode (in-process)

1. **Optional peer deps + lazy registration.** `@adhd/apigen-runtime` declares rich-type libs (e.g.
   `decimal.js`) as **optional peerDependencies**; the corresponding codec registers **only if the lib
   resolves** at startup. A consumer who never uses `Decimal` never installs it and pays nothing.
2. **Fail-fast (ties to BUG-APIGEN-004).** If a surface uses a type whose backing lib is absent, error at
   **startup** with an actionable message — *"function `quote` takes a `Decimal`; install `decimal.js`"* —
   never a cryptic mid-call crash.
3. **Foreign-host run mode is free.** A Python sidecar runs *generated, stdlib-only* code → no install. A
   Rust/Go sidecar resolves crates at build-time via the generated manifest (§14.1).
4. **Branded zero-dep mode (`mode:'branded'`).** Per-type/per-language/per-surface knob: represent a rich type
   as a branded primitive (`type Decimal = string & {__brand}`) with **no runtime lib** when the consumer only
   passes values through — trades rich behavior (arithmetic) for zero deps. Default for TS date-only/time-only/
   duration; opt-in for decimal.

### 14.3 Net dependency posture
- **Python & Java add ~0–1 deps** (stdlib / one Jackson module) — the cheapest hosts to add.
- **TS adds 1** (`decimal.js`), avoidable for temporals via branding.
- **Go adds 2**, **Rust adds ~6** — expected for their ecosystems; all de-facto-standard, curated, pinned.
- The **per-surface minimal-manifest + optional-peer-dep** rules keep a consumer's dependency tree to exactly
  the rich types they actually use — never the full set.

---

## 15. Wrapped backlog bugs

This plan subsumes the fixes for the backlog bugs whose root cause is shared with the logical-type machinery.
Each is folded into a named state + DoD clause; the BACKLOG entries are annotated `tracked-by:
apigen-logical-types`.

| Bug | Relationship | Folded as | DoD clause |
|---|---|---|---|
| **BUG-APIGEN-005** | **is this plan** | all phases | dod.scalar / dod.int64 / dod.nominal / dod.union / dod.crosshost |
| **BUG-APIGEN-004** | shared **fail-fast** machinery | `lt-fail-fast` | dod.fail-fast |
| **BUG-APIGEN-002** | shared **generated-dependency-manifest** machinery | `lt-dep-manifest` | dod.gen-deps |
| BUG-APIGEN-003 | **unrelated** (MCP SSE transport) | — out of scope — | — |

### 15.1 BUG-APIGEN-004 → `lt-fail-fast`
The original bug (extraction yields 0 functions → cryptic `ERR_MODULE_NOT_FOUND` instead of an actionable
halt) and the new logical-types need (a surface uses a rich type whose **optional backing lib** is absent) are
the **same guard**: validate preconditions before invoke, fail fast with an actionable message.
- *Implementation:* extend the `run`/`generate` precondition check (`packages/apigen/cli/src/lib/commands/`)
  to halt on (a) 0 extracted functions, and (b) a used `LogicalTypeId` whose `dep` is unresolved at startup.
- *`[dod.fail-fast]`* — running a surface whose function takes a `Decimal` with `decimal.js` absent errors at
  **startup**: *"function `quote` takes a Decimal; install `decimal.js`"*; and pointing `--source` at a file
  with 0 functions errors with the "looks like generated output / wrong source" message.
  - *negative-control:* remove the guard → the cryptic `ERR_MODULE_NOT_FOUND` / 0-function crash returns → red.

### 15.2 BUG-APIGEN-002 → `lt-dep-manifest`
The logical-types work **requires** the generator to emit real 3rd-party deps (§14.1), which is exactly the
generated-output-portability concern BUG-002 raised. This plan owns the **dependency-manifest emission** slice:
- *Implementation:* the generator collects used logical types → unions their `dep` entries → emits the minimal
  manifest (`package.json` / `Cargo.toml` / `go.mod` / `pom.xml`) + import headers, integrated with the
  existing Option-A publish model and `--link-workspace`.
- *`[dod.gen-deps]`* — a generated surface using `Decimal` declares `decimal.js` in its generated
  `package.json` and runs after a clean install (no `--link-workspace` needed for the published path).
  - *negative-control:* omit the dep from the manifest → the generated server fails to import → red.
- *Scope note:* this plan fixes only the **dep-manifest** slice of BUG-002. The broader publish-model status
  reconciliation (BACKLOG marks BUG-002 OPEN while the apigen-v2 RESUME claims it FIXED via `--link-workspace`)
  remains a **human reconciliation item** — surfaced, not silently resolved here.

---

## 16. Adding a host language (the runbook the enforcement makes binding)

A new host's *entire* obligation, in order — small because the engine, walk, and vectors are shared:

1. **Fill the template column** (§13.2) — the ~10–19 ✗ cells for that language (`encode`/`decode`/`imports`/
   `dep`/`mode`). This is data, not an engine.
2. **Declare deps** — each cell's `dep` feeds both the generated manifest (§14.1) and the host-manifest's
   `type → {lib, version}` pin.
3. **Run the generated conformance harness** — scaffolded by the `lt-host-generator` (§10); it loads the shared
   `vectors.json`, encodes each `seed` (byte-equal to `wire`), decodes + checks `invariants`, and asserts every
   `negativeControl` turns red.
4. **Publish `host-manifest.json`** — `{host, logicalTypeVersion, supportedIds, deps}`; the §10 completeness
   check asserts `supportedIds ⊇ canonical-ids` at the pinned version.
5. **Go green on `apigen:conformance`** — the workspace gate auto-discovers the new manifest and requires the
   full matrix green. Until then the host is non-conformant **by construction** (manifest starts empty).

No transcoder, no engine — *a column, a dep list, and a green harness.*

---

## 17. State breakdown — addendum (codegen-first + wrapped bugs + enforcement)

Supersedes/extends §6 for the codegen-first model. New package + states:

- **New package:** `@adhd/apigen-logical` (`lt-package`, Phase 0) — the canonical table + generate-time
  walk/emitter + run-mode closure builder. Single source of truth.
- **Phase 1 revision:** `lt-transcoder` is replaced by `lt-generator-emit` (the generate-time schema walk →
  glue emitter) + `lt-runmode-closures` (compile-once in-process builder + optional-peer-dep lazy registration).
- **Phase 6 additions:** `lt-dep-manifest` (§15.2 / BUG-002 slice), `lt-fail-fast` (§15.1 / BUG-004 slice).
- **Phase 7 additions:** `lt-host-generator` (§10 scaffolding golden path — emits a new host's harness +
  empty manifest, red by construction) and `lt-conformance-gate` (the workspace `apigen:conformance` target +
  host discovery + the cross-host matrix audit).

Revised totals: **~24 states**, **1 new package + 5 extended**, **~4,500 LOC** (codegen-first removes the
~1,000-LOC runtime transcoder + Python mirror; adds the emitter, dep-manifest, fail-fast, and enforcement
harness).

---

## 18. Open decisions — reconciled against codegen-first

| § | Decision | Status |
|---|---|---|
| 8.1 | Map key encoding | **RESOLVED (2026-06-23, pseudosky)** — `[k,v]` pairs, keys codec-encoded; uniform for non-string keys |
| 8.2 | Decimal host type | **RESOLVED** — `mode:'branded'` string default in TS (zero-dep); real `Decimal`/`BigDecimal`/`rust_decimal`/`shopspring` in Python/Java/Rust/Go; `decimal.js` opt-in for rich TS |
| 8.3 | Cycle policy | **RESOLVED (2026-06-23, pseudosky)** — `strict` default (reject cycles with a diagnostic); opt-in ref-tracking deferred |
| 8.4 | Nominal id stability across hosts | **RESOLVED (mechanism)** — qualified `<namespace>.<Class>`, pinned in the conformance vector + host-manifest |
| 8.5 | Non-reconstructable classes | **RESOLVED (direction)** — gated by the extractor's opt-in-instances flag; encode-only or rejected |
| 8.6 | `logicalTypeVersion` bump policy | **RESOLVED** — any wire-table **or pinned-lib-version** change bumps it; treated as a breaking change to generated clients; conformance vectors regenerate |
| 14 | Per-language dep posture | **RESOLVED** — §14.3 (Python/Java cheapest; Rust heaviest; all pinned + minimal-per-surface) |

**All §8 decisions are now resolved (2026-06-23, pseudosky).** No open human-gate questions remain blocking
authoring — the plan is authoring-ready pending the BUG-005 verification + BUG-003 fix that precede formal
scaffolding.
