# `@adhd/environment-base-spec` — Contract Specification

> **Status:** v0.0.5. Canonical, cross-language contract for the `@adhd/environment`
> package family. This document + `adhd-environment.schema.json` +
> `cross-language-test-vectors.json` together are the single source of truth
> every other package (TypeScript, Python, Rust) builds against.
>
> Source of authority, in order: `docs/plan/adhd-environment/SCOPE.md` (project
> scope) → `docs/plan/adhd-environment/interfaces-architect.md` §2 (reference
> type layout) → this file + the two sibling JSON artifacts (the executable
> contract).

## 1. What this package is

`environment-base-spec` is a **types-only, zero-runtime-dependency** package.
It has no build logic, no I/O, no CLI. It exists so that:

1. Every other `environment-*` package (`environment-builder`,
   `environment-core-node`, `environment-core-py`, `environment-core-rs`,
   `environment-cli`) shares one canonical set of TypeScript interfaces
   instead of redeclaring them.
2. Four pure functions that MUST behave identically in TypeScript, Python,
   and Rust (`contentHash`, `projectEnvPrefix`, `inferEnvVar`,
   `generateFieldSchema`) have exactly one authoritative definition + a
   pinned set of input/output vectors every language implementation is
   graded against.
3. The on-disk snapshot format (`adhd-environment.json`, written by the
   builder, read by every runtime client) has exactly one schema
   (`adhd-environment.schema.json`) that all three languages validate
   against, directly or via a generated equivalent.

## 2. File map

| File | Role |
|---|---|
| `src/index.ts` | Canonical TypeScript types + the four pure primitives. |
| `spec/adhd-environment.schema.json` | JSON Schema (draft 2020-12) for the on-disk snapshot (`SnapshotData`). |
| `spec/cross-language-test-vectors.json` | Pinned input → output vectors for the four primitives. TS/Python/Rust test suites all read this same file. |
| `spec/SPEC.md` | This document. |

## 3. The snapshot format (`SnapshotData` / `adhd-environment.schema.json`)

A built snapshot is a single JSON object written atomically to
`~/.<orgNamespace>/<project>/<namespace>/adhd-environment.json` (see
`contexts/_shared.md` `[def:orgNamespace]` / `[def:namespace]`). Top-level
shape (required, in schema property order):

| Field | Type | Meaning |
|---|---|---|
| `version` | `string` (semver) | Snapshot format version. Currently `SPEC_VERSION = "0.0.5"`. |
| `libraryVersion` | `string` | Version of the builder that produced the snapshot. |
| `generatedAt` | `string` (ISO-8601) | Build timestamp. |
| `project` | `ProjectIdentity` | `{ name, orgNamespace, envPrefix, namespace, description? }` — who/where. |
| `config` | `object` | Fully resolved, **nested** config (dot-paths expanded into objects). |
| `raw` | `Record<string,string>` | Flat, un-nested config (`"db.path"` → value). Hashing/lookup source. |
| `fieldSchema` | `object \| null` | `generateFieldSchema()` output describing `config`'s shape; `null` if no fields declared. |
| `configHash` | `string` | `contentHash(raw)`. |
| `structureHash` | `string` | Hash of directory *structure* (`type:name:scope` tuples), not absolute paths. Computed by `environment-builder`, not this package. |
| `dirs` | `ResolvedDirectoryEntry[]` | Fully-resolved, absolute directory paths. |
| `provenance` | `Record<string,ProvenanceEntry>` | Per-field: where its value came from. |
| `envVars` | `Record<string,string>` | Env var values actually read at build time. |

`ProjectConfig` / `YamlFieldDefinition` / `DirectoryEntry` (authoring-time, as
written in `adhd.environment.yaml`) and `ConfigFieldDefinition` /
`ResolvedDirectoryEntry` (build-time, resolved) are distinct type families —
see `src/index.ts` sections 3–9 and the matching `$defs` in the schema. The
schema is authoritative for wire shape; `src/index.ts` mirrors it field for
field, so a change to one without the other is a contract break.

`EnvironmentSnapshot` is exported from this package **as a type alias for
`SnapshotData`** — the data shape only. The `EnvironmentSnapshot` *class*
(with `.set()` / `.get()` / `.configPath` / `.write()` behavior) is owned by
`@adhd/environment-builder` (interfaces-architect.md §3.4); this package
supplies no behavior, only shapes.

## 4. Cross-language pure primitives

All four functions are deterministic, side-effect-free, and take/return only
JSON-serializable values (or `Record<string,string>` / plain objects). Each
has a pinned set of vectors in `cross-language-test-vectors.json` keyed by
function name; Python and Rust ports MUST load and pass the identical file.

### 4.1 `contentHash(config: Record<string,string>): string`

**Serialization format `v2` (length-prefixed, injective).** Bumped from the
original `key=value\n` form (`v1`) which was non-injective — a value
containing `\n` or `=` collided with a structurally different map (ENV-CORE-004:
`contentHash({a:"1\nb=2"}) === contentHash({a:"1",b:"2"})`). Every pinned
digest in `cross-language-test-vectors.json` is a `v2` digest
(`contentHashFormatVersion: 2`).

**Algorithm:**
1. Reject any key or value containing a **lone surrogate** (an unpaired
   UTF-16 surrogate, U+D800–U+DFFF) with `LoneSurrogateError` — see §4.5.
2. `Object.keys(config)`, sorted ascending by **Unicode code point**. This is
   the canonical order (ENV-CORE-002). Python `sorted()` and Rust `str::cmp`
   already order by code point / UTF-8 byte order; TypeScript's default
   `Array.prototype.sort()` and `String.prototype.localeCompare` order by
   UTF-16 **code unit**, which places astral-plane characters (≥ U+10000,
   lead surrogate 0xD800–0xDBFF) *before* BMP characters in U+E000–U+FFFF —
   so the TS port must sort by explicit code-point comparison
   (`Array.from(k)` + `codePointAt`), NOT `localeCompare`.
3. For each key `k`, let `lk` / `lv` be the **UTF-8 byte lengths** of `k` and
   `config[k]`, and emit the line `` `${lk}:${k}=${lv}:${config[k]}\n` ``
   (every line, including the last, carries its own trailing `\n`).
4. Concatenate all lines — no additional separator between them.
5. UTF-8 encode, SHA-256, hex-encode the digest.
6. Prefix the hex digest with `"sha256-"`.

The byte-length prefixes are what make the encoding **injective**: a decoder
reads exactly `lk`/`lv` bytes for the key/value, so a `=` or `\n` occurring
*inside* a key or value can never be mistaken for a structural delimiter.

**Worked example:** `contentHash({ b: "2", a: "1" })` sorts to keys
`["a", "b"]`, serializes to `"1:a=1:1\n1:b=1:2\n"`, and hashes to
`sha256-66e4efebc74d002dabcf821c0ee1402726e5c9d25a8469e7fc3f7d7691464788`.

> **Plan-document discrepancy (flagged, not silently patched):**
> `docs/plan/adhd-environment/contexts/_shared.md` (`[def:contentHash]`),
> `contract-base-spec.md` (Delta Spec item 2), and
> `scripts/criteria.json` (`audit-final.6`) pin this example to
> `sha256-9f86d081…` — the SHA-256 of the literal string `"test"`, a
> placeholder never computed from the documented algorithm. It was
> superseded once by the `v1` computed value (`sha256-4a73850f…`) and again,
> here, by the `v2` injective value above. Those three plan documents remain
> to be corrected in a follow-up plan-doc fix (out of scope for the
> `packages/environment` source tree). The vectors file is **generated** from
> the reference implementation (see §8), so it can never disagree with the
> code.

### 4.2 `projectEnvPrefix(projectName: string): string`

Uppercase the project name, fold every `-` **and** `.` to `_`, prepend
`"ADHD_"`. Folding both separators (ENV-CORE-003) guarantees a legal POSIX
env-var name even for dotted project names, and matches `inferEnvVar`, which
already folds both. (Previously TS and Python folded only `-`, emitting the
illegal `ADHD_FOO.BAR` for `"foo.bar"`; Rust already folded both — Rust's
behaviour is now canonical.)

```
projectEnvPrefix("agent-mcp")     // → "ADHD_AGENT_MCP"
projectEnvPrefix("decompile-cli") // → "ADHD_DECOMPILE_CLI"
projectEnvPrefix("foo.bar")       // → "ADHD_FOO_BAR"
```

### 4.3 `inferEnvVar(prefix: string, fieldPath: string): string`

Uppercase `fieldPath`, replace every `.` **and** `-` with `_`, prepend
`` `${prefix}_` ``. (Per `_shared.md` `[def:inferEnvVar]`, which folds both
separators — the more complete of the two plan descriptions; see `src/index.ts`
JSDoc for the interfaces-architect.md §2.4 cross-reference.)

```
inferEnvVar("ADHD_AGENT_MCP", "db.path")             // → "ADHD_AGENT_MCP_DB_PATH"
inferEnvVar("ADHD_AGENT_MCP", "provider-key.secret") // → "ADHD_AGENT_MCP_PROVIDER_KEY_SECRET"
```

An explicit per-field `env:` override in the YAML replaces this inferred
name entirely; that substitution is applied by `environment-builder`'s
`field-merge` step, not by this function.

### 4.4 `generateFieldSchema(fields: Record<string, YamlFieldDefinition>): object`

Converts a flat map of dot-path field definitions into a nested JSON Schema
object. Each flat key is split on `.`; every non-terminal segment becomes an
intermediate `{ type: "object", properties: {...} }` node (shared/reused
across fields with a common parent); the terminal segment receives a
JSON-Schema property built from the definition's genuine JSON-Schema
keywords only (`type`, `default`, `description`, `minimum`, `maximum`,
`enum`, `pattern`, `minLength`, `maxLength`, `items`). adhd-specific
metadata (`env`, `scope`, `secret`, `noEnv`) is intentionally **not** copied
into the generated schema — it configures resolution, not value validation.

adhd-specific metadata (`env`, `scope`, `secret`, `noEnv`) is **dropped** from
the generated schema (ENV-CORE-001). Copying the leaf verbatim (the old
Python/Rust behaviour) leaked which fields are secrets and their env-var
names into any emitted schema. All three ports now apply the same whitelist.

```
generateFieldSchema({ "server.port": { type: "integer", minimum: 1024 } })
// → { type: "object",
//     properties: { server: { type: "object",
//                              properties: { port: { type: "integer", minimum: 1024 } } } } }
```

### 4.5 Lone surrogates (`LoneSurrogateError`)

A `contentHash` key or value containing a lone (unpaired) UTF-16 surrogate
(U+D800–U+DFFF) is **rejected** with a typed `LoneSurrogateError` in TypeScript
and Python (ENV-CORE-005). Such a string is not well-formed Unicode and has no
canonical UTF-8 encoding; the old ports diverged (TS silently substituted
U+FFFD via `TextEncoder`; Python raised a raw `UnicodeEncodeError`). Rust
`String`/`&str` cannot represent a lone surrogate at all, so the condition is
unreachable there by construction — the Rust suite skips the surrogate error
vector, which the vectors file encodes via `inputKeyCodeUnits` (not a literal
JSON string, which `serde_json` would reject outright).

## 5. Invariants

- **Schema is the single source of truth.** `src/index.ts`'s `SnapshotData`
  (and its constituent types) must match `adhd-environment.schema.json`
  exactly. A change to one without the other is a contract break.
- **Test vectors are the cross-language gate.** Never change an expected
  value in `cross-language-test-vectors.json` without updating all three
  language clients (TS/Python/Rust) in the same change. Add new vectors
  freely; never mutate a pinned one silently.
- **Zero runtime dependencies.** This package uses only `node:crypto`
  (TypeScript builtin) — no npm dependencies (`package.json`
  `"dependencies": {}`). The Python and Rust ports use only their respective
  standard hashing libraries (`hashlib`, `sha2`).
- **Types only, no behavior.** This package exports type declarations and
  four pure functions. It performs no file I/O, no env var reads, no YAML
  parsing — those live in `environment-builder` and the runtime clients.

## 6. Consumers

| Package | What it imports from here |
|---|---|
| `environment-builder` | All types (re-exported under the same names) + `contentHash`, `projectEnvPrefix`, `inferEnvVar`, `generateFieldSchema` (wraps the latter with a scope-aware variant). |
| `environment-core-node` (`@adhd/environment`) | `SnapshotData`, `EnvironmentParams`, `ProvenanceEntry`, `DirectoryEntry`/`ResolvedDirectoryEntry`, `DeepPath`, and re-exports `contentHash` for `audit-final.6`-style consumers. |
| `environment-core-py` / `environment-core-rs` | No direct import (different language) — must reproduce `contentHash`, `projectEnvPrefix`, `inferEnvVar`, `generateFieldSchema` byte-for-byte per §4 above and pass `cross-language-test-vectors.json`. |
| `environment-cli` | Transitively, via `environment-builder` / `environment-core-node`. |

## 7. Secret handling (credential redaction)

A resolved snapshot MUST NEVER persist the plaintext value of a `secret: true`
field (ENV-CORE-009). Instead it stores a **reference**: the reserved-prefix
string `` `${SECRET_REF_PREFIX}${ENV_VAR}` `` (i.e.
`"adhd-secret-ref:<ENV_VAR>"`), where `<ENV_VAR>` is the field's effective
env-var name. The reference is a plain string so it is representable both in
the nested `config` (a JSON value) and in the flat `raw` map (whose values are
strings in every port, including Rust's `BTreeMap<String,String>`).

- **Write side** (`environment-builder`): `redactSecrets(raw, fields)` replaces
  each secret field's value with its reference *before* the snapshot is
  assembled and hashed. `configHash` is therefore computed over the redacted
  `raw` and never depends on a secret's plaintext.
- **Read side** (every runtime client's `Environment.get`): when a resolved
  `config.*` value is a secret reference, the client resolves the live value
  from the process environment (`process.env` / `os.environ` /
  `std::env::var`), returning `undefined`/`None` when the env var is unset.

The snapshot file itself is written owner-only: mode `0o600`, in a `0o700`
parent directory, via an atomic tmp-write that is `unlink`ed on failure so no
stale, more-permissive `.tmp` survives a mid-write crash (ENV-CORE-010/011).

## 8. Cross-language conformance vectors (generation)

`spec/cross-language-test-vectors.json` is the single gate all three ports are
graded against. It is **generated**, never hand-authored:
`generateCrossLanguageVectors()` (exported from `src/index.ts`) runs the real
primitives and emits every vector's `expected` (or, for a specified failure
case, its `error` name). This is what prevents the class of bug that let
ENV-CORE-001/002/003 ship green — a pure vector-replay suite cannot fail when
a port diverges from a pinned string that one impl produced, but it *can* fail
when graded against inputs the reference implementation actually computed.

- **Regenerate:** build `environment-base-spec` and write
  `generateCrossLanguageVectors()`'s JSON output to the file (see the
  generator's own doc comment). A drift guard in `environment-builder`'s test
  suite asserts the committed file deep-equals a fresh generation, so a stale
  file fails CI.
- **Consume:** the Python (`test_cross_language_vectors.py`) and Rust
  (`lib.rs` tests) suites load the committed file and assert their ports
  reproduce every vector, including the adversarial cases (astral-plane key
  ordering, dotted project names, secret-leaf metadata stripping,
  `\n`/`=`-bearing values, Unicode case folding, and the lone-surrogate error
  case).
- **Error vectors:** a vector with `error` instead of `expected` is a
  specified failure. Inputs that cannot be portably JSON-serialized (a lone
  surrogate) are carried as `inputKeyCodeUnits` + `inputValue`; a port that
  cannot even construct the input (Rust) skips only those.
