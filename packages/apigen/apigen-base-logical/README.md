# @adhd/apigen-base-logical

The **contract spine** for apigen's schema-driven, registry-based logical-type
transcoding — one mechanism that round-trips every non-JSON-native value
(well-known scalars like `Date`/`int64`/`decimal`/`bytes`/`UUID`, plus user
classes and discriminated unions) over the JSON wire, identically across host
languages.

> **Status:** contract spine only. This package currently exports **interfaces**
> (the codec/registry/transcoder contracts and the descriptor extension
> vocabulary). Codec bodies, the schema-walking transcoder, and per-host
> bindings are later plan states — see
> [`docs/plan/apigen-base-logical-types/DESIGN.md`](../../../docs/plan/apigen-base-logical-types/DESIGN.md)
> §4/§5/§11–§14.

- **Platform:** `shared` (pure TypeScript — safe in a Node CLI and a browser).
- **Layer:** `logic`.

## Surface

| Export                                                             | What it is                                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `LogicalTypeId`, `LogicalKind`, `Wire`, `SchemaNode`               | Core type aliases (DESIGN §4.2).                                                  |
| `TranscodeCtx`, `LogicalTypeCodec`                                 | The host-agnostic codec contract (DESIGN §4.2).                                   |
| `LogicalTypeRegistry`, `createRegistry`, `CodecRegistryError`      | The registry contract + minimal dup-detecting stub (DESIGN §4.3).                 |
| `Transcoder`                                                       | The schema-walking transcoder **interface** (impl is a later state, DESIGN §4.4). |
| `ENVELOPE_KEY`, `ApigenEnvelope`                                   | The self-describing envelope for schema-less positions (DESIGN §4.5).             |
| `TemplateCell`                                                     | Per-language codegen cell shape (DESIGN §13.1).                                   |
| `X_APIGEN_*`, `LOGICAL_TYPE_VERSION`, `logicalKindOf`, `codecIdOf` | Descriptor extension vocabulary + advisory hint readers (DESIGN §4.1).            |

## Invariant `[inv:hints-advisory]`

The `x-apigen-*` descriptor keys are **optional** dispatch accelerators —
structure (`format`/`$ref`/`oneOf`) is authoritative. `logicalKindOf` and
`codecIdOf` therefore return `undefined` (never throw) when a key is absent or
malformed; correctness must never depend on a hint being present.

## Schema example synthesis (shipped, unlike the contract-spine surface above)

`synthesizeExample(schema)` / `renderExampleNote(schema)` — generates a
concrete, plausible example value from any JSON Schema: walks `properties`/
`required`, resolves `$ref` against the schema's own `definitions`/`$defs`,
picks a `oneOf`/`anyOf` branch, merges `allOf`, and produces format-aware
placeholders (`date-time`, `uuid`, `email`, `decimal`, `int64`, `byte`, etc.)
that satisfy `ajv-formats`. Every synthesized shape round-trips through real
AJV validation in this package's own tests.

This exists to solve a concrete discoverability problem: an apigen-mounted
MCP tool's description/error used to only describe the *shape* of a valid
call ("all domain parameters go inside a `data` envelope"), never a *worked
example* with real field names — so callers repeatedly got the call shape
wrong on the first try. `renderExampleNote` is consumed by:

- `@adhd/apigen-engine-runtime`'s `buildToolDescription` — appends a
  synthesized example to every apigen-mounted tool's description.
- `@adhd/apigen-engine-runtime`'s validate-Layer — appends the same
  synthesized example to AJV validation-failure error messages, so a
  rejected call comes back with both what was wrong *and* a working example.

Because synthesis is schema-driven (not hand-written per tool), it covers
every current and future apigen-mounted MCP tool automatically, including
mount-derived tools (e.g. `apigen-plugin-batch`'s `_batch/<kind>` mounts)
whose top-level shape differs from the `{data:{...}}` envelope regular
extracted operations use — the synthesized example always reflects each
tool's own real, advertised schema, never an assumed universal convention.

```ts
import { renderExampleNote } from '@adhd/apigen-base-logical';

renderExampleNote(someOperation.input);
// → 'Example: {"data":{"input":{"family":"<string>","title":"<string>","body":"<string>","repo":"<string>"}}}'
```
