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

**Algorithm:**
1. `Object.keys(config)`, sorted ascending (code point / lexicographic order).
2. For each key `k` in that order, emit the line `` `${k}=${config[k]}\n` ``
   (every line, including the last, carries its own trailing `\n`).
3. Concatenate all lines — no additional separator between them.
4. UTF-8 encode, SHA-256, hex-encode the digest.
5. Prefix the hex digest with `"sha256-"`.

**Worked example:** `contentHash({ b: "2", a: "1" })` sorts to keys
`["a", "b"]`, serializes to `"a=1\nb=2\n"`, and hashes to
`sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930`.

> **Known plan discrepancy (flagged, not silently patched):**
> `docs/plan/adhd-environment/contexts/_shared.md` (`[def:contentHash]`) and
> `docs/plan/adhd-environment/contexts/contract-base-spec.md` (Delta Spec
> item 2) pin this exact example to
> `sha256-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08`.
> That value is the well-known SHA-256 digest of the literal string
> `"test"` — independently verified via both `shasum -a 256` and Python
> `hashlib` — and does not correspond to any reasonable canonicalization of
> `{b:"2",a:"1"}` (~75 separator/ordering/JSON variants were brute-forced
> while implementing this contract; none produced it). It is a placeholder
> that was never actually computed from the documented algorithm. This
> package implements the algorithm **as documented** and pins the
> **correct, computed** value
> (`sha256-4a73850f...0d930`, in full above) in
> `cross-language-test-vectors.json`. The wrong value also appears as a hard
> automated gate in `docs/plan/adhd-environment/scripts/criteria.json`
> (`audit-final.6`) and must be corrected there, in `_shared.md`, and in
> `contract-base-spec.md` in a follow-up plan-doc fix — see the executor
> report for `contract-base-spec` for the explicit flag to the orchestrator.

### 4.2 `projectEnvPrefix(projectName: string): string`

Uppercase the project name, replace every `-` with `_`, prepend `"ADHD_"`.

```
projectEnvPrefix("agent-mcp")     // → "ADHD_AGENT_MCP"
projectEnvPrefix("decompile-cli") // → "ADHD_DECOMPILE_CLI"
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

```
generateFieldSchema({ "server.port": { type: "integer", minimum: 1024 } })
// → { type: "object",
//     properties: { server: { type: "object",
//                              properties: { port: { type: "integer", minimum: 1024 } } } } }
```

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
