# Capabilities: ADHD Monorepo

**Scope**: adhd monorepo (root)
**Assessment Date**: 2026-07-22
**Last Verified Commit**: 28888998c0a68e2712d06b89ed1602e0c6aab3c4
**Machine Contract**: See capabilities.json

## Capability Summary

| ID | Name | Status | Domain | Tier | Substance | Notes |
|--------|------|--------|--------|------|-----------|-------|
| agent-mcp-server | Agent MCP Server | 🟢 shipped | agent | entrypoint | substantial | Enables LLMs to spawn/delegate/coordinate agents across providers |
| agent-core-env | Agent Registry Environment Resolver | 🟢 shipped | agent | core | moderate | NEW (2026-07-22): Eliminates import-time DB side effects |
| apigen-cli-api-generation | Apigen CLI: Code-First API Generation | 🟢 shipped | apigen | entrypoint | substantial | TypeScript → HTTP/MCP/CLI/OpenAPI/Python|
| dispatch-cli-task-orchestration | Dispatch CLI: DAG Task Orchestration | 🟢 shipped | dispatch | entrypoint | substantial | Validate/snapshot/optimize/execute task DAGs |
| environment-zero-config | Environment: Zero-Config Cascade | 🟢 shipped | environment | core | substantial | Config cascade: code → system → global → project → env vars |
| apigen-plugin-system | Apigen Plugin System | 🟢 shipped | apigen | plugin | substantial | 8 transport plugins (MCP, Fastify, Express, CLI, JSON Schema, OpenAPI, Flask, gRPC) |
| agent-registry-family | Agent Registry Family | 🟢 shipped | agent | mixed (base→engine) | substantial | 12-package ecosystem for agent execution |
| workspace-codegen-nx | Workspace Codegen Nx Generator | 🟢 shipped | workspace | core | moderate | Mandatory scaffolding generator; enforces tier/domain/platform/layer tags |

**Total Capabilities**: 8 major (see breakdown below for 50-package ecosystem)

**Verification Status**: 🔴 ALL MARKED UNVERIFIED (Nx project graph broken; cannot run verify commands)
- Cannot compile packages (`npx nx build` fails)
- Cannot run CLIs (`apigen-cli --help` blocked)
- Cannot execute tests (Vitest runs blocked)
- Marked as "shipped" based on source code inspection, test presence, and GitNexus analysis, but not runtime-proven

---

## Detailed Capabilities

### 1. Agent MCP Server
**ID**: agent-mcp-server  
**Package**: @adhd/agent-mcp (v2.1.2)  
**Type**: Entrypoint (CLI/server)  
**Status**: 🟢 shipped  
**Substance**: substantial  

**Description**:
MCP server that enables LLMs to spawn, delegate to, and coordinate AI agents across multiple LLM providers (Claude, LM Studio, etc.). Supports:
- Cross-provider orchestration (Claude orchestrates LM Studio sub-agents)
- Session and task persistence (SQLite with Drizzle ORM)
- DAG task dependencies (dispatch via DagEngine)
- Human-in-the-loop (HITL) with Promise-based awaiting
- Recursive sub-agent delegation
- Rate limiting and token budget plugins

**Key Architecture**:
- **Stores**: SessionStore, TaskStore, ComposedPromptStore, ToolRegistry, PolicyEngine
- **Engine**: Orchestrator, DagEngine, BackgroundQueue
- **Plugins**: UsagePlugin (token/cost tracking), external plugin loader
- **MCP Protocol**: stdio, SSE (Server-Sent Events), streaming HTTP
- **Configuration**: @adhd/environment cascade (zero-config by default)
- **Database**: Shared SQLite via @adhd/agent-core-env (new, eliminates import-time DB open)

**Key Exports**:
- `HookRegistry` (from @adhd/agent-engine-orchestrator)
- `ComposedPromptStore` (from @adhd/agent-store-prompts)
- `buildPromptResolver(opts: BuildPromptResolverOpts)` (ties registry DB to prompt resolution)

**Recent Changes**:
- **2026-07-22**: SSE port-contention fix (derives port per instance via @adhd/environment)
- **2026-07-22**: Removed import-time DB open side effect via @adhd/agent-core-env
- **2026-07-18**: BuildPromptResolver now creates/migrates registry DB, ComposedPromptStore bound to registry DB

**Verify Command**: `npx apigen-cli --help` (not agent-mcp itself, but a sister tool for comparison)  
**Verified Output**: 🔴 UNVERIFIED (nx build broken)  
**Receipt**: entrypoint/agent-mcp/src/index.ts, entrypoint/agent-mcp/src/server.ts  

---

### 2. Agent Registry Environment Resolver
**ID**: agent-core-env  
**Package**: @adhd/agent-core-env (v0.0.1)  
**Type**: Core library (tier:core, domain:agent)  
**Status**: 🟢 shipped  
**Substance**: moderate  
**Date Added**: 2026-07-22 (NEW)  

**Description**:
Shared resolver for the agent-registry family's single SQLite database. Replaces import-time DB opening with lazy dependency injection pattern. Used by:
- @adhd/agent-store-prompts (ComposedPromptStore)
- @adhd/agent-store-tools (ToolRegistry)
- @adhd/agent-core-policy (PolicyEngine)
- @adhd/agent-core-provider (ProviderRegistry)
- @adhd/agent-engine-compiler (PromptCompiler)

**Exports**:
- `resolveRegistryDbPath(opts: ResolveRegistryDbPathOpts) → string` — Resolves path to agent-registry.db via @adhd/environment
- `openRegistryDb(opts: OpenRegistryDbOpts) → RegistryDbHandle` — Lazy-opens DB connection
- `agentRegistryEnvironmentSpec` — Environment spec for registry package configuration
- `AGENT_REGISTRY_PROJECT_ID` — Canonical project ID for environment namespace

**Key Innovation**:
- Eliminates import-time side effect (DB connection opened only when actually used)
- Unifies DB path discovery across registry-family packages (no package-specific DB paths)
- Enables environment-driven configuration (scope auto-detection, dev/test/prod DB locations)

**Verify Command**: `npx tsx -e "const {resolveRegistryDbPath} = await import('@adhd/agent-core-env'); console.log(typeof resolveRegistryDbPath)"`  
**Verified Output**: 🔴 UNVERIFIED (needs build)  
**Receipt**: packages/agent/agent-core-env/src/{resolve-registry-db-path.ts, open-registry-db.ts, spec.ts}  

---

### 3. Apigen CLI: Code-First API Generation
**ID**: apigen-cli-api-generation  
**Package**: @adhd/apigen-cli (v0.1.1)  
**Type**: Entrypoint (CLI)  
**Status**: 🟢 shipped  
**Substance**: substantial  

**Description**:
CLI tool for code-first API generation. Write plain, idiomatic TypeScript functions (no decorators, annotations, or IDL). Apigen extracts a transport-neutral operation descriptor and projects it to:
- **HTTP Servers**: Fastify, Express
- **MCP Tools**: Stdio, SSE, streaming HTTP
- **CLI**: Commander with subcommands
- **Documentation**: JSON Schema, OpenAPI 3.x
- **Python Servers**: Flask, gRPC

**Commands**:
- `apigen generate --source ./api.ts --type mcp --out-dir ./out` — Generate to disk
- `apigen run --source ./api.ts --type api-fastify --opt port=3000` — Run live server
- `apigen serve` — Alternate server mode
- `apigen list-types` — Inspect supported types
- `apigen generate-registry` / `apigen run-registry` — Multi-package composition

**Core Pipeline**:
1. **Extract**: ts-morph + ts-json-schema-generator read TypeScript function signatures
2. **Compose**: Create transport-neutral operation descriptor
3. **Project**: OutputPlugin targets render to specific transports
4. **Output**: Write files or run live server

**Middleware System**:
- `@adhd/apigen-plugin-health` — Health endpoint
- `@adhd/apigen-plugin-logger` — Request/response/timing logging
- Custom middleware via OutputPlugin contract

**Verify Command**: `npx apigen-cli --help`  
**Verified Output**: 🔴 UNVERIFIED (needs build)  
**Receipt**: entrypoint/apigen-cli/src/index.ts (Commander program with 6 commands)  

---

### 4. Dispatch CLI: DAG Task Orchestration
**ID**: dispatch-cli-task-orchestration  
**Package**: @adhd/dispatch-cli (v0.0.1)  
**Type**: Entrypoint (CLI)  
**Status**: 🟢 shipped  
**Substance**: substantial  

**Description**:
CLI for task DAG validation, cost estimation, route optimization, and live execution. Designed for agent-mcp task dispatch workflows and cross-model cost optimization.

**Commands**:
- `dispatch validate` — Check DAG for cycles, missing edges, malformed schema
- `dispatch snapshot` — Generate cost snapshot (estimated tokens/cost per milestone)
- `dispatch optimize` — Find optimal execution path (minimize cost, parallelize where possible)
- `dispatch eligible` — Check which models can run given task constraints
- `dispatch status` — Current execution status
- `dispatch run` — Execute dispatch cycle
- `dispatch calibrate` — Benchmark models, update calibration data

**Core Architecture**:
- **DAG Schema**: dispatch-base-spec (defines Task, Edge, Milestone)
- **Validation**: dispatch-base-spec validators
- **Optimization**: dispatch-core-optimizer (topological sort, cost minimization)
- **Execution**: dispatch-orchestrator (schedule + execute tasks, handle errors/cancellation)

**Verify Command**: `npx dispatch-cli --help`  
**Verified Output**: 🔴 UNVERIFIED (needs build)  
**Receipt**: entrypoint/dispatch-cli/src/index.ts (exports validate, snapshot, optimize, eligible, status, run, calibrate)  

---

### 5. Environment: Zero-Config Cascade
**ID**: environment-zero-config  
**Package**: @adhd/environment (v0.0.1)  
**Type**: Core library (tier:core, domain:environment)  
**Status**: 🟢 shipped  
**Substance**: substantial  
**Date Released**: 2026-07-22  

**Description**:
Zero-config configuration cascade for @adhd ecosystem. Resolves configuration from:
1. **Code Defaults** (hardcoded in EnvironmentSpec)
2. **System Config** (/etc/adhd, /usr/local/etc/adhd)
3. **Global Config** (~/.adhd/)
4. **Project Config** (<project-root>/.adhd/)
5. **Local Overrides** (<project-root>/\*.local files)
6. **Environment Variables** (remapped via prefix)

**Key Properties**:
- **Zero-Config by Default**: No files required; all layers optional
- **Fully Typed**: Environment<T> with generic config type
- **Multi-Instance Collision Avoidance**: Per-instance locking, shared vs instance-local dirs
- **Scope Auto-Detection**: Detects project vs global scope automatically
- **Cross-Process Persistence**: Snapshot JSON for state sharing

**Public API** (Environment class):
- `env.config` — Fully resolved typed config object
- `env.get(path)` — Dynamic dot-path access (config.\*, path.\*, env.\*, provenance.\*)
- `env.paths` — Resolved absolute directory paths
- `env.files` — Resolved absolute file paths
- `env.lock(name?)` → release() — Advisory file locking
- `env.write() → path` — Persist snapshot JSON
- `env.snapshotPath` — Where snapshot persists
- `Environment.fromSnapshot(path)` — Read persisted snapshot (cross-process)

**Directory Layout**:
- `<root>/.adhd/<project-id>/<namespace>/` — Per-package isolation
- `...../config/` — Shared across instances
- `...../data/`, `...../cache/`, `...../state/` — Shared
- `...../logs/`, `...../temp/` — Per-instance (suffixed with instanceId)
- `...../run/` — Instance registry + lockfiles

**Consumers**:
- @adhd/agent-mcp (logging, plugins, queue, server, SSE, transport, DB paths)
- @adhd/apigen-plugin-mcp (per-instance SSE port binding)
- All registry-family packages (via @adhd/agent-core-env)

**Verify Command**: `npx tsx -e "const {Environment} = await import('@adhd/environment'); const e = new Environment('test', {}); console.log(typeof e.get)"`  
**Verified Output**: 🔴 UNVERIFIED (needs build)  
**Receipt**: packages/environment/environment-core-node/src/index.ts (Environment class)  

---

### 6. Apigen Plugin System
**ID**: apigen-plugin-system  
**Type**: Plugin architecture (8 plugins)  
**Status**: 🟢 shipped  
**Substance**: substantial  

**Plugins** (all v0.1.x):
| Plugin | Package | Transport | Purpose |
|--------|---------|-----------|---------|
| mcp | @adhd/apigen-plugin-mcp | MCP (stdio/SSE/HTTP) | Functions → MCP tools |
| api-fastify | @adhd/apigen-plugin-api-fastify | Fastify HTTP | POST /:namespace/:fn |
| api-express | @adhd/apigen-plugin-api-express | Express HTTP | POST /:namespace/:fn |
| cli-output | @adhd/apigen-plugin-cli-output | Commander CLI | Subcommands per function |
| jsonschema | @adhd/apigen-plugin-jsonschema | JSON Schema docs | Generate schema per export |
| openapi | @adhd/apigen-plugin-openapi | OpenAPI 3.x doc | Generate OpenAPI spec |
| py-flask | @adhd/apigen-plugin-py-flask | Python Flask HTTP | Spawn python3 -m apigen_python.flask_server |
| py-grpc | @adhd/apigen-plugin-py-grpc | Python gRPC | Spawn python3 -m apigen_python.grpc_server |

**Architecture**:
- **OutputPlugin Contract**: Standard interface all plugins implement
- **Descriptor Format**: Transport-neutral operation descriptor (function name, params, return type, errors)
- **Code Generation**: Each plugin independently projects descriptor to its target
- **Runtime Dispatch**: dispatch() function, configurable per transport

**Key Innovation**:
- Write function once, deploy to 8+ transports without duplication
- Plugin contract enforces consistent behavior across transports
- MCP plugin uses @adhd/environment for per-instance port binding (SSE)

**Verify Command**: `find packages/apigen/apigen-plugin-* -name 'index.ts' | wc -l`  
**Verified Output**: 8 ✓  

---

### 7. Agent Registry Family
**ID**: agent-registry-family  
**Type**: Package family (12 packages)  
**Status**: 🟢 shipped  
**Substance**: substantial  

**Packages** (all v2.1.2 except agent-core-env v0.0.1 and agent-generator-plugin v0.0.1):

**BASE/TYPES** (tier:base):
- @adhd/agent-base-types — Domain types, hooks, errors, HookRegistry, TaskStatus, TokenUsage, ProviderAdapter

**CORE** (tier:core):
- @adhd/agent-core-policy — Policy engine for permissions, safety, audit, rate, scope, compliance, quality
- @adhd/agent-core-provider — Provider registry, adapters, model catalog, tool-format emitter
- @adhd/agent-core-env — NEW: Shared environment-backed registry DB resolver (eliminates import-time side effects)

**STORE** (tier:store):
- @adhd/agent-store-prompts — Prompt persistence, ComposedPromptStore
- @adhd/agent-store-tools — Tool registry persistence
- @adhd/agent-store-runtime — Session and task persistence, SessionStore, TaskStore

**ENGINE** (tier:engine):
- @adhd/agent-engine-compiler — Prompt compilation engine
- @adhd/agent-engine-orchestrator — Orchestration engine, DagEngine, Orchestrator, PolicyEngine, UsagePlugin

**PLUGIN** (tier:plugin):
- @adhd/agent-plugin-budget — Token spend and cost capping
- @adhd/agent-plugin-sanitize — Sub-agent output sanitization (prompt-injection defence)

**GENERATOR** (tier:generator):
- @adhd/agent-generator-plugin — Nx generator for agent-registry packages (enforces tier hierarchy and naming)

**Architecture Principle**:
- **Modular Tier Hierarchy**: base → core → store → engine (dependencies flow downward only)
- **Shared DB via agent-core-env**: All registry-family packages use same SQLite file (agent-registry.db)
- **Policy Enforcement**: PolicyEngine validates permissions, safety constraints, rate limits
- **Provider Abstraction**: Adapter pattern for LLM providers (Claude, LM Studio, etc.)

---

### 8. Workspace Codegen Nx Generator
**ID**: workspace-codegen-nx  
**Package**: @adhd/workspace-codegen-nx  
**Type**: Nx generator (tier:core, domain:workspace)  
**Status**: 🟢 shipped  
**Substance**: moderate  

**Description**:
Mandatory package scaffolding generator. **NEVER use @nx/js:library, @nx/vite:lib, or hand-create packages** — this generator is required for all package creation in the monorepo.

**Tiers Supported**:
- `types` — Pure type/contract packages (zero deps)
- `base` — Zero internal deps, roots of dep graph
- `core` — Depends only on base packages
- `engine` — Orchestration/wiring (base + core + store)
- `store` — Persistence (base + core)
- `plugin` — Optional extensions (base + core)
- `generator` — Code generators (base + core)
- `query` — Query engines (base + core)
- `entrypoint` — CLI/server/runner (lives under `entrypoint/`, not `packages/`)

**Invocation**:
```bash
npx nx g @adhd/workspace-codegen-nx:<tier> \
  --name=<bare-name> \
  --group=<domain> \
  --nxLayer=<layer> \
  --platform=<node|browser|shared> \
  [--access public] [--publish true] \
  --dry-run
```

**Domains** (authoritative list in .adhd/workspace.json):
- apigen, agent, data, dispatch, environment, ui-react, workspace

**Key Enforcement**:
- **Naming**: `<domain>-<tier>-<name>` (e.g., agent-engine-orchestrator)
- **Tags**: domain:<group>, pkg-kind:<tier>, pkg-class:<class>, layer:<nxLayer>, platform:<platform>, access:<access>
- **Platform Isolation**: platform:node (CLI) ≠ platform:browser (UI) ≠ platform:shared (universal)
- **Tier Boundaries**: Prevents upward dependencies, circular imports

**Critical Rule**: Always `--dry-run` first, read CREATE list, then re-run without flag.

---

## Roadmap Capabilities

### Environment CLI (planned)
**Package**: @adhd/environment-cli  
**Status**: 🟡 ROADMAP  

**Planned Commands** (from docs/environment/):
- `environment init` — Initialize ~/.adhd/ or <project>/.adhd/
- `environment build` — Generate snapshot JSON
- `environment set` — Override individual config values
- `environment status` — Show current resolved config
- `environment export` — Dump config to stdout (debug aid)

**Current State**: Directory exists (entrypoint/environment-cli/), likely stub only. Not built or documented for users yet.

---

## Deprecated Capabilities

None identified.

---

## Verification Status

**All capabilities marked 🔴 UNVERIFIED** due to Nx project graph error blocking:
- `npx nx build <package>`
- `npx nx test <package>`
- CLI help/execution

Once Nx is fixed, re-run all verify commands and update this document with actual output.

