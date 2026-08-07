# @adhd/environment — Implementation Spec v0.0.2 (SUPERSEDED)

> **Superseded by SPEC_0.0.3.md** on 2026-07-06. This revision still had env vars as explicit required properties on every field definition (should be inferred by convention), wrong scope assignments for project-specific fields, and no builder/runtime client split. See SPEC_0.0.3.md for the current design: env vars inferred from field path + prefix, builder/runtime split, and a minimal runtime API (`env.get("config...")`, `env.get("path...")`, `env.get("env...")`, `env.hash`, `env.version`).

> **Current as of 2026-07-06.** This revision introduces the three-tier scope cascade (system → global → project), redesigned directory registry (type-first identification with optional name disambiguator), namespaced environments, and system-scope directory support. See revision history below for full details.

> Supersedes [SPEC_0.0.1.md](./SPEC_0.0.1.md).

## Revision History

| Revision | Date | Key Changes |
|---|---|---|
| 0.0.0 | (earlier) | Initial design: `Environment`, `DirectoryRegistry`, `ConfigResolver`, snapshot I/O, content/structure hashing, `.env` hierarchy, apigen CLI |
| 0.0.1 | 2026-07-06 | Zod removed (validation keywords in `ConfigFieldDefinition`), `fieldSchema` auto-generated JSON Schema, cross-language validation contract, field inheritance merge (global→project), provenance tracking, scope-based value resolution, scope-based directory access, configurable `.env` hierarchy, full Python + Rust implementations, CLI renames (`snapshotExport`→`export`, `snapshotDiff`→`diff`) |
| **0.0.2** | **2026-07-06** | **Three-tier scope cascade (system→global→project), type-first directory identification with optional name disambiguator, namespaced environments, system-scope directory roots, 5 concrete demos** |

---

## Summary

`@adhd/environment` gives every ADHD project deterministic namespacing, typed configuration, directory cataloging, dual content+structure hashing, three-tier scope-based field/directory inheritance (system → global → project), provenance tracking, namespaced environments for multi-instance projects, and a language-agnostic JSON snapshot with embedded JSON Schema that any runtime can consume. Five monorepo packages under `packages/environment/` — all FULL implementations:

| Package | npm/Py/Cargo | Language | Status |
|---|---|---|---|
| `environment-base-spec` | `@adhd/environment-base-spec` | JSON Schema + SPEC.md | **implement now** |
| `environment-core-node` | `@adhd/environment` | TypeScript (Node) | **implement now** |
| `environment-cli` | `@adhd/environment-cli` | TypeScript (Node, apigen-generated CLI) | **implement now** |
| `environment-core-py` | `adhd-environment` | Python (≥3.10) | **implement now** (full) |
| `environment-core-rs` | `adhd-environment` | Rust (edition 2021) | **implement now** (full) |

The TypeScript implementation has one external runtime dependency: `ajv` for JSON Schema validation of resolved config against `fieldSchema`. All other logic (`.env` parsing, content hashing, snapshot I/O, `${VAR}` interpolation) uses `node:*` builtins with zero third-party deps.

---

## Language-agnostic contract

### `environment-base-spec/spec/adhd-environment.schema.json`

The canonical format for `~/.adhd/<project>/<namespace>/adhd-environment.json`. Every language client reads and writes this exact shape. This is the authority — TypeScript types derive from it.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://adhd.dev/schemas/adhd-environment.json",
  "title": "ADHD Environment Snapshot",
  "type": "object",
  "required": ["project", "namespace", "version", "directories", "config", "envPrefix", "envVars"],
  "properties": {
    "project": {
      "type": "object",
      "required": ["name"],
      "properties": {
        "name":        { "type": "string" },
        "description": { "type": "string" },
        "repo":        { "type": "string", "format": "uri" },
        "homepage":    { "type": "string", "format": "uri" },
        "license":     { "type": "string" },
        "meta":        { "type": "object", "additionalProperties": { "type": "string" } }
      }
    },
    "namespace": {
      "type": "string",
      "default": "default",
      "description": "Environment namespace. Affects snapshot path, directory roots, and env-var prefix suffix. Defaults to 'default'."
    },
    "version": {
      "type": "object",
      "required": ["configHash", "structureHash", "generatedAt", "libraryVersion"],
      "properties": {
        "configHash":     { "type": "string", "pattern": "^sha256-[a-f0-9]{64}$" },
        "structureHash":  { "type": "string", "pattern": "^sha256-[a-f0-9]{64}$" },
        "generatedAt":    { "type": "string", "format": "date-time" },
        "libraryVersion": { "type": "string" }
      }
    },
    "directories": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/directoryEntry"
      },
      "description": "Directory entries keyed by type name (format: '<type>/<name>' when multiple of same type, or '<type>' when unique)."
    },
    "$defs": {
      "directoryEntry": {
        "type": "object",
        "required": ["path", "type", "scope"],
        "properties": {
          "path":        { "type": "string" },
          "type":        {
            "type": "string",
            "pattern": "^(state|runtime|user)\\.[a-z][a-z0-9-]*$",
            "description": "Hierarchical: state.data | state.config | runtime.log | runtime.cache | runtime.pid | user.bin | user.custom"
          },
          "name":        { "type": "string", "description": "Disambiguator when multiple directories share the same type." },
          "description": { "type": "string" },
          "scope":       { "type": "string", "enum": ["system", "global", "project"] }
        }
      }
    },
    "config": {
      "type": "object",
      "description": "Resolved config values — shape is project-defined. Nested object matching fieldSchema structure."
    },
    "fieldSchema": {
      "type": "object",
      "description": "Auto-generated JSON Schema from merged field definitions. Every language client validates resolved config against this schema at initialize() time."
    },
    "provenance": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": ["source", "scope"],
        "properties": {
          "source": { "type": "string", "enum": ["system.default", "global.default", "global.env", "project.default", "project.env"] },
          "scope":  { "type": "string", "enum": ["system", "global", "project"] },
          "env":    { "type": "string", "description": "Env var name when source includes .env." }
        }
      },
      "description": "Provenance tracking: maps each resolved config dot-path key to where its value came from."
    },
    "envPrefix": {
      "type": "string"
    },
    "envVars": {
      "type": "object",
      "additionalProperties": { "type": "string" }
    }
  }
}
```

### `environment-base-spec/spec/SPEC.md` — Behavioral contract

Every language client MUST implement these sections.

#### §1 Snapshot I/O

```
read_snapshot(project_name: string, namespace?: string) → EnvironmentSnapshot
```

Reads `~/.adhd/<project_name>/<namespace>/adhd-environment.json`. `namespace` defaults to `"default"`. MUST throw if missing or malformed. Error MUST include the file path.

```
write_snapshot(project_name: string, namespace: string, snapshot: EnvironmentSnapshot) → string
```

Writes `~/.adhd/<project_name>/<namespace>/adhd-environment.json`. **Atomic write:** write to `<path>.tmp`, then `renameSync`. Creates parent directories. Returns the written path. JSON prettified (2-space indent), trailing newline.

#### §2 Directory Registry (constructor-only, scope-aware, type-first)

```
DirectoryRegistry(systemRoot: string, globalRoot: string, projectRoot: string, entries: DirectoryEntry[])

path(type: string, name?: string) → string
ensure_directories() → void
snapshot() → DirectoryRegistrySnapshot
```

All directories are declared at construction time. No runtime `register()` method. Each entry carries a `scope` — `"system"`, `"global"`, or `"project"`.

**Root resolution:**
- `scope: "system"` → resolved under `systemRoot` (e.g., `/etc/adhd/`)
- `scope: "global"` → resolved under `globalRoot` (e.g., `~/.adhd/`)
- `scope: "project"` → resolved under `projectRoot` (e.g., `<cwd>/.adhd/`)

**Type-first identification:** The `type` is the primary identifier. `name` is optional — only needed when multiple directories share the same type.

```
// Registration
dirs: [
  { name: "primary", type: "state.data", scope: "global" },
  { name: "replica", type: "state.data", scope: "global" },
  { type: "runtime.log",               scope: "project" },  // no name needed — only one
]

// Lookup by type (returns first/only match)
env.dirs.path("state.data")              // → data/primary/
env.dirs.path("state.data", "replica")   // → data/replica/

// Lookup by name (shortcut when name is unique)
env.dirs.path("primary")                 // → data/primary/
env.dirs.path("runtime.log")             // → log/

// When ambiguous, lookup by type alone throws:
// "Multiple directories of type state.data: primary, replica"
```

**Path pattern:** `<scope_root>/<project>/<namespace>/<type_base>/<name>/`

`type_base` mapping:
| Type | Base dir |
|---|---|
| `state.data` | `data` |
| `state.config` | `config` |
| `runtime.log` | `log` |
| `runtime.cache` | `cache` |
| `runtime.pid` | `pid` |
| `user.bin` | `bin` |
| `user.custom` | `custom` |

**Directory types** use hierarchical dot-path namespacing:

| Type | Category | Purpose | Behavior |
|---|---|---|---|
| `state.data` | state | Persistent application data (databases) | Persisted, never auto-deleted |
| `state.config` | state | Configuration files | Persisted, version-controlled |
| `runtime.log` | runtime | Log output | Auto-created, append-only |
| `runtime.cache` | runtime | Temporary / safe to delete | May be cleared at any time |
| `runtime.pid` | runtime | Process IDs, sockets, lock files | Ephemeral, cleaned on shutdown |
| `user.bin` | user | Executables / scripts | May be added to PATH |
| `user.custom` | user | User-defined purpose | No special behavior |

#### §3 Config Resolution (three-tier scope cascade, with field inheritance)

```
resolve_config(
  project_name: string,
  fields: ConfigFieldMap,
  scope?: 'system' | 'global' | 'project' | undefined,
  env_vars?: Map<string,string>,
  env_overrides?: Map<string,string>
) → ConfigSnapshot
```

**Field inheritance merge** (performed before resolution — three tiers):

1. Collect all fields where `scope === 'system'` → base.
2. Collect all fields where `scope === 'global'` → mid.
3. Collect all fields where `scope === 'project'` → top.
4. Merge: system → global → project. At each step, the higher-precedence scope's non-undefined properties overwrite the lower. If a key exists only in the higher scope, it is added.
5. Result is the effective field map used for resolution.

**Value resolution** per field:
1. Check `env_vars?[fieldDef.env]` → `process.env[fieldDef.env]` → field's `default` value.
2. Expand `${VAR}` references in resolved values (§3a).
3. Track provenance: record which source won for each field.

**Scope parameter semantics:**
- `scope: undefined` (default): resolve all fields (full cascade: system → global → project).
- `scope: "system"`: resolve only fields whose effective scope is `"system"`.
- `scope: "global"`: resolve only fields whose effective scope is `"global"`.
- `scope: "project"`: resolve only fields whose effective scope is `"project"`.

After resolution:
1. `unflatten(raw)` → nested config object.
2. Generate `fieldSchema` from merged field definitions (§3b).
3. Compute `configHash` (§5) and `structureHash` (§5a).
4. Return `{ raw, nested, configHash, structureHash, fieldSchema, provenance, envVars }`.

#### §3a Variable Interpolation

Values MAY contain `${VAR}` references. Resolution order per reference:

```
1. Same-file env var (already loaded, same key scope)
2. process.env[VAR]
3. Scoped default for the field being resolved
4. Leave unresolved: ${VAR} stays as literal text
```

Example: `ADHD_AGENT_MCP_DB_PATH=${HOME}/.adhd/agent-mcp/db` → expands `${HOME}` from `process.env`.

#### §3b JSON Schema Generation from Field Definitions

Given merged field definitions (flat dot-path keys), generate a nested JSON Schema:

```
generate_field_schema(fields: ConfigFieldMap) → object
```

Algorithm:
1. For each `key.subkey.field` entry, walk the dot-path creating nested `{ "type": "object", "properties": {...} }` nodes.
2. At the leaf, emit validation keywords:
   - `type: "string"` → `{ "type": "string" }`
   - `type: "integer"` → `{ "type": "integer" }`
   - `type: "number"` → `{ "type": "number" }`
   - `type: "boolean"` → `{ "type": "boolean" }`
   - `type: "path"` → `{ "type": "string" }` (path is a validation hint, not a JSON Schema type)
   - `minimum`, `maximum`, `enum`, `pattern`, `minLength`, `maxLength` — pass through directly when defined
3. Omit keywords whose value is `undefined`.

**Example input:**
```json
{
  "server.port": { "type": "integer", "minimum": 1024 },
  "server.host": { "type": "string", "pattern": "^[a-z.]+$" },
  "db.path": { "type": "path" }
}
```

**Example output:**
```json
{
  "type": "object",
  "properties": {
    "server": {
      "type": "object",
      "properties": {
        "port": { "type": "integer", "minimum": 1024 },
        "host": { "type": "string", "pattern": "^[a-z.]+$" }
      }
    },
    "db": {
      "type": "object",
      "properties": {
        "path": { "type": "string" }
      }
    }
  }
}
```

This `fieldSchema` is stored in the snapshot and used by every language client to validate resolved config at `initialize()` time.

#### §3c Cross-Language Validation Contract

At `initialize()` time, every language client MUST:

1. Generate (or read from snapshot) the `fieldSchema` JSON Schema.
2. Validate the resolved `config` section of the snapshot against `fieldSchema`.
3. Use the language's native JSON Schema validator:
   - TypeScript: `ajv` (`ajv.compile(schema)(config)`)
   - Python: `jsonschema` (`jsonschema.validate(config, schema)`)
   - Rust: `jsonschema` crate (`jsonschema::validator_for(&schema).validate(&config)`)
4. If validation fails, throw with the validation errors (field path + message).
5. If no field definitions were provided (no `fields` in options, no `schema`), skip validation.

The `fieldSchema` in the snapshot IS the contract. Cross-language parity is proven when all three clients validate the same config against the same generated schema and produce the same result.

#### §4 Env File Loading (configurable)

`ConfigResolverOptions.envFiles` specifies which `.env` files to load and in what order. When omitted, the default 3-tier hierarchy applies:

```
1. <adhd_root>/.env              (no override — sets only if unset)
2. <cwd>/.adhd/.env              (override)
3. <cwd>/.env                    (override)
```

Users can override, prepend, or replace by providing their own `envFiles` array. Each entry is an absolute path. Custom order via `load_env_files(paths, cwd?)`.

Parsing rules (unchanged from v0.0.0):
- Blank lines and `#`-prefixed lines skipped
- `export KEY=VALUE` → `KEY=VALUE` (prefix stripped)
- Matching quotes (`"..."` or `'...'`) stripped from values
- `${VAR}` references are **not expanded at parse time** — expansion happens during `resolve_config()`

#### §5 Content Hashing (unchanged)

```
compute_content_hash(config: Map<string,string>) → string
```

1. Sort keys lexicographically (byte-order).
2. For each key: append `key=value\n` (unexpanded values — `${VAR}` preserved as-is).
3. SHA-256 hash the buffer.
4. Return `"sha256-"` + lowercase hex digest.

**Contract test vector (MUST pass in every client):**

```
Input:  { "b": "2", "a": "1" }
Output: "sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930"
```

#### §5a Structure Hashing (updated for v0.0.2)

```
compute_structure_hash(directories: DirectoryRegistrySnapshot) → string
```

1. Sort directory type-name keys lexicographically.
2. For each directory: append `type:name:scope\n` (path is NOT hashed — only logical structure). When `name` is undefined, use the empty string: `type::scope\n`.
3. SHA-256 hash the buffer.
4. Return `"sha256-"` + lowercase hex digest.

#### §6 Env Prefix Derivation (unchanged)

```
derive_env_prefix(project_name: string) → string
```

1. Uppercase name.
2. Replace `[^A-Z0-9]` with `_`.
3. Prepend `"ADHD_"`.

```
"agent-mcp" → "ADHD_AGENT_MCP"
"my app"    → "ADHD_MY_APP"
```

#### §6a Namespaced Env Prefix

When a namespace is set (non-`"default"`), the namespace is uppercased and appended with `_` to the project env prefix:

```
projectEnvPrefix("agent-mcp")                          → "ADHD_AGENT_MCP"
namespaceEnvPrefix("agent-mcp", "production")          → "ADHD_AGENT_MCP_PRODUCTION_"
namespaceEnvPrefix("agent-mcp", "staging")             → "ADHD_AGENT_MCP_STAGING_"
namespaceEnvPrefix("agent-mcp", "default")             → "ADHD_AGENT_MCP"  (default = no suffix)
```

NOTE: `projectEnvPrefix()` always returns just the project-derived prefix. The namespace-suffixed prefix is for snapshot and env-var injection only — it does not replace the project prefix.

---

## FIELD DEFINITION DESIGN (authoring time)

### ConfigFieldDefinition — complete shape

This is what the developer authors in code. Every field definition has the same uniform shape — fields that do not need a keyword simply omit it.

```typescript
export interface ConfigFieldDefinition {
  /** Env var name that overrides this field (e.g. "ADHD_AGENT_MCP_DB_PATH"). */
  env: string;

  /** Default value when env is unset. May contain ${VAR} references. */
  default: string;

  /**
   * Scope for value resolution and field definition inheritance.
   * - "system":  base defaults (shipped by the framework, rooted at /etc/adhd/).
   * - "global":  org-wide overrides (shared across projects, rooted at ~/.adhd/).
   * - "project": project-specific overrides (per-project, rooted at ./.adhd/).
   */
  scope: ConfigScope;

  // ---- Validation keywords (replace Zod, optional — omit when not needed) ----

  /** JSON Schema type for validation. "path" maps to {"type":"string"} in generated schema. */
  type?: 'string' | 'integer' | 'number' | 'boolean' | 'path';

  /** Minimum value (integer/number types). */
  minimum?: number;

  /** Maximum value (integer/number types). */
  maximum?: number;

  /** Allowed values (string, integer, or number). */
  enum?: (string | number)[];

  /** ECMAScript regex pattern for string validation (passed through to JSON Schema). */
  pattern?: string;

  /** Minimum string length (string type). */
  minLength?: number;

  /** Maximum string length (string type). */
  maxLength?: number;
}
```

### Field Inheritance Merge Algorithm (three-tier)

**Input:** three `ConfigFieldMap` objects — system, global, project.

**Output:** a single merged `ConfigFieldMap`.

```
merge_field_definitions(system: ConfigFieldMap, global: ConfigFieldMap, project: ConfigFieldMap) → ConfigFieldMap
```

Algorithm:
1. Start with a shallow copy of `system`.
2. For each `[key, globalDef]` in `global`:
   - If `key` exists in the working copy:
     - For each non-undefined property in `globalDef`: overwrite.
     - The resulting `scope` becomes `"global"`.
   - If not: add `globalDef` as-is.
3. For each `[key, projectDef]` in `project`:
   - If `key` exists in the working copy:
     - For each non-undefined property in `projectDef`: overwrite.
     - The resulting `scope` becomes `"project"`.
   - If not: add `projectDef` as-is.
4. Return merged map.

---

## DIRECTORY DESIGN (type-first)

### DirectoryEntry — updated shape

```typescript
export interface DirectoryEntry {
  /** Primary identifier — the directory's functional type. */
  type: DirectoryType;

  /**
   * Optional disambiguator. Required when more than one directory
   * of the same type is registered. When only one directory of a given
   * type exists, name is optional — the type alone is the key.
   */
  name?: string;

  /** Scope: "system" | "global" | "project". */
  scope: 'system' | 'global' | 'project';

  /** Optional metadata. Does not affect path resolution. */
  description?: string;
}
```

### DirectoryRegistry — updated constructor and methods

```typescript
export class DirectoryRegistry {
  /**
   * @param systemRoot  Root for system-scoped dirs (e.g., /etc/adhd/).
   * @param globalRoot  Root for global-scoped dirs (e.g., ~/.adhd/).
   * @param projectRoot Root for project-scoped dirs (e.g., <cwd>/.adhd/).
   * @param entries     All directory entries declared at construction time.
   */
  constructor(systemRoot: string, globalRoot: string, projectRoot: string, entries: DirectoryEntry[]);

  /**
   * Get resolved absolute path.
   *
   * @param type  Directory type (primary lookup key).
   * @param name  Disambiguator when multiple directories share the type.
   *              When omitted: returns first match for the type.
   *              Throws if multiple directories of same type exist and name is omitted.
   * @throws If directory not found.
   * @throws If type matches multiple directories and name is omitted.
   */
  path(type: string, name?: string): string;

  /** All registered directory names. */
  get names(): string[];

  /** Create all directories on disk (all scopes). Idempotent. */
  ensure(): void;

  /** Serializable snapshot for hashing and JSON output. */
  snapshot(): DirectoryRegistrySnapshot;
}
```

### Path Resolution Rules

**Full path pattern:**
```
<scope_root>/<project_name>/<namespace>/<type_base>/<name>/
```

Where:
- `<scope_root>`: system → `/etc/adhd/`, global → `~/.adhd/`, project → `<cwd>/.adhd/`
- `<project_name>`: from `ProjectIdentity.name`
- `<namespace>`: from `EnvironmentOptions.namespace` (defaults to `"default"`)
- `<type_base>`: derived from type (state.data→data, runtime.log→log, etc.)
- `<name>`: the `name` field from `DirectoryEntry`; when name is undefined, the type's base dir IS the terminal directory

**Concrete example for agent-mcp, namespace="production":**

System dir: `{ type: "runtime.pid", scope: "system" }`
→ `/etc/adhd/agent-mcp/production/pid/`

Global dir: `{ name: "primary", type: "state.data", scope: "global" }`
→ `~/.adhd/agent-mcp/production/data/primary/`

Global dir: `{ name: "replica", type: "state.data", scope: "global" }`
→ `~/.adhd/agent-mcp/production/data/replica/`

Project dir: `{ type: "runtime.log", scope: "project" }` (no name needed)
→ `<cwd>/.adhd/agent-mcp/production/log/`

---

## NAMESPACED ENVIRONMENTS

`EnvironmentOptions.namespace` (optional, defaults to `"default"`):

```typescript
const env = new Environment({
  project: { name: "agent-mcp" },
  namespace: "production",
  dirs: [ /* ... */ ],
});
```

Namespace affects:
- **Snapshot path:** `~/.adhd/<project>/<namespace>/adhd-environment.json`
- **Directory roots:** `~/.adhd/<project>/<namespace>/<type_base>/<name>/`
- **Env-var prefix suffix:** `ADHD_AGENT_MCP_PRODUCTION_` when namespace is `"production"` (namespace is uppercased, appended with `_`)

Namespace does NOT affect:
- `projectEnvPrefix("agent-mcp")` → still `"ADHD_AGENT_MCP"` (prefix derives from project name only)
- The namespace-prefixed env vars are for creation-time injection only

A project with no namespace uses `"default"` — snapshot at `~/.adhd/<project>/default/adhd-environment.json`.

---

## FULL WORKED EXAMPLES (5 Demos)

### Demo 1: Definition-time — Samira defines agent-mcp config

Samira is configuring `agent-mcp` for her org. She defines three tiers of field definitions and registers directories.

#### System-scoped fields (framework defaults, shipped by ADHD)

These are defined in the framework itself — Samira does NOT author these; they come from `@adhd/environment` or the system package.

```typescript
const systemFields: ConfigFieldMap = {
  "runtime.threads": {
    env: "ADHD_AGENT_MCP_RUNTIME_THREADS",
    default: "4",
    scope: "system",
    type: "integer",
    minimum: 1,
    maximum: 64,
  },
  "runtime.memory": {
    env: "ADHD_AGENT_MCP_RUNTIME_MEMORY",
    default: "512",
    scope: "system",
    type: "integer",
    minimum: 64,
    maximum: 65536,
  },
};
```

#### Global-scoped fields (org-wide overrides, shared across projects)

Samira's team defines these in a shared package:

```typescript
const globalFields: ConfigFieldMap = {
  "server.port": {
    env: "ADHD_AGENT_MCP_SERVER_PORT",
    default: "8080",
    scope: "global",
    type: "integer",
    minimum: 1024,
    maximum: 65535,
  },
  "server.host": {
    env: "ADHD_AGENT_MCP_SERVER_HOST",
    default: "localhost",
    scope: "global",
    type: "string",
    pattern: "^[0-9a-z.]+$",
  },
  "db.path": {
    env: "ADHD_AGENT_MCP_DB_PATH",
    default: "${ADHD_HOME}/agent-mcp/data/db",
    scope: "global",
    type: "path",
  },
  "db.port": {
    env: "ADHD_AGENT_MCP_DB_PORT",
    default: "5432",
    scope: "global",
    type: "integer",
    minimum: 1024,
  },
  "log.level": {
    env: "ADHD_AGENT_MCP_LOG_LEVEL",
    default: "info",
    scope: "global",
    type: "string",
    enum: ["debug", "info", "warn", "error"],
  },
};
```

#### Project-scoped fields (agent-mcp specific overrides)

Samira defines these in the agent-mcp entrypoint:

```typescript
const projectFields: ConfigFieldMap = {
  // Override server.port default — keep all validation from global
  "server.port": {
    env: "ADHD_AGENT_MCP_SERVER_PORT",
    default: "3000",
    scope: "project",
  },
  // Override db.path default — inherit type from global
  "db.path": {
    env: "ADHD_AGENT_MCP_DB_PATH",
    default: "${HOME}/.adhd/agent-mcp/db",
    scope: "project",
  },
  // New project-only field
  "server.workers": {
    env: "ADHD_AGENT_MCP_WORKERS",
    default: "4",
    scope: "project",
    type: "integer",
    minimum: 1,
    maximum: 32,
  },
};
```

#### Directory registration (type-first, with namespacing)

Samira registers directories for both `"production"` and `"staging"` namespaces:

```typescript
// For production:
const prodDirs: DirectoryEntry[] = [
  { name: "primary", type: "state.data",  scope: "global",  description: "Primary SQLite database" },
  { name: "replica", type: "state.data",  scope: "global",  description: "Read replica" },
  { type: "runtime.log",                  scope: "project", description: "Application logs" },
  { type: "runtime.cache",                scope: "global",  description: "Transient cache" },
  { type: "runtime.pid",                  scope: "system",  description: "PID files" },
];

// For staging (different namespace — different directories on disk):
const stagingDirs: DirectoryEntry[] = [
  { name: "primary", type: "state.data",  scope: "global",  description: "Staging SQLite database" },
  { type: "runtime.log",                  scope: "project", description: "Staging application logs" },
  { type: "runtime.cache",                scope: "global",  description: "Staging transient cache" },
];
```

**Visual path layout for namespace="production":**

```
/etc/adhd/agent-mcp/production/pid/           ← system
~/.adhd/agent-mcp/production/data/primary/    ← global
~/.adhd/agent-mcp/production/data/replica/    ← global
~/.adhd/agent-mcp/production/cache/           ← global
<project>/.adhd/agent-mcp/production/log/     ← project
```

---

### Demo 2: The merge — what happens at initialize()

**Input to `merge_field_definitions(system, global, project)`:**

#### System fields:
```json
{
  "runtime.threads": { "env": "ADHD_AGENT_MCP_RUNTIME_THREADS", "default": "4",   "scope": "system", "type": "integer", "minimum": 1,  "maximum": 64 },
  "runtime.memory":  { "env": "ADHD_AGENT_MCP_RUNTIME_MEMORY",  "default": "512", "scope": "system", "type": "integer", "minimum": 64, "maximum": 65536 }
}
```

#### Global fields:
```json
{
  "server.port":  { "env": "ADHD_AGENT_MCP_SERVER_PORT",  "default": "8080",      "scope": "global", "type": "integer", "minimum": 1024, "maximum": 65535 },
  "server.host":  { "env": "ADHD_AGENT_MCP_SERVER_HOST",  "default": "localhost", "scope": "global", "type": "string",  "pattern": "^[0-9a-z.]+$" },
  "db.path":      { "env": "ADHD_AGENT_MCP_DB_PATH",      "default": "${ADHD_HOME}/agent-mcp/data/db", "scope": "global", "type": "path" },
  "db.port":      { "env": "ADHD_AGENT_MCP_DB_PORT",      "default": "5432",      "scope": "global", "type": "integer", "minimum": 1024 },
  "log.level":    { "env": "ADHD_AGENT_MCP_LOG_LEVEL",    "default": "info",      "scope": "global", "type": "string",  "enum": ["debug","info","warn","error"] }
}
```

#### Project fields:
```json
{
  "server.port":    { "env": "ADHD_AGENT_MCP_SERVER_PORT", "default": "3000",                              "scope": "project" },
  "db.path":        { "env": "ADHD_AGENT_MCP_DB_PATH",     "default": "${HOME}/.adhd/agent-mcp/db",        "scope": "project" },
  "server.workers": { "env": "ADHD_AGENT_MCP_WORKERS",     "default": "4",    "scope": "project", "type": "integer", "minimum": 1, "maximum": 32 }
}
```

#### Merged output:
```json
{
  "runtime.threads": { "env": "ADHD_AGENT_MCP_RUNTIME_THREADS", "default": "4",   "scope": "system",  "type": "integer", "minimum": 1,  "maximum": 64 },
  "runtime.memory":  { "env": "ADHD_AGENT_MCP_RUNTIME_MEMORY",  "default": "512", "scope": "system",  "type": "integer", "minimum": 64, "maximum": 65536 },
  "server.port":     { "env": "ADHD_AGENT_MCP_SERVER_PORT",     "default": "3000",                     "scope": "project", "type": "integer", "minimum": 1024, "maximum": 65535 },
  "server.host":     { "env": "ADHD_AGENT_MCP_SERVER_HOST",     "default": "localhost",                "scope": "global",  "type": "string",  "pattern": "^[0-9a-z.]+$" },
  "db.path":         { "env": "ADHD_AGENT_MCP_DB_PATH",         "default": "${HOME}/.adhd/agent-mcp/db", "scope": "project", "type": "path" },
  "db.port":         { "env": "ADHD_AGENT_MCP_DB_PORT",         "default": "5432",                     "scope": "global",  "type": "integer", "minimum": 1024 },
  "log.level":       { "env": "ADHD_AGENT_MCP_LOG_LEVEL",       "default": "info",                     "scope": "global",  "type": "string",  "enum": ["debug","info","warn","error"] },
  "server.workers":  { "env": "ADHD_AGENT_MCP_WORKERS",         "default": "4",                        "scope": "project", "type": "integer", "minimum": 1, "maximum": 32 }
}
```

**Observations:**
- `runtime.threads` and `runtime.memory` pass through from system untouched — scope stays `"system"`.
- `server.port` gets `default: "3000"` from project but inherits `type: "integer"`, `minimum: 1024`, `maximum: 65535` from global. Scope becomes `"project"` (project override).
- `server.host`, `db.port`, `log.level` pass through from global untouched — scope stays `"global"`.
- `db.path` gets project `default` but inherits `type: "path"` from global. Scope becomes `"project"`.
- `server.workers` is added from project — scope is `"project"`.

---

### Demo 3: Value resolution with provenance

Environment: `ADHD_AGENT_MCP_SERVER_HOST=0.0.0.0` is set in the environment. No other env vars are set.

#### Full cascade resolution table (all scopes):

| Field | Env Var | Env Set? | Default | Resolved Value | Provenance Source | Scope |
|---|---|---|---|---|---|---|
| `runtime.threads` | `ADHD_AGENT_MCP_RUNTIME_THREADS` | no | `"4"` | `"4"` | `system.default` | system |
| `runtime.memory` | `ADHD_AGENT_MCP_RUNTIME_MEMORY` | no | `"512"` | `"512"` | `system.default` | system |
| `server.port` | `ADHD_AGENT_MCP_SERVER_PORT` | no | `"3000"` | `"3000"` | `project.default` | project |
| `server.host` | `ADHD_AGENT_MCP_SERVER_HOST` | yes (`0.0.0.0`) | `"localhost"` | `"0.0.0.0"` | `global.env` | global |
| `db.path` | `ADHD_AGENT_MCP_DB_PATH` | no | `"${HOME}/.adhd/agent-mcp/db"` | `"/home/user/.adhd/agent-mcp/db"` | `project.default` | project |
| `db.port` | `ADHD_AGENT_MCP_DB_PORT` | no | `"5432"` | `"5432"` | `global.default` | global |
| `log.level` | `ADHD_AGENT_MCP_LOG_LEVEL` | no | `"info"` | `"info"` | `global.default` | global |
| `server.workers` | `ADHD_AGENT_MCP_WORKERS` | no | `"4"` | `"4"` | `project.default` | project |

#### Scope-filtered resolution: `resolve({ scope: "system" })` — only system-scoped fields:

| Field | Env Set? | Default | Resolved Value | Provenance Source |
|---|---|---|---|---|
| `runtime.threads` | no | `"4"` | `"4"` | `system.default` |
| `runtime.memory` | no | `"512"` | `"512"` | `system.default` |

#### Scope-filtered resolution: `resolve({ scope: "global" })` — only global-scoped fields:

| Field | Env Set? | Default | Resolved Value | Provenance Source |
|---|---|---|---|---|
| `server.host` | yes (`0.0.0.0`) | `"localhost"` | `"0.0.0.0"` | `global.env` |
| `db.port` | no | `"5432"` | `"5432"` | `global.default` |
| `log.level` | no | `"info"` | `"info"` | `global.default` |

Note: `server.port` and `db.path` are NOT in the global-scoped result — their effective scope is `"project"` after merge, even though the core definition came from global.

#### Scope-filtered resolution: `resolve({ scope: "project" })` — only project-scoped fields:

| Field | Env Set? | Default | Resolved Value | Provenance Source |
|---|---|---|---|---|
| `server.port` | no | `"3000"` | `"3000"` | `project.default` |
| `db.path` | no | `"${HOME}/.adhd/agent-mcp/db"` | `"/home/user/.adhd/agent-mcp/db"` | `project.default` |
| `server.workers` | no | `"4"` | `"4"` | `project.default` |

---

### Demo 4: Runtime snapshot — the full output

After `initialize()` for `agent-mcp` with `namespace: "production"`, the complete `adhd-environment.json` at `~/.adhd/agent-mcp/production/adhd-environment.json`:

```json
{
  "project": {
    "name": "agent-mcp",
    "description": "ADHD Agent MCP Server",
    "repo": "https://github.com/example/adhd",
    "homepage": "https://adhd.dev",
    "license": "MIT",
    "meta": {}
  },
  "namespace": "production",
  "version": {
    "configHash": "sha256-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    "structureHash": "sha256-b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3",
    "generatedAt": "2026-07-06T12:00:00.000Z",
    "libraryVersion": "0.0.2"
  },
  "directories": {
    "state.data/primary": {
      "path": "/home/user/.adhd/agent-mcp/production/data/primary",
      "type": "state.data",
      "name": "primary",
      "description": "Primary SQLite database",
      "scope": "global"
    },
    "state.data/replica": {
      "path": "/home/user/.adhd/agent-mcp/production/data/replica",
      "type": "state.data",
      "name": "replica",
      "description": "Read replica",
      "scope": "global"
    },
    "runtime.log": {
      "path": "/home/user/projects/agent-mcp/.adhd/agent-mcp/production/log",
      "type": "runtime.log",
      "description": "Application logs",
      "scope": "project"
    },
    "runtime.cache": {
      "path": "/home/user/.adhd/agent-mcp/production/cache",
      "type": "runtime.cache",
      "description": "Transient cache",
      "scope": "global"
    },
    "runtime.pid": {
      "path": "/etc/adhd/agent-mcp/production/pid",
      "type": "runtime.pid",
      "description": "PID files",
      "scope": "system"
    }
  },
  "config": {
    "runtime": {
      "threads": 4,
      "memory": 512
    },
    "server": {
      "port": 3000,
      "host": "0.0.0.0",
      "workers": 4
    },
    "db": {
      "path": "/home/user/.adhd/agent-mcp/db",
      "port": 5432
    },
    "log": {
      "level": "info"
    }
  },
  "fieldSchema": {
    "type": "object",
    "properties": {
      "runtime": {
        "type": "object",
        "properties": {
          "threads": { "type": "integer", "minimum": 1, "maximum": 64 },
          "memory":  { "type": "integer", "minimum": 64, "maximum": 65536 }
        }
      },
      "server": {
        "type": "object",
        "properties": {
          "port":    { "type": "integer", "minimum": 1024, "maximum": 65535 },
          "host":    { "type": "string",  "pattern": "^[0-9a-z.]+$" },
          "workers": { "type": "integer", "minimum": 1, "maximum": 32 }
        }
      },
      "db": {
        "type": "object",
        "properties": {
          "path": { "type": "string" },
          "port": { "type": "integer", "minimum": 1024 }
        }
      },
      "log": {
        "type": "object",
        "properties": {
          "level": { "type": "string", "enum": ["debug", "info", "warn", "error"] }
        }
      }
    }
  },
  "provenance": {
    "runtime.threads": { "source": "system.default",  "scope": "system" },
    "runtime.memory":  { "source": "system.default",  "scope": "system" },
    "server.port":     { "source": "project.default", "scope": "project" },
    "server.host":     { "source": "global.env",      "scope": "global", "env": "ADHD_AGENT_MCP_SERVER_HOST" },
    "db.path":         { "source": "project.default", "scope": "project" },
    "db.port":         { "source": "global.default",  "scope": "global" },
    "log.level":       { "source": "global.default",  "scope": "global" },
    "server.workers":  { "source": "project.default", "scope": "project" }
  },
  "envPrefix": "ADHD_AGENT_MCP",
  "envVars": {
    "ADHD_AGENT_MCP_PRODUCTION_RUNTIME_THREADS": "4",
    "ADHD_AGENT_MCP_PRODUCTION_RUNTIME_MEMORY": "512",
    "ADHD_AGENT_MCP_PRODUCTION_SERVER_PORT": "3000",
    "ADHD_AGENT_MCP_PRODUCTION_SERVER_HOST": "0.0.0.0",
    "ADHD_AGENT_MCP_PRODUCTION_DB_PATH": "/home/user/.adhd/agent-mcp/db",
    "ADHD_AGENT_MCP_PRODUCTION_DB_PORT": "5432",
    "ADHD_AGENT_MCP_PRODUCTION_LOG_LEVEL": "info",
    "ADHD_AGENT_MCP_PRODUCTION_WORKERS": "4"
  }
}
```

Key differences from v0.0.1 snapshot:
- `namespace` field added (new required field).
- `directories` keyed by `"<type>/<name>"` or `"<type>"` (type-first, not name-first).
- `directories` entries now have optional `name` and three `scope` values (`system`, `global`, `project`).
- `runtime.pid` directory has `scope: "system"`, rooted at `/etc/adhd/`.
- `provenance` now includes `system.default` source.
- `envVars` uses namespace-suffixed keys (`ADHD_AGENT_MCP_PRODUCTION_...`).
- `structureHash` uses `type:name:scope\n` format with empty name when not set.

---

### Demo 5: User usage — Samira coding

Samira uses the `Environment` instance in her agent-mcp code.

#### Directory lookups (type-first):

```typescript
const env = new Environment({
  project: { name: "agent-mcp" },
  namespace: "production",
  dirs: [
    { name: "primary", type: "state.data",  scope: "global", description: "Primary SQLite database" },
    { name: "replica", type: "state.data",  scope: "global", description: "Read replica" },
    { type: "runtime.log",                  scope: "project", description: "Application logs" },
    { type: "runtime.cache",                scope: "global", description: "Transient cache" },
    { type: "runtime.pid",                  scope: "system", description: "PID files" },
  ],
  config: {
    system:  systemFields,
    global:  globalFields,
    project: projectFields,
  },
});

await env.initialize();

// Lookup by type — returns the first/only match:
env.dirs.path("state.data")
// → "/home/user/.adhd/agent-mcp/production/data/primary"

// Lookup by type + name — returns the specific disambiguated match:
env.dirs.path("state.data", "replica")
// → "/home/user/.adhd/agent-mcp/production/data/replica"

// Lookup by name alone (shortcut — works when name is unique):
env.dirs.path("primary")
// → "/home/user/.adhd/agent-mcp/production/data/primary"

// Lookup by type alone when only one exists:
env.dirs.path("runtime.log")
// → "/home/user/projects/agent-mcp/.adhd/agent-mcp/production/log"

// System-scoped directory:
env.dirs.path("runtime.pid")
// → "/etc/adhd/agent-mcp/production/pid"
```

#### Config resolution (scope-aware):

```typescript
// Full cascade (default) — all fields, system → global → project:
const fullConfig = env.config.resolve();
// fullConfig.nested = {
//   runtime: { threads: 4, memory: 512 },
//   server: { port: 3000, host: "0.0.0.0", workers: 4 },
//   db:     { path: "/home/user/.adhd/agent-mcp/db", port: 5432 },
//   log:    { level: "info" }
// }

// System-only resolution:
const systemConfig = env.config.resolve({ scope: "system" });
// systemConfig.nested = { runtime: { threads: 4, memory: 512 } }

// Global-only resolution:
const globalConfig = env.config.resolve({ scope: "global" });
// globalConfig.nested = { server: { host: "0.0.0.0" }, db: { port: 5432 }, log: { level: "info" } }

// Project-only resolution:
const projectConfig = env.config.resolve({ scope: "project" });
// projectConfig.nested = { server: { port: 3000, workers: 4 }, db: { path: "/home/user/.adhd/agent-mcp/db" } }
```

#### Namespace switching:

```typescript
// Production instance:
const prod = new Environment({
  project: { name: "agent-mcp" },
  namespace: "production",
  dirs: prodDirs,
  config: { system: systemFields, global: globalFields, project: projectFields },
});
await prod.initialize();
// Snapshot at: ~/.adhd/agent-mcp/production/adhd-environment.json
// Paths rooted at: ~/.adhd/agent-mcp/production/...
// Env vars: ADHD_AGENT_MCP_PRODUCTION_...

// Staging instance — same project, different namespace, different disks, different snapshot:
const staging = new Environment({
  project: { name: "agent-mcp" },
  namespace: "staging",
  dirs: stagingDirs,
  config: { system: systemFields, global: globalFields, project: projectFields },
});
await staging.initialize();
// Snapshot at: ~/.adhd/agent-mcp/staging/adhd-environment.json
// Paths rooted at: ~/.adhd/agent-mcp/staging/...
// Env vars: ADHD_AGENT_MCP_STAGING_...

// The two instances are completely isolated on disk.
// prod.dirs.path("state.data")    → .../production/data/primary
// staging.dirs.path("state.data") → .../staging/data/primary
```

---

## TypeScript interfaces

### `Environment` — composition root

```typescript
export interface EnvironmentOptions {
  /** Project identity. */
  project: ProjectIdentity;

  /**
   * Environment namespace. Defaults to "default".
   * Affects snapshot path, directory roots, and env-var prefix suffix.
   */
  namespace?: string;

  /** Directory entries (constructor-only — no runtime registration). */
  dirs?: DirectoryEntry[];

  /** Config resolver options. */
  config?: EnvironmentConfigOptions;

  /** Custom root for ~/.adhd/ (default: os.homedir()/.adhd). */
  adhdRoot?: string;

  /** Custom CWD for project-scoped resolution. */
  cwd?: string;

  /** Custom system root (default: /etc/adhd/). */
  systemRoot?: string;
}

export interface EnvironmentConfigOptions {
  /** System-scoped field definitions (base defaults, framework-shipped). */
  system?: ConfigFieldMap;

  /** Global-scoped field definitions (org-wide overrides). */
  global?: ConfigFieldMap;

  /** Project-scoped field definitions (project-specific overrides). */
  project?: ConfigFieldMap;

  /** Custom .env file load order. Each entry is an absolute path. */
  envFiles?: string[];

  /** Organization name for path roots (default: "adhd"). */
  org?: string;
}

export class Environment {
  readonly project: Readonly<ProjectIdentity>;
  readonly namespace: string;
  readonly dirs: DirectoryRegistry;
  readonly config: ConfigResolver;
  readonly envPrefix: string;

  constructor(options: EnvironmentOptions);

  /**
   * Full pipeline: load .env, merge field definitions (system→global→project),
   * resolve config, generate fieldSchema, ensure dirs, detect changes,
   * validate config against fieldSchema, track provenance, write snapshot.
   *
   * Warns if structure changed from on-disk snapshot.
   * Throws if a competing structure is detected.
   * Throws if resolved config fails validation against fieldSchema.
   */
  initialize(): EnvironmentSnapshot;

  /**
   * Resolve config values, optionally scoped.
   * @param scope  Filter to a specific scope. Omit for full cascade.
   */
  resolve(scope?: ConfigScope): ConfigSnapshot;

  /** Re-resolve: invalidates caches, re-loads .env, re-computes hashes, writes snapshot. */
  refresh(): EnvironmentSnapshot;

  /** Get cached snapshot. Throws if initialize() was never called. */
  get snapshot(): EnvironmentSnapshot;
}
```

### `DirectoryRegistry` — scope-aware, type-first directory management

```typescript
export interface DirectoryRegistrySnapshot {
  /** All registered directories keyed by type (or "type/name" for disambiguation). */
  entries: Record<string, DirectoryEntry & { path: string }>;
}

export class DirectoryRegistry {
  /**
   * @param systemRoot  Root for system-scoped dirs (e.g., /etc/adhd/).
   * @param globalRoot  Root for global-scoped dirs (e.g., ~/.adhd/).
   * @param projectRoot Root for project-scoped dirs (e.g., <cwd>/.adhd/).
   * @param entries     All directory entries declared at construction time.
   */
  constructor(systemRoot: string, globalRoot: string, projectRoot: string, entries: DirectoryEntry[]);

  /**
   * Get resolved absolute path.
   * @param type  Directory type (primary lookup key — e.g., "state.data").
   * @param name  Disambiguator when multiple directories share the type.
   *              When omitted: returns first match for the type.
   *              When ambiguous: throws with list of possible names.
   *              Also accepts a name-only lookup (matches against entry.name).
   * @throws If directory not found.
   */
  path(type: string, name?: string): string;

  /** All registered directory names (unique). */
  get names(): string[];

  /** Create all directories on disk (all scopes). Idempotent. */
  ensure(): void;

  /** Serializable snapshot for hashing and JSON output. */
  snapshot(): DirectoryRegistrySnapshot;
}
```

### `ConfigResolver` — three-tier scope-aware with field inheritance

```typescript
export interface ConfigResolverOptions {
  /** Env-var prefix for this project. */
  prefix: string;

  /** Organization name for global/system path roots (default: "adhd"). */
  org?: string;

  /**
   * Field definitions in three tiers.
   * system → global → project merge cascade.
   */
  system?: ConfigFieldMap;
  global?: ConfigFieldMap;
  project?: ConfigFieldMap;

  /**
   * Custom .env file load order. Each entry is an absolute path.
   * Omit for default 3-tier hierarchy:
   *   1. <adhdRoot>/.env      (no override)
   *   2. <cwd>/.adhd/.env      (override)
   *   3. <cwd>/.env            (override)
   */
  envFiles?: string[];

  /** Custom CWD for resolving relative paths. */
  cwd?: string;

  /** Custom adhd root for resolving global-scoped paths. */
  adhdRoot?: string;
}

export interface ConfigSnapshot {
  /** Flat resolved key→value map (all strings, ${VAR} expanded). */
  raw: Record<string, string>;

  /** Nested config object (unflattened, type-coerced). */
  nested: Record<string, unknown>;

  /** Content hash (SHA-256 of sorted raw values). */
  configHash: string;

  /** Generated JSON Schema from merged field definitions. */
  fieldSchema: Record<string, unknown>;

  /** Provenance map: key → { source, scope, env? }. */
  provenance: Record<string, ProvenanceEntry>;

  /** All env vars read during resolution → their resolved values. */
  envVars: Record<string, string>;
}

export class ConfigResolver {
  constructor(options: ConfigResolverOptions);

  /**
   * Resolve config fields.
   * @param opts.scope        Filter to a specific scope. Omit for full cascade.
   * @param opts.envSnapshot  Test injection — overrides process.env for specific vars.
   * @param opts.envOverrides Aliasing map: {"ORIGINAL_VAR": "ALIASED_VAR"}.
   */
  resolve(opts?: {
    scope?: ConfigScope;
    envSnapshot?: Record<string, string | undefined>;
    envOverrides?: Record<string, string>;
  }): ConfigSnapshot;

  /** Clear cached resolution — next resolve() re-reads env and re-computes. */
  invalidate(): void;
}
```

### Exported utilities

```typescript
export function parseEnvFile(filePath: string): Record<string, string>;
export function loadEnvHierarchy(adhdRoot?: string, cwd?: string): void;
export function loadEnvFiles(paths: string[], cwd?: string): void;
export function interpolate(value: string, context: Record<string, string>): string;
export function contentHash(config: Record<string, string>): string;
export function structureHash(dirs: DirectoryRegistrySnapshot): string;
export function unflatten(flat: Record<string, string>): Record<string, unknown>;
export function projectEnvPrefix(name: string): string;
export function namespaceEnvPrefix(projectName: string, namespace: string): string;
export function generateFieldSchema(fields: ConfigFieldMap): Record<string, unknown>;
export function mergeFieldDefinitions(system: ConfigFieldMap, global: ConfigFieldMap, project: ConfigFieldMap): ConfigFieldMap;
export function readSnapshot(projectName: string, namespace?: string, adhdRoot?: string): EnvironmentSnapshot;
export function writeSnapshot(projectName: string, namespace: string, snapshot: EnvironmentSnapshot, adhdRoot?: string): string;
```

### Types

```typescript
export type DirectoryType =
  | 'state.data' | 'state.config'
  | 'runtime.log' | 'runtime.cache' | 'runtime.pid'
  | 'user.bin' | 'user.custom';

export type ConfigScope = 'system' | 'global' | 'project';

export type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'path';

export type ProvenanceSource =
  | 'system.default'
  | 'global.default' | 'global.env'
  | 'project.default' | 'project.env';

export interface ProjectIdentity {
  name: string;
  description?: string;
  repo?: string;
  homepage?: string;
  license?: string;
  meta?: Record<string, string>;
}

export interface DirectoryEntry {
  type: DirectoryType;           // primary identifier
  name?: string;                 // disambiguator when multiple of same type
  scope: 'system' | 'global' | 'project';
  description?: string;          // optional metadata, does not affect path
}

export interface ConfigFieldDefinition {
  env: string;
  default: string;
  scope: ConfigScope;

  // Validation keywords (all optional)
  type?: FieldType;
  minimum?: number;
  maximum?: number;
  enum?: (string | number)[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

export type ConfigFieldMap = Record<string, ConfigFieldDefinition>;

export interface ProvenanceEntry {
  source: ProvenanceSource;
  scope: ConfigScope;
  env?: string;
}

export interface EnvironmentSnapshot {
  project: ProjectIdentity;
  namespace: string;
  version: {
    configHash: string;
    structureHash: string;
    generatedAt: string;
    libraryVersion: string;
  };
  directories: Record<string, {
    path: string;
    type: DirectoryType;
    name?: string;
    description?: string;
    scope: 'system' | 'global' | 'project';
  }>;
  config: Record<string, unknown>;
  fieldSchema?: Record<string, unknown>;
  provenance?: Record<string, ProvenanceEntry>;
  envPrefix: string;
  envVars: Record<string, string>;
}
```

---

## Behavioral specification

### `mergeFieldDefinitions` — three-tier field definition inheritance

```typescript
function mergeFieldDefinitions(system: ConfigFieldMap, global: ConfigFieldMap, project: ConfigFieldMap): ConfigFieldMap
```

Algorithm per the FIELD DEFINITION DESIGN section above. Key behaviors:
- Cascades system → global → project. At each step, higher-precedence scope's non-undefined properties overwrite lower scope.
- Validation keywords from lower scope are retained when higher scope only changes `default`.
- The resulting field's `scope` reflects the highest-precedence participant (e.g., if project overrides a system field, scope is `"project"`).
- Fields only in system stay system; only in global stay global; only in project stay project.
- Empty maps are handled: `mergeFieldDefinitions({}, {}, project)` works (returns project as-is).

### `generateFieldSchema` — JSON Schema generation

```typescript
function generateFieldSchema(fields: ConfigFieldMap): Record<string, unknown>
```

Algorithm:
1. Initialize result: `{ "type": "object", "properties": {} }`.
2. For each `[key, def]` in `fields`:
   - Split key on `.` to get path segments.
   - Walk/create nested `{ "type": "object", "properties": {...} }` nodes.
   - At the leaf, create a property schema:
     - Map `def.type` to JSON Schema `type` (`"path"` → `"string"`).
     - Copy `minimum`, `maximum`, `enum`, `pattern`, `minLength`, `maxLength` if defined.
     - Omit undefined keywords.
3. Return the schema object.

### `ConfigResolver.resolve()` — resolution order with provenance

1. Load `.env` files from `envFiles` (or default hierarchy).
2. Apply `envOverrides`: for each `[original, aliased]`, redirect env reads from `original` to `aliased`.
3. **Merge field definitions:** `mergeFieldDefinitions(system, global, project)` → `effectiveFields`.
4. For each field in `effectiveFields`, resolve value:
   - Check `envSnapshot?.[fieldDef.env]` → `process.env[fieldDef.env]` → field's `default`.
   - Record provenance: which source won, scope, and env var name if applicable.
5. Run `interpolate(value, process.env)` on each resolved value.
6. **Generate `fieldSchema`** from `effectiveFields`.
7. `unflatten(raw)` → nested config object, coerce types per field definitions.
8. Compute `contentHash(raw)`.
9. Return `ConfigSnapshot` with all sections populated.

**Scope filtering:** When `opts.scope` is provided, filter `fields` to only those whose effective `scope` matches before step 4.

### `DirectoryRegistry.path()` — type-first lookup

1. If `name` is provided:
   - Check for exact match: `entries.filter(e => e.name === name)`. If one match → return its path.
   - Check for exact match: `entries.filter(e => e.type === type && e.name === name)`. If one match → return its path.
   - If not found → throw.
2. If `name` is NOT provided:
   - Check for exact match: `entries.filter(e => e.name === type)`. If one match → return its path.
   - Check for exact match: `entries.filter(e => e.type === type)`:
     - If zero matches → throw "No directory of type <type> registered."
     - If one match → return its path.
     - If multiple matches → throw "Multiple directories of type <type>: <list of names>. Specify name to disambiguate."
   - If not found → throw.

Key: When `name` is omitted and `type` matches a known DirectoryType pattern, the first lookup is by name (treating the argument as a name). This supports the shortcut `env.dirs.path("primary")` when `primary` is a name. Implement as: treat the single string argument as a possible name first, then fall back to type matching.

### `parseEnvFile` — internal `.env` parser (unchanged)

Replaces `dotenv`. Pure function — reads a file, returns a `Record<string, string>`. Never mutates `process.env`.
- Skips blank lines and `#`-prefixed lines.
- Splits on first `=` only.
- Strips `export ` prefix from keys.
- Strips matching single or double quotes from values.
- `${VAR}` references preserved as literal strings.
- Returns empty object for missing files (ENOENT). Throws on other read errors.

### `interpolate` — variable expansion (unchanged)

Finds all `${VAR}` patterns. For each: look up in context → replace with resolved value. Not found → leave `${VAR}` as literal. Single-level only — no recursive expansion.

### `contentHash` + `structureHash` (updated)

`contentHash` unchanged. `structureHash` now uses `type:name:scope\n` format (where name is empty string when not set).

### `namespaceEnvPrefix` — new utility

```typescript
function namespaceEnvPrefix(projectName: string, namespace: string): string
```

1. Derive `projectEnvPrefix(name)` → e.g. `"ADHD_AGENT_MCP"`.
2. If `namespace === "default"` → return the project prefix unchanged.
3. Uppercase namespace, replace `[^A-Z0-9]` with `_`.
4. Return `"<project_prefix>_<namespace_upper>_"` → e.g. `"ADHD_AGENT_MCP_PRODUCTION_"`.

### `Environment.initialize()` — full pipeline with three-tier merge and namespace

1. Load `.env` files (delegates to ConfigResolver).
2. **Merge field definitions** (system → global → project) and resolve config (delegates to ConfigResolver).
3. **Generate `fieldSchema`** from merged definitions.
4. **Validate** resolved config against `fieldSchema` using `ajv`. If validation fails, throw with detailed field-level errors.
5. Compute `structureHash(dirs.snapshot())`.
6. **Track provenance** for every resolved config key (now includes `system.default` source).
7. **Read on-disk snapshot** (if exists, at namespace-specific path). Compare `structureHash`:
   - Hash matches: no structural change. Proceed.
   - Hash differs: compare directory entries:
     - New directories → **warn**.
     - Directories removed → **warn**.
     - Directory types changed → **throw** `Error("Competing structure: <dir> changed from <old> to <new>")`.
     - Directory scope changed → **throw** `Error("Competing structure: <dir> scope changed from <old> to <new>")`.
     - Project name mismatch → **throw** `Error("Namespace conflict: <path> already claimed by <other-project>")`.
8. `dirs.ensure()` — create all directories on disk (all three scopes).
9. Build `EnvironmentSnapshot` with all sections (config, fieldSchema, provenance, namespace, etc.).
10. **Atomic write** to `<path>.tmp` then `renameSync` at `~/.adhd/<project>/<namespace>/adhd-environment.json`.
11. Cache and return snapshot.

### `Environment.refresh()` — re-resolution

Invalidates config cache, re-runs full `initialize()` pipeline.

---

## File manifests

### `packages/environment/environment-base-spec/` — Contract package

| Path | Change | Description |
|------|--------|-------------|
| `package.json` | modify | Update spec version references |
| `project.json` | modify | No structural change |
| `tsconfig.json` | modify | No structural change |
| `spec/SPEC.md` | modify | §1–§6a updated: three-tier scope, type-first dirs, namespace, system root |
| `spec/adhd-environment.schema.json` | modify | New: `namespace` field, `$defs/directoryEntry` with optional `name` and three `scope` values, `provenance` includes `system.default` |
| `spec/cross-language-test-vectors.json` | modify | Add test vectors for three-tier merge, namespaceEnvPrefix, type-first path resolution |
| `src/index.ts` | modify | Updated type re-exports |
| `README.md` | modify | Updated overview |

### `packages/environment/environment-core-node/` — TypeScript reference implementation

| Path | Change | Description |
|------|--------|-------------|
| `src/index.ts` | modify | Public API re-exports — add `namespaceEnvPrefix`, updated types |
| `src/lib/types.ts` | modify | `DirectoryEntry` — name optional, scope includes `"system"`. `EnvironmentSnapshot` — add `namespace`. `ProvenanceSource` — add `"system.default"`. |
| `src/lib/project-identity.ts` | modify | Add `namespaceEnvPrefix()` |
| `src/lib/directory-registry.ts` | modify | Constructor takes `systemRoot` + `globalRoot` + `projectRoot`. `path()` — type-first lookup with name disambiguation. Path pattern includes namespace. |
| `src/lib/field-merge.ts` | modify | `mergeFieldDefinitions()` — three-tier (system, global, project) |
| `src/lib/json-schema-gen.ts` | modify | No functional change |
| `src/lib/config-resolver.ts` | modify | `ConfigResolverOptions` — separate `system`, `global`, `project` maps. `resolve()` — opts object with scope, envSnapshot, envOverrides. Three-tier merge. |
| `src/lib/interpolate.ts` | modify | No functional change |
| `src/lib/unflatten.ts` | modify | No functional change |
| `src/lib/content-hash.ts` | modify | `structureHash` — updated line format: `type:name:scope\n` |
| `src/lib/snapshot.ts` | modify | `readSnapshot(project, namespace?, adhdRoot?)`, `writeSnapshot(project, namespace, snapshot, adhdRoot?)` |
| `src/lib/provenance.ts` | modify | Add `system.default` to provenance source mapping |
| `src/lib/validation.ts` | modify | No functional change |
| `src/lib/environment.ts` | modify | `EnvironmentOptions` — add `namespace`, `systemRoot`, `system` fields. Three-tier merge in `initialize()`. Namespace-suffixed env vars. |
| `src/__tests__/contract-compliance.test.ts` | modify | Updated test vectors |
| `src/__tests__/field-merge.test.ts` | modify | Three-tier merge tests |
| `src/__tests__/directory-registry.test.ts` | modify | Type-first lookup, name disambiguation, system scope, namespace in paths |
| `src/__tests__/config-resolver.test.ts` | modify | Three-tier merge, system scope resolution, namespace prefix |
| `src/__tests__/environment.test.ts` | modify | Namespace isolation, system root paths, type-first dir lookups |
| `src/__tests__/snapshot.test.ts` | modify | Namespace in snapshot path |
| `src/__tests__/provenance.test.ts` | modify | `system.default` source tracking |
| `README.md` | modify | Updated API reference |

### `packages/environment/environment-core-py/` — Python full implementation

Mirrors all TypeScript changes above. Updated files: `types.py`, `directory_registry.py`, `field_merge.py`, `config_resolver.py`, `content_hash.py`, `snapshot.py`, `environment.py`, `project_identity.py` (add `namespace_env_prefix`). All test files updated.

### `packages/environment/environment-core-rs/` — Rust full implementation

Mirrors all TypeScript changes above. Updated files: `types.rs`, `directory_registry.rs`, `field_merge.rs`, `config_resolver.rs`, `content_hash.rs`, `snapshot.rs`, `environment.rs`, `project_identity.rs` (add `namespace_env_prefix`). All test files updated.

### `packages/environment/environment-cli/` — CLI (apigen-generated)

| Path | Change | Description |
|------|--------|-------------|
| `src/api.ts` | modify | No function name changes. Add `init` accepts optional `--namespace` param. |
| `src/lib/core.ts` | modify | Wire `namespace` through to `Environment` constructor. |
| `src/__tests__/cli.test.ts` | modify | Add namespace flag tests. |

---

## Independent segments (implementation order)

### Segment A — Type definitions + utility foundation

- **Files:** `types.ts`, `project-identity.ts` (add `namespaceEnvPrefix`), `content-hash.ts` (update `structureHash` format)
- **Dependencies:** none — standalone types and pure functions
- **Read tokens:** ~200
- **Output tokens:** ~800
- **Strategy:** Update `DirectoryEntry` (name optional, three scopes). Update `ConfigScope` type. Add `namespaceEnvPrefix()` utility. Update `structureHash` line format to `type:name:scope\n`.

### Segment B — Three-tier field merge

- **Files:** `field-merge.ts`
- **Dependencies:** Segment A (types exist)
- **Read tokens:** ~100
- **Output tokens:** ~400
- **Strategy:** Rewrite `mergeFieldDefinitions` to accept three `ConfigFieldMap` arguments: system, global, project. Cascade system → global → project.

### Segment C — DirectoryRegistry rewrite (type-first, three roots)

- **Files:** `directory-registry.ts`
- **Dependencies:** Segment A (types exist)
- **Read tokens:** ~200
- **Output tokens:** ~800
- **Strategy:** Constructor takes `systemRoot`, `globalRoot`, `projectRoot`. Rewrite `path()` for type-first lookup with name disambiguation. Incorporate namespace into path pattern: `<scope_root>/<project>/<namespace>/<type_base>/<name>/`.

### Segment D — ConfigResolver update (three-tier)

- **Files:** `config-resolver.ts`
- **Dependencies:** Segments A, B
- **Read tokens:** ~200
- **Output tokens:** ~600
- **Strategy:** Accept `system`, `global`, `project` as separate `ConfigFieldMap` properties in `ConfigResolverOptions`. Call `mergeFieldDefinitions(system, global, project)`. Update `resolve()` to take opts object. Add `system.root` path resolution for system-scoped env var defaults.

### Segment E — Snapshot + Environment update

- **Files:** `snapshot.ts`, `environment.ts`, `index.ts`
- **Dependencies:** Segments A-D
- **Read tokens:** ~300
- **Output tokens:** ~800
- **Strategy:** Add `namespace` to `EnvironmentOptions` and `EnvironmentSnapshot`. Update snapshot paths to `~/.adhd/<project>/<namespace>/`. Wire three-tier merge through `initialize()`. Add `systemRoot` option. Generate namespace-suffixed env vars.

### Segment F — Contract package update

- **Files:** `base-spec/spec/SPEC.md`, `base-spec/spec/adhd-environment.schema.json`, `base-spec/spec/cross-language-test-vectors.json`
- **Dependencies:** Segment E (to verify the schema matches implementation)
- **Read tokens:** ~500
- **Output tokens:** ~2000
- **Strategy:** Update behavioral contract with three-tier scope, type-first dirs, namespaced environments, system root. Update JSON Schema with `namespace`, updated `$defs/directoryEntry`. Add new test vectors.

### Segment G — Tests

- **Files:** All test files
- **Dependencies:** Segments A-F
- **Read tokens:** ~1000
- **Output tokens:** ~4000
- **Strategy:** Update all test files. Add type-first lookup tests, name disambiguation tests, three-tier merge tests, namespace isolation tests, system scope tests.

### Segment H — Python implementation

- **Files:** All Python source + test files
- **Dependencies:** Segment F (spec is contract)
- **Output tokens:** ~8000

### Segment I — Rust implementation

- **Files:** All Rust source + test files
- **Dependencies:** Segment F (spec is contract)
- **Output tokens:** ~9000

### Segment J — CLI update

- **Files:** `environment-cli/src/api.ts`, `core.ts`, tests
- **Dependencies:** Segment E
- **Output tokens:** ~1000

---

## Test cases

### Contract compliance tests (cross-language)

Shared test vectors in `environment-base-spec/spec/cross-language-test-vectors.json`:

- **`contentHash`** — `{ b: "2", a: "1" }` → `sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930` (unchanged)
- **`structureHash`** — standard directory set with new line format: `state.data:primary:global\n` etc. → deterministic output
- **`projectEnvPrefix`** — `"agent-mcp"` → `"ADHD_AGENT_MCP"` (unchanged)
- **`namespaceEnvPrefix`** — `("agent-mcp", "production")` → `"ADHD_AGENT_MCP_PRODUCTION_"`, `("agent-mcp", "default")` → `"ADHD_AGENT_MCP"`
- **`mergeFieldDefinitions`** — three-tier: system + global + project maps → expected merged map
- **`generateFieldSchema`** — standard field definitions → expected JSON Schema object (unchanged)
- Validate — standard config against generated schema → passes (unchanged)
- Validate fail — invalid config against generated schema → throws with field-level errors (unchanged)
- Write snapshot → read back → deep-equal round-trip (updated: namespace in path)
- Atomic write: if write fails mid-way, no partial file exists (only `.tmp`) (unchanged)

### New/updated unit tests

- `namespaceEnvPrefix`: default returns project prefix, production returns suffixed, staging returns different suffix
- `mergeFieldDefinitions`: three-tier — system only, global overrides system, project overrides global, project overrides system, all empty maps, mixed (some scopes absent)
- `DirectoryRegistry`: type-first lookup, name disambiguation, system-scope resolution to `/etc/adhd/`, global-scope to `~/.adhd/`, project-scope to `<cwd>/.adhd/`, namespace in resolved paths, duplicate type registration with and without names, ambiguous type throws, name-only shortcut, type_base mapping correctness
- `ConfigResolver`: three-tier merge, system scope filtering, global scope filtering (fields with project-effective scope excluded), project scope filtering, namespace-suffixed env var defaults
- `Environment`: namespace in snapshot path, namespace isolation (two instances, different namespaces → different disks), system root override, three-tier field merge in initialize, type-first dir lookups

### Cross-language parity tests

Each language client (TS, Python, Rust) runs against the SAME `cross-language-test-vectors.json`:

- `contentHash` produces identical output (unchanged)
- `structureHash` produces identical output for identical directory snapshots (updated format)
- `generateFieldSchema` produces identical JSON Schema for identical field definitions (unchanged)
- `mergeFieldDefinitions` produces identical merged definitions (updated for three maps)
- `namespaceEnvPrefix` produces identical output (new)
- Validate identical config against identical fieldSchema → same pass/fail result (unchanged)

---

## Edge cases

| Case | Behavior |
|---|---|
| Empty project name | `projectEnvPrefix("")` → `"ADHD_"` |
| Special chars in name | Non-`[A-Za-z0-9_-]` → mapped to `_` |
| Namespace with special chars | Uppercased + `[^A-Z0-9]` → `_` |
| Namespace = `"default"` | `namespaceEnvPrefix` returns project prefix only (no suffix) |
| No `.env` files exist | `loadEnvHierarchy()` no-op |
| `~/.adhd/` doesn't exist | `ensure()` and `writeSnapshot()` create it |
| Custom `envFiles` array empty | No `.env` files loaded (user explicitly opted out) |
| `envFiles` entry is missing file | Skip with warning (don't throw) |
| Empty string env var | Treated as set — fails validation, not silently defaulting |
| `~` in defaults | Expanded to `os.homedir()` at resolution time |
| `${VAR}` in `.env` values | Preserved as literal by parser, expanded by `interpolate()` |
| `${UNSET_VAR}` | Left as literal `${UNSET_VAR}` — no error |
| Recursive `${VAR}` | NOT expanded — only one level |
| Validation: config missing a field with default | Passes (default fills in) |
| Validation: config has extra undeclared field | Passes (JSON Schema `additionalProperties` is permissive) |
| Validation: type coercion mismatch | Fails with field-level error |
| Field merge: system → global → project | project wins over global wins over system |
| Field merge: project overrides type but not min/max from global | min/max from global inherited |
| Field merge: project overrides only `default` | All validation keywords inherited from lower scope |
| Field merge: system defines `runtime.threads`, global doesn't touch it | Stays system-scoped |
| Field merge: global defines `server.port`, project overrides `default` | Scope becomes `"project"` |
| Field merge: empty maps | `mergeFieldDefinitions({}, {}, project)` → returns project as-is |
| Directory type-first: single of type | `path("runtime.log")` returns the path without needing name |
| Directory type-first: multiple of type | `path("state.data")` throws with disambiguation message |
| Directory type-first: type + name | `path("state.data", "replica")` returns specific match |
| Directory type-first: name shortcut | `path("primary")` returns path (matches by name) |
| Directory type-first: name shortcut ambiguous | `path("primary")` if multiple entries have name="primary" → throws |
| Directory scope: same type, different scopes | Allowed — system, global, project roots independently resolved |
| Directory scope: duplicate type+name at same scope | Throws at construction |
| System-scope directory resolve | `/etc/adhd/<project>/<namespace>/<type_base>/<name>/` |
| Namespace isolation | Two `Environment` instances with different namespaces → completely separate snapshot files and directory trees |
| Snapshot file write fails mid-way | `.tmp` file may exist but `.json` is untouched |
| Concurrent access | Not guarded — last write wins |
| Custom `adhdRoot` | Testing override — points to temp dir |
| Custom `cwd` | Testing override — project root resolution uses this |
| Custom `systemRoot` | Testing override — system scope resolution uses this |
| No field definitions provided | `fieldSchema` is absent from snapshot, no validation performed |
| `fieldSchema` in old snapshot (v0.0.1) | Missing `fieldSchema` — skip validation, warn |
| Old snapshot without namespace field | Treat as namespace="default", warn |
| Structure hash: dir type changed | Throws (competing structure) |
| Structure hash: dir scope changed | Throws (competing structure) |
| Provenance: same key resolved from different env on refresh | Provenance updated to new source |
| Provenance: `system.default` source | New source value tracked |
| Cross-language hash parity | Test vector is the gate — all languages MUST match |
| `type: "path"` in field definition | Generates `{"type":"string"}` in JSON Schema |
| `enum` with mixed types | Passed through as-is to JSON Schema |
| JSON Schema generation: deeply nested keys | `a.b.c.d.e` → 5-level nested object |

---

## Retained from v0.0.1 (unchanged)

- Five-package layout under `packages/environment/`
- npm names: `@adhd/environment`, `@adhd/environment-base-spec`, `@adhd/environment-cli`, `adhd-environment` (Py), `adhd-environment` (Rs)
- Zero external runtime deps for core logic (ajv is the only new dep for validation)
- Directory types: `state.data`, `state.config`, `runtime.log`, `runtime.cache`, `runtime.pid`, `user.bin`, `user.custom`
- `contentHash` test vector: `{b:"2",a:"1"}` → `sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930`
- Atomic writes (`.tmp` + `renameSync`)
- Drift detection on `initialize()`: warn on new/removed, throw on type change and namespace conflict (+ scope change now)
- `${VAR}` interpolation (single-level, leave unresolved as literal)
- `projectEnvPrefix` derivation
- `unflatten` utility
- apigen-generated CLI (with renamed exports: `export`, `diff`)
- `Environment` class name (not `AdhdEnvironment`)
- Constructor-only directory registration
- `adhdRoot` constructor option + `ADHD_HOME` env var override
- Zod removed (replaced by inline validation keywords)
- `ConfigFieldDefinition` without Zod — validation keywords live directly on the interface
- `generateFieldSchema()` — JSON Schema auto-generation from merged field definitions
- Cross-language validation via `fieldSchema` (ajv/TS, jsonschema/Python, jsonschema/Rust)
- Provenance tracking for all resolved config keys
- Configurable `.env` hierarchy (`envFiles` array)
- Full Python + Rust implementations with cross-language parity
- CLI renames: `snapshotExport` → `export`, `snapshotDiff` → `diff`

---

## Future client gate

Each new language client MUST pass all test vectors in `cross-language-test-vectors.json` before being considered complete. The §5 content hash test vector remains the primary gate:

```
Input:  { "b": "2", "a": "1" }
Output: "sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930"
```

Additional gates:
- `generateFieldSchema` produces identical JSON Schema across languages
- `mergeFieldDefinitions` produces identical merged definitions (updated: three inputs)
- `contentHash` + `structureHash` produce identical hashes
- `namespaceEnvPrefix` produces identical output (new gate)
- Validation produces identical pass/fail results

---

## Migration targets (future — separate plans)

- `entrypoint/agent-mcp` — replace `config.ts` + `load-env.ts` with `Environment`
- `packages/agent/agent-engine-compiler` — replace ad-hoc env
- `packages/agent/agent-store-prompts` — replace ad-hoc env
- `packages/agent/agent-store-tools` — replace ad-hoc env
- `packages/agent/agent-core-policy` — replace ad-hoc env
- `packages/agent/agent-core-provider` — replace ad-hoc env

## Related documents

- `docs/plan/adhd-environment/SPEC_0.0.1.md` — superseded spec (global→project cascade, name-first dirs, no namespace)
- `docs/plan/adhd-environment/SPEC_0.0.0.md` — original spec (Zod, no fieldSchema, no provenance)
- `docs/plan/workspace-cleanup/SCOPE.md` — monorepo naming convention
- `BACKLOG.md` §FEAT-ENV-001 — backlog entry
