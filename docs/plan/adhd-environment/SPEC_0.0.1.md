# @adhd/environment — Implementation Spec v0.0.1 (SUPERSEDED)

> **Superseded by SPEC_0.0.2.md** on 2026-07-06. This revision had the scope cascade as global→project (missing system scope), directory types mapped to subdirectories in a confusing way (type as both path controller and metadata), and no namespace/environment support. See SPEC_0.0.2.md for the current design.

> Supersedes [SPEC_0.0.0.md](./SPEC_0.0.0.md). Revisions: Zod removed entirely (validation keywords live directly in `ConfigFieldDefinition`); JSON Schema auto-generated from field definitions into `fieldSchema`; cross-language validation contract via `fieldSchema`; field definition inheritance across scopes (merge global → project); scope-based value resolution; scope-based directory access; configurable `.env` hierarchy; full Python + Rust implementations; provenance tracking; CLI renames (`snapshotExport`→`export`, `snapshotDiff`→`diff`).

---

## Summary

`@adhd/environment` gives every ADHD project deterministic namespacing, typed configuration, directory cataloging, dual content+structure hashing, scope-based field/directory inheritance, provenance tracking, and a language-agnostic JSON snapshot with embedded JSON Schema that any runtime can consume. Five monorepo packages under `packages/environment/` — all FULL implementations:

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

The canonical format for `~/.adhd/<project>/adhd-environment.json`. Every language client reads and writes this exact shape. This is the authority — TypeScript types derive from it.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://adhd.dev/schemas/adhd-environment.json",
  "title": "ADHD Environment Snapshot",
  "type": "object",
  "required": ["project", "version", "directories", "config", "envPrefix", "envVars"],
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
        "type": "object",
        "required": ["path", "type", "description", "scope"],
        "properties": {
          "path":        { "type": "string" },
          "type":        {
            "type": "string",
            "pattern": "^(state|runtime|user)\\.[a-z][a-z0-9-]*$",
            "description": "Hierarchical: state.data | state.config | runtime.log | runtime.cache | runtime.pid | user.bin | user.custom"
          },
          "description": { "type": "string" },
          "scope":       { "type": "string", "enum": ["global", "project"] }
        }
      },
      "description": "Directory entries keyed by name. Scope determines the root path."
    },
    "config": {
      "type": "object",
      "description": "Resolved config values — shape is project-defined. Nested object matching fieldSchema structure."
    },
    "fieldSchema": {
      "type": "object",
      "description": "Auto-generated JSON Schema from merged field definitions. Every language client validates resolved config against this schema at initialize() time. Absent for snapshots produced by older clients."
    },
    "provenance": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": ["source", "scope"],
        "properties": {
          "source": { "type": "string", "enum": ["global.default", "global.env", "project.default", "project.env", "system.default"] },
          "scope":  { "type": "string", "enum": ["global", "project", "system"] },
          "env":    { "type": "string", "description": "Env var name when source includes .env. Omitted for .default sources." }
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
read_snapshot(project_name: string) → EnvironmentSnapshot
```

Reads `~/.adhd/<project_name>/adhd-environment.json`. MUST throw if missing or malformed. Error MUST include the file path.

```
write_snapshot(project_name: string, snapshot: EnvironmentSnapshot) → string
```

Writes `~/.adhd/<project_name>/adhd-environment.json`. **Atomic write:** write to `<path>.tmp`, then `renameSync`. Creates parent directories. Returns the written path. JSON prettified (2-space indent), trailing newline.

#### §2 Directory Registry (constructor-only, scope-aware)

```
DirectoryRegistry(global_root: string, project_root: string, entries: DirectoryEntry[])

get_directory_path(name: string, opts?: { scope?: 'global' | 'project' }) → string
ensure_directories() → void
snapshot() → DirectoryRegistrySnapshot
```

All directories are declared at construction time. No runtime `register()` method. Each entry carries a `scope` — `"global"` or `"project"`. The scope determines which root path the directory is resolved under:

- `scope: "global"` → resolved under `global_root` (e.g., `~/.adhd/<project>/`)
- `scope: "project"` → resolved under `project_root` (e.g., `<cwd>/.adhd/`)

`path("db")` defaults to project scope. `path("db", { scope: "global" })` returns the global-scoped path. `ensure_directories()` creates all registered directories on disk (idempotent, both scopes).

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

The type maps to a subdirectory: `state.data` → `<root>/data/`, `state.config` → `<root>/config/`, `runtime.log` → `<root>/log/`, etc. A directory named `db` of type `state.data` at global scope resolves to `<global_root>/data/db/`.

#### §3 Config Resolution (scope-based, with field inheritance)

```
resolve_config(
  project_name: string,
  fields: ConfigFieldMap,
  scope?: 'global' | 'project' | undefined,
  env_vars?: Map<string,string>,
  env_overrides?: Map<string,string>
) → ConfigSnapshot
```

**Field inheritance merge** (performed before resolution):

1. Collect all fields where `scope === 'global'` → base.
2. Collect all fields where `scope === 'project'` → overrides.
3. For each key in overrides: merge override properties (non-undefined) over base field. If key only exists in overrides, add it.
4. Result is the effective field map used for resolution.

**Value resolution** per field:
1. Check `env_vars?[fieldDef.env]` → `process.env[fieldDef.env]` → field's `default` value.
2. Expand `${VAR}` references in resolved values (§3a).
3. Track provenance: record which source won for each field.

**Scope parameter semantics:**
- `scope: undefined` (default): resolve all fields (full cascade: global → project → system).
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

Example: `ADHD_AGENT_DB_PATH=${HOME}/.adhd/agent-mcp/db` → expands `${HOME}` from `process.env`.

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
Output: "sha256-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
```

#### §5a Structure Hashing (unchanged)

```
compute_structure_hash(directories: DirectoryRegistrySnapshot) → string
```

1. Sort directory names lexicographically.
2. For each directory: append `name:type:scope\n` (path is NOT hashed — only logical structure).
3. SHA-256 hash the buffer.
4. Return `"sha256-"` + lowercase hex digest.

Change from v0.0.0: `scope` is now included in the structure hash line format (`name:type:scope` instead of `name:type`).

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
   * - "global":  base field definition (default rooted at ~/.adhd/<project>/).
   * - "project": can override a global field definition with same key (only changed properties needed).
   * - "system":  default rooted at /etc/adhd/.
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

### Field Inheritance Merge Algorithm

**Input:** two `ConfigFieldMap` objects — one from global-scoped fields, one from project-scoped fields.

**Output:** a single merged `ConfigFieldMap`.

```
merge_field_definitions(global: ConfigFieldMap, project: ConfigFieldMap) → ConfigFieldMap
```

Algorithm:
1. Start with a shallow copy of `global`.
2. For each `[key, projectDef]` in `project`:
   - If `key` exists in `global`:
     - For each property in `projectDef` that is NOT `undefined` (including `default`, `type`, `minimum`, `maximum`, `enum`, `pattern`, `minLength`, `maxLength`): overwrite the corresponding property on the merged definition.
     - The resulting `scope` is `"project"` (project override takes precedence).
   - If `key` does NOT exist in `global`:
     - Add `projectDef` as-is to the result.
3. Return merged map.

**Concrete example:**

Global fields:
```json
{
  "db.path": { "env": "ADHD_AGENT_MCP_DB_PATH", "default": "/default/db", "scope": "global", "type": "path", "pattern": "^/" },
  "db.port": { "env": "ADHD_AGENT_MCP_DB_PORT", "default": "5432", "scope": "global", "type": "integer", "minimum": 1024 }
}
```

Project fields (only overrides):
```json
{
  "db.path": { "env": "ADHD_AGENT_MCP_DB_PATH", "default": "/project/db", "scope": "project" },
  "server.port": { "env": "ADHD_AGENT_MCP_SERVER_PORT", "default": "8080", "scope": "project", "type": "integer", "minimum": 1024 }
}
```

Merged result:
```json
{
  "db.path": { "env": "ADHD_AGENT_MCP_DB_PATH", "default": "/project/db", "scope": "project", "type": "path", "pattern": "^/" },
  "db.port": { "env": "ADHD_AGENT_MCP_DB_PORT", "default": "5432", "scope": "global", "type": "integer", "minimum": 1024 },
  "server.port": { "env": "ADHD_AGENT_MCP_SERVER_PORT", "default": "8080", "scope": "project", "type": "integer", "minimum": 1024 }
}
```

`db.path` validation keywords (`type: "path"`, `pattern: "^/"`) are inherited from the global definition. Only the `default` value changes. `server.port` is a new project-only field.

---

## RUNTIME SNAPSHOT (output)

The complete `EnvironmentSnapshot` as written to `~/.adhd/<project>/adhd-environment.json` after `initialize()`:

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
  "version": {
    "configHash": "sha256-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "structureHash": "sha256-a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a",
    "generatedAt": "2026-07-06T12:00:00.000Z",
    "libraryVersion": "0.0.1"
  },
  "directories": {
    "db": {
      "path": "/home/user/.adhd/agent-mcp/data/db",
      "type": "state.data",
      "description": "SQLite database directory",
      "scope": "global"
    },
    "logs": {
      "path": "/home/user/projects/agent-mcp/.adhd/log/logs",
      "type": "runtime.log",
      "description": "Application logs",
      "scope": "project"
    },
    "cache": {
      "path": "/home/user/.adhd/agent-mcp/cache/cache",
      "type": "runtime.cache",
      "description": "Transient cache",
      "scope": "global"
    }
  },
  "config": {
    "server": {
      "port": 8080,
      "host": "0.0.0.0"
    },
    "db": {
      "path": "/home/user/.adhd/agent-mcp/data/db",
      "port": 5432
    }
  },
  "fieldSchema": {
    "type": "object",
    "properties": {
      "server": {
        "type": "object",
        "properties": {
          "port": { "type": "integer", "minimum": 1024, "maximum": 65535 },
          "host": { "type": "string", "pattern": "^[0-9a-z.]+$" }
        }
      },
      "db": {
        "type": "object",
        "properties": {
          "path": { "type": "string" },
          "port": { "type": "integer", "minimum": 1024 }
        }
      }
    }
  },
  "provenance": {
    "server.port": { "source": "project.default", "scope": "project" },
    "server.host": { "source": "project.env", "scope": "project", "env": "ADHD_AGENT_MCP_HOST" },
    "db.path": { "source": "global.default", "scope": "global" },
    "db.port": { "source": "global.default", "scope": "global" }
  },
  "envPrefix": "ADHD_AGENT_MCP",
  "envVars": {
    "ADHD_AGENT_MCP_HOST": "0.0.0.0",
    "ADHD_AGENT_MCP_PORT": "8080",
    "ADHD_AGENT_MCP_DB_PATH": "/home/user/.adhd/agent-mcp/data/db",
    "ADHD_AGENT_MCP_DB_PORT": "5432"
  }
}
```

Key differences from v0.0.0 snapshot:
- `directories` entries now have `scope` property.
- `fieldSchema` section added (auto-generated JSON Schema from merged field definitions).
- `provenance` section added (maps each config key to its resolution source).
- `structureHash` now includes `scope` in its input lines.

---

## FULL WORKED EXAMPLE: agent-mcp configuration

This example shows every stage: definition → field inheritance merge → runtime snapshot.

### Stage 1 — Definition-time field definitions

The developer authors two field definition maps:

**Global field definitions** (in a shared package, defines the standard interface):
```typescript
const agentMcpGlobalFields: ConfigFieldMap = {
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

**Project field definitions** (in the entrypoint, overrides only what it needs to change):
```typescript
const agentMcpProjectFields: ConfigFieldMap = {
  // Override server.port default — keep all validation from global
  "server.port": {
    env: "ADHD_AGENT_MCP_SERVER_PORT",
    default: "3000",
    scope: "project",
  },
  // Override db.path default — inherit type/pattern from global
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

### Stage 2 — Merged field definitions (after `merge_field_definitions`)

```typescript
const mergedFields = merge_field_definitions(agentMcpGlobalFields, agentMcpProjectFields);
// Result:
// {
//   "server.port": {
//     env: "ADHD_AGENT_MCP_SERVER_PORT", default: "3000", scope: "project",
//     type: "integer", minimum: 1024, maximum: 65535
//   },
//   "server.host": {
//     env: "ADHD_AGENT_MCP_SERVER_HOST", default: "localhost", scope: "global",
//     type: "string", pattern: "^[0-9a-z.]+$"
//   },
//   "db.path": {
//     env: "ADHD_AGENT_MCP_DB_PATH", default: "${HOME}/.adhd/agent-mcp/db", scope: "project",
//     type: "path"
//   },
//   "db.port": {
//     env: "ADHD_AGENT_MCP_DB_PORT", default: "5432", scope: "global",
//     type: "integer", minimum: 1024
//   },
//   "log.level": {
//     env: "ADHD_AGENT_MCP_LOG_LEVEL", default: "info", scope: "global",
//     type: "string", enum: ["debug", "info", "warn", "error"]
//   },
//   "server.workers": {
//     env: "ADHD_AGENT_MCP_WORKERS", default: "4", scope: "project",
//     type: "integer", minimum: 1, maximum: 32
//   },
// }
```

### Stage 3 — JSON Schema generated from merged definitions

`generate_field_schema(mergedFields)` produces:

```json
{
  "type": "object",
  "properties": {
    "server": {
      "type": "object",
      "properties": {
        "port": { "type": "integer", "minimum": 1024, "maximum": 65535 },
        "host": { "type": "string", "pattern": "^[0-9a-z.]+$" },
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
}
```

### Stage 4 — Value resolution (full cascade, env vars set: `ADHD_AGENT_MCP_HOST=0.0.0.0`)

| Field | Env var | Env set? | Default | Resolved | Source | Provenance |
|---|---|---|---|---|---|---|
| `server.port` | `ADHD_AGENT_MCP_SERVER_PORT` | no | `"3000"` | `"3000"` | project default | `project.default` |
| `server.host` | `ADHD_AGENT_MCP_SERVER_HOST` | yes (`0.0.0.0`) | `"localhost"` | `"0.0.0.0"` | env var | `project.env` |
| `db.path` | `ADHD_AGENT_MCP_DB_PATH` | no | `"${HOME}/.adhd/agent-mcp/db"` | `"/home/user/.adhd/agent-mcp/db"` | project default (interpolated) | `project.default` |
| `db.port` | `ADHD_AGENT_MCP_DB_PORT` | no | `"5432"` | `"5432"` | global default | `global.default` |
| `log.level` | `ADHD_AGENT_MCP_LOG_LEVEL` | no | `"info"` | `"info"` | global default | `global.default` |
| `server.workers` | `ADHD_AGENT_MCP_WORKERS` | no | `"4"` | `"4"` | project default | `project.default` |

### Stage 5 — Runtime snapshot (see RUNTIME SNAPSHOT section above for full output)

After `unflatten(raw)` and validation against `fieldSchema`, the config section is:

```json
{
  "server": { "port": 3000, "host": "0.0.0.0", "workers": 4 },
  "db": { "path": "/home/user/.adhd/agent-mcp/data/db", "port": 5432 },
  "log": { "level": "info" }
}
```

Note: values are coerced to their declared types (`"3000"` → `3000`, `"4"` → `4`) during unflatten+validation. The raw (pre-unflatten) values remain strings.

---

## TypeScript interfaces

### `Environment` — composition root

```typescript
export interface EnvironmentOptions {
  /** Project identity. */
  project: ProjectIdentity;

  /** Directory entries (constructor-only — no runtime registration). */
  dirs?: DirectoryEntry[];

  /** Config resolver options. Fields go here. */
  config?: Omit<ConfigResolverOptions, 'prefix'>;

  /** Custom root for ~/.adhd/ (default: os.homedir()/.adhd). */
  adhdRoot?: string;

  /** Custom CWD for project-scoped resolution. */
  cwd?: string;
}

export class Environment {
  readonly project: Readonly<ProjectIdentity>;
  readonly dirs: DirectoryRegistry;
  readonly config: ConfigResolver;
  readonly envPrefix: string;

  constructor(options: EnvironmentOptions);

  /**
   * Full pipeline: load .env, merge field definitions, resolve config,
   * generate fieldSchema, ensure dirs, detect changes, validate config
   * against fieldSchema, track provenance, write snapshot.
   *
   * Warns if structure changed from on-disk snapshot.
   * Throws if a competing structure is detected (directory type changed or
   * another project claims the same namespace).
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

### `DirectoryRegistry` — scope-aware directory management

```typescript
export interface DirectoryRegistrySnapshot {
  paths: Record<string, string>;
  entries: Record<string, DirectoryEntry & { path: string }>;
}

export class DirectoryRegistry {
  /**
   * @param globalRoot   Root for global-scoped dirs (e.g., ~/.adhd/<project>/).
   * @param projectRoot  Root for project-scoped dirs (e.g., <cwd>/.adhd/).
   * @param entries      All directory entries declared at construction time.
   */
  constructor(globalRoot: string, projectRoot: string, entries: DirectoryEntry[]);

  /**
   * Get resolved absolute path.
   * @param name   Directory name.
   * @param opts.scope  Defaults to "project". Use "global" for global-scoped path.
   * @throws If directory not declared at the requested scope.
   */
  path(name: string, opts?: { scope?: 'global' | 'project' }): string;

  /** All registered directory names. */
  get names(): string[];

  /** Create all directories on disk (both scopes). Idempotent. */
  ensure(): void;

  /** Serializable snapshot for hashing and JSON output. */
  snapshot(): DirectoryRegistrySnapshot;
}
```

### `ConfigResolver` — scope-aware with field inheritance

```typescript
export interface ConfigResolverOptions {
  /** Env-var prefix for this project. */
  prefix: string;

  /** Organization name for global/system path roots (default: "adhd"). */
  org?: string;

  /**
   * Field definitions. Supports both global-scoped and project-scoped fields.
   * At resolve time, project fields override global fields with same key.
   */
  fields?: ConfigFieldMap;

  /**
   * Custom .env file load order. Each entry is an absolute path.
   * Omit for default 3-tier hierarchy:
   *   1. <adhdRoot>/.env  (no override)
   *   2. <cwd>/.adhd/.env  (override)
   *   3. <cwd>/.env        (override)
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
   * @param scope          Filter to a specific scope. Omit for full cascade.
   * @param envSnapshot    Test injection — overrides process.env for specific vars.
   * @param envOverrides   Aliasing map: {"ORIGINAL_VAR": "ALIASED_VAR"}.
   */
  resolve(
    scope?: ConfigScope,
    envSnapshot?: Record<string, string | undefined>,
    envOverrides?: Record<string, string>
  ): ConfigSnapshot;

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
export function generateFieldSchema(fields: ConfigFieldMap): Record<string, unknown>;
export function mergeFieldDefinitions(global: ConfigFieldMap, project: ConfigFieldMap): ConfigFieldMap;
export function readSnapshot(projectName: string, adhdRoot?: string): EnvironmentSnapshot;
export function writeSnapshot(projectName: string, snapshot: EnvironmentSnapshot, adhdRoot?: string): string;
```

### Types

```typescript
export type DirectoryType =
  | 'state.data' | 'state.config'
  | 'runtime.log' | 'runtime.cache' | 'runtime.pid'
  | 'user.bin' | 'user.custom';

export type ConfigScope = 'global' | 'project' | 'system';

export type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'path';

export type ProvenanceSource =
  | 'global.default' | 'global.env'
  | 'project.default' | 'project.env'
  | 'system.default';

export interface ProjectIdentity {
  name: string;
  description?: string;
  repo?: string;
  homepage?: string;
  license?: string;
  meta?: Record<string, string>;
}

export interface DirectoryEntry {
  name: string;
  type: DirectoryType;
  description: string;
  scope: 'global' | 'project';
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
  version: {
    configHash: string;
    structureHash: string;
    generatedAt: string;
    libraryVersion: string;
  };
  directories: Record<string, {
    path: string;
    type: DirectoryType;
    description: string;
    scope: 'global' | 'project';
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

### `mergeFieldDefinitions` — field definition inheritance

```typescript
function mergeFieldDefinitions(global: ConfigFieldMap, project: ConfigFieldMap): ConfigFieldMap
```

Algorithm per the FIELD DEFINITION DESIGN section above. Key behaviors:
- Project fields with same key override global field properties (shallow merge — only non-undefined props overwrite).
- Validation keywords from global are retained when project only changes `default`.
- The resulting field's `scope` is `"project"` if project overrides, `"global"` if only in global.
- Fields only in project are added as-is.

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
3. **Merge field definitions:** `mergeFieldDefinitions(globalFields, projectFields)` → `effectiveFields`.
4. For each field in `effectiveFields`, resolve value:
   - Check `envSnapshot?.[fieldDef.env]` → `process.env[fieldDef.env]` → field's `default`.
   - Record provenance: which source won, scope, and env var name if applicable.
5. Run `interpolate(value, process.env)` on each resolved value.
6. **Generate `fieldSchema`** from `effectiveFields`.
7. `unflatten(raw)` → nested config object, coerce types per field definitions.
8. Compute `contentHash(raw)`.
9. Return `ConfigSnapshot` with all sections populated.

**Scope filtering:** When `scope` parameter is provided, filter `fields` to only those whose effective `scope` matches before step 4.

### `parseEnvFile` — internal `.env` parser (unchanged from v0.0.0)

Replaces `dotenv`. Pure function — reads a file, returns a `Record<string, string>`. Never mutates `process.env`.
- Skips blank lines and `#`-prefixed lines.
- Splits on first `=` only.
- Strips `export ` prefix from keys.
- Strips matching single or double quotes from values.
- `${VAR}` references preserved as literal strings.
- Returns empty object for missing files (ENOENT). Throws on other read errors.

### `interpolate` — variable expansion (unchanged from v0.0.0)

Finds all `${VAR}` patterns. For each: look up in context → replace with resolved value. Not found → leave `${VAR}` as literal. Single-level only — no recursive expansion.

### `contentHash` + `structureHash` (updated)

`contentHash` unchanged. `structureHash` now uses `name:type:scope\n` format (scope added).

### `Environment.initialize()` — full pipeline with validation and provenance

1. Load `.env` files (delegates to ConfigResolver).
2. **Merge field definitions** and resolve config (delegates to ConfigResolver).
3. **Generate `fieldSchema`** from merged definitions.
4. **Validate** resolved config against `fieldSchema` using `ajv`. If validation fails, throw with detailed field-level errors.
5. Compute `structureHash(dirs.snapshot())`.
6. **Track provenance** for every resolved config key.
7. **Read on-disk snapshot** (if exists). Compare `structureHash`:
   - Hash matches: no structural change. Proceed.
   - Hash differs: compare directory entries:
     - New directories → **warn**.
     - Directories removed → **warn**.
     - Directory types changed → **throw** `Error("Competing structure: <dir> changed from <old> to <new>")`.
     - Directory scope changed → **throw** `Error("Competing structure: <dir> scope changed from <old> to <new>")`.
     - Project name mismatch → **throw** `Error("Namespace conflict: <path> already claimed by <other-project>")`.
8. `dirs.ensure()` — create all directories on disk.
9. Build `EnvironmentSnapshot` with all sections (config, fieldSchema, provenance, etc.).
10. **Atomic write** to `<path>.tmp` then `renameSync`.
11. Cache and return snapshot.

### `Environment.refresh()` — re-resolution

Invalidates config cache, re-runs full `initialize()` pipeline.

---

## File manifests

### `packages/environment/environment-base-spec/` — Contract package

| Path | Change | Description |
|------|--------|-------------|
| `package.json` | create | `@adhd/environment-base-spec`, `type: "module"`, `private: false` |
| `project.json` | create | Nx project, tags `["pkg-class:types", "layer:shared", "platform:shared"]` |
| `tsconfig.json` | create | Extends `tsconfig.base.json` |
| `spec/SPEC.md` | create | Behavioral contract §1–§6 with all updates (fieldSchema, scope-based dirs, field inheritance, provenance, configurable .env, cross-language validation) |
| `spec/adhd-environment.schema.json` | create | JSON Schema for the snapshot file (updated with `fieldSchema`, `provenance`, directory `scope`) |
| `spec/cross-language-test-vectors.json` | create | Standard test vectors: content hash, structure hash, field merge cases, JSON Schema generation cases |
| `src/index.ts` | create | TypeScript type re-exports from schema |
| `README.md` | create | Package overview + link to SPEC.md |

### `packages/environment/environment-core-node/` — TypeScript reference implementation

| Path | Change | Description |
|------|--------|-------------|
| `package.json` | create | `@adhd/environment`, dep on `environment-base-spec: "workspace:*"`, runtime dep: `ajv` |
| `project.json` | create | Nx project, tags `["platform:node", "layer:shared"]` |
| `tsconfig.json` | create | Extends `tsconfig.base.json` |
| `tsconfig.lib.json` | create | outDir `dist/out-tsc`, include `src/**/*.ts` |
| `vite.config.ts` | create | Externalize `ajv`, `node:*` builtins |
| `src/index.ts` | create | Public API re-exports |
| `src/lib/types.ts` | create | All shared types (updated: ConfigFieldDefinition with validation keywords, DirectoryEntry with scope, EnvironmentSnapshot with fieldSchema + provenance) |
| `src/lib/project-identity.ts` | create | `ProjectIdentity` + `projectEnvPrefix()` |
| `src/lib/parse-env-file.ts` | create | Internal `.env` parser — zero deps |
| `src/lib/env-loader.ts` | create | `loadEnvHierarchy()`, `loadEnvFiles()` |
| `src/lib/directory-registry.ts` | create | `DirectoryRegistry` — constructor takes `globalRoot` + `projectRoot`, scope-aware `path()`, `ensure()` creates both scopes |
| `src/lib/field-merge.ts` | create | `mergeFieldDefinitions()` — field inheritance merge algorithm |
| `src/lib/json-schema-gen.ts` | create | `generateFieldSchema()` — JSON Schema generation from merged field definitions |
| `src/lib/config-resolver.ts` | create | `ConfigResolver` with field merging, scope filtering, aliasing, `${VAR}` expansion, provenance tracking, `fieldSchema` generation |
| `src/lib/interpolate.ts` | create | `${VAR}` expansion per §3a (unchanged) |
| `src/lib/unflatten.ts` | create | Dot-path → nested object with type coercion |
| `src/lib/content-hash.ts` | create | `contentHash()` + `structureHash()` (structureHash updated: `name:type:scope`) |
| `src/lib/snapshot.ts` | create | `readSnapshot()`, `writeSnapshot()` (atomic) |
| `src/lib/provenance.ts` | create | Provenance tracking utilities |
| `src/lib/validation.ts` | create | JSON Schema validation via `ajv` — `validateConfig(nested, fieldSchema)` |
| `src/lib/environment.ts` | create | `Environment` — composition root, updated pipeline with field merge, fieldSchema generation, provenance, validation |
| `src/__tests__/contract-compliance.test.ts` | create | Validates against cross-language test vectors |
| `src/__tests__/parse-env-file.test.ts` | create | `.env` parser unit tests |
| `src/__tests__/field-merge.test.ts` | create | Field inheritance merge tests |
| `src/__tests__/json-schema-gen.test.ts` | create | JSON Schema generation tests |
| `src/__tests__/directory-registry.test.ts` | create | Directory registry unit tests (scope-aware) |
| `src/__tests__/config-resolver.test.ts` | create | Config resolver unit tests (scope filtering, provenance, field merge) |
| `src/__tests__/interpolate.test.ts` | create | `${VAR}` expansion tests |
| `src/__tests__/snapshot.test.ts` | create | Snapshot I/O unit tests |
| `src/__tests__/validation.test.ts` | create | Validation against fieldSchema tests |
| `src/__tests__/provenance.test.ts` | create | Provenance tracking tests |
| `src/__tests__/environment.test.ts` | create | Integration tests |
| `README.md` | create | API reference + usage examples |

### `packages/environment/environment-core-py/` — Python full implementation

| Path | Change | Description |
|------|--------|-------------|
| `pyproject.toml` | create | `adhd-environment`, Python ≥3.10, dep: `jsonschema>=4.0` |
| `project.json` | create | Nx project with shell-command targets for `lint` (ruff), `test` (pytest), `build` (setuptools) |
| `src/adhd_environment/__init__.py` | create | Public API exports |
| `src/adhd_environment/types.py` | create | Type definitions (dataclasses — ConfigFieldDefinition, DirectoryEntry, EnvironmentSnapshot, ProvenanceEntry, etc.) |
| `src/adhd_environment/project_identity.py` | create | `project_env_prefix()` |
| `src/adhd_environment/env_parser.py` | create | Internal `.env` parser (zero deps) |
| `src/adhd_environment/env_loader.py` | create | `load_env_hierarchy()`, `load_env_files()` |
| `src/adhd_environment/directory_registry.py` | create | `DirectoryRegistry` — scope-aware, `path()` with scope option, `ensure()`, `snapshot()` |
| `src/adhd_environment/field_merge.py` | create | `merge_field_definitions()` |
| `src/adhd_environment/json_schema_gen.py` | create | `generate_field_schema()` |
| `src/adhd_environment/content_hash.py` | create | `content_hash()` + `structure_hash()` (structureHash: `name:type:scope\n`) |
| `src/adhd_environment/interpolate.py` | create | `${VAR}` expansion |
| `src/adhd_environment/unflatten.py` | create | Dot-path → nested dict with type coercion |
| `src/adhd_environment/provenance.py` | create | Provenance tracking |
| `src/adhd_environment/validation.py` | create | JSON Schema validation via `jsonschema` — `validate_config(nested, field_schema)` |
| `src/adhd_environment/config_resolver.py` | create | `ConfigResolver` — field merging, scope filtering, aliasing, `${VAR}` expansion, provenance, `fieldSchema` generation |
| `src/adhd_environment/snapshot.py` | create | `read_snapshot()`, `write_snapshot()` (atomic via `tempfile` + `os.rename`) |
| `src/adhd_environment/environment.py` | create | `Environment` — full pipeline with field merge, fieldSchema, provenance, validation |
| `tests/test_contract.py` | create | Contract compliance: content hash test vector, prefix derivation, cross-language test vectors |
| `tests/test_content_hash.py` | create | Content + structure hash tests |
| `tests/test_field_merge.py` | create | Field inheritance merge tests |
| `tests/test_field_schema.py` | create | JSON Schema generation tests |
| `tests/test_config_resolver.py` | create | Config resolver tests |
| `tests/test_directory_registry.py` | create | Scope-aware directory registry tests |
| `tests/test_interpolate.py` | create | `${VAR}` expansion tests |
| `tests/test_provenance.py` | create | Provenance tracking tests |
| `tests/test_validation.py` | create | Validation against fieldSchema tests |
| `tests/test_snapshot.py` | create | Snapshot I/O + atomic write tests |
| `tests/test_environment.py` | create | Full pipeline integration tests |
| `README.md` | create | Package overview |

### `packages/environment/environment-core-rs/` — Rust full implementation

| Path | Change | Description |
|------|--------|-------------|
| `Cargo.toml` | create | `adhd-environment`, edition 2021, deps: `serde`, `serde_json`, `sha2`, `jsonschema`, `tempfile`, `chrono`, `regex` |
| `project.json` | create | Nx project with cargo targets for `build`, `test`, `lint` (clippy) |
| `src/lib.rs` | create | Public API exports |
| `src/types.rs` | create | Type definitions (structs — ConfigFieldDefinition, DirectoryEntry, EnvironmentSnapshot, ProvenanceEntry, etc.) |
| `src/project_identity.rs` | create | `project_env_prefix()` |
| `src/env_parser.rs` | create | Internal `.env` parser (zero external deps) |
| `src/env_loader.rs` | create | `load_env_hierarchy()`, `load_env_files()` |
| `src/directory_registry.rs` | create | `DirectoryRegistry` — scope-aware, `path()` with scope option, `ensure()`, `snapshot()` |
| `src/field_merge.rs` | create | `merge_field_definitions()` |
| `src/json_schema_gen.rs` | create | `generate_field_schema()` |
| `src/content_hash.rs` | create | `content_hash()` + `structure_hash()` (structureHash: `name:type:scope\n`) |
| `src/interpolate.rs` | create | `${VAR}` expansion |
| `src/unflatten.rs` | create | Dot-path → nested `serde_json::Value` with type coercion |
| `src/provenance.rs` | create | Provenance tracking |
| `src/validation.rs` | create | JSON Schema validation via `jsonschema` crate — `validate_config(nested, field_schema)` |
| `src/config_resolver.rs` | create | `ConfigResolver` — field merging, scope filtering, aliasing, `${VAR}` expansion, provenance, `fieldSchema` generation |
| `src/snapshot.rs` | create | `read_snapshot()`, `write_snapshot()` (atomic via tempfile + rename) |
| `src/environment.rs` | create | `Environment` — full pipeline with field merge, fieldSchema, provenance, validation |
| `tests/contract.rs` | create | Contract compliance: content hash test vector, prefix derivation, cross-language test vectors |
| `tests/content_hash.rs` | create | Content + structure hash tests |
| `tests/field_merge.rs` | create | Field inheritance merge tests |
| `tests/field_schema.rs` | create | JSON Schema generation tests |
| `tests/config_resolver.rs` | create | Config resolver tests |
| `tests/directory_registry.rs` | create | Scope-aware directory registry tests |
| `tests/provenance.rs` | create | Provenance tracking tests |
| `tests/validation.rs` | create | Validation against fieldSchema tests |
| `tests/snapshot.rs` | create | Snapshot I/O + atomic write tests |
| `tests/environment.rs` | create | Full pipeline integration tests |
| `README.md` | create | Package overview |

### `packages/environment/environment-cli/` — CLI (apigen-generated)

The CLI is generated by `@adhd/apigen-generator-nx` from `src/api.ts`. Key changes from v0.0.0: `snapshotExport` renamed to `export`, `snapshotDiff` renamed to `diff`.

| Path | Change | Description |
|------|--------|-------------|
| `package.json` | create | `@adhd/environment-cli`, dep on `@adhd/environment`, `commander` (runtime), `@adhd/apigen-engine-runtime` |
| `project.json` | create | Nx project with `generate-cli` target using `@adhd/apigen-generator-nx:generate` |
| `tsconfig.json` | create | Extends `tsconfig.base.json` |
| `tsconfig.lib.json` | create | outDir `dist/out-tsc` |
| `vite.config.ts` | create | Externalize `commander` |
| `src/api.ts` | create | Apigen extraction surface — updated: `export` and `diff` function names |
| `src/lib/core.ts` | create | Real implementation wiring to `Environment`, `readSnapshot`, `writeSnapshot` — updated for new function names |
| `src/__tests__/cli.test.ts` | create | Smoke test: spawns generated CLI |

#### `src/api.ts` — updated exports

```typescript
// Renamed from snapshotExport → export
export async function export_(
  projectName: string,
  outFile?: string,
): Promise<EnvironmentSnapshot>;

// Renamed from snapshotDiff → diff
export async function diff(
  projectName: string,
  againstFile: string,
): Promise<VerifyFinding[]>;
```

#### Generated CLI commands (updated names)

| `api.ts` export | Generated command |
|---|---|
| `init` | `adhd-env init` |
| `status` | `adhd-env status` |
| `verify` | `adhd-env verify` |
| `doctor` | `adhd-env doctor` |
| `configGet` | `adhd-env config-get` |
| `configSet` | `adhd-env config-set` |
| `configRemap` | `adhd-env config-remap` |
| `configHash` | `adhd-env config-hash` |
| `export_` | `adhd-env export` |
| `diff` | `adhd-env diff` |

---

## Independent segments (implementation order)

### Segment 1 — Contract package (`environment-base-spec`)

- **Files:** All files in `packages/environment/environment-base-spec/`
- **Dependencies:** none
- **Read tokens:** 0 — net-new package
- **Output tokens:** ~3,000
- **Strategy:** Scaffold package. Write updated `adhd-environment.schema.json` with `fieldSchema`, `provenance`, directory `scope`. Write `SPEC.md` §1–§6 with all updates. Write `cross-language-test-vectors.json` with standard test vectors. Write `src/index.ts` with TypeScript type re-exports. Validate schema against JSON Schema meta-schema.

### Segment 2 — TypeScript types + field merge + JSON Schema generation

- **Files:** `environment-core-node/src/lib/types.ts`, `src/lib/field-merge.ts`, `src/lib/json-schema-gen.ts`
- **Dependencies:** Segment 1
- **Read tokens:** ~50 (reference types from schema)
- **Output tokens:** ~1,500
- **Strategy:** Implement `ConfigFieldDefinition` with validation keywords (no Zod). Implement `mergeFieldDefinitions()` with the shallow-merge algorithm from the spec. Implement `generateFieldSchema()` — the dot-path to nested JSON Schema algorithm with exact test vectors.

### Segment 3 — Core utilities (`environment-core-node`)

- **Files:** `package.json`, `project.json`, `tsconfig.json`, `tsconfig.lib.json`, `vite.config.ts`, `src/lib/parse-env-file.ts`, `src/lib/interpolate.ts`, `src/lib/unflatten.ts`, `src/lib/content-hash.ts`, `src/lib/project-identity.ts`, `src/lib/provenance.ts`, `src/lib/validation.ts`
- **Dependencies:** Segment 2 (types must exist)
- **Output tokens:** ~2,500
- **Strategy:** Implement all zero-dependency utilities. `structureHash` uses updated `name:type:scope\n` format. `validation.ts` wraps `ajv.compile()`. No Zod anywhere.

### Segment 4 — Env loader + DirectoryRegistry + ConfigResolver

- **Files:** `src/lib/env-loader.ts`, `src/lib/directory-registry.ts`, `src/lib/config-resolver.ts`
- **Dependencies:** Segment 3
- **Output tokens:** ~2,000
- **Strategy:** `DirectoryRegistry` takes `globalRoot` + `projectRoot`. `path()` defaults to project scope. `ConfigResolver` integrates field merge, scope filtering, provenance tracking, `fieldSchema` generation, and `ajv` validation. `envFiles` is configurable via options.

### Segment 5 — Snapshot + Environment + index

- **Files:** `src/lib/snapshot.ts`, `src/lib/environment.ts`, `src/index.ts`
- **Dependencies:** Segments 2–4
- **Output tokens:** ~1,500
- **Strategy:** `Environment.initialize()` pipeline updated: merge fields → resolve → generate fieldSchema → validate → compute hashes → provenance → detect drift → atomic write. `refresh()` re-runs full pipeline. Public API exports through `index.ts`.

### Segment 6 — Node tests

- **Files:** All `src/__tests__/*.test.ts` (13 test files)
- **Dependencies:** Segments 1–5
- **Output tokens:** ~5,000
- **Strategy:** Comprehensive test coverage. Contract compliance against `cross-language-test-vectors.json`. Unit tests for every module. Integration tests for full pipeline. Provenance tracking tests. Field merge tests. JSON Schema generation tests. Cross-language validation parity tests.

### Segment 7 — Python full implementation

- **Files:** All files in `packages/environment/environment-core-py/` (pyproject.toml, project.json, 16 source files in `src/adhd_environment/`, 11 test files in `tests/`)
- **Dependencies:** Segment 1 (spec + test vectors are the contract)
- **Output tokens:** ~8,000
- **Strategy:** FULL implementation — not stubs. Every module mirrors the TypeScript behavior. `jsonschema` library for validation. `tempfile` + `os.rename` for atomic writes. Contract compliance tests against shared test vectors. All utility tests. Full pipeline integration tests.

### Segment 8 — Rust full implementation

- **Files:** All files in `packages/environment/environment-core-rs/` (Cargo.toml, project.json, 16 source files in `src/`, 10 test files in `tests/`)
- **Dependencies:** Segment 1 (spec + test vectors are the contract)
- **Output tokens:** ~9,000
- **Strategy:** FULL implementation — not stubs. Every module mirrors the TypeScript behavior. `jsonschema` crate for validation. `sha2` for hashing. `serde` + `serde_json` for snapshot I/O. `tempfile` for atomic writes. Contract compliance tests against shared test vectors. Full integration tests.

### Segment 9 — CLI package (`environment-cli`)

- **Files:** All files in `packages/environment/environment-cli/` (package.json, project.json, tsconfig, vite.config, `src/api.ts`, `src/lib/core.ts`, `src/__tests__/cli.test.ts`)
- **Dependencies:** Segments 1–5 (library must build before CLI can extract)
- **Read tokens:** ~100 (reference `entrypoint/dispatch-cli/` for template)
- **Output tokens:** ~3,000
- **Strategy:**
  1. Scaffold package with deps on `@adhd/environment`, `commander`, `@adhd/apigen-engine-runtime`.
  2. Write `src/api.ts` — renamed exports: `export_` (was `snapshotExport`) and `diff` (was `snapshotDiff`).
  3. Write `src/lib/core.ts` — real implementation with new function names.
  4. Write `project.json` with `generate-cli` target.
  5. Write smoke test: spawn generated CLI, assert commands.

---

## Test cases

### Contract compliance tests (cross-language)

Shared test vectors in `environment-base-spec/spec/cross-language-test-vectors.json`:

- **`contentHash`** — `{ b: "2", a: "1" }` → `sha256-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08`
- **`structureHash`** — standard directory set with scope → deterministic output
- **`projectEnvPrefix`** — `"agent-mcp"` → `"ADHD_AGENT_MCP"`, `"my app"` → `"ADHD_MY_APP"`
- **`mergeFieldDefinitions`** — standard global + project maps → expected merged map
- **`generateFieldSchema`** — standard field definitions → expected JSON Schema object
- **Validate** — standard config against generated schema → passes
- **Validate fail** — invalid config against generated schema → throws with field-level errors
- Write snapshot → read back → deep-equal round-trip
- Atomic write: if write fails mid-way, no partial file exists (only `.tmp`)

### Unit tests (TypeScript)

- `parseEnvFile`: blank lines, comments, quotes, export prefix, missing file, `${VAR}` preserved
- `interpolate`: `${HOME}` expands, `${UNSET}` stays literal, multiple refs, no recursive
- `mergeFieldDefinitions`: global-only, project-override-default, project-override-validation, project-only-new, nested-merge-properties
- `generateFieldSchema`: flat fields, nested dot-paths, type mapping (`path`→`string`), keyword passthrough, undefined keywords omitted
- `DirectoryRegistry`: global + project scope paths, `path()` scope default + explicit, `ensure()` idempotent, snapshot shape, duplicate name at same scope throws, same name at different scopes allowed
- `ConfigResolver`: env var wins, default fallback, scope filtering, field merge integration, `${VAR}` expansion, provenance tracking per field, `fieldSchema` in snapshot, `invalidate()`
- `validation`: valid config passes, invalid type throws, out-of-range throws, missing required throws, no fields → skip validation
- `Environment`: full pipeline, field merge in initialize, validation gate, provenance population, structure change detection (scope change now throws), idempotent initialize, refresh after env change

### Integration tests

- Full pipeline: construct → initialize → verify snapshot on disk → verify directories exist → verify hashes → verify `fieldSchema` → verify provenance
- Two `Environment` instances → different project names → no collision
- Structure change: initialize with dirs A → modify to dirs B → re-initialize → warns on removed/new
- Field definition override: global defines `db.path` with `pattern: "^/"` → project overrides only `default` → resolved field has both

### Cross-language parity tests

Each language client (TS, Python, Rust) runs against the SAME `cross-language-test-vectors.json`:

- `contentHash` produces identical output (test vector gate)
- `structureHash` produces identical output for identical directory snapshots
- `generateFieldSchema` produces identical JSON Schema for identical field definitions
- `mergeFieldDefinitions` produces identical merged definitions
- Validate identical config against identical fieldSchema → same pass/fail result

### Python/Rust test files

Every Python test file mirrors its TypeScript counterpart. Every Rust test file mirrors its TypeScript counterpart. The contract tests are the gate — must pass in every language.

---

## Edge cases

| Case | Behavior |
|---|---|
| Empty project name | `projectEnvPrefix("")` → `"ADHD_"` |
| Special chars in name | Non-`[A-Za-z0-9_-]` → mapped to `_` |
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
| Field merge: project overrides type but not min/max | min/max from global inherited |
| Field merge: project overrides only `default` | All validation keywords inherited from global |
| Field merge: project defines new field with same key as global | Project properties win, scope becomes `"project"` |
| Directory scope: same name at both scopes | Allowed — `path("name")` returns project, `path("name", { scope: "global" })` returns global |
| Directory scope: duplicate name at same scope | Throws at construction |
| Snapshot file write fails mid-way | `.tmp` file may exist but `.json` is untouched |
| Concurrent access | Not guarded — last write wins |
| Custom `adhdRoot` | Testing override — points to temp dir |
| Custom `cwd` | Testing override — project root resolution uses this |
| No field definitions provided | `fieldSchema` is absent from snapshot, no validation performed |
| `fieldSchema` in old snapshot (v0.0.0) | Missing `fieldSchema` — skip validation, warn |
| Structure hash: dir scope changed | Throws (competing structure) |
| Provenance: same key resolved from different env on refresh | Provenance updated to new source |
| Cross-language hash parity | Test vector is the gate — all languages MUST match |
| `type: "path"` in field definition | Generates `{"type":"string"}` in JSON Schema |
| `enum` with mixed types | Passed through as-is to JSON Schema |
| JSON Schema generation: deeply nested keys | `a.b.c.d.e` → 5-level nested object |

---

## Retained from v0.0.0 (unchanged)

- Five-package layout under `packages/environment/`
- npm names: `@adhd/environment`, `@adhd/environment-base-spec`, `@adhd/environment-cli`, `adhd-environment` (Py), `adhd-environment` (Rs)
- Zero external runtime deps for core logic (ajv is the only new dep for validation)
- Directory types: `state.data`, `state.config`, `runtime.log`, `runtime.cache`, `runtime.pid`, `user.bin`, `user.custom`
- `contentHash` test vector: `{b:"2",a:"1"}` → `sha256-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08`
- Atomic writes (`.tmp` + `renameSync`)
- Drift detection on `initialize()`: warn on new/removed, throw on type change and namespace conflict (+ scope change now)
- `${VAR}` interpolation (single-level, leave unresolved as literal)
- `projectEnvPrefix` derivation
- `unflatten` utility
- apigen-generated CLI (but with renamed exports: `export`, `diff`)
- `Environment` class name (not `AdhdEnvironment`)
- Constructor-only directory registration
- `adhdRoot` constructor option + `ADHD_HOME` env var override

---

## Future client gate

Each new language client MUST pass all test vectors in `cross-language-test-vectors.json` before being considered complete. The §5 content hash test vector remains the primary gate:

```
Input:  { "b": "2", "a": "1" }
Output: "sha256-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
```

Additional gates:
- `generateFieldSchema` produces identical JSON Schema across languages
- `mergeFieldDefinitions` produces identical merged definitions
- `contentHash` + `structureHash` produce identical hashes
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

- `docs/plan/adhd-environment/SPEC_0.0.0.md` — superseded spec
- `docs/plan/workspace-cleanup/SCOPE.md` — monorepo naming convention
- `BACKLOG.md` §FEAT-ENV-001 — backlog entry (needs update per this spec)
