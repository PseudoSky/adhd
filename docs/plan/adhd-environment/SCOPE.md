# SCOPE — adhd-environment v0.0.5

> Derived from SPEC_0.0.4.md (1,524-line architect spec, 2026-07-06) and amendments per v0.0.5.
> Plan type: **build** — greenfield package family (6 packages) + refactor of `entrypoint/agent-mcp` as demonstration.

## 1. Outcomes

A concrete, falsifiable user-visible end-state:

- `npx nx build environment-builder` produces a working `@adhd/environment-builder` package — the internal engine that `adhd-env` calls
- `npx nx build environment-cli` produces `@adhd/environment-cli` with a generated CLI that has exactly 9 commands (`init`, `build`, `set`, `status`, `verify`, `doctor`, `config-get`, `export`, `diff` — the authoritative surface is `interfaces-architect.md` §6.1)
- `adhd-env init --generate-config` writes a starter `adhd.environment.yaml` to the current directory
- `adhd-env build` reads `adhd.environment.yaml`, resolves config from env vars + `adhd-env set` values, merges scopes, generates `fieldSchema`, validates, and writes `~/.<org>/<project>/<namespace>/adhd-environment.json` atomically
- `adhd-env build --namespace staging` produces a separate fully-nested snapshot for the staging namespace
- `adhd-env set providers.openai.secret sk-test-openai-key --namespace production` writes a secret via the CLI (no `.env` file)
- `npx nx build environment-core-node` produces `@adhd/environment` — a typed runtime client that reads a snapshot and exposes `env.get("config.*")`, `env.get("path.*")`, `env.get("env.*")`, `env.get("provenance.*")`, bracket access, `env.hash`, `env.version`
- `new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" })` produces a correctly-typed env object — `env.get("config.transport.port")` returns `number`, `env.get("config.db.path")` returns `string` (agent-mcp's real port field is `transport.port`/`sse.port`; `server.*` holds `maxDepth`/`maxToolLoops`/etc. — see CURRENT_CONFIG_PATTERNS.md field table, authoritative)
- Python and Rust runtime clients each pass the contract test vector and provide the same typed `get()` API (~40-50 lines each)
- **agent-mcp refactored:** `entrypoint/agent-mcp/src/config.ts` (299 lines) replaced with `adhd.environment.yaml` + `new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" })` + `env.get()` calls
- `contentHash({ b: "2", a: "1" })` returns exactly `"sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930"` in all three languages
- `build(ProjectConfig)` returns an `EnvironmentSnapshot<{ data }>` instance with `.set(key, value)`, `.get(key)`, `.configPath`, `.write()` methods
- All 6 packages pass their respective test suites (`nx test`, `pytest`, `cargo test`)

## 2. Scope Boundaries

### In scope

- **6 packages** under `packages/environment/`:
  - `environment-base-spec` — JSON Schema, SPEC.md, cross-language test vectors
  - `environment-builder` — builder engine: YAML parser, field merge, config resolution, fieldSchema generation, provenance, validation, snapshot writer, `EnvironmentSnapshot` class with `.set()`, `.get()`, `configPath`, `.write()`
  - `environment-core-node` — typed TypeScript runtime client (~50 lines)
  - `environment-cli` — apigen-generated CLI at `entrypoint/environment-cli/` wrapping the builder engine
  - `environment-core-py` — thin Python runtime client (~40 lines)
  - `environment-core-rs` — thin Rust runtime client (~50 lines)
- YAML-based static spec (`adhd.environment.yaml`) with human-writable structure
- **No `.env` file** — secrets and config values set via `adhd-env set` command, stored in the builder's internal store
- `adhd.environment.yaml` project config:
  - `name` — project name (kebab-case)
  - `orgNamespace` — org namespace, defaults to `"adhd"`, feeds directory path: `~/.<org>/<project>/`
  - `envPrefixOverride` — optional, overrides the inferred env prefix; when absent, prefix is inferred from project name
- Env var prefix inference: project name → `ADHD_<PROJECT>` (uppercase, dots→underscores); e.g. `"agent-mcp"` → `"ADHD_AGENT_MCP"`
- Directory structure: `~/.<orgNamespace>/<projectName>/<namespace>/adhd-environment.json`
  - `~/.adhd/agent-mcp/production/adhd-environment.json` (org=`adhd`, ns=`production`)
  - `~/.adhd/agent-mcp/default/adhd-environment.json` (no namespaces listed in YAML → defaults to `"default"`)
- `namespaces` field in YAML is optional; when absent, namespace defaults to `"default"`
- When `namespaces` IS listed (e.g. `[production, staging]`), only those namespaces are valid — no automatic `"default"`
  - **No "default" namespace directory** — if no namespace is specified, no namespace level in path
- Namespaces create fully-nested directory trees: each namespace gets its own complete subdirectory hierarchy
- Three-tier scope cascade: system → global → project, with field-level inheritance
- `generateFieldSchema()` — auto-generates JSON Schema from merged field definitions
- Cross-language validation via JSON Schema (ajv / jsonschema / jsonschema crate)
- Provenance tracking: every resolved config key traces back to its source
- Directory types with type-primary lookup, optional name disambiguation
- `contentHash`, `structureHash` (with scope in line format), atomic writes
- Drift detection, `${VAR}` interpolation, `unflatten`
- apigen-generated CLI with exactly 9 commands: init, build, set, status, verify, doctor, config-get, export, diff
  - **Deprecated / out of scope (v0.0.5):** `config-remap` and `config-hash` — earlier drafts listed these, but the authoritative apigen surface (`interfaces-architect.md` §6.1) defines 9 commands and does not include them. They are not implemented in this plan.
- `EnvironmentSnapshot<{ data }>` class:
  - `build(ProjectConfig | EnvironmentSnapshot)` — static/exported function, returns `EnvironmentSnapshot`
  - `.set(path, value)` — set a config value in the snapshot
  - `.get(path)` — get a config value from the snapshot
  - `.configPath` — the path to the snapshot file on disk
  - `.write()` — atomically persist the snapshot to disk
- `Environment` runtime constructor takes a **params object**:
  ```typescript
  new Environment<ConfigType>({
    project: "agent-mcp",
    scope: "global",        // optional
    namespace: "production", // optional
    adhdRoot: ADHD_HOME     // optional
  })
  ```
- `Environment` is **typed**: `env.get("config.db.path")` returns the correct TypeScript type based on the field definitions

### In scope — agent-mcp refactor

- Replace `entrypoint/agent-mcp/src/config.ts` (299 lines) with:
  - `adhd.environment.yaml` — the project's static spec
  - Runtime: `new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" })` + `env.get()` calls
  - Drop: `load-env.ts`, `PROVIDER_DEFAULTS`, `rawFromEnv()`, `configSchema`, `deepFreeze()`, `resolveEnvRef()`, `verifyEnvRefs()`, `subprocessEnv()`
- Preserve: `getProviderConfig()` logic (provider credential resolution) — moves to a thin wrapper over `env.get("config.providers.*")` + `env.get("env.*")`
- Preserve: `isEnvNameAllowed()` security guard — stays, reads prefix from `env.prefix`

### Out of scope

- Migration of other entrypoints (dispatch-cli, apigen-cli, decompile-cli, agent-engine-compiler) — separate plans
- Runtime `register()` for directories — constructor-only (or in this case, YAML-only)
- Recursive `${VAR}` expansion — single-level only
- Concurrent access guards — last-write-wins
- Production-grade npm distribution beyond the monorepo
- Any Zod integration — fully removed at v0.0.1
- `.env` file loading — replaced by `adhd-env set` command

## 3. Constraints / Assumptions

### Non-negotiable constraints

| Constraint | Source |
|---|---|
| Static spec is YAML, not TypeScript/JSON | stakeholder decision (v0.0.4) |
| CLI is the sole interface for `set` and `build` | stakeholder decision (v0.0.5) |
| No `.env` file — config values stored via `adhd-env set` | stakeholder decision (v0.0.5) |
| Runtime clients are thin — read snapshot, expose typed `get()`, bracket access, `hash`, `version` | stakeholder decision (v0.0.4) |
| Env vars inferred by convention — `env` is optional override in field definition | stakeholder decision (v0.0.3) |
| `envPrefixOverride` replaces inferred prefix; `orgNamespace` defaults to "adhd" | stakeholder decision (v0.0.5) |
| Three-tier scope cascade: system → global → project | stakeholder decision (v0.0.2) |
| Directory type-primary lookup with optional name disambiguation | stakeholder decision (v0.0.2) |
| Namespaced environments create fully-nested directory trees | stakeholder decision (v0.0.5) |
| Namespace defaults to `"default"` when `namespaces` absent from YAML | stakeholder decision (v0.0.5) |
| Zero Zod — validation keywords in field definitions, JSON Schema auto-generated | stakeholder decision (v0.0.1) |
| Cross-language validation via JSON Schema + native validators | stakeholder decision (v0.0.1) |
| Full Python + Rust implementations (not stubs) | stakeholder decision (v0.0.1) |
| `contentHash` test vector is the cross-language gate | v0.0.0 |
| Atomic snapshot writes | v0.0.0 |
| Drift detection on `build()` — warn on new/removed dirs, throw on type/scope change, throw on namespace conflict | v0.0.0 |
| Apigen-generated CLI with scalar-param-only exports | v0.0.0 |
| `<group>-<layer>-<name>` monorepo convention | monorepo convention |
| Class name `Environment` (not `AdhdEnvironment`) | stakeholder decision |
| npm name `@adhd/environment` | stakeholder decision |
| `Environment` constructor takes params object (not positional args) | stakeholder decision (v0.0.5) |
| `Environment` is typed — `get()` returns correct TypeScript type per field | stakeholder decision (v0.0.5) |
| `EnvironmentSnapshot` instance has `.set()`, `.get()`, `.configPath`, `.write()` | stakeholder decision (v0.0.5) |

### Assumptions

- Node.js ≥18 (uses `node:crypto`, ES modules)
- Python ≥3.10 (with `jsonschema`)
- Rust stable (with `serde`, `serde_json`, `sha2`, `jsonschema` crate)
- Nx monorepo with TypeScript composite builds
- `~/.<orgNamespace>/` is the canonical data root (default `~/.adhd/` for org `"adhd"`, overridable via `ADHD_HOME`)
- `yaml` npm package for YAML parsing in the builder engine
- `${VAR}` interpolation is single-level only (unresolved vars kept as literal)

## 4. Prior Decisions

All non-negotiable — derived from the five spec revisions:

| Decision | Introduced | Type |
|---|---|---|
| Six packages: base-spec, builder, core-node, core-py, core-rs, cli | v0.0.4 | non-negotiable |
| YAML static spec, CLI as sole builder and setter | v0.0.4/v0.0.5 | non-negotiable |
| `EnvironmentSnapshot` with `.set()`, `.get()`, `.configPath`, `.write()` | v0.0.5 | non-negotiable |
| No `.env` file — values stored via `adhd-env set` | v0.0.5 | non-negotiable |
| `orgNamespace` defaults to "adhd", feeds directory path | v0.0.5 | non-negotiable |
| `envPrefixOverride` replaces `envPrefix`, inferred from project name when absent | v0.0.5 | non-negotiable |
| Namespace defaults to `"default"` when `namespaces` absent from YAML | v0.0.5 | non-negotiable |
| Namespaces create fully-nested directory trees | v0.0.5 | non-negotiable |
| `Environment` constructor takes params object | v0.0.5 | non-negotiable |
| `Environment` is typed — `get()` returns correct TypeScript type | v0.0.5 | non-negotiable |
| Thin runtime clients (~40-50 lines) — no builder logic in any language | v0.0.4 | non-negotiable |
| Env vars inferred from prefix + field path, `env` is optional override | v0.0.3 | non-negotiable |
| Three-tier scope cascade: system → global → project | v0.0.2 | non-negotiable |
| Directory type-primary lookup: `path("state.data")`, `path("state.data", "replica")` | v0.0.2 | non-negotiable |
| Namespaced environments: namespace in path + snapshot + prefix suffix | v0.0.2/v0.0.5 | non-negotiable |
| Field definitions carry validation keywords (type, minimum, maximum, enum, pattern) | v0.0.1 | non-negotiable |
| `generateFieldSchema()` auto-generates JSON Schema from field definitions | v0.0.1 | non-negotiable |
| Cross-language validation contract via `fieldSchema` + native validators | v0.0.1 | non-negotiable |
| Provenance tracking in snapshot | v0.0.1 | non-negotiable |
| Zod fully removed | v0.0.1 | non-negotiable |
| `structureHash` hashes logical structure (`type:name:scope`), not absolute paths | v0.0.0 | non-negotiable |
| `contentHash` hashes sorted `key=value\n` — test vector is the authority | v0.0.0 | non-negotiable |
| Atomic snapshot writes (`.tmp` + `renameSync`) | v0.0.0 | non-negotiable |
| `<group>-<layer>-<name>` monorepo convention | monorepo convention | non-negotiable |

## 5. Task Breakdown

Five segments:

| Segment | Package(s) | Units | Depends on | Token est. |
|---|---|---|---|---|
| A | `environment-base-spec` | A1. scaffold, schema, SPEC.md, test vectors, index.ts | none | ~2.5k |
| B | `environment-builder` | B1. scaffold + types + yaml-parser + ProjectConfig, B2. field-merge + config-resolver + interpolate, B3. json-schema-gen + validation + provenance, B4. snapshot-writer + buildSnapshot pipeline + EnvironmentSnapshot class (set/get/configPath/write) + index.ts | A | ~5.5k |
| C | `environment-core-node` + `environment-cli` | C1. typed runtime client (~60 lines with generic), C2. snapshot I/O utilities, C3. CLI at `entrypoint/environment-cli/` (api.ts + core.ts + generate-cli target + smoke test) | B | ~3k |
| D | `environment-core-py` + `environment-core-rs` | D1. Python runtime client + snapshot reader + contract tests, D2. Rust runtime client + snapshot reader + contract tests | A | ~2k |
| E | **agent-mcp refactor** | E1. Write `adhd.environment.yaml` with `orgNamespace` + inferred `envPrefixOverride`, E2. Replace `config.ts` with typed `Environment<AgentMcpConfig>`, E3. Preserve `getProviderConfig()` + `isEnvNameAllowed()`, E4. Drop `load-env.ts`, E5. Tests | A, B, C | ~3k |

## 6. Verification Criteria

### Builder probes

- `npx nx build environment-builder && node -e "const {build, EnvironmentSnapshot} = require('@adhd/environment-builder'); ..."` — `build()` returns `EnvironmentSnapshot` instance
- `build(projectConfig)` returns `EnvironmentSnapshot<{ data }>` with correct type
- `snapshot.set("db.path", "/new/path")` mutates snapshot in memory
- `snapshot.get("db.path")` returns the set value
- `snapshot.configPath` returns `~/.adhd/agent-mcp/production/adhd-environment.json`
- `snapshot.write()` atomically persists to disk
- `generateFieldSchema({ "server.port": { type: "integer", minimum: 1024 } })` → `{ type: "object", properties: { server: { type: "object", properties: { port: { type: "integer", minimum: 1024 } } } } }`
- `mergeFieldDefinitions(system, global, project)` — project overrides global, global overrides system
- `inferEnvVar("ADHD_AGENT_MCP", "db.path")` → `"ADHD_AGENT_MCP_DB_PATH"`
- `inferEnvVar("ADHD_AGENT_MCP", "providers.deepseek.secret")` → `"ADHD_AGENT_MCP_PROVIDERS_DEEPSEEK_SECRET"`
- `build(spec, { namespace: "production" })` writes to `~/.adhd/agent-mcp/production/adhd-environment.json`
- `build(spec, {})` writes to `~/.adhd/agent-mcp/default/adhd-environment.json` (namespace defaults to `"default"`)
- Atomic write: kill mid-write → no partial `.json` file exists (only `.tmp`)

### Runtime probes

- `new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" }).get("config.db.path")` returns the resolved db path from the snapshot
- `env.get("path.state.data")` returns the first state.data directory path
- `env["path.db"]` returns the same as `env.get("path.db")`
- `env.get("env.OPENAI_API_KEY")` returns the recorded env var value from the snapshot
- `env.get("provenance.db.path")` returns `{ source: "project.default", scope: "project" }`
- `env.hash` returns a `sha256-` prefixed string matching the snapshot
- `env.version` returns `{ configHash, structureHash, generatedAt, libraryVersion }`
- `typeof env.get("config.transport.port")` is `number` (typed via generic; `transport.port` is agent-mcp's real numeric port field per CURRENT_CONFIG_PATTERNS.md — `config.server.port` is NOT a real field)
- `typeof env.get("config.db.path")` is `string`

### CLI probes

- `npx nx generate-cli environment-cli` produces valid `dist/entrypoint/environment-cli/cli/cli.ts`
- `adhd-env init --generate-config` writes a valid `adhd.environment.yaml` with `orgNamespace: adhd` and no `envPrefixOverride`
- `adhd-env set providers.openai.secret sk-test-openai-key --namespace production` writes to the builder store
- `adhd-env build` reads YAML + stored values, exits 0, writes snapshot
- `adhd-env build --namespace staging` writes to the staging namespace directory tree
- `adhd-env build --scope project` builds only project-scoped values
- `adhd-env status --project agent-mcp --json` returns StatusResult matching the snapshot

### Agent-mcp refactor probes

- `entrypoint/agent-mcp/src/config.ts` is gone — replaced by `adhd.environment.yaml` + typed `Environment`
- Agent-mcp starts up with `new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" })` — no Zod, no dotenv, no manual env resolution, no `.env` file
- All 26 env vars from the old `rawFromEnv()` map to inferred env vars in the YAML
- `getProviderConfig({ provider: "openai" })` still works — reads from `env.get("config.providers.openai.*")` + `env.get("env.OPENAI_API_KEY")`
- Agent-mcp test suite still passes after refactor

### Cross-language probes

- `contentHash({ b: "2", a: "1" })` → `"sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930"` in TS, Python, Rust
- `generateFieldSchema(identicalFields)` → identical JSON in all three languages
- Python `Environment.get("config.db.path")` returns same value as TypeScript for the same snapshot

## Pinned-vs-Resolve Partition

### PIN in the work-order (provide verbatim)

- Acceptance signal: test vectors (`contentHash`, `inferEnvVar`, `generateFieldSchema`, `mergeFieldDefinitions`), YAML round-trip, atomic write integrity, runtime `get()` API contract, builder `EnvironmentSnapshot` method contract
- Architectural invariants: 6-package layout, YAML static spec format, CLI as sole builder/setter, no `.env` file, `orgNamespace: adhd` defaults, `envPrefixOverride` optional, no "default" namespace, namespaces create fully-nested trees, thin runtime clients (~40-50 lines), three-tier scope cascade, env var inference with override, directory type-primary lookup with optional name
- Non-goals: `EnvironmentBuilder` class in any language, Zod, recursive `${VAR}`, concurrent guards, `.env` file loading, migration of other entrypoints
- Authoritative artifacts: `adhd-environment.schema.json` (snapshot format), `adhd.environment.yaml` format specification, SPEC.md behavioral contract, `cross-language-test-vectors.json`
- Executor tier: Segment B (builder with typed `EnvironmentSnapshot`) → strong executor (deepseek-v4-pro); Segments C-D → strong executor for typed generic design; Segment E → strong executor; Segment A → flash executor

### LET the executor RESOLVE at dispatch time

- Current file contents & API signatures of existing codebase (read from repo, not pinned)
- Which symbols a change affects (determined by TypeScript compiler, not pre-calculated)
- Intermediate step outputs (e.g., exact contents of generated CLI `cli.ts`)
- Repo structure a 1-second probe can read (e.g., existing project.json patterns, nx.json namedInputs)
- Test file structure — executor decides test granularity and mock strategy within the acceptance criteria
- Exact names of Python packages and Rust crates — executor resolves from ecosystem
- Builder's internal store format for `adhd-env set` values — executor decides storage mechanism (JSON file, SQLite, etc.)
