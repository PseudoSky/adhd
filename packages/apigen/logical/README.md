# @adhd/apigen-logical

The **contract spine** for apigen's schema-driven, registry-based logical-type
transcoding — one mechanism that round-trips every non-JSON-native value
(well-known scalars like `Date`/`int64`/`decimal`/`bytes`/`UUID`, plus user
classes and discriminated unions) over the JSON wire, identically across host
languages.

> **Status:** contract spine only. This package currently exports **interfaces**
> (the codec/registry/transcoder contracts and the descriptor extension
> vocabulary). Codec bodies, the schema-walking transcoder, and per-host
> bindings are later plan states — see
> [`docs/plan/apigen-logical-types/DESIGN.md`](../../../docs/plan/apigen-logical-types/DESIGN.md)
> §4/§5/§11–§14.

- **Platform:** `shared` (pure TypeScript — safe in a Node CLI and a browser).
- **Layer:** `logic`.

## Surface

| Export | What it is |
| --- | --- |
| `LogicalTypeId`, `LogicalKind`, `Wire`, `SchemaNode` | Core type aliases (DESIGN §4.2). |
| `TranscodeCtx`, `LogicalTypeCodec` | The host-agnostic codec contract (DESIGN §4.2). |
| `LogicalTypeRegistry`, `createRegistry`, `CodecRegistryError` | The registry contract + minimal dup-detecting stub (DESIGN §4.3). |
| `Transcoder` | The schema-walking transcoder **interface** (impl is a later state, DESIGN §4.4). |
| `ENVELOPE_KEY`, `ApigenEnvelope` | The self-describing envelope for schema-less positions (DESIGN §4.5). |
| `TemplateCell` | Per-language codegen cell shape (DESIGN §13.1). |
| `X_APIGEN_*`, `LOGICAL_TYPE_VERSION`, `logicalKindOf`, `codecIdOf` | Descriptor extension vocabulary + advisory hint readers (DESIGN §4.1). |

## Invariant `[inv:hints-advisory]`

The `x-apigen-*` descriptor keys are **optional** dispatch accelerators —
structure (`format`/`$ref`/`oneOf`) is authoritative. `logicalKindOf` and
`codecIdOf` therefore return `undefined` (never throw) when a key is absent or
malformed; correctness must never depend on a hint being present.
