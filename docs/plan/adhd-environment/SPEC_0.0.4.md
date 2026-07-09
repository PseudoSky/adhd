# @adhd/environment — Implementation Spec v0.0.4

> **Status: Current.** Supersedes [SPEC_0.0.3.md](./SPEC_0.0.3.md) on 2026-07-06. This revision moves the static spec to YAML, eliminates `EnvironmentBuilder` from all language clients (CLI owns all build logic), adds `environment-builder` as a new internal engine package, and defines four end-to-end user flows as the centerpiece of the spec.

## Revision History

| Revision | Date | Key Changes |
|---|---|---|
| 0.0.0 | (earlier) | Initial design: `Environment`, `DirectoryRegistry`, `ConfigResolver`, snapshot I/O, content/structure hashing, `.env` hierarchy, apigen CLI |
| 0.0.1 | 2026-07-06 | Zod removed (validation keywords in `ConfigFieldDefinition`), `fieldSchema` auto-generated JSON Schema, cross-language validation contract, field inheritance merge, provenance tracking, scope-based value resolution, full Python + Rust implementations, CLI renames |
| 0.0.2 | 2026-07-06 | Three-tier scope cascade (system→global→project), type-first directory identification, namespaced environments, system-scope directory roots |
| 0.0.3 | 2026-07-06 | Env vars inferred by convention, realistic scope assignments, builder/runtime client split, minimal runtime API with `get()` + bracket access, static spec file format (TypeScript/JSON) |
| **0.0.4** | **2026-07-06** | **Static spec is YAML (not TS/JSON), CLI owns all build logic (no `EnvironmentBuilder` in any language client), new `environment-builder` internal package, runtime clients are snap-shot readers only (~40-50 lines each), four user flows as spec centerpiece** |

---

## Summary

`@adhd/environment` gives every ADHD project deterministic namespacing, typed configuration, directory cataloging, dual content+structure hashing, three-tier scope-based field/directory inheritance (system → global → project), provenance tracking, and namespaced environments — all defined in a single checked-in YAML file (`adhd.environment.yaml`), built by a CLI (`adhd-env build`), and consumed by ultra-thin runtime clients in TypeScript, Python, and Rust.

The `adhd.environment.yaml` is the single source of truth. The CLI reads it, merges, resolves, validates, hashes, and writes a JSON snapshot. Runtime clients just read the snapshot. No field-merge logic, no `.env` loading, no validation, no directory creation, no `ajv` in any runtime. The runtime `Environment` class in each language is ~40-50 lines.

This is a **build-time engine, not a runtime framework**. The snapshot is the contract.

---

## Design Changes from v0.0.3

### Change 1: Static spec is YAML, not TypeScript/JSON

The project configuration file is `adhd.environment.yaml`, checked into the project repo. YAML was chosen because:

- It's human-writable without TypeScript tooling
- It's language-agnostic — Python and Rust projects can use it without a TS compiler
- It supports comments (unlike JSON)
- It produces the exact same static spec that the CLI builder consumes

The CLI generates a starter `adhd.environment.yaml` via `adhd-env init --generate-config`. Users edit it by hand. The CLI reads it at build time. There is NO `adhd.environment.ts` and NO `adhd.environment.json` static spec file.

### Change 2: CLI is the builder — no EnvironmentBuilder class in ANY language

The `EnvironmentBuilder` class is removed from TypeScript, Python, and Rust. The CLI (`adhd-env build`) owns all build-time logic:

```
adhd.environment.yaml  →  adhd-env build  →  ~/.adhd/<project>/<namespace>/adhd-environment.json
```

The CLI reads the YAML, merges field definitions, loads `.env`, resolves config, validates, computes hashes, tracks provenance, ensures directories, and writes the snapshot atomically. All of this lives in the Node.js CLI package + its internal builder engine.

Python and Rust runtime clients do NOT need: `.env` loaders, `mergeFieldDefinitions`, `generateFieldSchema`, `ConfigResolver`, or `EnvironmentBuilder`. They just need: `readSnapshot()` + the minimal runtime API.

### Change 3: Core builder package

The CLI's build logic lives in a new TypeScript package under `packages/environment/`:

**`packages/environment/environment-builder/`** — the internal engine that the CLI calls. This is NOT a user-facing API. It's the machinery behind `adhd-env build`:

```
packages/environment/environment-builder/
  src/
    index.ts              — exports buildSnapshot(spec, options)
    yaml-parser.ts        — reads adhd.environment.yaml, validates structure
    field-merge.ts        — mergeFieldDefinitions(system, global, project)
    config-resolver.ts    — resolve with .env loading, interpolation, scope filtering
    json-schema-gen.ts    — generateFieldSchema() from merged definitions
    provenance.ts         — track where each value came from
    validation.ts         — ajv validation against fieldSchema
    snapshot-writer.ts    — atomic write with .tmp + renameSync
```

The CLI is a thin shell over this builder package — it parses CLI args, then delegates to `buildSnapshot()`.

### Change 4: Runtime clients are THIN — snapshot readers only

The `Environment` class in each language is a JSON reader with typed accessors. Nothing more:

```ts
// TypeScript runtime — ~50 lines
const env = new Environment("agent-mcp", "global", "production");
env.get("config.db.path")        // resolved value
env.get("path.state.data")       // directory path
env.get("env.OPENAI_API_KEY")    // recorded env var
env.get("provenance.db.path")    // { source, scope }
env["path.db"]                   // bracket shorthand
env.hash                         // config hash
env.version                      // version info
env.project                      // project metadata
env.prefix                       // env prefix
env.namespace                    // namespace
```

No `.env` loading, no field merge, no validation, no schema generation, no directory creation. Just reads JSON and exposes typed accessors.

Same for Python and Rust. The Python runtime is ~40 lines. The Rust runtime is ~50 lines.

### Change 5: Four user flows — documented in the spec

The spec must describe four concrete end-to-end flows with real YAML, real commands, real code, and real output. An implementer should be able to trace every flow from YAML → CLI build → snapshot → runtime access without guessing. These flows are the centerpiece of this spec — see the [User Flows](#user-flows) section below.

---

## User Flows

### Flow 1: Samira defines a project's configuration

Samira is the author of `agent-mcp`. She wants to define its environment — what config fields it has, what directories it needs, what env vars it reads, what namespaces it supports.

#### Step 1a: Generate starter config

Samira runs the init command to generate a starter YAML file:

```bash
$ adhd-env init --generate-config
```

Output:

```
✓ Generated adhd.environment.yaml with 2 namespaces, 4 directories, 12 config fields
Edit this file to customize your project's environment, then run 'adhd-env build'.
```

#### Step 1b: The generated starter YAML

```yaml
# adhd.environment.yaml — generated by adhd-env init --generate-config
# Edit this file to define your project's environment configuration.
# Run 'adhd-env build' when done.

project:
  name: agent-mcp
  description: ADHD Agent MCP Server
  envPrefix: ADHD_AGENT_MCP

namespaces:
  - development
  - staging
  - production

dirs:
  - name: data
    type: state.data
    scope: project
    description: Main application data directory
  - type: runtime.log
    scope: project
    description: Application logs
  - type: runtime.cache
    scope: project
    description: Application cache

config:
  system:
    log.level:
      default: info
      type: string
      enum: [debug, info, warn, error]

  global:
    log.format:
      default: json
      type: string
      enum: [json, pretty]

  project:
    server.port:
      default: "3000"
      type: integer
      minimum: 1024
      maximum: 65535
    db.path:
      default: ${HOME}/.adhd/agent-mcp/data.db
      type: path
```

#### Step 1c: Samira edits the YAML to match her project

Samira opens `adhd.environment.yaml` and customizes it with her actual config fields, directories, and namespaces:

```yaml
# adhd.environment.yaml — checked into agent-mcp repo
project:
  name: agent-mcp
  description: ADHD Agent MCP Server
  envPrefix: ADHD_AGENT_MCP

namespaces:
  - development
  - staging
  - production

dirs:
  - name: primary
    type: state.data
    scope: project
    description: Main SQLite database
  - name: registry
    type: state.data
    scope: project
    description: Agent registry DB
  - type: runtime.log
    scope: project
    description: Application logs
  - type: runtime.pid
    scope: project
    description: PID files

config:
  system:
    log.level:
      default: info
      type: string
      enum: [debug, info, warn, error]
    server.maxDepth:
      default: "5"
      type: integer
      minimum: 1
    server.maxToolLoops:
      default: "50"
      type: integer
      minimum: 1
    queue.concurrency:
      default: "5"
      type: integer
      minimum: 1

  global:
    log.format:
      default: json
      type: string
      enum: [json, pretty]
    transport.kind:
      default: stdio
      type: string
      enum: [stdio, sse, http]

  project:
    db.path:
      default: ${HOME}/.adhd/agent-mcp/agents.db
      type: path
    registry.path:
      default: ${HOME}/.adhd/agent-mcp/registry.db
      type: path
    server.port:
      default: "3000"
      type: integer
      minimum: 1024
      maximum: 65535
    server.allowedAgents:
      default: ""
      type: string
    providers.openai.secret:
      default: ""
      type: string
      env: OPENAI_API_KEY
    providers.openai.baseUrl:
      default: ""
      type: string
    providers.openai.model:
      default: gpt-4o
      type: string
    providers.anthropic.secret:
      default: ""
      type: string
      env: ANTHROPIC_API_KEY
    providers.anthropic.model:
      default: claude-sonnet-4-20250514
      type: string
    providers.deepseek.secret:
      default: ""
      type: string
    providers.deepseek.model:
      default: ""
      type: string
```

Note: Most fields have NO explicit `env` property — they're inferred from the field path + `envPrefix`. Only `providers.openai.secret` and `providers.anthropic.secret` have explicit `env` overrides because the real env var names don't follow the convention.

#### Step 1d: Samira builds the snapshot

```bash
$ adhd-env build --namespace production
```

Output:

```
✓ Read adhd.environment.yaml (project: agent-mcp, namespaces: development,staging,production)
✓ Merged field definitions: 4 system + 2 global + 10 project = 16 total
✓ Inferred env vars: 14/16 inferred, 2 explicit overrides (openai.secret→OPENAI_API_KEY, anthropic.secret→ANTHROPIC_API_KEY)
✓ Loaded 3 .env files (no changes)
✓ Resolved 16 config values
✓ Generated fieldSchema (JSON Schema)
✓ Validated config against fieldSchema — passed
✓ Computed contentHash: sha256-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2
✓ Computed structureHash: sha256-b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3
✓ Ensured 4 directories
✓ Wrote snapshot: ~/.adhd/agent-mcp/production/adhd-environment.json
```

The snapshot at `~/.adhd/agent-mcp/production/adhd-environment.json` is a JSON file with all resolved config, directory paths, fieldSchema, provenance, envVars, and hashes. Samira checks in `adhd.environment.yaml` to her repo. The snapshot is machine-local and NOT checked in.

### Flow 2: Samira uses the environment at runtime

Now Samira wants to use the snapshot in her agent-mcp code. She imports `Environment` and reads values.

#### Step 2a: Import and construct

```typescript
// agent-mcp/src/main.ts
import { Environment } from '@adhd/environment';

// Read the production snapshot with full scope cascade
const env = new Environment("agent-mcp", "global", "production");

console.log(`Environment loaded: ${env.project.name}/${env.namespace}`);
console.log(`Config hash: ${env.hash}`);
```

#### Step 2b: Access config values

```typescript
// Config access — all scopes visible with "global" scope parameter
const port = env.get("config.server.port");           // 3000
const dbPath = env.get("config.db.path");              // "/Users/nix/.adhd/agent-mcp/production/data/primary/"
const logLevel = env.get("config.log.level");          // "info" (system-scoped, visible in "global" scope)
const logFormat = env.get("config.log.format");        // "json" (global-scoped, visible in "global" scope)
const openaiModel = env.get("config.providers.openai.model");  // "gpt-4o" (project-scoped, visible in "global" scope)
```

Scope filtering: the `"global"` scope on the constructor means Samira sees `system` + `global` + `project` values. If she passes `"project"`, system-scoped values like `log.level` would return `undefined`:

```typescript
const projectEnv = new Environment("agent-mcp", "project", "production");
projectEnv.get("config.log.level");       // undefined (system-scoped, filtered out)
projectEnv.get("config.server.port");     // 3000 (project-scoped, visible)
```

#### Step 2c: Access directory paths

```typescript
const dbDir = env.get("path.db");                    // by name
// → "/Users/nix/.adhd/agent-mcp/production/data/primary/"

const registryDir = env.get("path.state.data.registry");  // by type + name
// → "/Users/nix/.adhd/agent-mcp/production/data/registry/"

const logDir = env.get("path.runtime.log");          // by type
// → "/Users/nix/.adhd/agent-mcp/production/log/"

// Bracket shorthand
console.log(env["path.db"]);  // same as env.get("path.db")
```

#### Step 2d: Access env vars

```typescript
// Env vars recorded in the snapshot
const openaiKey = env.get("env.OPENAI_API_KEY");
// → resolved value from snapshot (or empty string if not set)

const anthropicKey = env.get("env.ANTHROPIC_API_KEY");
// → resolved value from snapshot
```

#### Step 2e: Access metadata

```typescript
console.log(env.hash);        // "sha256-a1b2c3..."
console.log(env.version);     // { configHash, structureHash, generatedAt, libraryVersion }
console.log(env.project);     // { name: "agent-mcp", description: "ADHD Agent MCP Server" }
console.log(env.prefix);      // "ADHD_AGENT_MCP_PRODUCTION_"
console.log(env.namespace);   // "production"
```

#### Step 2f: Access provenance

```typescript
const dbSource = env.get("provenance.db.path");
// → { source: "project.default", scope: "project" }

const logLevelSource = env.get("provenance.log.level");
// → { source: "system.default", scope: "system" }

const openaiSource = env.get("provenance.providers.openai.secret");
// → { source: "project.default", scope: "project", env: "OPENAI_API_KEY" }
```

#### Step 2g: Error cases

```typescript
// Snapshot doesn't exist yet → throws
const env = new Environment("nonexistent", "global", "production");
// → Error: Snapshot not found: ~/.adhd/nonexistent/production/adhd-environment.json.
//   Run 'adhd-env build' first.

// Different namespace
const stagingEnv = new Environment("agent-mcp", "global", "staging");
stagingEnv.get("config.server.port");
// → reads from ~/.adhd/agent-mcp/staging/adhd-environment.json
// → if that snapshot doesn't exist: throws
```

#### Step 2h: Full startup example

```typescript
// agent-mcp/src/main.ts — complete runtime integration
import { Environment } from '@adhd/environment';

function main() {
  const env = new Environment("agent-mcp", "global", "production");

  console.log(`[agent-mcp] Environment loaded: ${env.project.name}/${env.namespace}`);
  console.log(`[agent-mcp] Config hash: ${env.hash}`);
  console.log(`[agent-mcp] DB path: ${env.get("config.db.path")}`);
  console.log(`[agent-mcp] Server starting on port ${env.get("config.server.port")}`);

  // Use values to configure the app
  const server = startServer({
    port: Number(env.get("config.server.port")),
    dbPath: String(env.get("config.db.path")),
    logLevel: String(env.get("config.log.level")),
    logFormat: String(env.get("config.log.format")),
    transportKind: String(env.get("config.transport.kind")),
  });

  // Provider setup
  const openaiKey = String(env.get("env.OPENAI_API_KEY"));
  if (openaiKey) {
    configureOpenAI(openaiKey, String(env.get("config.providers.openai.model")));
  }

  server.listen();
}
```

### Flow 3: Luca consumes the project and overrides config for his scope

Luca installs agent-mcp into his deployment. He needs to override the database path (different mount) and set his OpenAI key, but keep everything else at Samira's defaults.

#### Step 3a: Luca edits the YAML with only his overrides

Luca opens the `adhd.environment.yaml` from the agent-mcp repo and changes only the fields he needs to override. He focuses on the `project` scope section because project-scoped config is per-deployment:

```yaml
# adhd.environment.yaml — Luca's edits shown in comments
project:
  name: agent-mcp
  # ... (unchanged from Samira's original)
config:
  project:
    # Luca's override: different database mount
    db.path:
      default: /mnt/ssd/agent-mcp/agents.db
      type: path

    # Luca adds his OpenAI key via env (not in YAML — he sets OPENAI_API_KEY in his shell)
    # providers.openai.secret: unchanged — reads from OPENAI_API_KEY at build time

    # Everything else: Luca doesn't touch. Samira's defaults stay.
    # server.port: stays "3000"
    # server.maxDepth: stays "5"
    # providers.openai.model: stays "gpt-4o"
```

Key point: Luca does NOT copy the entire YAML. He edits only the fields he needs to override. The YAML file he edits IS Samira's file — the same file in the repo. Overrides are in-place edits.

#### Step 3b: Luca builds with project scope

```bash
$ adhd-env build --scope project --namespace production
```

Output:

```
✓ Read adhd.environment.yaml (project: agent-mcp, namespaces: development,staging,production)
✓ Merged field definitions: 4 system + 2 global + 10 project = 16 total
✓ Inferred env vars: 14/16 inferred, 2 explicit overrides
✓ Loaded 3 .env files
  - ~/.adhd/.env: no changes
  - ./.adhd/.env: no changes
  - ./.env: OPENAI_API_KEY=sk-abc123 (found!)
✓ Resolved 16 config values
  - db.path: /mnt/ssd/agent-mcp/agents.db (project.default override)
  - providers.openai.secret: sk-abc123 (project.env from OPENAI_API_KEY)
  - 14 other values unchanged from defaults
✓ Generated fieldSchema (JSON Schema)
✓ Validated config against fieldSchema — passed
✓ Computed contentHash: sha256-c3d4e5f6...
✓ Computed structureHash: sha256-d4e5f6a7...
✓ Ensured 4 directories
✓ Wrote snapshot: ~/.adhd/agent-mcp/production/adhd-environment.json
```

#### Step 3c: The resulting snapshot shows Luca's overrides + Samira's defaults

```json
{
  "config": {
    "db": {
      "path": "/mnt/ssd/agent-mcp/agents.db"
    },
    "registry": {
      "path": "/Users/luca/.adhd/agent-mcp/registry.db"
    },
    "server": {
      "port": 3000,
      "allowedAgents": ""
    },
    "providers": {
      "openai": {
        "secret": "sk-abc123",
        "baseUrl": "",
        "model": "gpt-4o"
      }
    }
  },
  "provenance": {
    "db.path":                 { "source": "project.default", "scope": "project" },
    "registry.path":           { "source": "project.default", "scope": "project" },
    "server.port":             { "source": "project.default", "scope": "project" },
    "providers.openai.secret": { "source": "project.env",     "scope": "project", "env": "OPENAI_API_KEY" },
    "providers.openai.model":  { "source": "project.default", "scope": "project" }
  }
}
```

Luca's `db.path` → `/mnt/ssd/agent-mcp/agents.db` (his override in the YAML).
Samira's `server.port` → `3000` (her original default, unchanged).
Luca's `openai.secret` → `sk-abc123` (from `.env` file, not in YAML at all).

#### Step 3d: Provenance tells the story

```typescript
// Luca's code — checking where values came from
const provenance = env.get("provenance.db.path");
// → { source: "project.default", scope: "project" }
// "project.default" means Luca's YAML default — his override won

const serverProv = env.get("provenance.server.port");
// → { source: "project.default", scope: "project" }
// This was Samira's original default — Luca didn't override it
```

### Flow 4: Luca integrates the project at runtime

Luca writes his runtime code. It's identical to Samira's code in Flow 2 — the same `Environment` constructor, the same `get()` calls. The only difference is the scope parameter:

#### Step 4a: Luca's runtime code

```typescript
// Luca's deployment code — identical shape to Samira's
import { Environment } from '@adhd/environment';

const env = new Environment("agent-mcp", "project", "staging");

// What Luca gets:
env.get("config.db.path");                            // "/mnt/ssd/agent-mcp/agents.db"
env.get("config.server.port");                        // 3000
env.get("config.providers.openai.secret");            // "sk-abc123"
env.get("config.log.level");                          // undefined (system-scoped, filtered by "project" scope)

// With full cascade:
const fullEnv = new Environment("agent-mcp", "global", "staging");
fullEnv.get("config.log.level");                      // "info" (system-scoped, visible)
fullEnv.get("config.db.path");                        // "/mnt/ssd/agent-mcp/agents.db"

// Provenance — Luca can trace every value
env.get("provenance.db.path");
// → { source: "project.default", scope: "project" } (Luca's override)

env.get("provenance.server.port");
// → { source: "project.default", scope: "project" } (Samira's original, unchanged)

env.get("provenance.providers.openai.secret");
// → { source: "project.env", scope: "project", env: "OPENAI_API_KEY" } (Luca's env var)
```

#### Step 4b: Different namespace — staging vs production

```typescript
// Staging environment
const stagingEnv = new Environment("agent-mcp", "project", "staging");
stagingEnv.get("config.server.port");   // 3000 (same defaults, different namespace)

// Production environment
const prodEnv = new Environment("agent-mcp", "project", "production");
prodEnv.get("config.server.port");     // 3000

// Each reads from its own snapshot:
// staging: ~/.adhd/agent-mcp/staging/adhd-environment.json
// production: ~/.adhd/agent-mcp/production/adhd-environment.json
```

#### Step 4c: How Luca reasons about the system

Luca needs to know: "Is this value what Samira intended, or did I override it?" He can:

1. Look at `env.get("provenance.<field>")` — the `source` and `scope` tell him the cascade tier
2. Run `adhd-env status --project agent-mcp --namespace staging` to see a summary
3. Run `adhd-env diff --project agent-mcp --against-file /tmp/samiras-snapshot.json` to compare against Samira's original snapshot

```bash
$ adhd-env diff --project agent-mcp --namespace staging --against-file /tmp/samiras-original.json
```

Output:

```
✓ Compared agent-mcp/staging against /tmp/samiras-original.json
  Differences found: 2

  db.path:
    Samira's: /Users/samira/.adhd/agent-mcp/agents.db
    Luca's:   /mnt/ssd/agent-mcp/agents.db
    Source:   project.default (override in adhd.environment.yaml)

  providers.openai.secret:
    Samira's: (empty)
    Luca's:   sk-abc***
    Source:   project.env (OPENAI_API_KEY set in local environment)
```

---

## `adhd.environment.yaml` Format

The single source of truth. Checked into the project repo. Read by `adhd-env build`.

### Complete reference

```yaml
# adhd.environment.yaml — checked into repo
# This is the complete schema. All fields except project.name and envPrefix are optional.

project:
  name: agent-mcp                    # Required. kebab-case project name.
  description: ADHD Agent MCP Server  # Optional. Human-readable description.
  envPrefix: ADHD_AGENT_MCP          # Required. Uppercase prefix for env var inference.

namespaces:                          # Optional. If absent, only "default" is available.
  - development
  - staging
  - production

dirs:                                # Optional. If absent, no directories are registered.
  - name: primary                    # Optional. Name disambiguator for type-first lookups.
    type: state.data                 # Required. Dot-path directory type.
    scope: project                   # Required. "system" | "global" | "project".
    description: Main SQLite database  # Optional.
  - name: registry
    type: state.data
    scope: project
    description: Agent registry DB
  - type: runtime.log                # No name — accessed by type only.
    scope: project
    description: Application logs
  - type: runtime.pid
    scope: project
    description: PID files

config:
  system:                            # Framework-shipped defaults. Rarely changed.
    log.level:
      default: info                  # Required. Default value (always a string in YAML).
      type: string                   # Optional. "string" | "integer" | "number" | "boolean" | "path".
      enum: [debug, info, warn, error]  # Optional. Allowed values.
    server.maxDepth:
      default: "5"                   # String in YAML, cast to integer by builder.
      type: integer
      minimum: 1                     # Optional.
    server.maxToolLoops:
      default: "50"
      type: integer
      minimum: 1
    queue.concurrency:
      default: "5"
      type: integer
      minimum: 1

  global:                            # Org-wide defaults. Shared across ALL ADHD projects.
    log.format:
      default: json
      type: string
      enum: [json, pretty]
    transport.kind:
      default: stdio
      type: string
      enum: [stdio, sse, http]

  project:                           # Project-specific. Paths, ports, secrets.
    db.path:
      default: ${HOME}/.adhd/agent-mcp/agents.db
      type: path
    registry.path:
      default: ${HOME}/.adhd/agent-mcp/registry.db
      type: path
    server.port:
      default: "3000"
      type: integer
      minimum: 1024
      maximum: 65535
    server.allowedAgents:
      default: ""
      type: string
    providers.openai.secret:
      default: ""
      type: string
      env: OPENAI_API_KEY            # Optional. Override inferred env var name.
    providers.openai.baseUrl:
      default: ""
      type: string
    providers.openai.model:
      default: gpt-4o
      type: string
    providers.anthropic.secret:
      default: ""
      type: string
      env: ANTHROPIC_API_KEY         # Optional. Override inferred env var name.
    providers.anthropic.model:
      default: claude-sonnet-4-20250514
      type: string
    providers.deepseek.secret:
      default: ""
      type: string
    providers.deepseek.model:
      default: ""
      type: string
```

### Field definition reference

| YAML key | Required | Type | Description |
|---|---|---|---|
| `default` | **Yes** | `string` | Default value when env var is unset. May contain `${VAR}` references. Always a string in YAML — the builder casts based on `type`. |
| `env` | No | `string` | Env var name override. When absent, inferred from `envPrefix` + field path. When present, completely replaces inferred name. |
| `type` | No | `string` enum | `"string"`, `"integer"`, `"number"`, `"boolean"`, `"path"`. Drives coercion and validation. |
| `minimum` | No | `number` | Minimum value (integer/number types only). |
| `maximum` | No | `number` | Maximum value (integer/number types only). |
| `enum` | No | `string[]` | Allowed values. Matches after type coercion. |
| `pattern` | No | `string` | Regex pattern (string type only). |
| `minLength` | No | `number` | Minimum string length. |
| `maxLength` | No | `number` | Maximum string length. |

### Env var inference rules

When `env` is omitted from a field definition, the effective env var name is inferred:

```
inferEnvVar("ADHD_AGENT_MCP", "db.path")
  → split: ["db", "path"]
  → uppercase: ["DB", "PATH"]
  → join: "DB_PATH"
  → prepend: "ADHD_AGENT_MCP_DB_PATH"
```

The `env` property is an **override**, not a fallback. When set, it completely replaces the inferred name:

```
providers.openai.secret:
  env: OPENAI_API_KEY    # Effective env var: "OPENAI_API_KEY"
                          # Inferred name "ADHD_AGENT_MCP_PROVIDERS_OPENAI_SECRET" is never checked
```

### YAML type coercion

All `default` values in YAML are strings. The builder coerces based on `type`:

| `type` | YAML value | Resolved value | Notes |
|---|---|---|---|
| `string` | `"hello"` | `"hello"` | Passed through |
| `integer` | `"3000"` | `3000` | `parseInt()`, must be valid |
| `integer` | `"5"` | `5` | |
| `number` | `"3.14"` | `3.14` | `parseFloat()` |
| `boolean` | `"true"` | `true` | `"true"`/`"false"` (case-insensitive) |
| `path` | `"${HOME}/.adhd/db"` | `"/Users/nix/.adhd/db"` | Interpolated, no trailing slash added |
| _(none)_ | `"hello"` | `"hello"` | Treated as string |

---

## CLI Commands

The `adhd-env` CLI (apigen-generated from `environment-cli/src/api.ts`) wraps the builder package.

```
adhd-env init --generate-config                  → writes starter adhd.environment.yaml
adhd-env build                                    → reads YAML, writes snapshot (namespace: "default")
adhd-env build --namespace staging                 → builds for specific namespace
adhd-env build --scope project                     → builds only project-scoped values (still writes full snapshot)
adhd-env status --project agent-mcp --namespace production
adhd-env verify --project agent-mcp
adhd-env doctor --project agent-mcp --yes
adhd-env config-get --project agent-mcp --field db.path
adhd-env config-set --project agent-mcp --field db.path --value /new/path
adhd-env export --project agent-mcp --out-file /tmp/snap.json
adhd-env diff --project agent-mcp --against-file /tmp/old.json
adhd-env diff --project agent-mcp --namespace staging --against-file /tmp/baseline.json
```

### `init --generate-config`

Writes a starter `adhd.environment.yaml` to the current directory. If the file already exists, exits with a warning (no overwrite).

```
adhd-env init --generate-config
```

The generated YAML includes:
- `project.name` derived from `package.json` name (or directory name)
- `project.envPrefix` derived from project name via `projectEnvPrefix()`
- Two default namespaces: `development`, `production`
- Four default directories: `state.data` (named "data"), `runtime.log`, `runtime.cache`, `runtime.pid`
- Three default config fields: `log.level` (system), `log.format` (global), `server.port` (project)

### `build`

Reads `adhd.environment.yaml` from the current directory, runs the full builder pipeline, and writes the snapshot atomically.

```
adhd-env build [--namespace <name>] [--scope <system|global|project>] [--config <path>] [--dry-run]
```

Options:
- `--namespace`: defaults to `"default"`. Snapshot goes to `~/.adhd/<project>/<namespace>/adhd-environment.json`.
- `--scope`: defaults to full cascade. When set, only values from that scope are written to the snapshot's `config` section. (Provenance and envVars always include all scopes.)
- `--config`: path to YAML file (default: `./adhd.environment.yaml`).
- `--dry-run`: validate and print summary without writing.

### `status`

```
adhd-env status --project agent-mcp [--namespace production]
```

Prints:
- Project name, namespace, snapshot path
- Config hash, structure hash
- Number of config fields (by scope), directories
- Whether snapshot exists and is valid
- Library version that produced it

### `verify`

```
adhd-env verify --project agent-mcp [--namespace production] [--strict]
```

Verifies:
- Snapshot file exists and is valid JSON
- All directories in the snapshot exist on disk
- Optional `--strict`: also checks for extra directories not in the snapshot

### `doctor`

```
adhd-env doctor --project agent-mcp [--namespace production] [--yes]
```

Fixes:
- Missing directories (recreates them)
- Prints what was fixed vs what couldn't be fixed

### `config-get`

```
adhd-env config-get --project agent-mcp --field db.path [--namespace production]
```

Reads a single config value from the snapshot and prints it.

### `config-set`

```
adhd-env config-set --project agent-mcp --field db.path --value /new/path [--namespace production]
```

Writes the override to the project's `.adhd/.env` file and triggers a rebuild:

1. Parse `field` to get env var name (from field definition or inferred)
2. Write `ENV_VAR_NAME=new_value` to `.adhd/.env` (or update existing line)
3. Re-run `adhd-env build` to produce new snapshot

### `export`

```
adhd-env export --project agent-mcp [--namespace production] --out-file /tmp/snap.json
```

Copies the snapshot JSON to the specified file. Useful for sharing snapshots between machines for comparison.

### `diff`

```
adhd-env diff --project agent-mcp [--namespace production] --against-file /tmp/old.json
```

Compares two snapshots. Shows:
- Config values that differ (field-by-field)
- Directories that differ (added, removed, type change)
- Provenance differences
- Hash differences

---

## Builder Package Architecture

The builder is an internal engine, NOT a user-facing API. It lives in `packages/environment/environment-builder/` and is consumed only by the CLI.

### Package structure

```
packages/environment/environment-builder/
  package.json
  tsconfig.json
  project.json            (nx target: build)
  src/
    index.ts              — exports buildSnapshot(spec, options) → EnvironmentSnapshot
    yaml-parser.ts        — parseYamlSpec(filePath) → ParsedYamlSpec
    field-merge.ts        — mergeFieldDefinitions(system, global, project) → ConfigFieldMap
    config-resolver.ts    — resolveConfig(fields, options) → ResolvedConfig
    json-schema-gen.ts    — generateFieldSchema(fields) → JSONSchema
    provenance.ts         — trackProvenance(resolved) → Record<string, ProvenanceEntry>
    validation.ts         — validateConfig(config, schema) → void | ValidationError[]
    snapshot-writer.ts    — writeSnapshotAtomic(path, snapshot) → string
    __tests__/            — unit tests for each module
```

### `buildSnapshot()` pipeline

```
buildSnapshot(spec: ParsedYamlSpec, options: BuildOptions) → EnvironmentSnapshot
```

1. **Parse YAML** — read `adhd.environment.yaml`, validate structure against internal schema.
2. **Validate project identity** — `project.name` must be non-empty kebab-case. `envPrefix` must be non-empty uppercase.
3. **Validate namespaces** — if `--namespace` is specified, confirm it's in the list (warn if not, allow).
4. **Load .env files** — configurable hierarchy: `~/.adhd/.env` → `./.adhd/.env` → `./.env`
5. **Merge field definitions** — `mergeFieldDefinitions(system, global, project)` → `effectiveFields`
6. **Infer env var names** — for each field without explicit `env`, set `effectiveEnvVar = inferEnvVar(envPrefix, key)`
7. **Resolve config values**:
   - For each field: check `process.env[effectiveEnvVar]` → field's `default`
   - Run `interpolate(value, process.env)` on each resolved value
   - Coerce type based on field's `type` (integer → parseInt, boolean → "true"/"false")
   - Record provenance: `{ source, scope, env }`
8. **Generate fieldSchema** — `generateFieldSchema(effectiveFields)` → JSON Schema object
9. **Validate config** — `ajv.compile(fieldSchema)(config)` → throws with field-level errors on failure
10. **Compute hashes** — `contentHash(resolvedRawConfig)` + `structureHash(directoryEntries)`
11. **Build directory registry** — from `dirs` entries, three roots (system, global, project) with namespace in path
12. **Drift detection** — read on-disk snapshot (if exists), compare:
    - `structureHash` matches → no structural change, proceed
    - New directories → **warn**
    - Directories removed → **warn**
    - Directory types changed → **throw**
    - Directory scope changed → **throw**
    - Project name mismatch → **throw**
13. **Ensure directories** — `mkdir -p` for all registered directories
14. **Collect env vars** — assemble `envVars` map with effective env var name → resolved value
15. **Build snapshot object** — assemble all sections
16. **Atomic write** — `writeSnapshotAtomic(path, snapshot)` — temp file + renameSync
17. **Return snapshot**

### `BuildOptions`

```typescript
export interface BuildOptions {
  /** Path to adhd.environment.yaml (default: "./adhd.environment.yaml") */
  configPath?: string;

  /** Environment namespace (default: "default") */
  namespace?: string;

  /** Scope filter: only write values from this scope to config (default: all) */
  scope?: ConfigScope;

  /** Custom root for ~/.adhd/ (default: os.homedir()/.adhd) */
  adhdRoot?: string;

  /** Custom CWD for project-scoped resolution */
  cwd?: string;

  /** Custom system root (default: /etc/adhd/) */
  systemRoot?: string;

  /** Custom .env file load order */
  envFiles?: string[];

  /** Dry run: validate and print summary without writing */
  dryRun?: boolean;
}
```

---

## Runtime Client API

The runtime `Environment` class in each language is a snapshot reader. ~40-50 lines.

### TypeScript (`@adhd/environment`)

```typescript
export class Environment {
  readonly project: Readonly<ProjectIdentity>;
  readonly namespace: string;
  readonly hash: string;                        // configHash from snapshot
  readonly version: Readonly<EnvironmentSnapshot['version']>;
  readonly prefix: string;                      // namespace-suffixed env prefix
  readonly scope: ConfigScope | undefined;

  /**
   * @param project   Project name (kebab-case)
   * @param scope     Config scope filter. undefined = full cascade.
   * @param namespace Environment namespace (default: "default")
   * @param adhdRoot  Custom ~/.adhd/ root (default: os.homedir()/.adhd)
   */
  constructor(project: string, scope?: ConfigScope, namespace?: string, adhdRoot?: string);

  /**
   * Get a value from the snapshot by dot-path.
   *   "config.*"     → resolved config values (scope-filtered by constructor's scope)
   *   "path.*"       → directory paths (by name, type, or type+name)
   *   "env.*"        → recorded env var values
   *   "provenance.*" → provenance entries
   */
  get(path: string): unknown;

  /** Bracket access — same as get(). */
  [key: string]: unknown;

  /** Private: the full snapshot loaded from disk. */
  private _snapshot: EnvironmentSnapshot;
}
```

### Python (`adhd-environment`)

```python
class Environment:
    def __init__(self, project: str, scope: str | None = None, namespace: str = "default", adhd_root: str | None = None):
        """Read snapshot from ~/.adhd/<project>/<namespace>/adhd-environment.json"""

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

### Rust (`adhd-environment`)

```rust
pub struct Environment {
    // ...private fields...
}

impl Environment {
    pub fn new(project: &str, scope: Option<&str>, namespace: Option<&str>, adhd_root: Option<&Path>) -> Result<Self, EnvironmentError>;

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

### Runtime behavior specifications

| Call | Behavior |
|---|---|
| `new Environment("agent-mcp")` | Reads `~/.adhd/agent-mcp/default/adhd-environment.json`. Throws if missing. |
| `new Environment("agent-mcp", undefined, "production")` | Reads `~/.adhd/agent-mcp/production/adhd-environment.json` |
| `new Environment("agent-mcp", "project", "production")` | Same snapshot, but `get("config.*")` filters to project-scoped values only |
| `env.get("config.db.path")` | Navigates unflattened config object. Returns undefined if scope-filtered out. |
| `env.get("path.db")` | Lookup by name → returns path. Throws if not found. |
| `env.get("path.state.data")` | Lookup by type. If exactly one match → returns path. If multiple → throws with disambiguation. |
| `env.get("path.state.data.registry")` | Lookup by type + name. Returns path. |
| `env.get("env.OPENAI_API_KEY")` | Looks up in snapshot's `envVars` map. Returns string or undefined. |
| `env.get("provenance.db.path")` | Looks up in snapshot's `provenance` map. Returns `{ source, scope, env? }` |
| `env["path.db"]` | Delegates to `env.get("path.db")` |
| `env.hash` | Returns `version.configHash` from snapshot |
| `env.version` | Returns `{ configHash, structureHash, generatedAt, libraryVersion }` |
| `env.project` | Returns `{ name, description? }` from snapshot |
| `env.prefix` | Returns namespace-suffixed prefix: `"ADHD_AGENT_MCP_PRODUCTION_"` |
| `env.namespace` | Returns namespace string (e.g., `"production"`) |
| Stale library version | Print warning but proceed (forward-compatible JSON) |
| Snapshot not found | Throw with path in message + "Run 'adhd-env build' first." |
| Malformed JSON | Throw with path + parse error details |

---

## Package Structure

```
packages/environment/
  environment-base-spec/       — JSON Schema + SPEC.md + cross-language test vectors
  environment-core-node/       — TypeScript runtime client (~50 lines) + snapshot I/O utilities
  environment-builder/         — TypeScript builder engine (CLI's internal machinery)
  environment-cli/             — apigen-generated CLI that wraps the builder
  environment-core-py/         — Python runtime client (~40 lines)
  environment-core-rs/         — Rust runtime client (~50 lines)
```

### Key differences from v0.0.3

| Package | v0.0.3 | v0.0.4 |
|---|---|---|
| `environment-core-node` | Full: `EnvironmentBuilder` + `Environment` runtime | **Thin**: `Environment` runtime only (~50 lines). No builder logic. |
| `environment-builder` | Did not exist | **New**: Internal engine behind `adhd-env build`. YAML parser, field merge, config resolution, validation, hashing, snapshot writing. |
| `environment-cli` | Thin wrapper over `EnvironmentBuilder` | Thin wrapper over `environment-builder`'s `buildSnapshot()`. |
| `environment-core-py` | Full: `EnvironmentBuilder` + `Environment` runtime | **Thin**: `Environment` runtime only (~40 lines). No builder logic. |
| `environment-core-rs` | Full: `EnvironmentBuilder` + `Environment` runtime | **Thin**: `Environment` runtime only (~50 lines). No builder logic. |
| `environment-base-spec` | JSON Schema + contracts | Unchanged shape, updated for YAML input + builder-only validation. |

### Dependency graph

```
environment-base-spec       — zero deps (JSON Schema + test vectors)
environment-core-node       — depends on base-spec (types only)
environment-builder         — depends on base-spec (types) + core-node (snapshot I/O utilities)
environment-cli             — depends on builder (buildSnapshot) + apigen (CLI generation)
environment-core-py         — zero deps (stdlib only)
environment-core-rs         — depends on serde_json only
```

---

## Snapshot Format

The snapshot format at `~/.adhd/<project>/<namespace>/adhd-environment.json` is unchanged from v0.0.3. It's the same JSON Schema, same structure. The only difference is HOW it's produced (CLI builder instead of `EnvironmentBuilder.initialize()`).

```json
{
  "project": { "name": "agent-mcp", "description": "ADHD Agent MCP Server" },
  "namespace": "production",
  "version": {
    "configHash": "sha256-a1b2c3...",
    "structureHash": "sha256-b2c3d4...",
    "generatedAt": "2026-07-06T12:00:00.000Z",
    "libraryVersion": "0.0.4"
  },
  "directories": {
    "state.data/primary": {
      "path": "/Users/nix/.adhd/agent-mcp/production/data/primary",
      "type": "state.data",
      "name": "primary",
      "scope": "project"
    }
  },
  "config": {
    "db": { "path": "/Users/nix/.adhd/agent-mcp/agents.db" },
    "server": { "port": 3000 }
  },
  "fieldSchema": { "type": "object", "properties": { "...": "..." } },
  "provenance": {
    "db.path": { "source": "project.default", "scope": "project" }
  },
  "envPrefix": "ADHD_AGENT_MCP",
  "envVars": {
    "ADHD_AGENT_MCP_PRODUCTION_DB_PATH": "/Users/nix/.adhd/agent-mcp/agents.db"
  }
}
```

---

## Retained from v0.0.3 (unchanged)

Everything not affected by Changes 1-5 is retained:

- Five-package layout under `packages/environment/` (one new: `environment-builder`)
- npm names: `@adhd/environment`, `@adhd/environment-base-spec`, `@adhd/environment-cli`, `adhd-environment` (Py), `adhd-environment` (Rs)
- Three-tier scope cascade (system → global → project)
- Type-first directory identification with optional name disambiguator
- Namespaced environments (namespace in path, snapshot location, env prefix suffix)
- System-scope directory roots (`/etc/adhd/`)
- `contentHash` test vector: `{b:"2",a:"1"}` → `sha256-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08`
- `structureHash` with `type:name:scope\n` format
- Atomic writes (`.tmp` + `renameSync`)
- Drift detection on build (warn on new/removed, throw on type/scope change, namespace conflict)
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
- Full Python + Rust runtime implementations with cross-language parity
- `mergeFieldDefinitions` (system, global, project) — three-input variant
- Path pattern: `<scope_root>/<project>/<namespace>/<type_base>/<name>/`
- Directory types: `state.data`, `state.config`, `runtime.log`, `runtime.cache`, `runtime.pid`, `user.bin`, `user.custom`
- Future client gate: all language clients MUST pass cross-language-test-vectors.json
- Env var inference: `inferEnvVar(prefix, fieldPath)` with optional `env` override
- Scope parameter on `Environment` constructor controls value visibility
- `get()` API: `"config.*"`, `"path.*"`, `"env.*"`, `"provenance.*"` prefixes + bracket access
- `env.hash`, `env.version`, `env.project`, `env.prefix`, `env.namespace` properties
- Minimal runtime: no `.env` loading, no field merge, no validation, no directory creation, no snapshot writing

---

## TypeScript Interfaces

### `EnvironmentSnapshot` (unchanged)

```typescript
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
    type: string;
    name?: string;
    description?: string;
    scope: ConfigScope;
  }>;
  config: Record<string, unknown>;
  fieldSchema?: Record<string, unknown>;
  provenance?: Record<string, ProvenanceEntry>;
  envPrefix: string;
  envVars: Record<string, string>;
}
```

### `ParsedYamlSpec` (new for v0.0.4)

```typescript
export interface ParsedYamlSpec {
  project: {
    name: string;
    description?: string;
    envPrefix: string;
  };
  namespaces?: string[];
  dirs?: DirectoryEntry[];
  config?: {
    system?: Record<string, YamlFieldDefinition>;
    global?: Record<string, YamlFieldDefinition>;
    project?: Record<string, YamlFieldDefinition>;
  };
}
```

### `YamlFieldDefinition` (new for v0.0.4)

```typescript
export interface YamlFieldDefinition {
  default: string;                // always a string in YAML
  env?: string;
  type?: 'string' | 'integer' | 'number' | 'boolean' | 'path';
  minimum?: number;
  maximum?: number;
  enum?: (string | number)[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}
```

### `BuildOptions` (new for v0.0.4)

```typescript
export interface BuildOptions {
  configPath?: string;
  namespace?: string;
  scope?: ConfigScope;
  adhdRoot?: string;
  cwd?: string;
  systemRoot?: string;
  envFiles?: string[];
  dryRun?: boolean;
}
```

### Retained types (unchanged from v0.0.3)

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
  scope: ConfigScope;
  description?: string;
}

export interface ConfigFieldDefinition {
  env?: string;
  default: string;
  scope: ConfigScope;
  type?: FieldType;
  minimum?: number;
  maximum?: number;
  enum?: (string | number)[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

export interface ProvenanceEntry {
  source: ProvenanceSource;
  scope: ConfigScope;
  env?: string;
}
```

---

## Independent Segments (implementation order)

### Segment A: Contract package update

- **Package:** `environment-base-spec`
- **Files:** `spec/adhd-environment.schema.json` (unchanged — snapshot format is the same), `spec/SPEC.md` (update for YAML input + builder-only + thin runtimes), `spec/cross-language-test-vectors.json` (add YAML round-trip vectors)
- **Dependencies:** none
- **Output tokens:** ~1500

### Segment B: Builder package (the engine)

- **Package:** `environment-builder` (NEW)
- **Files:** `package.json`, `tsconfig.json`, `project.json`, `src/index.ts`, `src/yaml-parser.ts`, `src/field-merge.ts`, `src/config-resolver.ts`, `src/json-schema-gen.ts`, `src/provenance.ts`, `src/validation.ts`, `src/snapshot-writer.ts`, `src/__tests__/*`
- **Dependencies:** Segment A (types), `environment-core-node` (snapshot I/O utilities, shared utils like `contentHash`, `inferEnvVar`, `interpolate`, `unflatten`)
- **Output tokens:** ~5000

### Segment C: Runtime clients — thin rewrite

- **Packages:** `environment-core-node`, `environment-core-py`, `environment-core-rs`
- **Changes:**
  - `environment-core-node`: Remove `EnvironmentBuilder` class, `builder.ts`, builder tests. Keep `Environment` (runtime), snapshot I/O, shared utilities. Add YAML-related types.
  - `environment-core-py`: Remove builder logic. Keep `Environment` (runtime). Reduce to ~40 lines.
  - `environment-core-rs`: Remove builder logic. Keep `Environment` (runtime). Reduce to ~50 lines.
- **Dependencies:** Segment A (types)
- **Output tokens:** ~3000 (combined)

### Segment D: CLI package

- **Package:** `environment-cli`
- **Files:** `src/api.ts` (exports for apigen — wrap `buildSnapshot`), `src/lib/core.ts` (wire builder), regenerate CLI
- **Dependencies:** Segment B (builder), Segment C (core-node)
- **Output tokens:** ~1500

### Segment E: Integration tests

- **Files:** Builder integration tests, CLI smoke tests, end-to-end flow tests (all four flows)
- **Dependencies:** Segments A-D
- **Output tokens:** ~4000

---

## Test Cases

### YAML parser

- Parse valid `adhd.environment.yaml` → returns `ParsedYamlSpec`
- Parse YAML with only `project.name` + `envPrefix` → valid (all other sections optional)
- Parse YAML with missing `project.name` → throws
- Parse YAML with missing `project.envPrefix` → throws
- Parse YAML with invalid field type → throws with field path
- Parse YAML with `minimum` on a string field → warns, ignores
- Parse YAML with integer field having non-numeric `default` → throws
- Parse YAML with empty `config: {}` → valid (no config fields)

### Builder pipeline

- `buildSnapshot(spec, { namespace: "production" })` → produces valid snapshot at `~/.adhd/<project>/production/adhd-environment.json`
- `buildSnapshot(spec, { dryRun: true })` → validates everything, prints summary, does NOT write file
- `buildSnapshot(spec, { scope: "project" })` → snapshot config contains only project-scoped values
- Builder resolves `${HOME}` in defaults
- Builder infers env var names for 14/16 fields, uses explicit `env` for 2
- Builder loads `.env` hierarchy and overrides defaults with env var values
- Builder validates config against generated `fieldSchema` — passes for valid
- Builder validates config against generated `fieldSchema` — throws for invalid (e.g., port out of range)
- Builder computes `contentHash` that matches known test vector
- Builder writes provenance with correct source and scope
- Builder writes `envVars` map with effective env var names
- Builder creates all registered directories on disk
- Builder detects drift: warns on new directory
- Builder detects drift: warns on removed directory
- Builder detects drift: throws on type change
- Builder detects drift: throws on scope change
- Builder detects drift: throws on project name mismatch
- Build with non-existent `.env` file in `envFiles` → no error, just skip

### Runtime client (all three languages)

- Constructor reads snapshot from correct path
- Constructor throws when snapshot doesn't exist
- `env.get("config.db.path")` → resolved value
- `env.get("config.log.level")` with `scope: "project"` → `undefined` (filtered out)
- `env.get("config.log.level")` with `scope: "global"` → `"info"` (visible)
- `env.get("path.db")` → directory path by name
- `env.get("path.state.data")` → first/only state.data directory
- `env.get("path.state.data.primary")` → specific named directory
- `env.get("path.state.data")` with 2 entries → throws (ambiguous)
- `env.get("env.OPENAI_API_KEY")` → value from snapshot's `envVars`
- `env.get("provenance.db.path")` → `{ source, scope }`
- `env.hash` → `configHash` string
- `env.version` → `{ configHash, structureHash, generatedAt, libraryVersion }`
- `env.project` → `{ name, description }`
- `env.namespace` → `"production"`
- `env.prefix` → `"ADHD_AGENT_MCP_PRODUCTION_"`
- `env["path.db"]` → same as `env.get("path.db")`
- Corrupt JSON snapshot → throws with path + parse error
- Stale library version → warns, still returns values

### CLI commands

- `adhd-env init --generate-config` → creates valid `adhd.environment.yaml`
- `adhd-env init --generate-config` when file exists → warns, does not overwrite
- `adhd-env build` → exits 0, writes snapshot
- `adhd-env build --dry-run` → exits 0, prints summary, no write
- `adhd-env build --namespace staging` → writes to staging snapshot path
- `adhd-env build --scope project` → writes only project-scoped config
- `adhd-env status --project agent-mcp` → prints status, exits 0
- `adhd-env verify --project agent-mcp` → exits 0 on clean, exits 1 on drift
- `adhd-env doctor --project agent-mcp --yes` → fixes missing dirs, exits 0
- `adhd-env config-get --project agent-mcp --field db.path` → prints value
- `adhd-env config-set --project agent-mcp --field db.path --value /new/path` → writes to `.adhd/.env`, rebuilds
- `adhd-env export --project agent-mcp --out-file /tmp/snap.json` → writes snapshot
- `adhd-env diff --project agent-mcp --against-file /tmp/old.json` → prints diff

### End-to-end flows

- **Flow 1:** Samira generates YAML, edits it, builds → snapshot exists at correct path with all fields, she accesses at runtime
- **Flow 2:** Samira imports `Environment`, calls `get()` for config, paths, env vars, provenance — all return correct values
- **Flow 3:** Luca edits YAML (changes only `db.path`), sets `OPENAI_API_KEY` in `.env`, builds → snapshot shows his override + Samira's unchanged `server.port` + his env var
- **Flow 4:** Luca's runtime code is identical to Samira's — `new Environment("agent-mcp", "project", "staging")` → `get("config.db.path")` returns his override, `get("config.server.port")` returns Samira's default, provenance shows the source for each

### Cross-language parity

- `contentHash({ b: "2", a: "1" })` → identical in TS, Python, Rust
- `inferEnvVar("ADHD_AGENT_MCP", "db.path")` → identical in TS, Python, Rust
- `generateFieldSchema(fields)` → identical JSON Schema in TS, Python, Rust
- All three runtimes produce identical `get()` results from the same snapshot

---

## Edge Cases

| Case | Behavior |
|---|---|
| YAML file has `config: {}` (no sections) | Builder works — empty config. Snapshot has `config: {}`. |
| YAML file has no `dirs` section | Builder works — no directories. Snapshot has `directories: {}`. |
| Field has `env: ""` (empty string) | Empty string IS the env var name. Builder checks `process.env[""]` which is always undefined → uses default. |
| Field has `env: "OPENAI_API_KEY"` | Override wins completely. Inferred name is never checked. |
| `envPrefix` is empty string | `inferEnvVar("", "db.path")` → `"_DB_PATH"` |
| `inferEnvVar` with empty field path | Returns `prefix` (no trailing underscore) |
| Build with no .env files present | All fields use their defaults. No error. |
| Build when target directory is read-only | Throws with path + permission error |
| Build with `--namespace` not in `namespaces` list | Warn but allow (advisory, not hard gate) |
| `get("path.state.data")` with multiple state.data dirs | Throws — ambiguous, provide name for disambiguation |
| `get("path.unknown")` | Throws — directory not found |
| `get("config.nonexistent")` | Returns `undefined` |
| `get("env.NONEXISTENT")` | Returns `undefined` |
| Snapshot written by older library version | Warn on `libraryVersion` mismatch, attempt to read (forward-compatible JSON) |
| Runtime `Environment` with `scope: "system"` | Returns only system-scoped config values. Global and project are `undefined`. |
| `adhd-env build` when `.tmp` file from crashed previous build exists | Overwrite `.tmp`, then renameSync. Atomicity preserved. |

---

## Migration Targets (future — separate plans)

- `entrypoint/agent-mcp` — create `adhd.environment.yaml`, replace `config.ts` + `load-env.ts` with `adhd-env build` + `Environment` runtime
- `packages/agent/agent-engine-compiler` — replace ad-hoc env with `Environment`
- `packages/agent/agent-store-prompts` — replace ad-hoc env
- `packages/agent/agent-store-tools` — replace ad-hoc env
- `packages/agent/agent-core-policy` — replace ad-hoc env
- `packages/agent/agent-core-provider` — replace ad-hoc env

## Related Documents

- `docs/plan/adhd-environment/SPEC_0.0.3.md` — superseded spec (TS/JSON static spec, `EnvironmentBuilder` in all languages)
- `docs/plan/adhd-environment/SPEC_0.0.2.md` — superseded spec (monolith Environment, explicit env vars, wrong scope assignments)
- `docs/plan/adhd-environment/SPEC_0.0.1.md` — superseded spec (global→project cascade, name-first dirs, no namespace)
- `docs/plan/adhd-environment/SPEC_0.0.0.md` — original spec (Zod, no fieldSchema, no provenance)
- `docs/plan/adhd-environment/SCOPE.md` — scope boundaries, verification criteria
- `docs/plan/adhd-environment/TOOLS.md` — capability inventory, interface contracts
- `docs/plan/adhd-environment/USE_CASES.md` — concrete use cases with inputs and expected outputs
- `docs/plan/adhd-environment/CURRENT_CONFIG_PATTERNS.md` — real entrypoint config patterns today
- `BACKLOG.md` §FEAT-ENV-001 — backlog entry
