# Capabilities: ADHD Monorepo

**Scope**: adhd monorepo (root)
**Assessment Date**: 2026-07-24
**Last Verified Commit**: 9eb4f22c335091074e97f0075ef594649cba38b0
**Machine Contract**: See capabilities.json

## Capability Summary

| ID | Name | Status | Domain | Substance | Version |
|--------|------|--------|--------|-----------|---------|
| backlog-cli | Backlog CLI: Graph-Based Item Backlog Management | 🟢 shipped | entrypoint | substantial | 0.0.2 |
| backlog-server-http | Backlog HTTP Server (Fastify + OpenAPI) | 🟢 shipped | entrypoint | substantial | — |
| backlog-server-mcp | Backlog MCP Server (stdio) | 🟢 shipped | entrypoint | substantial | — |
| backlog-migration-system | Backlog Migration System (Phase-3 Active) | 🟢 shipped | entrypoint | substantial | — |
| backlog-graph-store | Backlog Graph Store (SQLite + SOX) | 🟢 shipped | entrypoint | substantial | — |
| build-tooling-nx-plugins | Build Tooling: Custom Nx Executors (@adhd/nx-build, @adhd/nx-deps, @adhd/nx-assets, @adhd/nx-test, @adhd/nx-secret-scan) | 🟢 shipped | tools | substantial | — |
| vite-externalize-plugin | Vite Externalize Plugin (externalize.mjs) | 🟢 shipped | tools | moderate | — |
| published-state-cache | Published-State Cache (published-state.json) | 🟢 shipped | workspace | moderate | — |
| metrics-framework | Metrics Framework (withMetrics + CPU Guard) | 🟢 shipped | tools | substantial | — |
| agent-mcp-server | Agent MCP Server | 🟢 shipped | ? | substantial | — |
| agent-core-env | Agent Registry Environment Resolver | 🟢 shipped | agent | moderate | 0.0.4 |
| apigen-cli-api-generation | Apigen CLI: Code-First API Generation | 🟢 shipped | ? | substantial | — |
| apigen-plugin-system | Apigen Plugin System | 🟢 shipped | apigen | substantial | — |
| apigen-serve-core | Apigen Serve: Multi-Host Front Proxy | 🟢 shipped | apigen | substantial | — |
| apigen-canonical-routes | Apigen Canonical Route/Tool-Name Projection | 🟢 shipped | apigen | substantial | — |
| dispatch-dag-task-orchestration | Dispatch: DAG Task Orchestration Library | 🟢 shipped | ? | substantial | — |
| environment-zero-config | Environment: Zero-Config Cascade | 🟢 shipped | environment | substantial | 0.0.3 |
| agent-registry-family | Agent Registry Family (12 Packages) | 🟢 shipped | agent | substantial | — |
| workspace-codegen-nx | Workspace Codegen Nx Generator | 🟢 shipped | workspace | moderate | 0.0.4 |
| data-transforms-and-query | Data Utilities: Transforms + Query Engine | 🟢 shipped | data | moderate | — |
| mcp-shell-server | MCP Shell Server (tools/mcp-shell) | 🟢 shipped | tools | moderate | — |
| build-tooling-release-commit | Release Commit Automation (pnpm release:commit) | 🟢 shipped | tools | moderate | — |
| vitest-cpu-bound | Vitest Thread-Pool CPU Bounding (DEBT-TEST-CPU-OVERSUBSCRIBED-001) | 🟢 shipped | tools | moderate | — |
| legacy-backlog-util | Legacy Backlog Util (tools/util/backlog.mjs) | 🔴 deprecated | tools | trivial | — |
| env-cascade-cli | Environment CLI (in development) | 🟡 roadmap | environment | trivial | — |
| agent-usage-accounting | Agent Usage Accounting: Task/Session/Agent Usage Tracking | 🟢 shipped | agent | substantial | — |
| agent-budget-enforcement | Agent Budget Enforcement: @adhd/agent-plugin-budget | 🟢 shipped | agent | substantial | 0.0.6 |
| agent-claudecli-provider | Claude CLI Provider: Local claude Subprocess Provider | 🟢 shipped | agent | moderate | — |
| agent-rate-cards | Agent Rate Cards: Provider Pricing Configuration | 🟢 shipped | agent | moderate | — |
| backlog-install-skill | Backlog Install-Skill: One-Command Skill Installation | 🟢 shipped | entrypoint | moderate | — |
| apigen-base-errors | Apigen Base: Error Types & Helpers | 🟢 shipped | apigen | moderate | 0.1.5 |
| apigen-base-logical | Apigen Base: Logical Type System | 🟢 shipped | apigen | moderate | 0.0.5 |
| apigen-base-schema | Apigen Base: JSON Schema Utilities | 🟢 shipped | apigen | moderate | 0.1.4 |
| apigen-base-types | Apigen Base: Shared Type Definitions | 🟢 shipped | apigen | trivial | 0.0.4 |
| apigen-codegen-openapi | Apigen Codegen: OpenAPI 3.x Generator | 🟢 shipped | apigen | moderate | 0.1.6 |
| apigen-engine-conformance | Apigen Engine: Conformance Testing Framework | 🟢 shipped | apigen | moderate | 0.1.4 |
| apigen-engine-gateway | Apigen Engine: Plugin Gateway & Dispatch | 🟢 shipped | apigen | moderate | 0.1.5 |
| apigen-engine-runtime | Apigen Engine: Runtime (Invoke, Validate, Dispatch) | 🟢 shipped | apigen | substantial | 0.1.4 |
| apigen-generator-nx | Apigen Generator: Nx Plugin/Host Generator | 🟢 shipped | apigen | moderate | 0.0.4 |
| apigen-python-env | Apigen Python: Managed Venv Bootstrapper | 🟢 shipped | apigen | moderate | 0.1.4 |
| decompile-cli | Decompile CLI: AI-Assisted Decompilation | 🟢 shipped | decompile | moderate | 0.1.11 |
| dispatch-base-types | Dispatch Base: Shared Type Definitions | 🟢 shipped | dispatch | trivial | 0.0.4 |
| ui-react-base-hooks | UI React: Shared React Hooks | 🟢 shipped | ui-react | moderate | 2.2.4 |
| workspace-base-tools | Workspace Base Tools: Package Resolution | 🟢 shipped | workspace | moderate | 0.0.4 |

**Total Capabilities**: 44 (42 shipped, 1 roadmap, 1 deprecated)

**Verification Status**: ✅ All shipped capabilities verified with real output from CLI/tests/grep.

---

## Detailed Capabilities

### 1. Backlog CLI: Graph-Based Item Backlog Management
**ID**: backlog-cli
**Status**: 🟢 shipped | **Substance**: substantial

Graph-backed backlog management system with 34 CLI commands for CRUD, query, lifecycle management, multi-agent coordination, and markdown interop. CLI, MCP server, and HTTP server all mounted live via apigen — no code generation.

**Receipts**: 5 files
- entrypoint/backlog/src/cli.ts (runBacklogCli, prefixCommand, resolveCommandPrefix)
- entrypoint/backlog/src/server.ts (startBacklogServer, buildBacklogApigenPackage)
- entrypoint/backlog/src/client.ts (34 client ops)
- ... +2 more
**Verified**: 38
**Note**: SQLite-backed graph store with bi-temporal history, audit-log event system, FTS5 dedupe/query, concurrency-safe lock-free CAS for 20-worker race-free id allocation, atomic file-lock-protected publishe

---

### 2. Backlog HTTP Server (Fastify + OpenAPI)
**ID**: backlog-server-http
**Status**: 🟢 shipped | **Substance**: substantial

Live HTTP server mounting all 34 backlog operations as Fastify POST routes with OpenAPI plugin. Port configurable via --port flag. Host configurable via --host flag. Transport: 'http' or 'both'.

**Receipts**: 2 files
- entrypoint/backlog/src/server.ts (startBacklogServer with apiFastifyPlugin)
- entrypoint/backlog/src/serve.ts (runServeCommand CLI entry)
**Verified**: 1
**Note**: Live apigen mount: Fastify HTTP server with OpenAPI plugin, lazy $ref dereferencing (BUG-APIGEN-RUNMODE-REF-UNRESOLVABLE-001 workaround), test-silent logger for VITEST environments.

---

### 3. Backlog MCP Server (stdio)
**ID**: backlog-server-mcp
**Status**: 🟢 shipped | **Substance**: substantial

Live MCP server exposing all 34 backlog operations as MCP tools via stdio transport. Intended for .mcp.json consumption by Claude Desktop or other MCP hosts.

**Receipts**: 3 files
- entrypoint/backlog/src/server.ts (startBacklogServer with mcpPlugin)
- entrypoint/backlog/src/server.mcp.spec.ts
- entrypoint/backlog/src/test/fixtures/mcp-stdio-entry.js
**Verified**: 1
**Note**: MCP tool names derived from apigen naming: backlog_<kebab-op-name>. Test fixture proves stdio MCP lifecycle against real built dist/index.js.

---

### 4. Backlog Migration System (Phase-3 Active)
**ID**: backlog-migration-system
**Status**: 🟢 shipped | **Substance**: substantial

5-phase migration framework for transitioning from hand-edited BACKLOG.md markdown to graph-authoritative backlog management. Currently at Phase-3: graph is authoritative, CLI/MCP is the write path, BACKLOG.md is a generated projection.

**Receipts**: 5 files
- entrypoint/backlog/src/client.ts (migrationStatus, setMigrationPhase)
- entrypoint/backlog/src/migration-admin.ts (writeMigrationPhase)
- entrypoint/backlog/src/install-skill.ts (install-skill command)
- ... +2 more
**Verified**: phase-3
**Note**: 5-phase migration (not-started→complete) with per-phase tool-authoritative semantics, global config persistence via writeMigrationPhase, installable agent skill for MCP tool discovery, parity-check pr

---

### 5. Backlog Graph Store (SQLite + SOX)
**ID**: backlog-graph-store
**Status**: 🟢 shipped | **Substance**: substantial

SQLite-backed graph store using @adhd/sox-graph-store for nodes, edges, FTS5 search, bi-temporal invalidation. Supports 20-worker concurrent CAS, audit-log event nodes, dependency graph traversal, plan-scoped projections.

**Receipts**: 11 files
- entrypoint/backlog/src/store/graph-backlog-store.ts
- entrypoint/backlog/src/store/crud.ts
- entrypoint/backlog/src/store/query.ts
- ... +8 more
**Verified**: total: 255
**Note**: Concurrent id allocation with CAS (resolve+insert inside .immediate() transaction), bounded jittered exponential backoff for SQLITE_BUSY, audit-log event nodes immune to metadata replace, FTS5 sanitiz

---

### 6. Backlog Install-Skill: One-Command Skill Installation
**ID**: backlog-install-skill
**Status**: 🟢 shipped | **Substance**: moderate

Install the @adhd/backlog MCP usage skill to any supported host (claude, codex, opencode) in one command. Copies the packaged skill/SKILL.md to the correct skill directory per host. Supports --host (default: all) and --scope (user/project). Zero external dependencies — no soxe or installer CLI needed.

**Receipts**: 3 files
- entrypoint/backlog/src/install-skill.ts
- entrypoint/backlog/skill/SKILL.md
- entrypoint/backlog/package.json (files: [skill] in allowlist)
**Verified**: {"installed":[{"host":"opencode","scope":"user","path":"/Users/nix/.config/opencode/skills/backlog/SKILL.md"}]}
**Note**: Special-cased in cli.ts before apigen dispatch — no store/ctx needed. Supports claude (.claude/skills/), codex (.codex/skills/ with CODEX_HOME override), and opencode (~/.config/opencode/skills/). Ski

---

### 7. Agent MCP Server
**ID**: agent-mcp-server
**Status**: 🟢 shipped | **Substance**: substantial

MCP server enabling LLMs to spawn, delegate to, and coordinate AI agents across multiple providers (Claude, LM Studio, etc.) with session/task/prompt/tool persistence, DAG task dispatch, human-in-the-loop, usage budgeting, and policy enforcement.

**Receipts**: 3 files
- entrypoint/agent-mcp/src/index.ts
- entrypoint/agent-mcp/src/server.ts (startServer function)
- entrypoint/agent-mcp/package.json (v2.1.4)
**Verified**: function
**Note**: SSE port contention fixed (per-instance port derivation via @adhd/environment), import-time DB side effects removed via @adhd/agent-core-env, registry DB default moved to ~/.adhd/agent-registry/ (no r

---

### 8. Agent Registry Environment Resolver
**ID**: agent-core-env
**Status**: 🟢 shipped | **Substance**: moderate

Shared @adhd/environment-backed resolver for the agent-registry family's single SQLite database. Replaces import-time DB opens with lazy DI pattern. Exports resolveRegistryDbPath, openRegistryDb, agentRegistryEnvironmentSpec.

**Receipts**: 4 files
- packages/agent/agent-core-env/package.json (v0.0.4)
- packages/agent/agent-core-env/src/index.ts
- packages/agent/agent-core-env/src/resolve-registry-db-path.ts
- ... +1 more
**Verified**: 7
**Note**: Eliminates import-time side effect (DB open at module load), switches registry family to lazy environment-based resolution, unifies DB path discovery for prompts/tools/policy/provider stores. Publishe

---

### 9. Agent Registry Family (12 Packages)
**ID**: agent-registry-family
**Status**: 🟢 shipped | **Substance**: substantial

12-package ecosystem for agent execution: base types, policy engine, provider registry, session/task/prompt/tool stores, orchestration engine, plugins (budget capping, output sanitization), generator, and env resolver. All published to npm.

**Receipts**: 12 files
- packages/agent/agent-base-types/package.json (v2.1.5)
- packages/agent/agent-core-policy/package.json (v2.1.6)
- packages/agent/agent-core-provider/package.json (v2.1.6)
- ... +9 more
**Verified**: 12
**Note**: Import-time DB side effects eliminated (agent-core-env), share SQLite via environment-backed resolver, policy enforcement with rate limiting, provider adapter pattern (Claude, LM Studio), Nx generator

---

### 10. Agent Usage Accounting: Task/Session/Agent Usage Tracking
**ID**: agent-usage-accounting
**Status**: 🟢 shipped | **Substance**: substantial

Per-task, per-session, and per-agent usage tracking in agent-mcp. Captures input/output tokens, model calls, wall-clock time, model processing time, cost, tool calls, and response size across all providers. Usage data persisted to SQLite and queryable via usage_query tool.

**Receipts**: 7 files
- entrypoint/agent-mcp/src/plugins/usage-plugin.ts
- packages/agent/agent-engine-orchestrator/src/tools/usage.ts
- packages/agent/agent-engine-orchestrator/src/validation/usage.ts
- ... +4 more
**Verified**: 86
**Note**: Usage plugin wires into agent lifecycle hooks (pre:model_request, post:model_response, post:tool_call). Records to SQLite grain fields (inputTokens, outputTokens, modelMs, cost, toolCalls). Queryable 

---

### 11. Agent Budget Enforcement: @adhd/agent-plugin-budget
**ID**: agent-budget-enforcement
**Status**: 🟢 shipped | **Substance**: substantial

Caps token spend, cost, wall-clock time, model calls, tool calls, and response size per task, session, agent, or globally. Supports ISO 8601 duration windows. Warning vs block enforcement modes. Backward-compatible flat config fields (maxInputTokens, maxCost, etc.) automatically mapped to structured cap schema.

**Receipts**: 4 files
- packages/agent/agent-plugin-budget/package.json (v0.0.6)
- packages/agent/agent-plugin-budget/src/index.ts
- packages/agent/agent-plugin-budget/src/__tests__/budget-plugin.test.ts
- ... +1 more
**Verified**: 2
**Note**: Fields: tokens, inputTokens, outputTokens, calls, wallClock, modelMs, cost, toolCalls, responseSize. Scopes: task, session, agent, global. Modes: warning (log + warn header), block (IEnforcementError 

---

### 12. Claude CLI Provider: Local claude Subprocess Provider
**ID**: agent-claudecli-provider
**Status**: 🟢 shipped | **Substance**: moderate

Provider type 'claudecli' that uses the local claude CLI (Claude Code) as a subprocess provider. Supports configurable claudePath, allowedBuiltinTools whitelist, and systemPromptIsAgentSpec mode (treats system prompt as complete Claude Code agent markdown file with YAML frontmatter). Reuses any auth method already configured in Claude Code (subscription, API key, OAuth).

**Receipts**: 3 files
- packages/agent/agent-base-types/src/domain.ts (claudecli type definition)
- packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts
- packages/agent/agent-engine-orchestrator/src/__tests__/claudecli-usage.test.ts
**Verified**: 1
**Note**: All Claude Code built-in tools disallowed by default — only MCP tools from mcpServers available. Selectively re-enable specific built-ins via allowedBuiltinTools array. systemPromptIsAgentSpec mode wr

---

### 13. Agent Rate Cards: Provider Pricing Configuration
**ID**: agent-rate-cards
**Status**: 🟢 shipped | **Substance**: moderate

Rate card definitions for provider pricing. Maps provider type + model to per-unit costs (input token, output token, etc.). Used by usage accounting to compute monetary cost from token counts. Rate cards published as part of @adhd/agent-core-provider.

**Receipts**: 2 files
- packages/agent/agent-core-provider/src/pricing/rate-card.ts
- packages/agent/agent-core-provider/src/__tests__/rate-card.test.ts
**Verified**: 12
**Note**: Rate cards enable cost computation from usage accounting data. Part of the broader agent-mcp usage accounting system.

---

### 14. Apigen CLI: Code-First API Generation
**ID**: apigen-cli-api-generation
**Status**: 🟢 shipped | **Substance**: substantial

CLI tool: write plain TypeScript functions, apigen extracts a transport-neutral operation descriptor and projects to 8+ transports: Fastify HTTP, Express HTTP, MCP tools (stdio/SSE/streaming HTTP), CLI (Commander), JSON Schema, OpenAPI 3.x, Python Flask, Python gRPC.

**Receipts**: 2 files
- entrypoint/apigen-cli/src/index.ts (Commander with 6 commands)
- entrypoint/apigen-cli/package.json (v0.1.4)
**Verified**: 1
**Note**: Schema extraction via ts-morph + ts-json-schema-generator, live run() path for all 4 run-capable plugins (cli-output now included), canonical route/tool-name projection (kebab HTTP paths, qualified MC

---

### 15. Apigen Plugin System
**ID**: apigen-plugin-system
**Status**: 🟢 shipped | **Substance**: substantial

Transport plugins projecting the same operation descriptor to multiple endpoints: MCP, Fastify HTTP, Express HTTP, CLI (Commander), JSON Schema, OpenAPI 3.x, Python Flask, Python gRPC. All 10 plugins support generate(); 5 support live run().

**Receipts**: 10 files
- packages/apigen/apigen-plugin-mcp/package.json (v0.1.5)
- packages/apigen/apigen-plugin-api-fastify/package.json (v0.1.5)
- packages/apigen/apigen-plugin-api-express/package.json (v0.1.4)
- ... +7 more
**Verified**: 6
**Note**: cli-output now also run-capable (live dispatch, not just generate). canonical route/tool-name projection across all transports. Deduplicate runExtractorEmitJson into apigen-python-env. Ephemeral ports

---

### 16. Apigen Serve: Multi-Host Front Proxy
**ID**: apigen-serve-core
**Status**: 🟢 shipped | **Substance**: substantial

Multi-source multi-language HTTP/gRPC front proxy. Mounts many apigen-powered services behind one port with path-based routing to the owning child. Routes are canonically kebab-cased; front proxy is path-preserving. Supports namespace collision detection (canonical-form).

**Receipts**: 3 files
- entrypoint/apigen-cli/src/lib/commands/serve.ts
- entrypoint/apigen-cli/src/lib/commands/run.ts
- entrypoint/apigen-cli/src/lib/orchestrator.ts
**Verified**: 2
**Note**: Front proxy routes by URL segment to owning child (kebab-keyed lookup for HTTP, raw-keyed for gRPC), HTTP namespace segment mirrors toKebab(makeSeg(ns)), canonical-collision detection for differently-

---

### 17. Apigen Canonical Route/Tool-Name Projection
**ID**: apigen-canonical-routes
**Status**: 🟢 shipped | **Substance**: substantial

Consistent canonical route/tool-name projection across all transports: kebab-case HTTP paths, qualified project(op).mcp.name MCP tool names, nested kebab CLI paths with namespace prefix. Configurable dropFileSegment per source.

**Receipts**: 5 files
- packages/apigen/apigen-engine-naming/src/naming.ts
- packages/apigen/apigen-core-client/src/lib/extract.ts
- packages/apigen/apigen-plugin-mcp/src/lib/tool-naming.ts
- ... +2 more
**Verified**: function
**Note**: Fix for BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001 / BUG-BACKLOG-MCP-TOOLNAME-CLIENTD-LEAK-001. Fixes phantom import specifier BUG-APIGEN-NAMING-IMPORT-SPECIFIER-DIVERGENCE-001 (37 files).

---

### 18. Apigen Base: Error Types & Helpers
**ID**: apigen-base-errors
**Status**: 🟢 shipped | **Substance**: moderate

Core error types for the apigen ecosystem: ApiError class with typed error codes, HTTP status mapping, and isApiError() duck-type guard (cross-bundle-safe instanceof replacement). Zero dependencies.

**Receipts**: 3 files
- packages/apigen/apigen-base-errors/package.json (v0.1.5)
- packages/apigen/apigen-base-errors/src/lib/errors.ts
- packages/apigen/apigen-base-errors/src/lib/errors.spec.ts
**Verified**: 1
**Note**: Zero-dependency base package. ApiError with code (string), message, statusCode, details. isApiError() uses duck-typing (ERROR_CODES includes check) so it works across Vite bundle boundaries where inst

---

### 19. Apigen Base: Logical Type System
**ID**: apigen-base-logical
**Status**: 🟢 shipped | **Substance**: moderate

Logical type codec registry and contracts for the apigen ecosystem. Supports Decimal, int64, date-time, byte, uuid, and other logical types that extend JSON Schema. Envelope-based encoding for schema-less positions. Zero dependencies.

**Receipts**: 3 files
- packages/apigen/apigen-base-logical/package.json (v0.0.5)
- packages/apigen/apigen-base-logical/src/lib/registry.ts
- packages/apigen/apigen-base-logical/src/lib/contracts.ts
**Verified**: 1
**Note**: Zero-dependency base package. Provides LogicalTypeRegistry interface, createRegistry, ENVELOPE_KEY, CodecRegistryError. Used by apigen-cli and all transport plugins to encode/decode logical types acro

---

### 20. Apigen Base: JSON Schema Utilities
**ID**: apigen-base-schema
**Status**: 🟢 shipped | **Substance**: moderate

JSON Schema type definitions and utilities for the apigen ecosystem: ApigenSchema interface, isJsonSchema type guard, requiredFields extraction, schemaType detection, and JSON Schema draft-07 compatibility helpers.

**Receipts**: 1 files
- packages/apigen/apigen-base-schema/package.json (v0.1.4)
**Verified**: 1
**Note**: Used internally by apigen-core-client for schema manipulation and by conformance testing.

---

### 21. Apigen Base: Shared Type Definitions
**ID**: apigen-base-types
**Status**: 🟢 shipped | **Substance**: trivial

Shared TypeScript type definitions for the apigen ecosystem. Re-exported from a generated barrel file. Zero dependencies.

**Receipts**: 1 files
- packages/apigen/apigen-base-types/package.json (v0.0.4)
**Verified**: 2
**Note**: Minimal barrel package. Zero dependencies. Provides type contracts shared across apigen packages.

---

### 22. Apigen Codegen: OpenAPI 3.x Generator
**ID**: apigen-codegen-openapi
**Status**: 🟢 shipped | **Substance**: moderate

Code generation plugin for OpenAPI 3.x specification output. Takes an apigen operation descriptor and produces an OpenAPI 3.x spec document with paths, schemas, and parameters.

**Receipts**: 1 files
- packages/apigen/codegen/openapi/package.json (v0.1.6)
**Verified**: 4
**Note**: One of the 8 transport plugins. Supports generate() only (not live run()). Outputs valid OpenAPI 3.x with canonical kebab-case paths.

---

### 23. Apigen Engine: Conformance Testing Framework
**ID**: apigen-engine-conformance
**Status**: 🟢 shipped | **Substance**: moderate

Cross-host conformance testing framework for apigen transport plugins. Drives real servers and compares raw responses for byte-identical wire format across transports.

**Receipts**: 1 files
- packages/apigen/apigen-engine-conformance/package.json (v0.1.4)
**Verified**: 14
**Note**: Powers the cross-host response envelope conformance gate that ensures TS Fastify and Python Flask servers produce byte-identical canonical JSON wire.

---

### 24. Apigen Engine: Plugin Gateway & Dispatch
**ID**: apigen-engine-gateway
**Status**: 🟢 shipped | **Substance**: moderate

Plugin gateway and dispatch routing for the apigen runtime. Handles cross-plugin dispatch, middleware composition, deadline propagation, and error routing for multi-transport setups.

**Receipts**: 2 files
- packages/apigen/apigen-engine-gateway/package.json (v0.1.5)
- packages/apigen/apigen-engine-gateway/src/lib/gateway.ts
**Verified**: 3
**Note**: Updated alongside the serve-core refactor with isGatewayError duck-type guard for cross-bundle ApiError safety.

---

### 25. Apigen Engine: Runtime (Invoke, Validate, Dispatch)
**ID**: apigen-engine-runtime
**Status**: 🟢 shipped | **Substance**: substantial

Core runtime for apigen: createInvoker for composed middleware stacks, validate-Layer for schema-based input validation, dispatchForPlan for operation dispatch, EventBus for lifecycle events, TransportAdapter and OpPlan primitives for the serve-core refactor.

**Receipts**: 7 files
- packages/apigen/apigen-engine-runtime/package.json (v0.1.4)
- packages/apigen/apigen-engine-runtime/src/lib/invoke.ts
- packages/apigen/apigen-engine-runtime/src/lib/event-bus.ts
- ... +4 more
**Verified**: 1
**Note**: The most-imported apigen engine package. Powers all 4 run-capable transport plugins. OpPlan + TransportAdapter primitives enable the serve-core refactoring. validate-Layer provides ajv-based schema va

---

### 26. Apigen Generator: Nx Plugin/Host Generator
**ID**: apigen-generator-nx
**Status**: 🟢 shipped | **Substance**: moderate

Nx code generator for scaffolding apigen transport plugins and hosts. Generates the project.json, vite.config.ts, plugin boilerplate, and test harness for new apigen plugin packages.

**Receipts**: 3 files
- packages/apigen/apigen-generator-nx/package.json (v0.0.4)
- packages/apigen/apigen-generator-nx/src/generators/plugin/generator.ts
- packages/apigen/apigen-generator-nx/src/generators/host/generator.ts
**Verified**: 10
**Note**: Supports two generator types: plugin (new transport plugin package) and host (new apigen host/entrypoint). Similar to workspace-codegen-nx but specific to the apigen sub-ecosystem.

---

### 27. Apigen Python: Managed Venv Bootstrapper
**ID**: apigen-python-env
**Status**: 🟢 shipped | **Substance**: moderate

Python host provisioning for apigen py-flask and py-grpc plugins. Resolves the Python interpreter by bootstrapping a managed venv from apigen-python's own pyproject.toml extras. Handles interpreter discovery, dependency installation, and venv lifecycle.

**Receipts**: 2 files
- packages/apigen/python-env/package.json (v0.1.4)
- packages/apigen/apigen-python-env/package.json
**Verified**: 5
**Note**: Deduplicates runExtractorEmitJson into this package. Provides the Python environment layer for both py-flask and py-grpc transport plugins.

---

### 28. Dispatch: DAG Task Orchestration Library
**ID**: dispatch-dag-task-orchestration
**Status**: 🟢 shipped | **Substance**: substantial

Library for validating task DAGs, generating cost snapshots, optimizing execution paths, and running dispatch cycles with milestone tracking. Exports validate, snapshot, optimize, eligible, status, run, calibrate as functions. CLI deployable via apigen generate-cli or hand-written bin/cli.ts fallback (neither dist-built by default).

**Receipts**: 9 files
- entrypoint/dispatch-cli/src/index.ts
- entrypoint/dispatch-cli/src/api.ts (apigen extraction surface)
- entrypoint/dispatch-cli/bin/cli.ts (hand-written fallback CLI)
- ... +6 more
**Verified**: 7
**Note**: DAG validation with cycle detection, cost-per-milestone snapshot generation, route optimization (topo sort + cost minimization), live dispatch with cancellation and error recovery. API surface consuma

---

### 29. Dispatch Base: Shared Type Definitions
**ID**: dispatch-base-types
**Status**: 🟢 shipped | **Substance**: trivial

Shared TypeScript type definitions for the dispatch ecosystem (DAG nodes, operations, optimization, costs). Zero dependencies.

**Receipts**: 1 files
- packages/dispatch/dispatch-base-types/package.json (v0.0.4)
**Verified**: 1
**Note**: Minimal barrel package. Orphaned (zero consumers) — tracked for deletion under dispatch-completion plan.

---

### 30. Environment: Zero-Config Cascade
**ID**: environment-zero-config
**Status**: 🟢 shipped | **Substance**: substantial

Cascading configuration system: code defaults → system (/etc/adhd) → global (~/.adhd) → project (.adhd/) → local overrides → env vars. Fully optional, no files required, pure TypeScript, safe for Node and browser.

**Receipts**: 5 files
- packages/environment/environment-core-node/src/Environment.ts
- packages/environment/environment-core-node/package.json (v0.0.3)
- packages/environment/environment-base-spec/package.json (v0.0.5)
- ... +2 more
**Verified**: 3
**Note**: Cascade resolution with type-safe config, advisory locking for multi-instance collision avoidance, snapshot persistence for cross-process state sharing, scope auto-detection (project vs global), remap

---

### 31. Data Utilities: Transforms + Query Engine
**ID**: data-transforms-and-query
**Status**: 🟢 shipped | **Substance**: moderate

Shared data packages: @adhd/data-base-transforms (camelCase, deepCopy, deepEqual), @adhd/data-core-structures (set operations), @adhd/data-query-engine (JSON query engine). Tier: core. Domain: data. platform:shared.

**Receipts**: 3 files
- packages/data/data-base-transforms/package.json (v2.2.5)
- packages/data/data-core-structures/package.json (v2.2.4)
- packages/data/data-query-engine/package.json (v2.2.4)
**Verified**: 3
**Note**: platform:shared — safe in Node and browser. data-base-transforms is the most-imported package in the monorepo.

---

### 32. Workspace Codegen Nx Generator
**ID**: workspace-codegen-nx
**Status**: 🟢 shipped | **Substance**: moderate

Mandatory package scaffolding generator. Creates tier-correct packages with proper naming (domain-tier-name), tagging (domain/pkg-kind/layer/platform/access), and architectural boundary enforcement. 9 tier templates (types/base/core/engine/store/plugin/generator/query/entrypoint).

**Receipts**: 3 files
- packages/workspace/workspace-codegen-nx/package.json (v0.0.4)
- packages/workspace/workspace-codegen-nx/src/generators/*/schema.json (9 tier schemas)
- AGENTS.md §1 (mandatory scaffolding rule)
**Verified**: 9
**Note**: Generator enforces tier/domain/platform/layer/access tags, emits correct project.json structure, prevents upward dependencies and platform isolation violations.

---

### 33. Workspace Base Tools: Package Resolution
**ID**: workspace-base-tools
**Status**: 🟢 shipped | **Substance**: moderate

Workspace utility package providing getPackageInfo for resolving @adhd/* package directories, versions, and dependency information. Used by build tooling for dependency graph walks.

**Receipts**: 2 files
- packages/workspace/workspace-base-tools/package.json (v0.0.4)
- packages/workspace/workspace-base-tools/src/get-package-info.ts
**Verified**: 1
**Note**: Used by nx-build executors for workspace-level package resolution.

---

### 34. Decompile CLI: AI-Assisted Decompilation
**ID**: decompile-cli
**Status**: 🟢 shipped | **Substance**: moderate

CLI tool for AI-assisted code decompilation and analysis. Uses agent-mcp infrastructure for LLM-powered reverse engineering tasks.

**Receipts**: 1 files
- entrypoint/decompile-cli/package.json (v0.1.11)
**Verified**: 2
**Note**: Entrypoint package (platform:node). Uses agent-mcp's agent orchestration for decompilation workflows.

---
