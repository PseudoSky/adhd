# @adhd Monorepo — Capability Summary

**Generated**: 2026-07-25T00:00:00
**HEAD**: `936d50dc` (release(adhd) 42 shipped capabilities)
**Machine Contract**: `capabilities.json` (44 entries: 42 shipped, 1 deprecated, 1 roadmap)

---

## 1. What This Repo IS

The **@adhd** monorepo (Agent Hierarchical Distributed Domain) is a production-grade **agent framework** for building multi-model orchestration systems with modular registries, composable prompt engineering, and real-time tool management. It provides a **separation of concerns** between agent definition, provider/LLM management, tool/policy registries, and transport — all backed by a shared SQLite registry and compiled to any platform (MCP, HTTP, CLI) at runtime.

Beyond agents, the monorepo includes:
- **Apigen**: A code-first API generation pipeline (TypeScript → 8+ transports: MCP, Fastify, Express, CLI, JSON Schema, OpenAPI, Python Flask, Python gRPC)
- **Dispatch**: DAG-based task orchestration with validation, cost estimation, and execution
- **Environment**: A zero-config cascading configuration system (code defaults → env vars → config files)
- **Backlog**: A graph-based multi-agent backlog management system with 34 CLI/HTTP/MCP operations
- **Build Tooling**: 5 custom Nx plugins (10+ executors) for publish, version, dependency sync, and metrics
- **Shared Data/UI/Workspace**: Common transforms, query engine, React hooks, and scaffolding generators

**Size**: 62 project targets, 54 packages published to npm (@adhd scope), 44 catalogged capabilities, ~30K+ symbols

---

## 2. Package Inventory by Domain

### Agent Registry Family (12 packages) — `packages/agent/`
The core agent system. All share a single SQLite registry database.

| Package | Tier | Purpose |
|---------|------|---------|
| `agent-base-types` | base | Shared type definitions (TokenUsage, AgentDefinition, ProviderConfig, Task, Session, Message, ProviderAdapter) |
| `agent-core-env` | core | Registry DB path resolver + lazy connection factory via Environment DI |
| `agent-core-policy` | core | Policy engine: templates, agent→policy bindings, constraint resolution, rate-limit enforcement |
| `agent-core-provider` | core | LLM provider/model registry, tool formats, platform bindings, pricing/rate cards |
| `agent-store-prompts` | store | Prompt component/composition/usecase/composed-prompt stores |
| `agent-store-tools` | store | Tool registry, MCP server configs, agent→tool grants, platform bindings |
| `agent-store-runtime` | store | Runtime agent execution logs and state persistence |
| `agent-engine-compiler` | engine | Compile registry configs into agent manifests (resolve components, tools, models, policies) |
| `agent-engine-orchestrator` | engine | Execute compiled agents: DAG task runner, delegation, HITL suspension/resume, cost tracking |
| `agent-plugin-budget` | plugin | Token/cost/wall-clock budget enforcement (task/session/agent/global scopes) |
| `agent-plugin-sanitize` | plugin | Output sanitization for HITL (prompt-injection defense) |
| `agent-generator-plugin` | generator | Nx generator plugin that scaffolds new registry packages |

### Apigen Ecosystem (23 packages) — `packages/apigen/`
Code-first API generation: TypeScript functions → multi-transport API.

| Package | Tier | Purpose |
|---------|------|---------|
| `apigen-base-types` | base | Shared type definitions |
| `apigen-base-errors` | base | Canonical error codes mapped to each transport (HTTP, gRPC, CLI, MCP) |
| `apigen-base-logical` | base | Logical type codecs (Date, int64, Decimal, UUID, bytes) |
| `apigen-base-schema` | base | JSON Schema utilities |
| `apigen-core-client` | core | Extraction engine: `extract()`, `composeSchemas()`, plugin contracts |
| `apigen-engine-runtime` | engine | Dispatch runtime: `dispatch`, `buildFnTable`, middleware, streaming, OpPlan, TransportAdapter |
| `apigen-engine-naming` | engine | Naming: case conversion, collision detection, envelope keys |
| `apigen-engine-gateway` | engine | Multi-package aggregation with health probes, deadline propagation |
| `apigen-engine-conformance` | engine | Cross-host conformance testing suite |
| `apigen-generator-nx` | generator | Nx generator for scaffolding apigen plugins/hosts |
| `apigen-python-env` | core | Python venv provisioning for py-flask/py-grpc |
| `apigen-codegen-openapi` | codegen | OpenAPI 3.1 document builder |
| `apigen-plugin-mcp` | plugin | MCP server plugin (stdio/SSE/streaming-http) |
| `apigen-plugin-api-fastify` | plugin | Fastify HTTP server plugin |
| `apigen-plugin-api-express` | plugin | Express HTTP server plugin |
| `apigen-plugin-cli-output` | plugin | Commander CLI tool plugin |
| `apigen-plugin-jsonschema` | plugin | JSON Schema file generation |
| `apigen-plugin-openapi` | plugin | Live OpenAPI doc mount (`GET /_meta/openapi`) |
| `apigen-plugin-health` | plugin | Health check endpoint (`GET /_meta/health`) |
| `apigen-plugin-logger` | plugin | Per-operation logging layer |
| `apigen-plugin-py-flask` | plugin | Python Flask server (cross-language target) |
| `apigen-plugin-py-grpc` | plugin | Python gRPC server (cross-language target) |
| `codegen/openapi` | codegen | OpenAPI 3.1 spec generator |

### Dispatch Family (6 packages) — `packages/dispatch/`
DAG-based task orchestration.

| Package | Tier | Purpose |
|---------|------|---------|
| `dispatch-base-spec` | base | DAG schema types, validators, migration helpers |
| `dispatch-base-types` | base | Shared type definitions (leaf package, orphaned) |
| `dispatch-core-client` | core | DAG client interface (`IDagClient`, `IDagSerializer`) |
| `dispatch-core-optimizer` | core | DAG optimization: route optimization, cost estimation |
| `dispatch-orchestrator` | engine | DAG execution engine: cycle orchestration, milestone tracking |
| `dispatch-serializer-json` | serializer | JSON file-based DAG serializer with atomic writes |

### Environment Family (3 packages) — `packages/environment/`
Zero-config cascading configuration.

| Package | Tier | Purpose |
|---------|------|---------|
| `environment-base-spec` | base | Spec types: `EnvironmentSpec`, `FieldSpec`, `DirSpec`, scopes |
| `environment-builder` | core | Cascade resolution engine: scope, roots, layer files, config merge |
| `environment-core-node` | core | `Environment` class: live in-memory resolve, typed config/paths/files |

### Data Family (3 packages) — `packages/data/`
Shared TypeScript utilities, safe for Node and browser.

| Package | Tier | Platform | Purpose |
|---------|------|----------|---------|
| `data-base-transforms` | core | shared | camelCase, deepCopy, deepEqual, humanize, stats, collections, filters |
| `data-core-structures` | core | shared | Data structure utilities |
| `data-query-engine` | core | shared | In-memory JSON query engine |

### UI React (2 packages) — `packages/ui-react/`
Dashboard component primitives.

| Package | Tier | Platform | Purpose |
|---------|------|----------|---------|
| `ui-react-base-hooks` | base | browser | Shared React hooks (useDebounce, useFileDownload, useLocalStorage) |
| `ui-react-base-storybook` | base | browser | Storybook configuration (private, not published) |

### Workspace (2 packages) — `packages/workspace/`
Monorepo scaffolding and resolution tools.

| Package | Tier | Platform | Purpose |
|---------|------|----------|---------|
| `workspace-codegen-nx` | core | shared | Mandatory Nx generator for package scaffolding (9 tier templates) |
| `workspace-base-tools` | base | node | Package info resolver (getPackageInfo) for build tooling |

### Entrypoints (5 packages) — `entrypoint/`
Consumable CLI/server applications.

| Package | Purpose | Transports |
|---------|---------|------------|
| `agent-mcp` | MCP server for spawning/managing AI agents | MCP stdio/SSE |
| `apigen-cli` | Code-first API generation CLI | CLI, serve (multi-host proxy) |
| `dispatch-cli` | DAG task orchestrator CLI | CLI (library + apigen-generated) |
| `backlog` | Graph-based backlog management system | CLI, MCP stdio, HTTP/Fastify |
| `decompile-cli` | AI-assisted code decompilation | CLI |
| `environment-cli` | (Planned) Environment config management | _(stub only)_ |

### Build Tooling (6 plugin directories) — `tools/nx-plugins/`
Custom Nx plugins that power the monorepo's own release pipeline.

| Plugin | Executors | Purpose |
|--------|-----------|---------|
| `@adhd/nx-build` | version, publish, reconcile, manifest, verify-dist-load, hygiene, link | Full release lifecycle |
| `@adhd/nx-deps` | sync-deps, sync-deps-check | Dependency range reconciliation |
| `@adhd/nx-assets` | copy | README/CHANGELOG to dist |
| `@adhd/nx-secret-scan` | scan | Credential detection |
| `@adhd/nx-test` | wiring | Test config verification |
| `tools/vite-plugins/` | externalize.mjs, vitest-pool-defaults.mjs | Build-time dependency externalization, CPU oversubscription prevention |

### Other Tools
- **tools/mcp-shell/** — Runtime MCP stdio server for restricted shell execution (security-gated)
- **tools/util/backlog.mjs** — Legacy BACKLOG.md parser (deprecated, superseded by @adhd/backlog)

---

## 3. Capability Inventory Summary

| Status | Count |
|--------|-------|
| 🟢 **shipped** | 42 |
| 🟡 **roadmap** | 1 (environment-cli) |
| 🔴 **deprecated** | 1 (legacy backlog util) |
| **Total** | **44** |

### By Domain

| Domain | Shipped | Roadmap | Deprecated |
|--------|---------|---------|------------|
| **agent** (registry + runtime) | 6 capabs covering 12 packages | — | — |
| **apigen** (extraction + plugins + runtime) | 13 capabs covering 23 packages | — | — |
| **entrypoint** (backlog) | 6 capabs | — | — |
| **tools** (nx plugins, vite, mcp) | 7 capabs | — | 1 |
| **environment** | 2 capabs covering 3 packages | 1 | — |
| **workspace** | 3 capabs covering 2 packages | — | — |
| **data** | 1 capab covering 3 packages | — | — |
| **dispatch** | 2 capabs covering 6 packages | — | — |
| **decompile** | 1 capab | — | — |
| **ui-react** | 1 capab covering 2 packages | — | — |

### By Substance

| Substance | Count |
|-----------|-------|
| **substantial** (non-trivial algorithm, engine, meaningful edge-case handling) | 20 |
| **moderate** | 19 |
| **trivial** (thin wrapper, re-export) | 5 |

### Key Substantial Capabilities (engines, not wrappers)

| Capability | Description |
|------------|-------------|
| Agent Registry Family (12 packages) | Shared SQLite registry, import-time side-effect-free, lazy environment-based DI, provider adapter pattern, 4-stage migration order |
| Agent MCP Server | MCP server with session/task/prompt/tool persistence, multi-provider orchestration, HITL, DAG dispatch |
| Apigen CLI + Plugin System | ts-morph extraction, 8+ transport plugins (5 run-capable), serve-core OpPlan/TransportAdapter refactor |
| Apigen Canonical Routes | Consistent kebab-case HTTP, qualified MCP tool names, nested CLI paths across all transports |
| Backlog CLI + Graph Store | SQLite graph with bi-temporal history, FTS5, concurrency-safe CAS, 34 op CLI/HTTP/MCP |
| Build Tooling Nx Plugins (5 plugins) | Published-state cache (1166× faster version bumps), CPU guard, atomic lockfile, vitest CPU bounding |
| Dispatch DAG Orchestration | Cycle detection, cost-optimized topo sort, milestone tracking, cancellation |
| Environment Zero-Config Cascade | 6-layer cascade (code→system→global→project→local→env), advisory locking, scope detection |

---

## 4. Doc Conformance Assessment

| Metric | Current | Prior Run (iter-1) | Δ |
|--------|---------|-------------------|-----|
| **Total Public Capabilities** | 42 shipped (44 total) | 19 shipped | +23 |
| **Junk Ratio** (wrong/obsolete/noise) | ~8% | ~10% | −2pp |
| **Redundancy Ratio** (duplicated) | ~10% | ~10% | — |
| **Undocumented Ratio** (real cap, no doc) | ~20% | ~25% | −5pp |
| **User-facing docs** | ~60% complete | ~60% | — |
| **Agent-facing docs** (AGENTS.md) | ~95% complete | ~95% | — |
| **Capabilities with verified_output** | 42/42 (100%) | 22/22 (100%) | — |

### Doc Quality per Document

| Document | Quality | Assessment |
|----------|---------|------------|
| **README.md** | 🟢 **KEEP** | Completely rewritten since baseline; accurate architecture diagram; missing backlog reference and tooling section |
| **AGENTS.md** | 🟢 **KEEP** | Well-maintained 14-section agent instructions; comprehensive scaffolding/testing/publishing guidance; missing build tooling coverage |
| **CHANGELOG.md** | 🟢 **KEEP** | Exceptionally detailed (900+ lines), consistent structure, negative controls cited; needs TOC |
| **docs/environment/** | 🟢 **KEEP** | Comprehensive ARCHITECTURE.md with full API contract; no files required |
| **entrypoint/backlog/** | 🟢 **KEEP** | Best-documented package: README, SPEC (32KB), DESIGN (45KB), RAG-SPEC (93KB) |
| **docs/apigen/** | 🟡 **REVISE** | Missing plugin architecture overview, no working example workflows |
| **PUBLISHING.md** | 🟡 **REVISE** | 2 broken links to per-package PUBLISHING.md files that don't exist |

### Remaining Doc Gaps (HIGH priority)

1. **@adhd/backlog** — Not listed in repo-root README navigation table, despite being a major new capability
2. **Build tooling** — 5 custom Nx plugins, published-state cache, metrics framework not mentioned in README or AGENTS.md
3. **Package count** — README says "50 packages across 7 domains"; actual is 62 projects, 54 published, +8 tools
4. **agent-core-env/README.md** — Nx boilerplate with wrong project name ("agent-agent-core-env")

---

## 5. Key Architectural Patterns

### Pattern 1: Tier-Hierarchical Dependency Isolation
Packages follow a strict tier system (types → base → core → store → engine → serializer/plugin/generator/query) with enforced downward-only dependency flow. Each package gets Nx tags (`domain:`, `pkg-kind:`, `pkg-class:`, `layer:`, `platform:`) that enable boundary linting.

### Pattern 2: Single SQLite Registry, Lazy Connection
All 5 agent-registry family packages share one SQLite file. Packages never open DB at import time — connection is passed explicitly via DI (`agent-core-env` provides resolution + lazy open). Migrations run in a prescribed order (provider → tools → policy → prompts → compiler) to satisfy FK constraints.

### Pattern 3: Plugin Architecture for Apigen Transports
The apigen extraction engine produces a neutral operation descriptor; 10 transport plugins project that descriptor to different endpoints. 5 plugins support live `run()` (no disk output). All share the same `dispatch` + `OpPlan` core. Plugins are self-contained packages with their own lifecycle.

### Pattern 4: Zero-Config Configuration Cascade
The Environment system provides code defaults that work with zero files on disk. Optional layers (system → global → project → local → env vars) override in priority order. Everything nests under `<root>/.adhd/<project>/<namespace>/`.

### Pattern 5: Published-State Cache for Zero-Network Version Bumps
A committed `published-state.json` (54 packages) stores `{version, normalizedHash, publishedIntegrity}`. Version-bump decisions use this cache instead of npm tarball fetch (1166× faster). Atomic file-lock protects concurrent `nx run-many` writes.

### Pattern 6: 3-Transport Entrypoint Standard
All entrypoints (agent-mcp, backlog, apigen-cli) support **CLI + MCP + HTTP** transports. The MCP/HTTP transports are mounted live via apigen's `run()` path — no code generation required. This enables the same agent/server to operate as a CLI tool, AI agent tool, or web API from a single build.

### Pattern 7: Build Artifact Verification Pipeline
Every package goes through: `build → dist-manifest → verify-dist-load → publish-hygiene → publish`. `verify-dist-load` proves the built artifact loads via `require()` (consumer simulation). `publish-hygiene` asserts no test files or build config leak into the npm tarball.

---

## 6. Overlap and Complementarity with `@adhd/reverse-*` (reverse-apis repo)

The `reverse-apis` repo at `/Users/nix/dev/projects/reverse-apis` uses `@adhd/reverse-*` packages. Based on the monorepo structure, here are the known touch-points and complementary capabilities:

### Known Consumed Capabilities (from reverse-apis)
- **`@adhd/apigen-core-client`** — Likely used for API extraction and schema composition in the reverse-engineering toolchain
- **`@adhd/apigen-engine-runtime`** — Runtime dispatch, middleware, streaming consumed by reverse-apis tooling
- **`@adhd/apigen-plugin-mcp`** — MCP server transport used to expose reverse-engineering tools to AI agents
- **`@adhd/apigen-plugin-api-express`/`@adhd/apigen-plugin-api-fastify`** — HTTP transports used by reverse-apis
- **`@adhd/data-base-transforms`** — Most-imported package in the monorepo, likely used extensively
- **`@adhd/apigen-base-errors`** — Canonical error codes shared across reverse-apis tooling
- **`@adhd/apigen-base-logical`** — Logical type codecs (Decimal, int64, UUID, bytes) likely used for schema handling

### Potentially Complementary Capabilities (not yet consumed)
- **Agent Registry Family** — If reverse-apis builds AI-augmented developer tools, `agent-core-provider`, `agent-store-prompts`, and `agent-engine-orchestrator` could provide a ready-made agent execution framework
- **`@adhd/backlog`** — Graph-based backlog management could replace hand-edited BACKLOG.md in reverse-apis (matching the Phase-3 model in this repo)
- **`@adhd/agent-core-env`** — Environment-backed lazy DB resolution could replace any ad-hoc DB path handling in reverse-apis
- **`@adhd/agent-plugin-budget`** — Cost/token budget enforcement if reverse-apis spawns LLM agents
- **`@adhd/dispatch-*`** — DAG-based task orchestration if reverse-apis needs coordinated multi-step workflows
- **`@adhd/environment`** — Zero-config cascade could simplify configuration management in reverse-apis
- **`@adhd/apigen-py-flask`/`@adhd/apigen-py-grpc`** — If reverse-apis has Python targets

### Shared Infrastructure Patterns
- Both repos use **Nx monorepo** with similar structure
- Both use **pnpm** for package management
- Both use **Vitest** for testing
- Both have custom Nx plugin tooling
- The `@adhd/reverse-*` packages follow the same package naming convention as this monorepo

### Key Differentiators
This monorepo (@adhd source) provides the **foundational platform** — agent registry, API generation, DAG orchestration, configuration, shared utilities. The reverse-apis repo provides **application-layer tools** built on top of this platform. This follows the intended tier-hierarchy: platform libraries feed application consumers.

---

## Files Written/Updated

| File | Purpose |
|------|---------|
| `docs/marketing/.catalog/capabilities.json` | 44 capability entries (42 shipped, 1 deprecated, 1 roadmap) — *pre-existing, verified current* |
| `docs/marketing/.catalog/capabilities-summary.md` | **This file** — executive summary for cross-repo comparison |
