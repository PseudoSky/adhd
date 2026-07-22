# adhd-environment Feature Inventory
## v0.0.5 — Complete Raw Feature & Concept Extraction

> Source plan directory: `docs/plan/adhd-environment/`
> Produced: 2026-07-17T18:15:08Z
> Scope: All files in the plan directory extracted. Focus is on what is NEW or
> ADDITIONAL to what already exists in `packages/agent/*` and `packages/dispatch/*`.
> This is NOT a re-list of what's already in packages — it captures the environment
> configuration SDK itself and its plan structure.

---

## Table of Contents

1. [Architecture & Package Design](#1-architecture--package-design)
2. [YAML Static Spec Format (`adhd.environment.yaml`)](#2-yaml-static-spec-format-adhdenvironmentyaml)
3. [Builder Pipeline (EnvironmentSnapshot)](#3-builder-pipeline-environmentsnapshot)
4. [Runtime Client (Environment\<T\>)](#4-runtime-client-environmentt)
5. [CLI (`adhd-env`)](#5-cli-adhd-env)
6. [Scope Cascade & Field Inheritance](#6-scope-cascade--field-inheritance)
7. [Directory Registry (Type-First)](#7-directory-registry-type-first)
8. [Env Var Inference & Naming](#8-env-var-inference--naming)
9. [Content & Structure Hashing](#9-content--structure-hashing)
10. [Provenance Tracking](#10-provenance-tracking)
11. [JSON Schema Generation (`fieldSchema`)](#11-json-schema-generation-fieldSchema)
12. [Cross-Language Parity (Python + Rust)](#12-cross-language-parity-python--rust)
13. [Validation & Drift Detection](#13-validation--drift-detection)
14. [Agent-MCP Refactor (Demonstration Target)](#14-agent-mcp-refactor-demonstration-target)
15. [Audit Infrastructure & Guard Scripts](#15-audit-infrastructure--guard-scripts)
16. [Plan State Machine & Orchestration](#16-plan-state-machine--orchestration)
17. [Known Defects & Gaps (BACKLOG)](#17-known-defects--gaps-backlog)
18. [Key Interfaces & Types](#18-key-interfaces--types)

---

## 1. Architecture & Package Design

### High-Level Concept

`@adhd/environment` is a **multi-language centralized configuration management
system** for the ADHD monorepo. It replaces hand-written Zod schemas + dotenv
loading + manual env var mapping with a single checked-in YAML config file
(`adhd.environment.yaml`), a CLI builder (`adhd-env build`), and thin typed
runtime clients in TypeScript, Python, and Rust.

The core design principle: **build-time engine, not a runtime framework**.
Config resolution, validation, hashing, and directory creation happen once
during `adhd-env build`. Runtime clients (~40–60 lines each) just read the
resulting JSON snapshot and expose typed accessors. [README.md][1]

### Six-Package Layout

All packages live under `packages/environment/` except the CLI (which is at
`entrypoint/environment-cli/`):

| Package | npm/PyPI/Cargo | Language | Purpose |
|---------|---------------|----------|---------|
| `environment-base-spec` | `@adhd/environment-base-spec` | TS (JSON Schema + types) | Contract package: JSON Schema, cross-language test vectors, SPEC.md |
| `environment-builder` | `@adhd/environment-builder` | TS (Node) | Internal builder engine: YAML parser, field merge, config resolver, JSON Schema gen, provenance, validation, snapshot writer |
| `environment-core-node` | `@adhd/environment` | TS (Node) | Thin TypeScript runtime client (~50 lines) — reads snapshot, exposes typed `get()` |
| `environment-core-py` | `adhd-environment` | Python (≥3.10) | Thin Python runtime client (~40 lines) |
| `environment-core-rs` | `adhd-environment` | Rust (edition 2021) | Thin Rust runtime client (~50 lines) |
| `environment-cli` | `@adhd/environment-cli` | TS (Node, apigen-generated) | CLI wrapping the builder — 9 commands |

[interfaces-architect.md §1][2], [SCOPE.md §2][3], [SPEC_0.0.5.md][4]

### Architectural Invariants

- **No Zod anywhere.** Validation keywords live directly in field definitions;
  JSON Schema is auto-generated. [SCOPE.md §3][5]
- **No `.env` file.** Secrets and config values set via `adhd-env set` command,
  stored in a builder internal store. [SCOPE.md §3][5]
- **CLI is sole builder and setter.** No `EnvironmentBuilder` class in any
  runtime client. [SCOPE.md §3][5]
- **Thin runtime clients.** No builder logic, no `.env` loading, no validation,
  no directory creation, no schema generation in the runtime `Environment` class.
  [SCOPE.md §5][6], [CURRENT_CONFIG_PATTERNS.md][7]
- **Atomic snapshot writes.** `.tmp` + `renameSync` — never a partial file.
  [SPEC_0.0.0.md §1][8]
- **Package identity:** The TS runtime client publishes as `@adhd/environment`
  (NOT `@adhd/environment-core-node`). The `tsconfig.base.json` alias and
  `package.json` `name` must agree. [contexts/_shared.md][9]
- `contentHash` test vector is the cross-language gate.
  [SPEC_0.0.0.md §5][10]
- `<group>-<layer>-<name>` monorepo naming convention.
  [SCOPE.md §3][5]

### Package Dependencies

```
environment-base-spec       — no deps
environment-builder         — depends on: yaml, ajv, environment-base-spec (types)
environment-core-node       — depends on: environment-base-spec (types only)
environment-cli             — depends on: environment-builder, environment-core-node, apigen
environment-core-py         — depends on: jsonschema, pyyaml (for snapshot reading)
environment-core-rs         — depends on: serde, serde_json, sha2, jsonschema
```

[TOOLS.md §6][11], [interfaces-architect.md §1][2]

---

## 2. YAML Static Spec Format (`adhd.environment.yaml`)

### Purpose

The single source of truth for a project's entire environment. Checked into the
project repo. Read by `adhd-env build`. Human-writable without TypeScript
tooling, supports comments (unlike JSON), language-agnostic.

[SPEC_0.0.4.md §Design Changes — Change 1][12]

### Structure

```yaml
project:
  name: agent-mcp              # Required. kebab-case project name.
  description: ...              # Optional.
  orgNamespace: adhd            # Optional. Defaults to "adhd". Feeds ~/.<org>/<project>/...
  envPrefixOverride: ADHD_AGENT # Optional. When absent, inferred from project name.

namespaces:                     # Optional. When absent, defaults to "default".
  - production                  #   When listed, only these are valid.
  - staging

dirs:                           # Optional. Directory catalog.
  - name: primary               # Optional name for disambiguation.
    type: state.data            # Required. Dot-path directory type.
    scope: project              # Required. "system" | "global" | "project".
    description: ...            # Optional.

config:
  system:                       # Framework-shipped defaults. Lowest priority.
    log.level:
      default: info             # Required. Always string in YAML.
      type: string              # Optional. "string"|"integer"|"number"|"boolean"|"path"|"array"
      enum: [debug, info, ...]  # Optional.
    server.maxDepth:
      default: "5"              # String in YAML, cast to integer by builder.
      type: integer
      minimum: 1                # Optional validation keyword.
  global:                       # Org-wide defaults. Mid priority.
    log.format:
      default: json
      type: string
      enum: [json, pretty]
  project:                      # Project-specific. Highest priority.
    db.path:
      default: ${HOME}/.adhd/.../agents.db
      type: path
    server.port:
      default: "3000"
      type: integer
      minimum: 1024
      maximum: 65535
    providers.openai.secret:
      default: ""
      type: string
      env: OPENAI_API_KEY       # Optional override for inferred env var name.
```

[SPEC_0.0.4.md §Flow 1][13], [SPEC_0.0.4.md §YAML Format Reference][14]

### YAML Field Definition Reference

| YAML key | Required | Type | Description |
|----------|----------|------|-------------|
| `default` | **Yes** | `string` | Default value when env var is unset. May contain `${VAR}` refs. Always string — builder casts. |
| `env` | No | `string` | Env var name override. When absent, inferred from `envPrefix` + field path. Completely replaces inferred name when present. |
| `type` | No | `string` enum | `"string"`, `"integer"`, `"number"`, `"boolean"`, `"path"`, `"array"`. Drives coercion and validation. |
| `minimum` | No | `number` | Minimum value (integer/number types) |
| `maximum` | No | `number` | Maximum value |
| `enum` | No | `unknown[]` | Allowed values |
| `pattern` | No | `string` | Regex pattern (string type only) |
| `minLength` | No | `number` | Minimum string length |
| `maxLength` | No | `number` | Maximum string length |
| `items` | No | `{ type: string }` | Array item type |
| `secret` | No | `boolean` | Marks field as sensitive (not logged) |
| `noEnv` | No | `boolean` | Suppresses env var inference entirely — field only settable via `adhd-env set` or default |
| `scope` | No | `string` | Field-level scope override (rare) |
| `description` | No | `string` | Documentation |

[SPEC_0.0.4.md §Field Definition Reference][15], [interfaces-architect.md §2.1.4][16]

### YAML Type Coercion Rules

| `type` | YAML value | Resolved value | Notes |
|--------|-----------|----------------|-------|
| `string` | `"hello"` | `"hello"` | Passed through |
| `integer` | `"3000"` | `3000` | `parseInt()`, must be valid |
| `number` | `"3.14"` | `3.14` | `parseFloat()` |
| `boolean` | `"true"` | `true` | `"true"`/`"false"` (case-insensitive) |
| `path` | `"${HOME}/.adhd/db"` | `"/Users/nix/.adhd/db"` | Interpolated, no trailing slash |
| `array` | `"a,b,c"` | `["a","b","c"]` | Split on comma |
| _(none)_ | `"hello"` | `"hello"` | Treated as string |

[SPEC_0.0.4.md §YAML Type Coercion][17]

---

## 3. Builder Pipeline (`EnvironmentSnapshot`)

### Package: `environment-builder`

Internal engine behind `adhd-env build`. NOT a user-facing API. Lives at
`packages/environment/environment-builder/`. [SPEC_0.0.4.md §Builder Package Architecture][18]

### Module Structure

```
src/
  index.ts                    — barrel: exports build(), EnvironmentSnapshot, parseYamlSpec, etc.
  yaml-parser.ts              — parseYamlSpec(filePath) → ParsedYamlSpec
  field-merge.ts              — mergeFieldDefinitions(system, global, project) → ConfigFieldMap
  config-resolver.ts          — resolveConfig, interpolateValue, unflatten, readStore
  json-schema-gen.ts          — generateFieldSchema(fields) → JSON Schema
  provenance.ts               — trackProvenance(resolved) → Record<string, ProvenanceEntry>
  validation.ts               — validateConfig(config, schema) → void | throws
  snapshot-writer.ts          — atomicWrite, resolveConfigPath, resolveDirs
  environment-snapshot.ts     — build() factory, EnvironmentSnapshot class
  __tests__/                  — unit tests for each module
```

[interfaces-architect.md §3.1][19]

### `build()` Factory Function

```typescript
function build<T = Record<string, unknown>>(
  spec: ParsedYamlSpec | EnvironmentSnapshot,
  options?: BuildOptions,
): EnvironmentSnapshot<T>
```

**17-step pipeline:**

| Step | Function | What it does |
|------|----------|-------------|
| 1 | (inline) | Parse source: if `EnvironmentSnapshot`, read YAML from configPath |
| 2 | `projectEnvPrefix` | Resolve org namespace and env prefix |
| 3 | (inline) | Validate namespace against declared list |
| 4 | `mergeFieldDefinitions` | Merge system → global → project field definitions |
| 5 | `readStore` | Load stored values from `adhd-env set` store |
| 6 | `inferEnvVar` | Infer env var names for fields without explicit `env` |
| 7 | `resolveConfig` | Resolve each field: env var → store → default |
| 8 | (inline) | Preserve overrides when rebuilding from existing snapshot |
| 9 | `interpolateValue` | Expand `${VAR}` references (single-level) |
| 10 | `unflatten` | Convert flat dot-path map to nested object |
| 11 | (inline) | Type-coerce values per field definitions |
| 12 | `generateFieldSchema` | Generate JSON Schema from merged field definitions |
| 13 | `validateConfig` | Validate nested config against fieldSchema (ajv) |
| 14 | `contentHash` / `structureHash` | Compute both hashes |
| 15 | `resolveDirs` | Resolve directory paths with namespace/org |
| 16 | (inline) | Read existing snapshot, detect drift |
| 17 | `EnvironmentSnapshot` | Build and return instance |

[interfaces-architect.md §7][20]

### `EnvironmentSnapshot<T>` Class

```typescript
class EnvironmentSnapshot<T = Record<string, unknown>> {
  readonly configPath: string;     // Resolved output path
  readonly options: BuildOptions;

  constructor(data: SnapshotData, configPath: string, options: BuildOptions);

  // Typed getter — returns DeepPath<T, K> when generic is provided
  get<K extends string>(path: K): DeepPath<T, K>;
  // Untyped fallback
  get(path: string): unknown;

  // Typed setter — mutates in memory (no validation until write)
  set<K extends string>(path: K, value: DeepPath<T, K>): void;
  // Untyped fallback
  set(path: string, value: unknown): void;

  // Validate + atomic write to configPath. Throws on validation failure.
  write(opts?: { skipValidation?: boolean }): void;

  // Deep clone the internal snapshot data
  toJSON(): SnapshotData;
}
```

[interfaces-architect.md §3.4][21], [TOOLS.md §C16][22]

### BuildOptions

```typescript
interface BuildOptions {
  namespace?: string;       // Default: "default"
  scope?: ConfigScope;      // When set, only fields from that scope resolved
  adhdRoot?: string;        // Default: os.homedir()/.adhd
  configPath?: string;      // Custom snapshot output path
  dryRun?: boolean;         // Skip disk writes
}
```

[interfaces-architect.md §2.1.8][23]

### Internal Store Format

The `adhd-env set` command stores values in a simple JSON file:

```
Path: <adhdRoot>/<orgNamespace>/<project>/<namespace>/.adhd-store.json
```

```json
{
  "version": "0.0.5",
  "values": {
    "providers.openai.secret": "sk-...",
    "providers.openai.model": "gpt-4o"
  },
  "updatedAt": "2026-07-08T12:00:00.000Z"
}
```

Store is **flat** (dot-path keys → string values). Type coercion happens at
build time. [interfaces-architect.md §8][24]

---

## 4. Runtime Client (`Environment<T>`)

### TypeScript (`@adhd/environment`)

~50 lines. Reads snapshot JSON from disk, provides typed accessors.
No builder logic, no `.env`, no validation, no disk writes.

```typescript
class Environment<T = Record<string, unknown>> {
  readonly project: string;
  readonly namespace: string;
  readonly orgNamespace: string;
  readonly scope: ConfigScope | undefined;
  readonly snapshotPath: string;
  readonly prefix: string;         // Namespace-aware env prefix
  readonly hash: string;           // configHash from snapshot

  constructor(params: EnvironmentParams);

  // Typed getter: "config.*" | "path.*" | "env.*" | "provenance.*"
  get<K extends string>(key: K): DeepPath<T, K>;
  get(key: string): unknown;

  // Bracket access shorthand — env["config.port"] === env.get("config.port")
  [key: string]: unknown;

  toJSON(): Readonly<SnapshotData>;
}

interface EnvironmentParams {
  project: string;           // Required.
  scope?: ConfigScope;       // Optional. Filters returned values.
  namespace?: string;        // Optional. Defaults to "default".
  adhdRoot?: string;         // Optional. Defaults to os.homedir()/.adhd.
}
```

[interfaces-architect.md §4.2][25], [SPEC_0.0.4.md §Runtime Client API][26]

### `get()` Path Resolution

| Prefix | Resolves To | Example |
|--------|------------|---------|
| `config.*` | Resolved config values (scope-filtered by constructor) | `env.get("config.server.port")` → `3000` |
| `path.*` | Directory paths by name, type, or type+name | `env.get("path.state.data.primary")` → path |
| `env.*` | Recorded env var values from snapshot's `envVars` | `env.get("env.OPENAI_API_KEY")` → `"sk-..."` |
| `provenance.*` | Provenance entries | `env.get("provenance.db.path")` → `{ source, scope }` |

[SPEC_0.0.3.md §Runtime API][27]

### Python (`adhd-environment`)

```python
class Environment:
    def __init__(self, project: str, scope: str | None = None,
                 namespace: str = "default", adhd_root: str | None = None): ...
    @property
    def project(self) -> dict: ...
    @property
    def namespace(self) -> str: ...
    @property
    def hash(self) -> str: ...
    @property
    def version(self) -> dict: ...
    @property
    def prefix(self) -> str: ...
    def get(self, path: str) -> Any: ...
    def __getitem__(self, key: str) -> Any: ...
```

[SPEC_0.0.4.md §Runtime Client API — Python][28]

### Rust (`adhd-environment`)

```rust
pub struct Environment { /* ... */ }

impl Environment {
    pub fn new(project: &str, scope: Option<&str>,
               namespace: Option<&str>,
               adhd_root: Option<&Path>) -> Result<Self, EnvironmentError>;
    pub fn project(&self) -> &ProjectIdentity;
    pub fn namespace(&self) -> &str;
    pub fn hash(&self) -> &str;
    pub fn version(&self) -> &Version;
    pub fn prefix(&self) -> &str;
    pub fn get(&self, path: &str) -> Option<serde_json::Value>;
    pub fn get_str(&self, path: &str) -> Option<&str>;
    pub fn get_int(&self, path: &str) -> Option<i64>;
    pub fn get_bool(&self, path: &str) -> Option<bool>;
}
```

[SPEC_0.0.4.md §Runtime Client API — Rust][29]

---

## 5. CLI (`adhd-env`)

### Package: `environment-cli` at `entrypoint/environment-cli/`

Apigen-generated CLI. The `project.json` has a `generate-cli` target using
`@adhd/apigen-generator-nx:generate` from `src/api.ts`.

[SPEC_0.0.4.md §CLI Commands][30], [interfaces-architect.md §5.2][31]

### 9 Commands

| Command | API Function | Purpose |
|---------|-------------|---------|
| `adhd-env init --generate-config` | `init(generateConfig)` | Writes starter `adhd.environment.yaml` |
| `adhd-env build [--namespace <ns>] [--scope <scope>] [--config <path>] [--dry-run]` | `build(namespace, scope, config, adhdRoot, dryRun)` | Full build pipeline → snapshot |
| `adhd-env set <field> <value> [--namespace <ns>]` | `set(field, value, namespace, config, adhdRoot)` | Stores config value (no `.env` file) |
| `adhd-env status [--project <name>] [--namespace <ns>] [--json]` | `status(project, namespace, json, adhdRoot)` | Show environment status |
| `adhd-env verify [--project <name>] [--namespace <ns>]` | `verify(project, namespace, config, adhdRoot)` | Verify snapshot matches YAML |
| `adhd-env doctor [--project <name>] [--namespace <ns>]` | `doctor(project, namespace, config, adhdRoot)` | Diagnose config issues |
| `adhd-env config-get <path> [--project <name>]` | `configGet(path, project, namespace, adhdRoot)` | Read single config value |
| `adhd-env export [--project <name>] [--output <file>]` | `exportSnapshot(project, namespace, output, pretty, adhdRoot)` | Export snapshot as JSON |
| `adhd-env diff [--from <path>] [--to <path>]` | `diff(from, to, project, namespace, adhdRoot)` | Diff two snapshots |

[interfaces-architect.md §6.1][32]

### CLI Return Types

```typescript
interface InitResult       { success: boolean; path: string; template: string; }
interface BuildResult      { success: boolean; configPath: string; namespace: string;
                             configHash: string; structureHash: string;
                             fieldCount: number; dirCount: number; warnings: string[]; }
interface SetResult        { success: boolean; field: string; value: string; // masked if secret
                             namespace: string; message: string; }
interface StatusResult     { project: string; namespace: string; snapshotPath: string;
                             snapshotExists: boolean; configHash: string; generatedAt: string;
                             fieldCount: number; dirCount: number; envVarCount: number; }
interface VerifyResult     { clean: boolean; drift: string[]; hash: string; }
interface DoctorResult     { healthy: boolean; checks: DoctorCheck[]; }
interface ConfigGetResult  { path: string; value: unknown; type: string; provenance: {...}; }
interface ExportResult     { snapshot: object | string; }
interface DiffResult       { hasChanges: boolean; added: string[]; removed: string[];
                             changed: Array<{path: string; from: unknown; to: unknown}>; }
```

[interfaces-architect.md §6.2][33]

---

## 6. Scope Cascade & Field Inheritance

### Three-Tier Scope System

| Scope | Root | What goes here | Examples |
|-------|------|---------------|---------|
| `system` | `/etc/adhd/` | Framework-shipped defaults, rarely changed | `log.level`, `server.maxDepth`, `queue.concurrency` |
| `global` | `~/.adhd/` | Org-wide defaults shared across ALL ADHD projects | `log.format`, `transport.kind` |
| `project` | `<cwd>/.adhd/` | This-project-only: paths, ports, secrets | `db.path`, `server.port`, `providers.*` |

[SPEC_0.0.3.md §Fix 2: Scope Assignments][34]

### mergeFieldDefinitions Algorithm

**Input:** three `ConfigFieldMap` objects — system, global, project.

**Output:** single merged `ConfigFieldMap`.

1. Start with shallow copy of `system`.
2. For each key in `global`: if exists, non-undefined properties overwrite;
   scope becomes `"global"`. If not, add as-is.
3. For each key in `project`: if exists, non-undefined properties overwrite;
   scope becomes `"project"`. If not, add as-is.
4. Validation keywords (minimum, maximum, pattern, enum, etc.) inherit from
   lower scopes when higher scope only changes `default`.

```typescript
function mergeFieldDefinitions(
  system: ConfigFieldMap,
  global: ConfigFieldMap,
  project: ConfigFieldMap,
): ConfigFieldMap
```

[SPEC_0.0.2.md §Field Inheritance Merge Algorithm][35]

### Value Resolution Chain

For each field at build time:
1. `process.env[effectiveEnvVar]` (unless `noEnv: true`)
2. `adhd-env set` store value
3. Field `default`
4. If all absent: `undefined`

Then single-level `${VAR}` interpolation. [interfaces-architect.md §7][20]

---

## 7. Directory Registry (Type-First)

### Concept

Directories are identified by their **type** as the primary key, with an
optional **name** for disambiguation when multiple of the same type exist.
This is a change from name-first identification.

[SPEC_0.0.2.md §Directory Design (Type-First)][36]

### DirectoryType Enum

```typescript
type DirectoryType =
  | 'state.data'    | 'state.config'
  | 'runtime.log'   | 'runtime.cache' | 'runtime.pid'
  | 'user.bin'      | 'user.custom';
```

Updated in `interfaces-architect.md`:
```typescript
type DirectoryType = 'state.data' | 'runtime.log' | 'runtime.cache' | 'runtime.temp';
```

[interfaces-architect.md §2.1.3][37]

### Path Resolution

Full path pattern:
```
<scope_root>/<orgNamespace>/<project>/<namespace>/<type_base>/<name>/
```

Type→base mapping:
| Type | Base dir |
|------|---------|
| `state.data` | `data` |
| `state.config` | `config` |
| `runtime.log` | `log` |
| `runtime.cache` | `cache` |
| `runtime.pid` | `pid` |
| `user.bin` | `bin` |
| `user.custom` | `custom` |

### Lookup Semantics

```
path("state.data")                   // first/only match by type
path("state.data", "replica")        // specific named directory
path("primary")                      // by name (shortcut — works when name is unique)
// When type matches multiple and name omitted: throws with disambiguation
```

[SPEC_0.0.2.md §DirectoryRegistry][38]

### DirectoryEntry Interface

```typescript
interface DirectoryEntry {
  type: DirectoryType;            // Primary identification key
  name?: string;                  // Disambiguator
  scope?: 'system' | 'global' | 'project';  // Default: project
  path?: string;                  // Optional override (supports $HOME, ${PROJECT_ROOT}, ${NAMESPACE})
  description?: string;           // Documentation
}
```

[interfaces-architect.md §2.1.3][37]

---

## 8. Env Var Inference & Naming

### Inference Algorithm

When `env` is omitted from a field definition, the env var name is inferred:

```
inferEnvVar(prefix: string, fieldPath: string) → string
  1. Uppercase fieldPath
  2. Replace "." with "_"
  3. Prepend prefix + "_"

inferEnvVar("ADHD_AGENT_MCP", "db.path")           → "ADHD_AGENT_MCP_DB_PATH"
inferEnvVar("ADHD_AGENT_MCP", "providers.openai.secret") → "ADHD_AGENT_MCP_PROVIDERS_OPENAI_SECRET"
inferEnvVar("ADHD_AGENT_MCP", "server.port")       → "ADHD_AGENT_MCP_SERVER_PORT"
```

[SPEC_0.0.3.md §Fix 1: Env vars inferred by convention][39], [TOOLS.md §C5][40]

### Project Prefix Inference

The project env prefix is inferred from the project name when `envPrefixOverride`
is absent:

```
projectEnvPrefix(projectName: string) → string
  1. Uppercase project name
  2. Replace /-/g with '_'
  3. Prepend "ADHD_"

"agent-mcp"     → "ADHD_AGENT_MCP"
"decompile-cli" → "ADHD_DECOMPILE_CLI"
```

[interfaces-architect.md §2.4][41]

### Namespace Prefix

Namespace-suffixed prefix for snapshot's `envVars` section:

```
namespaceEnvPrefix("agent-mcp", "production")    → "ADHD_AGENT_MCP_PRODUCTION_"
namespaceEnvPrefix("agent-mcp", "staging")       → "ADHD_AGENT_MCP_STAGING_"
namespaceEnvPrefix("agent-mcp", "default")       → "ADHD_AGENT_MCP"  (default = no suffix)
```

[SPEC_0.0.2.md §6a Namespaced Env Prefix][42]

### Key Rule

When `env` is explicitly provided, it **completely replaces** the inferred name.
There is no fallback. [SPEC_0.0.3.md §Inference algorithm][39]

---

## 9. Content & Structure Hashing

### `contentHash`

SHA-256 hash of sorted `key=value\n` lines. Cross-language gate.

```typescript
function contentHash(config: Record<string, string>): string
```

Algorithm:
1. Sort keys lexicographically (byte-order)
2. For each key: append `key=value\n`
3. SHA-256 hash the buffer
4. Return `"sha256-"` + lowercase hex digest

**Test vector (MUST pass in every client):**
```
Input:  { "b": "2", "a": "1" }
Output: "sha256-66e4efebc74d002dabcf821c0ee1402726e5c9d25a8469e7fc3f7d7691464788"
```

[SPEC_0.0.0.md §5][10], [TOOLS.md §C3][43]

### `structureHash`

Hash of logical directory structure (not absolute paths):

```typescript
function structureHash(dirs: DirectoryRegistrySnapshot): string
```

Algorithm:
1. Sort directory type-name keys lexicographically
2. For each: append `type:name:scope\n`
3. SHA-256 hash the buffer

Detects when directory entries are added, removed, or have type/scope changes —
independent of the absolute paths.

[SPEC_0.0.2.md §5a][44]

---

## 10. Provenance Tracking

Every resolved config value has a provenance entry recording its source.

### ProvenanceSource Enum

```typescript
type ProvenanceSource =
  | 'system.default'          // System-scoped default
  | 'global.default'          // Global-scoped default
  | 'global.env'              // Global-scoped env var
  | 'project.default'         // Project-scoped default
  | 'project.env'             // Project-scoped env var (from process.env)
  | 'project.set'             // From adhd-env set store
  | 'project.override';       // From envVarOverride in field definition
```

[interfaces-architect.md §2.1.6][45]

### ProvenanceEntry

```typescript
interface ProvenanceEntry {
  source: string;               // e.g. "project.default", "project.env"
  scope: 'system' | 'global' | 'project';
  env?: string;                 // The env var name, if resolved from an env var
}
```

Example from a snapshot:
```json
{
  "server.port":     { "source": "project.default", "scope": "project" },
  "server.host":     { "source": "global.env",      "scope": "global", "env": "ADHD_AGENT_MCP_SERVER_HOST" },
  "providers.openai.secret": { "source": "project.env", "scope": "project", "env": "OPENAI_API_KEY" }
}
```

[SPEC_0.0.1.md §Runtime Snapshot][46]

---

## 11. JSON Schema Generation (`fieldSchema`)

### `generateFieldSchema`

Converts flat dot-path field definitions into a nested JSON Schema object stored
in the snapshot. Used for cross-language validation at build time.

```typescript
function generateFieldSchema(fields: ConfigFieldMap): Record<string, unknown>
```

Algorithm:
1. For each `key.subkey.field` entry, walk the dot-path creating nested `{ type: "object", properties: {...} }` nodes
2. At the leaf, emit validation keywords:
   - `type: "string"` → `{ type: "string" }`
   - `type: "integer"` → `{ type: "integer" }`
   - `type: "number"` → `{ type: "number" }`
   - `type: "boolean"` → `{ type: "boolean" }`
   - `type: "path"` → `{ type: "string" }` (validation hint)
   - `type: "array"` → `{ type: "array", items: { type: "string" } }`
   - `minimum`, `maximum`, `enum`, `pattern`, `minLength`, `maxLength` — pass through
3. Omit undefined keywords

**Input:**
```json
{ "server.port": { "type": "integer", "minimum": 1024 } }
```
**Output:**
```json
{ "type": "object", "properties": { "server": { "type": "object", "properties": { "port": { "type": "integer", "minimum": 1024 } } } } }
```

[SPEC_0.0.1.md §3b JSON Schema Generation][47], [interfaces-architect.md §2.4][41]

### Cross-Language Validation Contract

Every language client MUST validate resolved config against `fieldSchema` at
build time:

- TypeScript: `ajv` (`ajv.compile(schema)(config)`)
- Python: `jsonschema` (`jsonschema.validate(config, schema)`)
- Rust: `jsonschema` crate (`jsonschema::validator_for(&schema).validate(&config)`)

[SPEC_0.0.1.md §3c Cross-Language Validation][48]

---

## 12. Cross-Language Parity (Python + Rust)

### Python Runtime (`environment-core-py`)

- `contentHash()` must match TypeScript output exactly
- `Environment.get()` reads same snapshot format
- `generateFieldSchema()` produces identical JSON
- ~40 lines, zero external deps except `jsonschema`
- Contract test vectors from `cross-language-test-vectors.json`
- Built with `uv` / `python -m build`
- Package name on PyPI: `adhd-environment`
- Python ≥3.10

[SPEC_0.0.1.md §Python Implementation][49]

### Rust Runtime (`environment-core-rs`)

- `contentHash()` must match TypeScript output exactly
- `Environment.get()` reads same snapshot format
- `generateFieldSchema()` produces identical JSON
- ~50 lines, deps: `serde`, `serde_json`, `sha2`, `jsonschema`
- Toolchain pinned: 1.95.0 (via `rust-toolchain.toml`)
- Contract test vectors from `cross-language-test-vectors.json`
- Package name on crates.io: `adhd-environment`

[SPEC_0.0.1.md §Rust Implementation][50], [decisions.md §F1][51]

### Cross-Language Gate

```
contentHash({ b: "2", a: "1" }) === "sha256-66e4efebc74d002dabcf821c0ee1402726e5c9d25a8469e7fc3f7d7691464788"
```

This single test vector MUST pass in all 3 languages. Any implementation
producing a different hash is non-conformant. [SPEC_0.0.0.md §Future Client Gate][52]

### Known Cross-Language Equivalence Defects (see BACKLOG)

- **ENV-CORE-001 (CRITICAL):** `generateFieldSchema`: Python/Rust emit
  `secret`/`env`/`scope`/`noEnv` that TS strips. Equivalence break AND
  secret-metadata disclosure.
- **ENV-CORE-002 (CRITICAL):** `contentHash`: Astral keys sort by UTF-16 code
  unit in TS, code point in Python/Rust → same config, two digests.
- **ENV-CORE-003 (HIGH):** `projectEnvPrefix("foo.bar")` → `ADHD_FOO.BAR`
  (TS/Py) vs `ADHD_FOO_BAR` (Rust).
- **ENV-CORE-004 (MEDIUM):** `contentHash` `key=value\n` serialization is
  non-injective; `{"a":"1\nb=2"}` collides with `{"a":"1","b":"2"}`.
- **ENV-CORE-005 (LOW):** Lone-surrogate key: TS substitutes U+FFFD, Python raises.
- **ENV-CORE-006 (LOW):** Snapshot path built from project/namespace with no
  traversal guard.
- **ENV-CORE-007 (TEST-DEBT):** Python + Rust suites are pure vector-replay;
  cannot fail against ENV-CORE-001/002/003.

[BACKLOG.md §Cross-language equivalence defects][53]

---

## 13. Validation & Drift Detection

### Config Validation

At build time, the resolved `config` section is validated against the
auto-generated `fieldSchema` using the language's native JSON Schema validator.
On failure, throws with field-level errors including field path and constraint
violation.

[SPEC_0.0.1.md §3c][48], [TOOLS.md §C8][54]

### Drift Detection

On each `build()`, the pipeline reads the existing snapshot (if any) and
compares `structureHash`:

- **Hash matches** → no structural change, proceed
- **Hash differs** → compare directory entries:
  - New directories → **warn**
  - Directories removed → **warn**
  - Directory types changed → **throw** `Error("Competing structure: ...")`
  - Directory scope changed → **throw** `Error("Competing structure: ...")`
  - Project name mismatch → **throw** `Error("Namespace conflict: ...")`

[SPEC_0.0.2.md §Drift Detection][55]

### Atomic Writes

Snapshots are written atomically:
1. Write to `<path>.tmp`
2. `renameSync(<path>.tmp, <path>)` — this is atomic on the same filesystem

Never creates a partial `.json` file. [SPEC_0.0.0.md §1 Snapshot I/O][8]

---

## 14. Agent-MCP Refactor (Demonstration Target)

### What Gets Deleted

`entrypoint/agent-mcp/src/config.ts` (299 lines) — Zod schema, `rawFromEnv()`,
`PROVIDER_DEFAULTS`, `deepFreeze()`, `resolveEnvRef()`, `verifyEnvRefs()`,
`subprocessEnv()`. [SCOPE.md §In scope — agent-mcp refactor][56]

### What Gets Created

1. **`entrypoint/agent-mcp/adhd.environment.yaml`** — spec file
2. **`entrypoint/agent-mcp/src/environment.ts`** — new module with
   `new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" })`
   + re-exported `config` accessor + `getProviderConfig()` + `isEnvNameAllowed()`
   wrappers. [contexts/refactor-agent-mcp.md][57]

### Env Prefix Decision (Critical)

The live agent-mcp reads env vars named `ADHD_AGENT_*` (e.g.
`ADHD_AGENT_OPENAI_SECRET`, `ADHD_AGENT_DATABASE_PATH`). The default prefix
inference would yield `ADHD_AGENT_MCP_PRODUCTION_`, which does NOT match any
deployed secret.

**Solution:** `envPrefixOverride: ADHD_AGENT` MUST be set in the YAML.
Namespace is used ONLY for the on-disk snapshot path — NOT folded into the
env var prefix. Several legacy names (e.g. `db.path` → `ADHD_AGENT_DATABASE_PATH`)
require explicit per-field `env:` overrides.

[contexts/refactor-agent-mcp.md §Decision][58]

### Consumers to Rewire

Five files import from `./config.js` and must be rewired to `./environment.ts`:

- `entrypoint/agent-mcp/src/index.ts`
- `entrypoint/agent-mcp/src/server.ts`
- `entrypoint/agent-mcp/src/logger.ts`
- `entrypoint/agent-mcp/src/streaming/sse-server.ts`
- `entrypoint/agent-mcp/src/db/client.ts`

[contexts/refactor-agent-mcp.md][57]

### All 26 Legacy Env Vars

From `CURRENT_CONFIG_PATTERNS.md §agent-mcp`:
17 in `rawFromEnv` + 9 provider defaults = 26 unique `ADHD_AGENT_*` vars.

**Config keys (17):** `db.path`, `logging.level`, `queue.concurrency`,
`server.maxDepth`, `server.maxToolLoops`, `server.defaultMaxTokens`,
`server.contextLimit`, `server.allowedAgents`, `server.registryDbPath`,
`transport.kind`, `transport.port`, `sse.port`, `sse.host`, `sse.baseUrl`,
`plugins.configPath`, `plugins.entries`, `security.envAllowlist`.

**Provider secrets/env vars (9):** openai (secret, url, model), anthropic
(secret, url, model), deepseek (secret, url, model).

[CURRENT_CONFIG_PATTERNS.md §agent-mcp][59]

---

## 15. Audit Infrastructure & Guard Scripts

### run-audit.js

A vendored audit runner in `docs/plan/adhd-environment/scripts/` that executes
typed criteria from `criteria.json`. Supports phase-based filtering, repo-root
relative execution, self-test mode.

Key design:
- Phase filter: `--phase X` selects only criteria with that phase; `--phase X,Y`
  selects union; empty selects all.
- Criteria resolved from script DIR (not CWD). Commands execute with
  `cwd = REPO_ROOT`.
- `--self-test` asserts phase isolation properties without running criteria
  commands.

[decisions.md §F12][60]

### criteria.json

53 typed criteria across 7 phases (scaffold, contract, builder, runtime,
refactor, audit, docs). Each criterion has:
- `id` (e.g. `contract-base-spec.1`)
- `phase` (e.g. `contract`)
- `kind` (`present`, `exists`, `command`)
- `check` — the test command

### Guard Scripts

Repo-owned Python guard scripts in `docs/plan/adhd-environment/scripts/`:

| Script | For State | What It Asserts |
|--------|-----------|----------------|
| `guard_scaffold_workspace.py` | scaffold-workspace | Canonical scaffold manifests exist |
| `guard_audit_builder.py` | audit-builder | `run-audit.js --phase contract,builder` |
| `guard_audit_runtime.py` | audit-runtime | `run-audit.js --phase runtime` |
| `guard_audit_final.py` | audit-final | All phases + coverage count (55/55) + Python/Rust test pass |
| `guard_runtime_py.py` | runtime-py | `uv run --python 3.10 -m build` |
| `guard_runtime_rs.py` | runtime-rs | `rustup run 1.95.0 cargo build` |
| `guard_docs_steward.py` | docs-steward | Builds `@adhd/environment`, asserts constructable `Environment` with `.get()` |
| `guard_audit_runtime.py` | audit-runtime | Pinned test runner for all three runtimes |

[decisions.md §F1][51], [dag.json][61]

### Known Audit Gaps (BACKLOG)

- **ENV-PLAN-011:** All 3 audit gates are `nx build`; none invoke `run-audit.js`
  or own `audit_<slug>.py`.
- **ENV-PLAN-012:** Phase filter and cwd bugs in `run-audit.js` (FIXED in round 2).
- **ENV-PLAN-016:** Terminal DoD gate non-functional — `criteria.json` has 0
  `dod.*` ids, `audit-dod-mapping.js` is a stub.
- **ENV-PLAN-017:** `runtime-cli` guard greps for `function <name>` ×9; empty
  stubs pass.
- **ENV-PLAN-018:** `builder-snapshot-api` guard asserts `typeof m === "function"`;
  no-op methods pass.

[BACKLOG.md][53]

---

## 16. Plan State Machine & Orchestration

### DAG Structure

13 states across 7 phases (scaffold → contract → builder → runtime →
refactor → audit → docs). Terminal state: `done`.

Wave breakdown:
- Wave 1: `scaffold-workspace` (root)
- Wave 2: `contract-base-spec`, `builder-engine`, `runtime-py`, `runtime-rs`
  (parallel after scaffold)
- Wave 3: `builder-snapshot-api` (depends on builder-engine)
- Wave 4: `audit-builder`, `runtime-core-node` (parallel after builder-snapshot)
- Wave 5: `runtime-cli` (depends on builder-snapshot + core-node)
- Wave 6: `audit-runtime` (depends on all runtime states)
- Wave 7: `refactor-agent-mcp` (depends on runtime-core-node + cli + audit-builder)
- Wave 8: `audit-final` (depends on refactor + audit-runtime)
- Wave 9: `docs-steward` (terminal work state)

[dag.json][61], [state.json][62]

### State Ratings

| State | Model | Effort |
|-------|-------|--------|
| scaffold-workspace | sonnet | medium |
| contract-base-spec | sonnet | medium |
| builder-engine | sonnet | medium |
| builder-snapshot-api | sonnet | medium |
| audit-builder | **opus** | **hard** |
| runtime-core-node | sonnet | medium |
| runtime-cli | sonnet | medium |
| runtime-py | sonnet | medium |
| runtime-rs | sonnet | medium |
| audit-runtime | **opus** | **hard** |
| refactor-agent-mcp | **opus** | **hard** |
| audit-final | **opus** | **hard** |
| docs-steward | sonnet | medium |

[decisions.md §F2][63]

### Human Blockers

1. **agent-mcp-deployment-secrets:** The live `ADHD_AGENT_*` env vars must be
   confirmed before refactor cutover. Status: `needed`. Blocks at: `per-state`.
2. **cargo-registry-token:** crates.io API token for future publish pipeline.
   Currently UNIMPLEMENTED. Blocks at: `release`.

[human-blockers.json][64]

### Current State (as of state.json)

`current_state`: `audit-builder` (pending). 5 states complete:
`scaffold-workspace`, `contract-base-spec`, `builder-engine`,
`builder-snapshot-api`, `runtime-py`, `runtime-rs`. `dod_provenance` confirmed
by pseudosky on 2026-07-08 (all 8 DoDs). [state.json][62]

### DoD Gates

| DoD | Description | Delivered By |
|-----|-------------|-------------|
| dod.1 | All 6 packages build successfully | scaffold-workspace, docs-steward |
| dod.2 | `adhd-env init --generate-config` writes starter YAML | runtime-cli |
| dod.3 | `adhd-env set` stores config values without `.env` file | runtime-cli |
| dod.4 | `adhd-env build` reads YAML, writes snapshot atomically | builder-engine, runtime-cli |
| dod.5 | Typed `Environment` provides typed `env.get()` | runtime-core-node |
| dod.6 | `contentHash` test vector matches across all 3 languages | contract-base-spec, runtime-core-node, runtime-py, runtime-rs |
| dod.7 | Agent-mcp config.ts replaced with YAML + typed Environment | refactor-agent-mcp |
| dod.8 | `build()` returns `EnvironmentSnapshot` with set/get/configPath/write | builder-snapshot-api |

[README.md §Definition of Done][65]

---

## 17. Known Defects & Gaps (BACKLOG)

### Plan-Level Defects

| ID | Severity | Description | Status |
|----|----------|-------------|--------|
| ENV-PLAN-008 | **HIGH** | `env-pin-check` exit 0 is false green — `npx --yes` launders bare python/cargo | OPEN |
| ENV-PLAN-009 | **HIGH** | `builder-snapshot-api` guard byte-identical to `builder-engine`'s | OPEN |
| ENV-PLAN-010 | **HIGH** | plan-builder breached scope, wrote runtime-py while pending | OPEN |
| ENV-PLAN-011 | **HIGH** | All 3 audit gates are `nx build`; none invoke `run-audit.js` | OPEN |
| ENV-PLAN-012 | **HIGH** | `run-audit.js` phase filter + cwd bugs | FIXED (round 2) |
| ENV-PLAN-013 | **HIGH** | `audit-final` covers 4/6 packages, skips py+rs | OPEN |
| ENV-PLAN-014 | **MEDIUM** | `cargo-registry-token` cites non-existent `nx-release-publish` target | OPEN |
| ENV-PLAN-016 | **HIGH** | Terminal DoD gate non-functional | OPEN |
| ENV-PLAN-017 | **MEDIUM** | `runtime-cli` guard passes on empty stubs | OPEN |
| ENV-PLAN-018 | **MEDIUM** | `builder-snapshot-api` guard passes on no-op methods | OPEN |

### Cross-Language Equivalence Defects

| ID | Severity | Description | Status |
|----|----------|-------------|--------|
| ENV-CORE-001 | **CRITICAL** | `generateFieldSchema`: Python/Rust emit metadata TS strips | OPEN |
| ENV-CORE-002 | **CRITICAL** | `contentHash`: astral keys sort differently in TS vs Py/Rust | OPEN |
| ENV-CORE-003 | **HIGH** | `projectEnvPrefix("foo.bar")` inconsistent between Rust and TS/Py | OPEN |
| ENV-CORE-004 | **MEDIUM** | `contentHash` non-injective — `{"a":"1\nb=2"}` collision | OPEN |
| ENV-CORE-005 | **LOW** | Lone-surrogate key: TS substitutes, Python raises | OPEN |
| ENV-CORE-006 | **LOW** | Snapshot path has no traversal guard | OPEN |
| ENV-CORE-007 | **TEST-DEBT** | Py + Rs suites are pure vector-replay; cannot fail | OPEN |

[BACKLOG.md][53]

---

## 18. Key Interfaces & Types

### Canonical TypeScript Interfaces (from `environment-base-spec/src/types.ts`)

```typescript
// --- Project Configuration (YAML shape) ---
interface ProjectConfig {
  name: string;
  orgNamespace?: string;     // Default: "adhd"
  envPrefixOverride?: string;
  description?: string;
  namespaces?: string[];
  dirs?: DirectoryEntry[];
  config?: {
    system?: Record<string, ConfigFieldDefinition>;
    global?: Record<string, ConfigFieldDefinition>;
    project?: Record<string, ConfigFieldDefinition>;
  };
}

// --- Parsed YAML Spec ---
interface ParsedYamlSpec {
  project: ProjectConfig;
  namespaces: string[];
  dirs: DirectoryEntry[];
  config: {
    system: Record<string, YamlFieldDefinition>;
    global: Record<string, YamlFieldDefinition>;
    project: Record<string, YamlFieldDefinition>;
  };
  orgNamespace: string;
  envPrefix: string;
}

// --- Directory Entry ---
interface DirectoryEntry {
  type: DirectoryType;
  name?: string;
  path?: string;             // Optional path override
  scope?: 'system' | 'global' | 'project';
  description?: string;
}

// --- YAML Field Definition (authored) ---
interface YamlFieldDefinition {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array';
  default?: unknown;
  env?: string;              // Override for inferred env var name
  scope?: 'system' | 'global' | 'project';
  description?: string;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  items?: { type: string };
  secret?: boolean;
  noEnv?: boolean;
}

// --- Config Field Definition (resolved, merged) ---
interface ConfigFieldDefinition {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array';
  default: unknown;
  scope: 'system' | 'global' | 'project';
  env: string;
  sourceScope: 'system' | 'global' | 'project';
  description?: string;
  secret?: boolean;
  noEnv?: boolean;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  items?: { type: string };
}

// --- Provenance Entry ---
interface ProvenanceEntry {
  source: string;            // e.g. "project.default", "project.env"
  scope: 'system' | 'global' | 'project';
  env?: string;
}

// --- Snapshot Data (written to disk) ---
interface SnapshotData {
  version: string;
  libraryVersion: string;
  generatedAt: string;
  project: {
    name: string;
    orgNamespace: string;
    envPrefix: string;
    namespace: string;
    description?: string;
  };
  config: Record<string, unknown>;      // Nested, resolved
  raw: Record<string, unknown>;         // Flat dot-path map
  fieldSchema: object | null;
  configHash: string;
  structureHash: string;
  dirs: Array<{
    type: DirectoryType;
    name?: string;
    path: string;
    scope: string;
  }>;
  provenance: Record<string, ProvenanceEntry>;
  envVars: Record<string, string>;
}

// --- Build Options ---
interface BuildOptions {
  namespace?: string;
  scope?: 'system' | 'global' | 'project';
  adhdRoot?: string;
  configPath?: string;
  dryRun?: boolean;
}

// --- Environment Constructor Params ---
interface EnvironmentParams {
  project: string;
  scope?: 'system' | 'global' | 'project';
  namespace?: string;
  adhdRoot?: string;
}

// --- Deep-path type extraction utility ---
type DeepPath<T, K extends string> =
  K extends `${infer Head}.${infer Tail}`
    ? Head extends keyof T
      ? DeepPath<T[Head], Tail>
      : unknown
    : K extends keyof T
      ? T[K]
      : unknown;
```

[interfaces-architect.md §2][66]

### Key Constants

```typescript
const SPEC_VERSION = '0.0.5';
const DEFAULT_ORG_NAMESPACE = 'adhd';
const DEFAULT_NAMESPACE = 'default';
const SNAPSHOT_FILENAME = 'adhd-environment.json';
```

[interfaces-architect.md §2.3][67]

### Pure Utility Functions (Cross-Language)

```typescript
// Must produce identical output in all 3 languages
function contentHash(config: Record<string, string>): string;
function projectEnvPrefix(projectName: string): string;
function inferEnvVar(prefix: string, fieldPath: string): string;
function generateFieldSchema(fields: Record<string, YamlFieldDefinition>): object;
function mergeFieldDefinitions(system, global, project): ConfigFieldMap;
```

[interfaces-architect.md §2.4][41]

---

## Sources Cited

[1]: `docs/plan/adhd-environment/README.md` — Plan overview, Definition of Done
[2]: `docs/plan/adhd-environment/interfaces-architect.md` §1 — Package dependency graph
[3]: `docs/plan/adhd-environment/SCOPE.md` §2 — In scope/out of scope
[4]: `docs/plan/adhd-environment/SPEC_0.0.5.md` — Latest spec revision
[5]: `docs/plan/adhd-environment/SCOPE.md` §3 — Constraints
[6]: `docs/plan/adhd-environment/SCOPE.md` §5 — Task breakdown
[7]: `docs/plan/adhd-environment/CURRENT_CONFIG_PATTERNS.md` — Builder vs Runtime split
[8]: `docs/plan/adhd-environment/SPEC_0.0.0.md` §1 — Snapshot I/O, atomic writes
[9]: `docs/plan/adhd-environment/contexts/_shared.md` — Cross-cutting invariants
[10]: `docs/plan/adhd-environment/SPEC_0.0.0.md` §5 — Content hashing
[11]: `docs/plan/adhd-environment/TOOLS.md` §6 — Dependency graph
[12]: `docs/plan/adhd-environment/SPEC_0.0.4.md` §Design Changes — Change 1
[13]: `docs/plan/adhd-environment/SPEC_0.0.4.md` §Flow 1 — Samira defines config
[14]: `docs/plan/adhd-environment/SPEC_0.0.4.md` §YAML Format — Complete reference
[15]: `docs/plan/adhd-environment/SPEC_0.0.4.md` §Field Definition Reference
[16]: `docs/plan/adhd-environment/interfaces-architect.md` §2.1.4 — YamlFieldDefinition
[17]: `docs/plan/adhd-environment/SPEC_0.0.4.md` §YAML Type Coercion
[18]: `docs/plan/adhd-environment/SPEC_0.0.4.md` §Builder Package Architecture
[19]: `docs/plan/adhd-environment/interfaces-architect.md` §3.1 — Builder file structure
[20]: `docs/plan/adhd-environment/interfaces-architect.md` §7 — 17-step pipeline
[21]: `docs/plan/adhd-environment/interfaces-architect.md` §3.4 — EnvironmentSnapshot class
[22]: `docs/plan/adhd-environment/TOOLS.md` §C16 — build() contract
[23]: `docs/plan/adhd-environment/interfaces-architect.md` §2.1.8 — BuildOptions
[24]: `docs/plan/adhd-environment/interfaces-architect.md` §8 — Internal store format
[25]: `docs/plan/adhd-environment/interfaces-architect.md` §4.2 — Environment class
[26]: `docs/plan/adhd-environment/SPEC_0.0.4.md` §Runtime Client API
[27]: `docs/plan/adhd-environment/SPEC_0.0.3.md` §Runtime API — get() resolution
[28]: `docs/plan/adhd-environment/SPEC_0.0.4.md` §Runtime Client API — Python
[29]: `docs/plan/adhd-environment/SPEC_0.0.4.md` §Runtime Client API — Rust
[30]: `docs/plan/adhd-environment/SPEC_0.0.4.md` §CLI Commands
[31]: `docs/plan/adhd-environment/interfaces-architect.md` §5.2 — CLI project.json
[32]: `docs/plan/adhd-environment/interfaces-architect.md` §6.1 — Apigen extraction surface
[33]: `docs/plan/adhd-environment/interfaces-architect.md` §6.2 — Return type interfaces
[34]: `docs/plan/adhd-environment/SPEC_0.0.3.md` §Fix 2 — Scope assignments
[35]: `docs/plan/adhd-environment/SPEC_0.0.2.md` §Field Inheritance Merge Algorithm
[36]: `docs/plan/adhd-environment/SPEC_0.0.2.md` §Directory Design (Type-First)
[37]: `docs/plan/adhd-environment/interfaces-architect.md` §2.1.3 — DirectoryEntry
[38]: `docs/plan/adhd-environment/SPEC_0.0.2.md` §DirectoryRegistry
[39]: `docs/plan/adhd-environment/SPEC_0.0.3.md` §Fix 1 — Env var inference
[40]: `docs/plan/adhd-environment/TOOLS.md` §C5 — inferEnvVar contract
[41]: `docs/plan/adhd-environment/interfaces-architect.md` §2.4 — Cross-language utilities
[42]: `docs/plan/adhd-environment/SPEC_0.0.2.md` §6a — Namespaced env prefix
[43]: `docs/plan/adhd-environment/TOOLS.md` §C3 — contentHash contract
[44]: `docs/plan/adhd-environment/SPEC_0.0.2.md` §5a — Structure hashing
[45]: `docs/plan/adhd-environment/interfaces-architect.md` §2.1.6 — ProvenanceEntry
[46]: `docs/plan/adhd-environment/SPEC_0.0.1.md` §Runtime Snapshot — Example
[47]: `docs/plan/adhd-environment/SPEC_0.0.1.md` §3b — JSON Schema generation
[48]: `docs/plan/adhd-environment/SPEC_0.0.1.md` §3c — Cross-language validation
[49]: `docs/plan/adhd-environment/SPEC_0.0.1.md` §Python implementation
[50]: `docs/plan/adhd-environment/SPEC_0.0.1.md` §Rust implementation
[51]: `docs/plan/adhd-environment/decisions.md` §F1 — Non-JS guards
[52]: `docs/plan/adhd-environment/SPEC_0.0.0.md` §Future Client Gate
[53]: `docs/plan/adhd-environment/BACKLOG.md` — All plan defects
[54]: `docs/plan/adhd-environment/TOOLS.md` §C8 — validateConfig contract
[55]: `docs/plan/adhd-environment/SPEC_0.0.2.md` §Drift Detection
[56]: `docs/plan/adhd-environment/SCOPE.md` §In scope — agent-mcp refactor
[57]: `docs/plan/adhd-environment/contexts/refactor-agent-mcp.md` — Full refactor spec
[58]: `docs/plan/adhd-environment/contexts/refactor-agent-mcp.md` §Decision — env prefix
[59]: `docs/plan/adhd-environment/CURRENT_CONFIG_PATTERNS.md` §agent-mcp
[60]: `docs/plan/adhd-environment/decisions.md` §F12 — run-audit.js fixes
[61]: `docs/plan/adhd-environment/dag.json` — Complete DAG
[62]: `docs/plan/adhd-environment/state.json` — Current execution state
[63]: `docs/plan/adhd-environment/decisions.md` §F2 — Per-state tier ratings
[64]: `docs/plan/adhd-environment/human-blockers.json` — Human blockers
[65]: `docs/plan/adhd-environment/README.md` §Definition of Done
[66]: `docs/plan/adhd-environment/interfaces-architect.md` §2 — Type definitions
[67]: `docs/plan/adhd-environment/interfaces-architect.md` §2.3 — Constants
