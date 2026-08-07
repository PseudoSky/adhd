# @adhd/environment — Implementation Spec v0.0.3 (SUPERSEDED)

> **Superseded by SPEC_0.0.4.md** on 2026-07-06. This revision still had a static spec file in TypeScript/JSON format and `EnvironmentBuilder` classes in every language client. SPEC_0.0.4 moves the static spec to YAML, eliminates `EnvironmentBuilder` from all language clients (CLI is the builder), and defines four user flows.

> Supersedes [SPEC_0.0.2.md](./SPEC_0.0.2.md).

## Revision History

| Revision | Date | Key Changes |
|---|---|---|
| 0.0.0 | (earlier) | Initial design: `Environment`, `DirectoryRegistry`, `ConfigResolver`, snapshot I/O, content/structure hashing, `.env` hierarchy, apigen CLI |
| 0.0.1 | 2026-07-06 | Zod removed (validation keywords in `ConfigFieldDefinition`), `fieldSchema` auto-generated JSON Schema, cross-language validation contract, field inheritance merge (global→project), provenance tracking, scope-based value resolution, scope-based directory access, configurable `.env` hierarchy, full Python + Rust implementations, CLI renames |
| 0.0.2 | 2026-07-06 | Three-tier scope cascade (system→global→project), type-first directory identification with optional name disambiguator, namespaced environments, system-scope directory roots |
| **0.0.3** | **2026-07-06** | **Env vars inferred by convention (not required on every field), realistic scope assignments in worked example, builder/runtime client split (`EnvironmentBuilder` + `Environment`), minimal runtime API with `get()` + bracket access, static spec file format** |

---

## Summary

`@adhd/environment` gives every ADHD project deterministic namespacing, typed configuration, directory cataloging, dual content+structure hashing, three-tier scope-based field/directory inheritance (system → global → project), provenance tracking, namespaced environments for multi-instance projects, and a language-agnostic JSON snapshot with embedded JSON Schema that any runtime can consume.

Two classes, not one:

- **`EnvironmentBuilder`** — runs once (or on config change). Does all the heavy work: loads `.env`, merges field definitions, resolves config, generates `fieldSchema`, validates, computes hashes, tracks provenance, ensures directories exist, writes snapshot atomically.
- **`Environment`** — runs every startup. Reads the snapshot and provides access. Parses JSON. That's it. No `ajv`, no `.env` loading, no field merge, no directory creation.

Five monorepo packages under `packages/environment/` — all FULL implementations:

| Package | npm/Py/Cargo | Language | Status |
|---|---|---|---|
| `environment-base-spec` | `@adhd/environment-base-spec` | JSON Schema + SPEC.md | **implement now** |
| `environment-core-node` | `@adhd/environment` | TypeScript (Node) | **implement now** |
| `environment-cli` | `@adhd/environment-cli` | TypeScript (Node, apigen-generated CLI) | **implement now** |
| `environment-core-py` | `adhd-environment` | Python (≥3.10) | **implement now** (full) |
| `environment-core-rs` | `adhd-environment` | Rust (edition 2021) | **implement now** (full) |

The TypeScript implementation has one external runtime dependency: `ajv` for JSON Schema validation of resolved config against `fieldSchema` — and that dependency is ONLY in the builder. The runtime `Environment` class depends on nothing but `node:fs`.

---

## Fix 1: Env vars are inferred by convention — `env` is an optional override

### The problem

v0.0.2 required every `ConfigFieldDefinition` to explicitly declare its env var name:

```ts
// v0.0.2: required on every field
"db.path": {
  env: "ADHD_AGENT_MCP_DB_PATH",
  default: "~/.adhd/agent-mcp/agents.db",
  scope: "project",
  type: "path",
}
```

This is boilerplate. The env var name is deterministically derivable from the field path + project prefix.

### The fix

The `env` property is now **optional**. When omitted, the env var name is **inferred** from:

1. The project's env prefix (from the static spec file, e.g. `ADHD_AGENT_MCP`)
2. The field's dot-path, uppercased with dots replaced by underscores

```
prefix:    "ADHD_AGENT_MCP"
field:     "db.path"
inferred:  "ADHD_AGENT_MCP_DB_PATH"

field:     "server.port"
inferred:  "ADHD_AGENT_MCP_SERVER_PORT"

field:     "providers.openai.secret"
inferred:  "ADHD_AGENT_MCP_PROVIDERS_OPENAI_SECRET"

field:     "log.level"
inferred:  "ADHD_AGENT_MCP_LOG_LEVEL"
```

### Inference algorithm

```
inferEnvVar(envPrefix: string, fieldPath: string) → string

1. Split fieldPath on '.' to get segments.
2. For each segment: uppercase, replace [^A-Z0-9] with '_'.
3. Join segments with '_'.
4. Prepend '<envPrefix>_'.
```

```
inferEnvVar("ADHD_AGENT_MCP", "db.path")          → "ADHD_AGENT_MCP_DB_PATH"
inferEnvVar("ADHD_AGENT_MCP", "server.port")       → "ADHD_AGENT_MCP_SERVER_PORT"
inferEnvVar("ADHD_AGENT_MCP", "providers.deepseek.secret") → "ADHD_AGENT_MCP_PROVIDERS_DEEPSEEK_SECRET"
```

### Explicit `env` override

Only specify `env` when the REAL env var name differs from the inferred convention:

```ts
// Normal field — env inferred, no explicit env property needed
"db.path": { default: "~/.adhd/agent-mcp/agents.db", scope: "project", type: "path" }

// Override — the real env var is named differently
"providers.openai.secret": { env: "OPENAI_API_KEY", default: "", scope: "project" }

// Another override example
"providers.anthropic.secret": { env: "ANTHROPIC_API_KEY", default: "", scope: "project" }
```

When `env` is explicitly provided, it **completely replaces** the inferred name. There is no fallback to the inferred name — if the author adds `env`, that's the name the builder uses, period.

In the static spec file at authoring time, the developer specifies their project's `envPrefix`:

```ts
export default {
  envPrefix: "ADHD_AGENT_MCP",
  config: {
    project: {
      // Most fields: no env needed — inferred
      "db.path":           { default: "~/.adhd/agent-mcp/agents.db",  type: "path" },
      "server.port":       { default: "3000",                          type: "integer", minimum: 1024 },

      // Only overrides where the real name doesn't follow convention:
      "providers.openai.secret":    { env: "OPENAI_API_KEY",           default: "", type: "string" },
      "providers.anthropic.secret": { env: "ANTHROPIC_API_KEY",        default: "", type: "string" },
    },
  },
};
```

### Impact on ConfigFieldDefinition

The `env` field becomes **optional**:

```typescript
// BEFORE (v0.0.2)
export interface ConfigFieldDefinition {
  env: string;           // REQUIRED
  default: string;
  scope: ConfigScope;
  // ...
}

// AFTER (v0.0.3)
export interface ConfigFieldDefinition {
  /** Env var name. Optional — inferred from prefix + field path when omitted. */
  env?: string;          // OPTIONAL
  default: string;
  scope: ConfigScope;
  // ...
}
```

### Impact on the builder

In `ConfigResolver.resolve()`, the effective env var name for each field is:

```
effectiveEnvVar = fieldDef.env ?? inferEnvVar(prefix, key)
```

The builder performs the inference at merge time (after system→global→project merge, before resolution). The inferred name is tracked in provenance (`env` field records the effective env var name used).

---

## Fix 2: Scope assignments must match reality

### The problem

The v0.0.2 worked example put `db.path` and `registry.path` at global scope. Looking at the REAL agent-mcp defaults:

- `db.path` defaults to `~/.adhd/agent-mcp/agents.db` — project-specific, not shared
- `registry.path` defaults to `~/.adhd/agent-mcp/registry.db` — project-specific, not shared
- `server.port` defaults to `3000` — a sensible project default (not org-wide `8080`)

Global-scoped fields should be things EVERY ADHD project shares: logging format/level, transport protocol, concurrency defaults. Project-scoped fields are specific to one project: its paths, its ports, its provider secrets.

### The fix

The worked example must show realistic scope assignments:

```ts
// Static spec for agent-mcp
export default {
  project: { name: "agent-mcp", description: "ADHD Agent MCP Server" },
  envPrefix: "ADHD_AGENT_MCP",
  namespaces: ["development", "staging", "production"],

  dirs: [
    { name: "primary",  type: "state.data",   scope: "project", description: "Main agent database" },
    { name: "registry", type: "state.data",   scope: "project", description: "Agent registry DB" },
    { type: "runtime.log",                    scope: "project", description: "Application logs" },
    { type: "runtime.pid",                    scope: "project", description: "PID files" },
  ],

  config: {
    // System scope: framework-shipped, rarely changed
    system: {
      "log.level":            { default: "info",  type: "string", enum: ["debug","info","warn","error"] },
      "server.maxDepth":      { default: "5",     type: "integer", minimum: 1 },
      "server.maxToolLoops":   { default: "50",    type: "integer", minimum: 1 },
      "queue.concurrency":    { default: "5",     type: "integer", minimum: 1 },
    },

    // Global scope: org-wide defaults, shared across all ADHD projects
    global: {
      "log.format":           { default: "json",   type: "string", enum: ["json","pretty"] },
      "transport.kind":       { default: "stdio",  type: "string", enum: ["stdio","sse","http"] },
    },

    // Project scope: specific to agent-mcp only
    project: {
      "db.path":              { default: "${HOME}/.adhd/agent-mcp/agents.db",  type: "path" },
      "registry.path":        { default: "${HOME}/.adhd/agent-mcp/registry.db", type: "path" },
      "server.port":          { default: "3000",   type: "integer", minimum: 1024, maximum: 65535 },
      "server.allowedAgents": { default: "",        type: "string" },
      "providers.openai.secret":      { env: "OPENAI_API_KEY",          default: "", type: "string" },
      "providers.openai.model":       { default: "gpt-4o",               type: "string" },
      "providers.anthropic.secret":   { env: "ANTHROPIC_API_KEY",        default: "", type: "string" },
      "providers.anthropic.model":    { default: "claude-sonnet-4-20250514", type: "string" },
      "providers.deepseek.secret":    { default: "",                     type: "string" },
      "providers.deepseek.model":     { default: "",                     type: "string" },
    },
  },
};
```

### Scope semantics (clarified)

| Scope | Root | What goes here | Examples |
|---|---|---|---|
| `system` | `/etc/adhd/` | Framework-shipped defaults, rarely changed | `log.level`, `server.maxDepth`, `queue.concurrency` |
| `global` | `~/.adhd/` | Org-wide defaults shared across ALL ADHD projects | `log.format`, `transport.kind` |
| `project` | `<cwd>/.adhd/` | This-project-only: paths, ports, secrets | `db.path`, `server.port`, `providers.openai.secret` |

Key principle: if a config value or directory path contains the PROJECT NAME in it, it's project-scoped. If it applies to every ADHD project in the org, it's global. If the framework ships it and it should almost never change, it's system.

---

## Fix 3: Builder vs Runtime client split

### The problem

v0.0.2 had a single `Environment` class that did everything:

```
const env = new Environment({ ... });
await env.initialize();   // loads .env, merges fields, resolves, validates, writes snapshot
env.dirs.path("state.data");  // directory access
env.config.resolve();         // config access
```

This conflates two very different use cases:
- **Build time** (once, on install or config change): heavy work — `.env` loading, field merging, resolution, validation, directory creation, snapshot writing
- **Runtime** (every startup): light work — read the JSON snapshot and provide typed access

### The fix

Two separate classes:

#### `EnvironmentBuilder` — runs once (or on config change)

```typescript
const builder = new EnvironmentBuilder({
  project: { name: "agent-mcp" },
  namespace: "production",
  dirs: [ /* entries */ ],
  config: {
    system:  { /* framework defaults */ },
    global:  { /* org-wide overrides */ },
    project: { /* project-specific overrides */ },
  },
  envFiles: [ /* optional custom .env paths */ ],
});

const snapshot = builder.initialize();
```

Does ALL the heavy work:
1. Load `.env` files (configurable hierarchy)
2. Merge field definitions (system → global → project)
3. Infer env var names for fields missing explicit `env`
4. Resolve config values (env vars → defaults, interpolate `${VAR}`)
5. Generate `fieldSchema` from merged definitions
6. Validate resolved config against `fieldSchema`
7. Compute `contentHash` + `structureHash`
8. Track provenance for every resolved key
9. Ensure directories exist on disk (all scopes)
10. Atomic write snapshot to `~/.adhd/<project>/<namespace>/adhd-environment.json`

#### `Environment` — runs every startup

```typescript
const env = new Environment("agent-mcp", "project", "production");
// Reads: ~/.adhd/agent-mcp/production/adhd-environment.json
// That's it. Parses JSON. No ajv, no .env loading, no field merge.
```

The runtime API — minimal, dot-path access via `get()`:

```typescript
env.get("config.db.path")                 // "/Users/nix/.adhd/agent-mcp/production/data/primary/"
env.get("config.server.port")            // 3000
env.get("path.db")                        // "~/.adhd/agent-mcp/production/data/primary/"
env.get("path.state.data")               // first/only state.data directory
env.get("path.state.data.replica")        // specific named state.data directory
env.get("path.state.data.registry")       // specific named state.data directory
env.get("env.ANTHROPIC_API_KEY")          // resolved env var from snapshot
env.get("provenance.db.path")             // { source: "project.default", scope: "project" }
env.hash                                   // config hash (string)
env.version                                // { configHash, structureHash, generatedAt, libraryVersion }
env.project                                // { name, description, ... }
env.prefix                                 // "ADHD_AGENT_MCP_PRODUCTION_"
env.namespace                              // "production"

// Bracket access for path shorthand:
env["path.db"]                            // same as env.get("path.db")
```

### What the runtime `Environment` does NOT do

- Does NOT load `.env` files
- Does NOT resolve config — values are already resolved in the snapshot
- Does NOT validate against `fieldSchema` — validation happened at build time
- Does NOT create directories — directories were created at build time
- Does NOT generate `fieldSchema`
- Does NOT track provenance
- Does NOT write anything to disk
- Does NOT import `ajv`

### The `get()` method

Resolves a dot-path against the snapshot:

| Prefix | Resolves To | Example |
|---|---|---|
| `"config.*"` | `EnvironmentSnapshot.config` (unflattened, resolved values) | `env.get("config.server.port")` → `3000` |
| `"path.*"` | Directory paths by name or by type+name | `env.get("path.db")` → resolved path |
| `"env.*"` | Recorded env var values from snapshot's `envVars` | `env.get("env.OPENAI_API_KEY")` → resolved value |
| `"provenance.*"` | Provenance entries | `env.get("provenance.db.path")` → `{ source, scope }` |

**Path resolution via `get()`:**

```
env.get("path.<name>")          → directory path by name
env.get("path.<type>")          → directory path by type (first/only match)
env.get("path.<type>.<name>")   → directory path by type + name (disambiguation)
```

Examples from the snapshot:
```
env.get("path.db")                    → resolved path for directory named "db"
env.get("path.state.data")           → first state.data directory
env.get("path.state.data.registry")  → specific state.data registry directory
env.get("path.runtime.log")         → runtime log directory
```

Path resolution follows the same type-first lookup rules as v0.0.2's `DirectoryRegistry.path()`:

1. If the path segment matches a registered name → return its resolved path.
2. If the path segment matches a registered type (with only one entry of that type) → return its resolved path.
3. If the path segment matches a registered type with multiple entries → throw with disambiguation message.
4. If two segments: first is type, second is name for disambiguation.

### Constructor parameters

```typescript
const env = new Environment(project, scope?, namespace?);

// Examples:
const env1 = new Environment("agent-mcp");
// namespace = "default", scope = undefined (full cascade)

const env2 = new Environment("agent-mcp", "project", "production");
// namespace = "production", scope = "project" (only project-scoped values)

const env3 = new Environment("agent-mcp", undefined, "staging");
// namespace = "staging", scope = undefined (full cascade)
```

### The `scope` parameter on the Environment constructor

Controls which scope's values `env.get("config.*")` returns:

| Scope | Behavior |
|---|---|
| `undefined` (default) | Full cascade: system → global → project. Same as `"system"` scope. |
| `"system"` | Only system-scoped values |
| `"global"` | Only global-scoped values |
| `"project"` | Only project-scoped values |

The scope filtering happens at **access time** in the runtime client. The snapshot contains ALL values from the full cascade. The `scope` parameter on the constructor is a convenience filter — the same snapshot supports any scope.

```typescript
// Same snapshot, different scope views:
const fullEnv    = new Environment("agent-mcp", undefined, "production");
fullEnv.get("config.log.level")    // "info" (system-scoped)
fullEnv.get("config.db.path")      // "/Users/nix/.adhd/agent-mcp/agents.db" (project-scoped)

const projectEnv = new Environment("agent-mcp", "project", "production");
projectEnv.get("config.log.level")    // undefined (system-scoped, filtered out)
projectEnv.get("config.db.path")      // "/Users/nix/.adhd/agent-mcp/agents.db" (project-scoped)
```

### When the builder runs

- **First install:** `adhd-env init --project-name agent-mcp` (calls `builder.initialize()`)
- **Config change:** `adhd-env config-set` triggers rebuild
- **CI:** `adhd-env verify` compares runtime snapshot against expected

### When the runtime client runs

- **Every startup:** `const env = new Environment("agent-mcp");` — reads the existing snapshot
- No builder needed in production code — the snapshot was already built
- In CI/test: builder runs first, then runtime client validates the result

---

## Static spec file format

A project checks in a file that defines its entire environment. This is the single source of truth.

### `adhd.environment.ts` (TypeScript — preferred)

```typescript
// adhd.environment.ts — checked into the agent-mcp repo
export default {
  project: {
    name: "agent-mcp",
    description: "ADHD Agent MCP Server",
  },

  /** Env var prefix for this project. Used to infer env var names. */
  envPrefix: "ADHD_AGENT_MCP",

  /** Namespaces this project supports. Default "default" is always available. */
  namespaces: ["development", "staging", "production"],

  /** Directory entries — declared at authoring time, created at build time. */
  dirs: [
    { name: "primary",  type: "state.data",   scope: "project", description: "Main agent database" },
    { name: "registry", type: "state.data",   scope: "project", description: "Agent registry DB" },
    { type: "runtime.log",                    scope: "project", description: "Application logs" },
    { type: "runtime.pid",                    scope: "project", description: "PID files" },
  ],

  /** Config field definitions in three tiers. */
  config: {
    system: {
      "log.level":            { default: "info",  type: "string", enum: ["debug","info","warn","error"] },
      "server.maxDepth":      { default: "5",     type: "integer", minimum: 1 },
      "server.maxToolLoops":   { default: "50",    type: "integer", minimum: 1 },
      "queue.concurrency":    { default: "5",     type: "integer", minimum: 1 },
    },
    global: {
      "log.format":           { default: "json",   type: "string", enum: ["json","pretty"] },
      "transport.kind":       { default: "stdio",  type: "string", enum: ["stdio","sse","http"] },
    },
    project: {
      "db.path":              { default: "${HOME}/.adhd/agent-mcp/agents.db",  type: "path" },
      "registry.path":        { default: "${HOME}/.adhd/agent-mcp/registry.db", type: "path" },
      "server.port":          { default: "3000",   type: "integer", minimum: 1024, maximum: 65535 },
      "server.allowedAgents": { default: "",        type: "string" },
      "providers.openai.secret":      { env: "OPENAI_API_KEY",          default: "", type: "string" },
      "providers.openai.baseUrl":     { default: "",                     type: "string" },
      "providers.openai.model":       { default: "gpt-4o",               type: "string" },
      "providers.anthropic.secret":   { env: "ANTHROPIC_API_KEY",        default: "", type: "string" },
      "providers.anthropic.model":    { default: "claude-sonnet-4-20250514", type: "string" },
      "providers.deepseek.secret":    { default: "",                     type: "string" },
      "providers.deepseek.model":     { default: "",                     type: "string" },
    },
  },
};
```

### `adhd.environment.json` (JSON — fallback for non-TS projects)

Same shape, just JSON format. Used by Python and Rust projects that don't have a TypeScript toolchain.

```json
{
  "project": { "name": "agent-mcp", "description": "ADHD Agent MCP Server" },
  "envPrefix": "ADHD_AGENT_MCP",
  "namespaces": ["development", "staging", "production"],
  "dirs": [
    { "name": "primary",  "type": "state.data",   "scope": "project" },
    { "name": "registry", "type": "state.data",   "scope": "project" }
  ],
  "config": {
    "system": {
      "log.level": { "default": "info", "type": "string", "enum": ["debug","info","warn","error"] }
    },
    "global": {
      "log.format": { "default": "json", "type": "string", "enum": ["json","pretty"] }
    },
    "project": {
      "db.path": { "default": "${HOME}/.adhd/agent-mcp/agents.db", "type": "path" },
      "server.port": { "default": "3000", "type": "integer", "minimum": 1024 }
    }
  }
}
```

### Required fields in the static spec

| Field | Required | Description |
|---|---|---|
| `project.name` | Yes | project name (kebab-case, matches repo) |
| `project.description` | No | Human-readable description |
| `envPrefix` | Yes | Uppercased prefix for env var inference |
| `namespaces` | No | If empty/absent, only `"default"` is available |
| `dirs` | No | If absent, no directories are registered |
| `config.system` | No | Framework-shipped field definitions |
| `config.global` | No | Org-wide field definitions |
| `config.project` | No | Project-specific field definitions |

### How the builder consumes the static spec

```typescript
import spec from './adhd.environment';

const builder = new EnvironmentBuilder({
  project: spec.project,
  namespace: "production",
  dirs: spec.dirs,
  config: spec.config,
  // envPrefix comes from spec.envPrefix
});

const snapshot = builder.initialize();
```

---

## Full worked example

### Step 1: Developer writes the static spec

Samira creates `adhd.environment.ts` in the agent-mcp repo (shown above in Static spec file format).

### Step 2: Builder runs (once, on install or config change)

```typescript
import spec from './adhd.environment';

const builder = new EnvironmentBuilder({
  project: spec.project,
  namespace: "production",
  dirs: spec.dirs,
  config: spec.config,
});

const snapshot = builder.initialize();
```

The builder pipeline:

1. **Load .env files** — default 3-tier hierarchy: `~/.adhd/.env` → `./.adhd/.env` → `./.env`
2. **Merge field definitions** — system → global → project cascade (unchanged from v0.0.2)
3. **Infer env var names** — for each field without explicit `env`, call `inferEnvVar("ADHD_AGENT_MCP", key)`
4. **Resolve values** — for each field: check `process.env[effectiveEnvVar]` → field's `default`
5. **Interpolate `${VAR}`** — expand `${HOME}`, `${ADHD_HOME}`, etc.
6. **Generate `fieldSchema`** — auto-generated JSON Schema from merged definitions
7. **Validate config** — `ajv.compile(fieldSchema)(config)` → throws on failure
8. **Compute hashes** — `contentHash` from resolved config, `structureHash` from directory registry
9. **Track provenance** — for every key: `{ source, scope, env? }`
10. **Ensure directories** — create all registered directories on disk
11. **Atomic write** — snapshot to `~/.adhd/agent-mcp/production/adhd-environment.json`

### Step 3: Runtime client uses the snapshot

In `agent-mcp`'s `main.ts` (every startup):

```typescript
import { Environment } from '@adhd/environment';

const env = new Environment("agent-mcp", "project", "production");

// Config access:
const dbPath = env.get("config.db.path");
// → "/Users/nix/.adhd/agent-mcp/agents.db"

const port = env.get("config.server.port");
// → 3000

const logLevel = env.get("config.log.level");
// → undefined (system-scoped, filtered by constructor's "project" scope)

// Full cascade access (different scope on constructor):
const fullEnv = new Environment("agent-mcp", undefined, "production");
fullEnv.get("config.log.level");
// → "info" (system-scoped, visible in full cascade)

// Path access:
const dbDir = env.get("path.db");
// → "/Users/nix/.adhd/agent-mcp/production/data/primary/"

const registryDir = env.get("path.state.data.registry");
// → "/Users/nix/.adhd/agent-mcp/production/data/registry/"

const logDir = env.get("path.runtime.log");
// → "/Users/nix/projects/agent-mcp/.adhd/agent-mcp/production/log/"

// Env var access:
const openaiKey = env.get("env.OPENAI_API_KEY");
// → resolved value from snapshot (or empty string)

// Metadata:
console.log(env.hash);       // "sha256-a1b2c3..."
console.log(env.version);    // { configHash, structureHash, generatedAt, libraryVersion }
console.log(env.project);    // { name: "agent-mcp", description: "..." }
console.log(env.prefix);     // "ADHD_AGENT_MCP_PRODUCTION_"
console.log(env.namespace);  // "production"

// Provenance:
const dbSource = env.get("provenance.db.path");
// → { source: "project.default", scope: "project" }
```

### End-to-end demo: Developer lifecycle

```
$ adhd-env init --spec ./adhd.environment.ts --namespace production
  ✓ Loaded adhd.environment.ts (system: 4 fields, global: 2 fields, project: 10 fields)
  ✓ Inferred env vars for 13/16 fields (3 had explicit env overrides)
  ✓ Merged field definitions (16 fields total)
  ✓ Loaded 3 .env files
  ✓ Resolved 16 config values
  ✓ Generated fieldSchema (JSON Schema)
  ✓ Validated config against fieldSchema — passed
  ✓ Computed contentHash: sha256-a1b2c3d4
  ✓ Computed structureHash: sha256-b2c3d4e5
  ✓ Ensured 4 directories
  ✓ Wrote snapshot: ~/.adhd/agent-mcp/production/adhd-environment.json

$ node dist/main.js
  [agent-mcp] Environment loaded: agent-mcp/production
  [agent-mcp] DB path: /Users/nix/.adhd/agent-mcp/production/data/primary/
  [agent-mcp] Server starting on port 3000
```

---

## Architecturally it's still a monolith — just at a different location

The builder/runtime split moves the heavy work from runtime to build time. The builder itself is a single pipeline — it still does everything it always did (load .env, merge, resolve, validate, hash, provenance, dirs, write). The only new thing is that the runtime client is a separate class that reads the snapshot and provides access.

| Concern | v0.0.2 | v0.0.3 |
|---|---|---|
| `.env` loading | `Environment.initialize()` | `EnvironmentBuilder.initialize()` |
| Field merge | `Environment.initialize()` | `EnvironmentBuilder.initialize()` |
| Config resolution | `Environment.initialize()` | `EnvironmentBuilder.initialize()` |
| Validation (`ajv`) | `Environment.initialize()` | `EnvironmentBuilder.initialize()` |
| Hash computation | `Environment.initialize()` | `EnvironmentBuilder.initialize()` |
| Provenance tracking | `Environment.initialize()` | `EnvironmentBuilder.initialize()` |
| Directory creation | `Environment.initialize()` | `EnvironmentBuilder.initialize()` |
| Snapshot write | `Environment.initialize()` | `EnvironmentBuilder.initialize()` |
| Config access | `env.config.resolve()` | `env.get("config.*")` |
| Directory access | `env.dirs.path()` | `env.get("path.*")` |
| Env var access | Not directly available | `env.get("env.*")` |
| Provenance access | Not directly available | `env.get("provenance.*")` |
| Hash access | Via snapshot | `env.hash`, `env.version` |
| Runtime deps | `ajv`, `node:*` builtins | `node:fs` only |

---

## Language-agnostic contract

### `environment-base-spec/spec/adhd-environment.schema.json`

The canonical format for `~/.adhd/<project>/<namespace>/adhd-environment.json`. Every language client reads and writes this exact shape. This is the authority — TypeScript types derive from it.

Unchanged from v0.0.2 except: the snapshot now contains the `envPrefix` from the static spec (not derived from project name — though derived is still a fallback).

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
      "description": "Environment namespace."
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
      "additionalProperties": { "$ref": "#/$defs/directoryEntry" },
      "description": "Directory entries keyed by type name: '<type>/<name>' or '<type>'."
    },
    "$defs": {
      "directoryEntry": {
        "type": "object",
        "required": ["path", "type", "scope"],
        "properties": {
          "path":        { "type": "string" },
          "type":        {
            "type": "string",
            "pattern": "^(state|runtime|user)\\.[a-z][a-z0-9-]*$"
          },
          "name":        { "type": "string" },
          "description": { "type": "string" },
          "scope":       { "type": "string", "enum": ["system", "global", "project"] }
        }
      }
    },
    "config": {
      "type": "object",
      "description": "Resolved config values — nested object matching fieldSchema structure."
    },
    "fieldSchema": {
      "type": "object",
      "description": "Auto-generated JSON Schema from merged field definitions."
    },
    "provenance": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": ["source", "scope"],
        "properties": {
          "source": { "type": "string", "enum": ["system.default", "global.default", "global.env", "project.default", "project.env"] },
          "scope":  { "type": "string", "enum": ["system", "global", "project"] },
          "env":    { "type": "string" }
        }
      }
    },
    "envPrefix": { "type": "string" },
    "envVars": {
      "type": "object",
      "additionalProperties": { "type": "string" }
    }
  }
}
```

---

## Builder pipeline (behavioral spec)

### `EnvironmentBuilder.initialize()` — full pipeline

```
builder.initialize() → EnvironmentSnapshot
```

1. **Validate inputs:** project name must be non-empty kebab-case. `namespace` defaults to `"default"`.
2. **Load `.env` files** from `envFiles` array (or default 3-tier hierarchy).
3. **Parse static spec config** — extract `system`, `global`, `project` field maps.
4. **Merge field definitions:** `mergeFieldDefinitions(system, global, project)` → `effectiveFields`.
5. **Infer env var names:** for each field in `effectiveFields` without explicit `env`, set `effectiveEnvVar = inferEnvVar(envPrefix, key)`.
6. **Resolve values:**
   - For each field: check `process.env[effectiveEnvVar]` → field's `default`.
   - Run `interpolate(value, process.env)` on each resolved value.
   - Record provenance: `{ source, scope, env }`.
7. **Generate `fieldSchema`** from `effectiveFields`.
8. **Validate config** against `fieldSchema` using `ajv`. Throw with field-level errors on failure.
9. **Compute `contentHash`** from resolved raw config.
10. **Build directory registry** from `dirs` entries (three roots: system, global, project with namespace in path).
11. **Compute `structureHash`** from directory registry snapshot.
12. **Drift detection:** Read on-disk snapshot (if exists). Compare `structureHash`:
    - Hash matches: no structural change. Proceed.
    - Hash differs: compare directory entries.
      - New directories → **warn**.
      - Directories removed → **warn**.
      - Directory types changed → **throw** `Error("Competing structure: ...")`.
      - Directory scope changed → **throw** `Error("Competing structure: ...")`.
      - Project name mismatch → **throw** `Error("Namespace conflict: ...")`.
13. **Ensure directories** on disk (all scopes).
14. **Build snapshot object** with all sections.
15. **Atomic write** to `<path>.tmp` then `renameSync`.
16. Return snapshot.

### `EnvironmentBuilder` options

```typescript
export interface EnvironmentBuilderOptions {
  /** Project identity. */
  project: ProjectIdentity;

  /**
   * Environment namespace. Defaults to "default".
   * Affects snapshot path, directory roots, and env-var prefix.
   */
  namespace?: string;

  /** Env var prefix for this project. Used to infer env var names. */
  envPrefix?: string;

  /** Directory entries. */
  dirs?: DirectoryEntry[];

  /** Config field definitions in three tiers. */
  config?: {
    system?: ConfigFieldMap;
    global?: ConfigFieldMap;
    project?: ConfigFieldMap;
  };

  /** Custom .env file load order. */
  envFiles?: string[];

  /** Custom root for ~/.adhd/ (default: os.homedir()/.adhd). */
  adhdRoot?: string;

  /** Custom CWD for project-scoped resolution. */
  cwd?: string;

  /** Custom system root (default: /etc/adhd/). */
  systemRoot?: string;

  /** Organization name for path roots (default: "adhd"). */
  org?: string;
}
```

---

## Runtime API (behavioral spec)

### `Environment` — reads snapshot, provides access

```typescript
export class Environment {
  readonly project: Readonly<ProjectIdentity>;
  readonly namespace: string;
  readonly hash: string;
  readonly version: EnvironmentSnapshot['version'];
  readonly prefix: string;
  readonly scope: ConfigScope | undefined;

  /**
   * @param project  Project name (kebab-case).
   * @param scope    Filter config values to a specific scope.
   *                 undefined = full cascade (system → global → project).
   * @param namespace Environment namespace (default: "default").
   * @param adhdRoot Custom root for ~/.adhd/ (testing override).
   */
  constructor(
    project: string,
    scope?: ConfigScope,
    namespace?: string,
    adhdRoot?: string,
  );

  /**
   * Get a value from the snapshot by dot-path.
   *
   * Prefixes:
   *   "config.*"     → resolved config values (scope-filtered by constructor)
   *   "path.*"       → directory paths (by name, type, or type+name)
   *   "env.*"        → recorded env var values
   *   "provenance.*" → provenance entries
   *
   * @returns The resolved value, or undefined if not found.
   */
  get(path: string): unknown;

  /** Bracket access — same as get(). */
  [key: string]: unknown;

  /** Private: the full snapshot loaded from disk. */
  private _snapshot: EnvironmentSnapshot;
}
```

### `get()` resolution behavior

**Config access (`"config.*"`):**

Navigates the unflattened `config` object in the snapshot. If the constructor was created with a `scope`, only fields matching that scope are returned (others are `undefined`).

```
env.get("config.server.port")        → 3000
env.get("config.db.path")            → "/Users/nix/.adhd/agent-mcp/agents.db"
env.get("config.providers.openai.secret") → ""
env.get("config.nonexistent")        → undefined
```

**Path access (`"path.*"`):**

One segment: lookup by name OR type. Two segments: lookup by type + name.

```
// One segment — lookup order: name match → type match
env.get("path.db")                   → resolved path for directory named "db"
env.get("path.state.data")          → first state.data directory
env.get("path.runtime.log")         → runtime log directory

// Two+ segments — first is type, second is name for disambiguation
env.get("path.state.data.primary")  → specific state.data/primary directory
env.get("path.state.data.registry") → specific state.data/registry directory

// Ambiguous:
env.get("path.state.data")          // if multiple state.data dirs → throws
```

Bracket access `env["path.db"]` delegates to `env.get("path.db")`.

**Env access (`"env.*"`):**

Looks up the env var name in the snapshot's `envVars` map.

```
env.get("env.OPENAI_API_KEY")                → "sk-..."
env.get("env.ADHD_AGENT_MCP_DB_PATH")        → "/Users/nix/..." (namespace-suffixed in snapshot)
env.get("env.NONEXISTENT")                   → undefined
```

**Provenance access (`"provenance.*"`):**

Looks up the dot-path in the snapshot's `provenance` map.

```
env.get("provenance.db.path")       → { source: "project.default", scope: "project" }
env.get("provenance.log.level")     → { source: "system.default",  scope: "system" }
env.get("provenance.server.host")   → { source: "global.env",      scope: "global", env: "ADHD_AGENT_MCP_SERVER_HOST" }
```

### Properties

| Property | Type | Description |
|---|---|---|
| `env.project` | `ProjectIdentity` | Project identity from snapshot |
| `env.namespace` | `string` | Environment namespace |
| `env.hash` | `string` | `configHash` from snapshot (shorthand) |
| `env.version` | `object` | Full version object: `{ configHash, structureHash, generatedAt, libraryVersion }` |
| `env.prefix` | `string` | Namespace-suffixed env prefix (e.g., `"ADHD_AGENT_MCP_PRODUCTION_"`) |
| `env.scope` | `ConfigScope \| undefined` | Scope filter from constructor (undefined = full cascade) |

---

## Updated TypeScript interfaces

### `EnvironmentBuilder` (new)

```typescript
export interface EnvironmentBuilderOptions {
  project: ProjectIdentity;
  namespace?: string;
  envPrefix?: string;
  dirs?: DirectoryEntry[];
  config?: {
    system?: ConfigFieldMap;
    global?: ConfigFieldMap;
    project?: ConfigFieldMap;
  };
  envFiles?: string[];
  adhdRoot?: string;
  cwd?: string;
  systemRoot?: string;
  org?: string;
}

export class EnvironmentBuilder {
  readonly project: ProjectIdentity;
  readonly namespace: string;

  constructor(options: EnvironmentBuilderOptions);

  /**
   * Full pipeline: load .env, merge field definitions (system→global→project),
   * infer env var names, resolve config, generate fieldSchema, validate config
   * against fieldSchema, compute hashes, track provenance, ensure directories,
   * write snapshot atomically.
   *
   * Warns if structure changed from on-disk snapshot.
   * Throws on competing structure or validation failure.
   */
  initialize(): EnvironmentSnapshot;

  /**
   * Re-build: invalidates state, re-runs full pipeline.
   * Used after config changes via CLI.
   */
  rebuild(): EnvironmentSnapshot;
}
```

### `Environment` (rewritten — runtime client)

```typescript
export class Environment {
  readonly project: Readonly<ProjectIdentity>;
  readonly namespace: string;
  readonly hash: string;
  readonly version: Readonly<EnvironmentSnapshot['version']>;
  readonly prefix: string;
  readonly scope: ConfigScope | undefined;

  constructor(
    project: string,
    scope?: ConfigScope,
    namespace?: string,
    adhdRoot?: string,
  );

  get(path: string): unknown;
  [key: string]: unknown;
}
```

### `ConfigFieldDefinition` — `env` is now optional

```typescript
export interface ConfigFieldDefinition {
  /** Env var name. Optional — inferred from envPrefix + field path when omitted.
   *  Explicit value completely replaces the inferred name (no fallback). */
  env?: string;

  /** Default value when env is unset. May contain ${VAR} references. */
  default: string;

  /** Scope: "system" | "global" | "project". */
  scope: ConfigScope;

  // ---- Validation keywords (all optional) ----

  type?: 'string' | 'integer' | 'number' | 'boolean' | 'path';
  minimum?: number;
  maximum?: number;
  enum?: (string | number)[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

export type ConfigFieldMap = Record<string, ConfigFieldDefinition>;
```

### Static spec file type

```typescript
export interface StaticEnvironmentSpec {
  project: ProjectIdentity;
  envPrefix: string;
  namespaces?: string[];
  dirs?: DirectoryEntry[];
  config?: {
    system?: ConfigFieldMap;
    global?: ConfigFieldMap;
    project?: ConfigFieldMap;
  };
}
```

### Other types — unchanged from v0.0.2

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
  type: DirectoryType;
  name?: string;
  scope: 'system' | 'global' | 'project';
  description?: string;
}

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

## Exported utilities

New utilities for v0.0.3:

### `inferEnvVar` — new

```typescript
export function inferEnvVar(envPrefix: string, fieldPath: string): string;
```

Algorithm:
1. Split `fieldPath` on `'.'`.
2. For each segment: uppercase, replace `[^A-Z0-9]` with `'_'`.
3. Join segments with `'_'`.
4. Return `envPrefix + '_' + joined`.

```
inferEnvVar("ADHD_AGENT_MCP", "db.path")          → "ADHD_AGENT_MCP_DB_PATH"
inferEnvVar("ADHD_AGENT_MCP", "server.port")       → "ADHD_AGENT_MCP_SERVER_PORT"
inferEnvVar("ADHD", "db.path")                     → "ADHD_DB_PATH"
```

### Unchanged utilities from v0.0.2

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

---

## Full worked example snapshot output

After `builder.initialize()` for agent-mcp with `namespace: "production"`, the `adhd-environment.json` at `~/.adhd/agent-mcp/production/adhd-environment.json`:

```json
{
  "project": {
    "name": "agent-mcp",
    "description": "ADHD Agent MCP Server"
  },
  "namespace": "production",
  "version": {
    "configHash": "sha256-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    "structureHash": "sha256-b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3",
    "generatedAt": "2026-07-06T12:00:00.000Z",
    "libraryVersion": "0.0.3"
  },
  "directories": {
    "state.data/primary": {
      "path": "/Users/nix/projects/agent-mcp/.adhd/agent-mcp/production/data/primary",
      "type": "state.data",
      "name": "primary",
      "description": "Main agent database",
      "scope": "project"
    },
    "state.data/registry": {
      "path": "/Users/nix/projects/agent-mcp/.adhd/agent-mcp/production/data/registry",
      "type": "state.data",
      "name": "registry",
      "description": "Agent registry DB",
      "scope": "project"
    },
    "runtime.log": {
      "path": "/Users/nix/projects/agent-mcp/.adhd/agent-mcp/production/log",
      "type": "runtime.log",
      "description": "Application logs",
      "scope": "project"
    },
    "runtime.pid": {
      "path": "/Users/nix/projects/agent-mcp/.adhd/agent-mcp/production/pid",
      "type": "runtime.pid",
      "description": "PID files",
      "scope": "project"
    }
  },
  "config": {
    "log": {
      "level": "info",
      "format": "json"
    },
    "server": {
      "maxDepth": 5,
      "maxToolLoops": 50,
      "port": 3000,
      "allowedAgents": ""
    },
    "queue": {
      "concurrency": 5
    },
    "transport": {
      "kind": "stdio"
    },
    "db": {
      "path": "/Users/nix/.adhd/agent-mcp/agents.db"
    },
    "registry": {
      "path": "/Users/nix/.adhd/agent-mcp/registry.db"
    },
    "providers": {
      "openai": {
        "secret": "",
        "baseUrl": "",
        "model": "gpt-4o"
      },
      "anthropic": {
        "secret": "",
        "model": "claude-sonnet-4-20250514"
      },
      "deepseek": {
        "secret": "",
        "model": ""
      }
    }
  },
  "fieldSchema": {
    "type": "object",
    "properties": {
      "log": {
        "type": "object",
        "properties": {
          "level": { "type": "string", "enum": ["debug","info","warn","error"] },
          "format": { "type": "string", "enum": ["json","pretty"] }
        }
      },
      "server": {
        "type": "object",
        "properties": {
          "maxDepth": { "type": "integer", "minimum": 1 },
          "maxToolLoops": { "type": "integer", "minimum": 1 },
          "port": { "type": "integer", "minimum": 1024, "maximum": 65535 },
          "allowedAgents": { "type": "string" }
        }
      },
      "queue": {
        "type": "object",
        "properties": {
          "concurrency": { "type": "integer", "minimum": 1 }
        }
      },
      "transport": {
        "type": "object",
        "properties": {
          "kind": { "type": "string", "enum": ["stdio","sse","http"] }
        }
      },
      "db": {
        "type": "object",
        "properties": {
          "path": { "type": "string" }
        }
      },
      "registry": {
        "type": "object",
        "properties": {
          "path": { "type": "string" }
        }
      },
      "providers": {
        "type": "object",
        "properties": {
          "openai": {
            "type": "object",
            "properties": {
              "secret": { "type": "string" },
              "baseUrl": { "type": "string" },
              "model": { "type": "string" }
            }
          },
          "anthropic": {
            "type": "object",
            "properties": {
              "secret": { "type": "string" },
              "model": { "type": "string" }
            }
          },
          "deepseek": {
            "type": "object",
            "properties": {
              "secret": { "type": "string" },
              "model": { "type": "string" }
            }
          }
        }
      }
    }
  },
  "provenance": {
    "log.level":               { "source": "system.default",  "scope": "system" },
    "log.format":              { "source": "global.default",  "scope": "global" },
    "server.maxDepth":         { "source": "system.default",  "scope": "system" },
    "server.maxToolLoops":     { "source": "system.default",  "scope": "system" },
    "server.port":             { "source": "project.default", "scope": "project" },
    "server.allowedAgents":    { "source": "project.default", "scope": "project" },
    "queue.concurrency":       { "source": "system.default",  "scope": "system" },
    "transport.kind":          { "source": "global.default",  "scope": "global" },
    "db.path":                 { "source": "project.default", "scope": "project" },
    "registry.path":           { "source": "project.default", "scope": "project" },
    "providers.openai.secret":       { "source": "project.default", "scope": "project", "env": "OPENAI_API_KEY" },
    "providers.openai.baseUrl":      { "source": "project.default", "scope": "project" },
    "providers.openai.model":        { "source": "project.default", "scope": "project" },
    "providers.anthropic.secret":    { "source": "project.default", "scope": "project", "env": "ANTHROPIC_API_KEY" },
    "providers.anthropic.model":     { "source": "project.default", "scope": "project" },
    "providers.deepseek.secret":     { "source": "project.default", "scope": "project" },
    "providers.deepseek.model":      { "source": "project.default", "scope": "project" }
  },
  "envPrefix": "ADHD_AGENT_MCP",
  "envVars": {
    "ADHD_AGENT_MCP_PRODUCTION_LOG_LEVEL": "info",
    "ADHD_AGENT_MCP_PRODUCTION_LOG_FORMAT": "json",
    "ADHD_AGENT_MCP_PRODUCTION_SERVER_MAX_DEPTH": "5",
    "ADHD_AGENT_MCP_PRODUCTION_SERVER_MAX_TOOL_LOOPS": "50",
    "ADHD_AGENT_MCP_PRODUCTION_SERVER_PORT": "3000",
    "ADHD_AGENT_MCP_PRODUCTION_SERVER_ALLOWED_AGENTS": "",
    "ADHD_AGENT_MCP_PRODUCTION_QUEUE_CONCURRENCY": "5",
    "ADHD_AGENT_MCP_PRODUCTION_TRANSPORT_KIND": "stdio",
    "ADHD_AGENT_MCP_PRODUCTION_DB_PATH": "/Users/nix/.adhd/agent-mcp/agents.db",
    "ADHD_AGENT_MCP_PRODUCTION_REGISTRY_PATH": "/Users/nix/.adhd/agent-mcp/registry.db",
    "ADHD_AGENT_MCP_PRODUCTION_PROVIDERS_OPENAI_MODEL": "gpt-4o",
    "ADHD_AGENT_MCP_PRODUCTION_PROVIDERS_ANTHROPIC_MODEL": "claude-sonnet-4-20250514"
  }
}
```

---

## Env var inference in action — the full mapping

For the agent-mcp static spec above, here's every field, its inferred env var name, and whether an explicit `env` override was needed:

| Field | `env` in spec | Inferred | Effective Env Var | Override? |
|---|---|---|---|---|
| `log.level` | omitted | `ADHD_AGENT_MCP_LOG_LEVEL` | `ADHD_AGENT_MCP_LOG_LEVEL` | No |
| `log.format` | omitted | `ADHD_AGENT_MCP_LOG_FORMAT` | `ADHD_AGENT_MCP_LOG_FORMAT` | No |
| `server.maxDepth` | omitted | `ADHD_AGENT_MCP_SERVER_MAX_DEPTH` | `ADHD_AGENT_MCP_SERVER_MAX_DEPTH` | No |
| `server.maxToolLoops` | omitted | `ADHD_AGENT_MCP_SERVER_MAX_TOOL_LOOPS` | `ADHD_AGENT_MCP_SERVER_MAX_TOOL_LOOPS` | No |
| `server.port` | omitted | `ADHD_AGENT_MCP_SERVER_PORT` | `ADHD_AGENT_MCP_SERVER_PORT` | No |
| `server.allowedAgents` | omitted | `ADHD_AGENT_MCP_SERVER_ALLOWED_AGENTS` | `ADHD_AGENT_MCP_SERVER_ALLOWED_AGENTS` | No |
| `queue.concurrency` | omitted | `ADHD_AGENT_MCP_QUEUE_CONCURRENCY` | `ADHD_AGENT_MCP_QUEUE_CONCURRENCY` | No |
| `transport.kind` | omitted | `ADHD_AGENT_MCP_TRANSPORT_KIND` | `ADHD_AGENT_MCP_TRANSPORT_KIND` | No |
| `db.path` | omitted | `ADHD_AGENT_MCP_DB_PATH` | `ADHD_AGENT_MCP_DB_PATH` | No |
| `registry.path` | omitted | `ADHD_AGENT_MCP_REGISTRY_PATH` | `ADHD_AGENT_MCP_REGISTRY_PATH` | No |
| `providers.openai.secret` | `"OPENAI_API_KEY"` | `ADHD_AGENT_MCP_PROVIDERS_OPENAI_SECRET` | `OPENAI_API_KEY` | **Yes** |
| `providers.openai.baseUrl` | omitted | `ADHD_AGENT_MCP_PROVIDERS_OPENAI_BASE_URL` | `ADHD_AGENT_MCP_PROVIDERS_OPENAI_BASE_URL` | No |
| `providers.openai.model` | omitted | `ADHD_AGENT_MCP_PROVIDERS_OPENAI_MODEL` | `ADHD_AGENT_MCP_PROVIDERS_OPENAI_MODEL` | No |
| `providers.anthropic.secret` | `"ANTHROPIC_API_KEY"` | `ADHD_AGENT_MCP_PROVIDERS_ANTHROPIC_SECRET` | `ANTHROPIC_API_KEY` | **Yes** |
| `providers.anthropic.model` | omitted | `ADHD_AGENT_MCP_PROVIDERS_ANTHROPIC_MODEL` | `ADHD_AGENT_MCP_PROVIDERS_ANTHROPIC_MODEL` | No |
| `providers.deepseek.secret` | omitted | `ADHD_AGENT_MCP_PROVIDERS_DEEPSEEK_SECRET` | `ADHD_AGENT_MCP_PROVIDERS_DEEPSEEK_SECRET` | No |
| `providers.deepseek.model` | omitted | `ADHD_AGENT_MCP_PROVIDERS_DEEPSEEK_MODEL` | `ADHD_AGENT_MCP_PROVIDERS_DEEPSEEK_MODEL` | No |

17 fields. 15 inferred correctly. 2 needed explicit `env` overrides because the actual env var names don't follow the convention (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).

---

## File manifests (updated for v0.0.3)

### `packages/environment/environment-base-spec/` — Contract package

| Path | Change | Description |
|------|--------|-------------|
| `package.json` | modify | Update spec version |
| `spec/SPEC.md` | modify | §1–§6a updated: builder/runtime split, `inferEnvVar`, static spec format, `get()` API |
| `spec/adhd-environment.schema.json` | modify | `ConfigFieldDefinition.env` optional, `fieldSchema` unchanged |
| `spec/cross-language-test-vectors.json` | modify | Add test vectors for `inferEnvVar` |
| `src/index.ts` | modify | Add `inferEnvVar`, `StaticEnvironmentSpec`, `EnvironmentBuilder`, `Environment` (runtime) types |

### `packages/environment/environment-core-node/` — TypeScript implementation

| Path | Change | Description |
|------|--------|-------------|
| `src/index.ts` | modify | Export `EnvironmentBuilder`, `Environment` (runtime), `inferEnvVar`, `StaticEnvironmentSpec` |
| `src/lib/types.ts` | modify | `env: string` → `env?: string` on `ConfigFieldDefinition`. Add `StaticEnvironmentSpec`, `EnvironmentBuilderOptions` |
| `src/lib/env-inference.ts` | **create** | `inferEnvVar(prefix, fieldPath)` + `resolveEffectiveEnvVar(def, prefix, key)` |
| `src/lib/builder.ts` | **create** | `EnvironmentBuilder` — full initialize pipeline (load .env, merge, infer, resolve, validate, hash, provenance, dirs, write) |
| `src/lib/environment.ts` | **rewrite** | `Environment` (runtime) — reads snapshot JSON, exposes `get()`, bracket access, properties. No ajv, no .env, no field merge. |
| `src/lib/config-resolver.ts` | modify | `resolve()` calls `resolveEffectiveEnvVar()` for each field. Still used inside builder — not by runtime. |
| `src/lib/directory-registry.ts` | retain | Unchanged. Used inside builder. Runtime accesses dir paths via snapshot's `directories` map + `get()`. |
| `src/lib/field-merge.ts` | retain | Unchanged |
| `src/lib/json-schema-gen.ts` | retain | Unchanged |
| `src/lib/content-hash.ts` | retain | Unchanged |
| `src/lib/snapshot.ts` | retain | Unchanged |
| `src/lib/provenance.ts` | retain | Unchanged |
| `src/lib/validation.ts` | retain | Unchanged (used in builder only) |
| `src/__tests__/env-inference.test.ts` | **create** | Tests for `inferEnvVar`, `resolveEffectiveEnvVar` |
| `src/__tests__/builder.test.ts` | **create** | Full pipeline: initialize, rebuild, error paths |
| `src/__tests__/environment-runtime.test.ts` | **create** | Read snapshot, `get()` access, scope filtering, bracket access |
| `src/__tests__/contract-compliance.test.ts` | modify | Add `inferEnvVar` test vectors |
| `src/__tests__/config-resolver.test.ts` | modify | Verify env var inference during resolution |
| `src/__tests__/environment.test.ts` | **remove** | Replaced by `builder.test.ts` + `environment-runtime.test.ts` |
| `README.md` | modify | Updated API reference with builder/runtime split |

### `packages/environment/environment-core-py/` — Python implementation

Mirrors all TypeScript changes. New files: `env_inference.py`, `builder.py`. Rewritten: `environment.py` (runtime). Removed: old environment tests, replaced with builder + runtime tests.

### `packages/environment/environment-core-rs/` — Rust implementation

Mirrors all TypeScript changes. New files: `env_inference.rs`, `builder.rs`. Rewritten: `environment.rs` (runtime). Removed: old environment tests, replaced with builder + runtime tests.

### `packages/environment/environment-cli/` — CLI (apigen-generated)

| Path | Change | Description |
|------|--------|-------------|
| `src/api.ts` | modify | New function: `buildFromSpec(specPath: string, namespace?: string)` — parses static spec and calls builder. |
| `src/lib/core.ts` | modify | Wire `EnvironmentBuilder` for CLI commands (`init`, `doctor`, `config-set`, etc.) |

---

## Test cases (new for v0.0.3)

### `inferEnvVar`

- `inferEnvVar("ADHD_AGENT_MCP", "db.path")` → `"ADHD_AGENT_MCP_DB_PATH"`
- `inferEnvVar("ADHD_AGENT_MCP", "server.port")` → `"ADHD_AGENT_MCP_SERVER_PORT"`
- `inferEnvVar("ADHD_AGENT_MCP", "providers.openai.secret")` → `"ADHD_AGENT_MCP_PROVIDERS_OPENAI_SECRET"`
- `inferEnvVar("ADHD", "a.b.c")` → `"ADHD_A_B_C"`
- `inferEnvVar("ADHD", "single")` → `"ADHD_SINGLE"`
- `inferEnvVar("ADHD_AGENT_MCP", "field-with-hyphens")` → `"ADHD_AGENT_MCP_FIELD_WITH_HYPHENS"`
- `inferEnvVar("", "db.path")` → `"_DB_PATH"` (empty prefix, still adds leading underscore)
- Cross-language parity: TypeScript, Python, Rust all produce identical output

### `resolveEffectiveEnvVar`

- Field has `env: "OPENAI_API_KEY"` → returns `"OPENAI_API_KEY"` (override wins)
- Field has no `env` → returns `inferEnvVar(prefix, key)`
- Field has `env: ""` → returns `""` (explicit empty, no fallback)

### Builder integration

- Builder infers env vars for fields without explicit `env`
- Builder uses explicit `env` overrides when present
- Builder writes effective env var names into provenance entries
- Provenance `env` field contains the EFFECTIVE env var name used during resolution
- Snapshot `envVars` uses effective env var names (not inferred placeholders)

### Runtime client

- `new Environment("agent-mcp")` with no namespace → reads `~/.adhd/agent-mcp/default/adhd-environment.json`
- `new Environment("agent-mcp", "project", "production")` → project-scoped filtering on `get("config.*")`
- `new Environment("agent-mcp", undefined, "production")` → full cascade on `get("config.*")`
- `env.get("config.db.path")` → resolved value from snapshot
- `env.get("path.db")` → directory path by name
- `env.get("path.state.data")` → first state.data directory
- `env.get("path.state.data.registry")` → specific named directory
- `env.get("env.OPENAI_API_KEY")` → value from `envVars` in snapshot
- `env.get("provenance.db.path")` → `{ source, scope }`
- `env.hash` → `configHash` from snapshot
- `env.version` → full version object
- `env.project` → project identity
- `env.namespace` → `"production"`
- `env.prefix` → `"ADHD_AGENT_MCP_PRODUCTION_"`
- `env["path.db"]` → same as `env.get("path.db")`
- Constructor throws if snapshot file doesn't exist
- Constructor loads snapshot lazily? No — reads on construction
- Snapshot with stale version → warn but don't throw (runtime correctness over strictness)

### Static spec file round-trip

- Load `adhd.environment.ts` → pass to `EnvironmentBuilder` → `initialize()` → `Environment` reads snapshot → `get()` returns correct values
- `envPrefix` from spec is used for inference
- `namespaces` from spec are validated (namespace must be in list, or `"default"`)
- Spec file with minimal fields (just `project.name` + `envPrefix`) → builder works (empty config, no dirs)

---

## Edge cases (new for v0.0.3)

| Case | Behavior |
|---|---|
| Field with `env: ""` (empty string) | Empty string IS the env var name — no inference fallback. Builder checks `process.env[""]` which is always undefined → uses default. |
| Field with `env: "OPENAI_API_KEY"` | Override wins completely. Inferred name is never used. |
| `envPrefix` is empty string | `inferEnvVar("", "db.path")` → `"_DB_PATH"` |
| `inferEnvVar` with empty field path | returns `prefix` (no trailing underscore for zero segments? Edge case — throw or return prefix) |
| Static spec missing `envPrefix` | Fall back to `projectEnvPrefix(project.name)` |
| Static spec has `config.system` but no `config.global` or `config.project` | Works — `mergeFieldDefinitions(system, {}, {})` → returns `system` |
| Runtime client: snapshot missing `fieldSchema` | No validation errors (runtime doesn't validate) — just return `undefined` for `fieldSchema` |
| Runtime client: scope filter with field not in that scope | `get("config.field")` returns `undefined` (field filtered out by scope) |
| Runtime client: `get("path.unknown")` | Throws — directory not found |
| Runtime client: `get("path.state.data")` with 2 state.data dirs | Throws — ambiguous, provide name |
| Runtime client: bracket access on unknown key | `env["nonexistent"]` → `undefined` (same as `get()`) |
| Builder: `rebuild()` on already-initialized instance | Full re-run of pipeline, new snapshot written |
| Builder: namespace not in `namespaces` | Warn but allow (the spec's `namespaces` is advisory, not a hard gate) |
| Runtime client: snapshot written by older library version | Warn on `libraryVersion` mismatch, attempt to read (forward-compatible JSON) |

---

## Retained from v0.0.2 (unchanged)

Everything not changed by the three fixes is retained:

- Five-package layout under `packages/environment/`
- npm names: `@adhd/environment`, `@adhd/environment-base-spec`, `@adhd/environment-cli`, `adhd-environment` (Py), `adhd-environment` (Rs)
- Three-tier scope cascade (system → global → project)
- Type-first directory identification with optional name disambiguator
- Namespaced environments (namespace in path, snapshot location, env prefix suffix)
- System-scope directory roots (`/etc/adhd/`)
- `contentHash` test vector: `{b:"2",a:"1"}` → `sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930`
- `structureHash` with `type:name:scope\n` format
- Atomic writes (`.tmp` + `renameSync`)
- Drift detection on `initialize()` (warn on new/removed, throw on type/scope change, namespace conflict)
- `${VAR}` interpolation (single-level, leave unresolved as literal)
- `projectEnvPrefix` + `namespaceEnvPrefix` derivation
- `unflatten` utility
- apigen-generated CLI (with renamed exports: `export`, `diff`)
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
- `DirectoryRegistry` class (used inside builder only — runtime reads paths from snapshot)
- `ConfigResolver` class (used inside builder only — runtime reads values from snapshot)
- `mergeFieldDefinitions` (system, global, project) — three-input variant unchanged
- Path pattern: `<scope_root>/<project>/<namespace>/<type_base>/<name>/`
- Directory types: `state.data`, `state.config`, `runtime.log`, `runtime.cache`, `runtime.pid`, `user.bin`, `user.custom`
- Future client gate: all language clients MUST pass cross-language-test-vectors.json

---

## Independent segments (implementation order)

### Segment A — Type + utility changes

- **Files:** `types.ts` (make `env` optional, add `StaticEnvironmentSpec`, `EnvironmentBuilderOptions`), `env-inference.ts` (create), `index.ts` (add exports)
- **Dependencies:** none
- **Read tokens:** ~200 (types.ts, index.ts)
- **Output tokens:** ~600
- **Strategy:** Make `env` optional on `ConfigFieldDefinition`. Implement `inferEnvVar()`. Add new types. Export everything.

### Segment B — EnvironmentBuilder

- **Files:** `builder.ts` (create)
- **Dependencies:** Segment A, existing `config-resolver.ts`, `field-merge.ts`, `json-schema-gen.ts`, `validation.ts`, `provenance.ts`, `directory-registry.ts`, `snapshot.ts`
- **Read tokens:** ~300 (existing resolver + environment.ts for pipeline logic)
- **Output tokens:** ~800
- **Strategy:** Extract the heavy pipeline from `Environment.initialize()` into `EnvironmentBuilder`. Wire env var inference into `ConfigResolver.resolve()`. Keep drift detection. Return snapshot.

### Segment C — Runtime Environment rewrite

- **Files:** `environment.ts` (rewrite)
- **Dependencies:** Segment B (builder writes the snapshot that runtime reads)
- **Read tokens:** ~200 (existing environment.ts, snapshot.ts)
- **Output tokens:** ~600
- **Strategy:** Rewrite `Environment` as a thin snapshot reader. Implement `get()` method with `"config.*"`, `"path.*"`, `"env.*"`, `"provenance.*"` prefixes. Implement bracket access. Add `hash`, `version`, `project`, `prefix`, `namespace`, `scope` properties. Remove all ajv, .env, field merge, directory creation, and snapshot writing logic.

### Segment D — ConfigResolver update (env inference)

- **Files:** `config-resolver.ts` (modify)
- **Dependencies:** Segment A
- **Read tokens:** ~200
- **Output tokens:** ~300
- **Strategy:** Add `resolveEffectiveEnvVar()` call during resolution. Pass effective env var name into provenance tracking. Builder's `envVar` is optional — infer when absent. The resolver still takes a `fields` map (pre-merged by builder). The resolver itself doesn't know about inference — the builder passes the effective env var name.

### Segment E — Tests

- **Files:** `env-inference.test.ts` (create), `builder.test.ts` (create), `environment-runtime.test.ts` (create), `config-resolver.test.ts` (modify)
- **Dependencies:** Segments A-D
- **Read tokens:** ~400
- **Output tokens:** ~3000
- **Strategy:** Full coverage: inference edge cases, builder initialize+rebuild, runtime `get()` with all prefixes, scope filtering, bracket access, error paths.

### Segment F — Contract package update

- **Files:** `base-spec/spec/SPEC.md`, `base-spec/spec/adhd-environment.schema.json`, `base-spec/spec/cross-language-test-vectors.json`
- **Dependencies:** Segment E (confirm schema matches implementation)
- **Read tokens:** ~300
- **Output tokens:** ~1500
- **Strategy:** Update SPEC.md with builder/runtime split, `inferEnvVar`, `get()` API. Update JSON Schema (env optional). Add inference test vectors.

### Segment G — Python + Rust implementations

- **Files:** All Python + Rust source + test files
- **Dependencies:** Segment F (spec is contract)
- **Output tokens:** ~12000 (combined)

### Segment H — CLI update

- **Files:** `environment-cli/src/api.ts`, `core.ts`, tests
- **Dependencies:** Segment B
- **Output tokens:** ~800

---

## Future client gate (updated)

Each new language client MUST pass all test vectors in `cross-language-test-vectors.json` before being considered complete. Updated gates for v0.0.3:

```
Input:  { "b": "2", "a": "1" }
Output: "sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930"
```

Additional gates:
- `inferEnvVar` produces identical output across languages (new)
- `generateFieldSchema` produces identical JSON Schema across languages
- `mergeFieldDefinitions` produces identical merged definitions (three inputs)
- `contentHash` + `structureHash` produce identical hashes
- `namespaceEnvPrefix` produces identical output
- Validation produces identical pass/fail results

## Migration targets (future — separate plans)

- `entrypoint/agent-mcp` — replace `config.ts` + `load-env.ts` with static spec → `EnvironmentBuilder` → `Environment`
- `packages/agent/agent-engine-compiler` — replace ad-hoc env with `Environment`
- `packages/agent/agent-store-prompts` — replace ad-hoc env
- `packages/agent/agent-store-tools` — replace ad-hoc env
- `packages/agent/agent-core-policy` — replace ad-hoc env
- `packages/agent/agent-core-provider` — replace ad-hoc env

## Related documents

- `docs/plan/adhd-environment/SPEC_0.0.2.md` — superseded spec (monolith Environment, explicit env vars, wrong scope assignments)
- `docs/plan/adhd-environment/SPEC_0.0.1.md` — superseded spec (global→project cascade, name-first dirs, no namespace)
- `docs/plan/adhd-environment/SPEC_0.0.0.md` — original spec (Zod, no fieldSchema, no provenance)
- `docs/plan/adhd-environment/CURRENT_CONFIG_PATTERNS.md` — real entrypoint config patterns today
- `docs/plan/workspace-cleanup/SCOPE.md` — monorepo naming convention
- `BACKLOG.md` §FEAT-ENV-001 — backlog entry
