# Architecture

## Overview

@adhd is a modular agent framework organized as a 50-package Nx monorepo across 7 domains. The core system is a **shared SQLite registry** that stores agents, tools, prompts, policies, and model definitions — then compiles them to any platform at runtime.

## Domains & Packages

### Agent Registry Family (12 packages)

The heart of @adhd. All packages are `tier:store` or `tier:core`, `platform:node`, and depend on a **shared registry database** at `~/.adhd/agent-registry/production/data/registry.db` (resolved via `@adhd/agent-core-env`).

| Package | Purpose | Exports |
|---------|---------|---------|
| `agent-base-types` | Shared type definitions | Type contracts only |
| **agent-core-env** | Registry DB resolver (NEW) | `resolveRegistryDbPath()`, `openRegistryDb()` |
| `agent-core-policy` | Authorization policies | `PolicyTemplateStore`, `AgentPolicyStore`, `resolveEffectiveRules()` |
| `agent-core-provider` | LLM providers & models | `ProviderStore`, `ModelStore`, `ToolFormatStore` |
| `agent-store-prompts` | Prompt components & composition | `ComponentStore`, `CompositionStore`, `ComposedPromptStore` |
| `agent-store-tools` | Tool registry & bindings | `ToolStore`, `BindingStore`, `McpServerStore`, `AgentToolStore` |
| `agent-store-runtime` | Runtime agent state | (persists agent execution logs) |
| `agent-engine-compiler` | Compiles registry → configs | `compileAgent()`, `resolveBody()`, `resolveTools()`, `emitYamlFrontmatter()` |
| `agent-engine-orchestrator` | Orchestrates agent execution | `TaskRunner`, DAG traversal, HITL handling |
| `agent-generator-plugin` | Code generator for registry packages | (Nx generator plugin) |
| `agent-plugin-budget` | Token/cost budget enforcement | (optional extension) |
| `agent-plugin-sanitize` | Output sanitization for HITL | (optional extension) |

**Key rule**: These 5 packages all write to the SAME SQLite file and must run their migrations in order:
1. `agent-core-provider` (provider_*, model_* tables)
2. `agent-store-tools` (tool_*, binding_* tables)
3. `agent-core-policy` (policy_* tables)
4. `agent-store-prompts` (registry_* tables)
5. `agent-engine-compiler` (compiler_* tables)

No package opens a DB at import time. Use `@adhd/agent-core-env` to resolve the path, then `openRegistryDb()` to get a connection and run migrations.

### Apigen (21 packages)

Code-first API generation: TypeScript → HTTP/MCP/CLI/Python/gRPC/OpenAPI.

- **Core**: `apigen-core-client` (schema extraction via ts-morph), `apigen-engine-runtime` (execution), `apigen-engine-conformance` (validation), `apigen-engine-naming` (symbol generation), `apigen-codegen-openapi` (OpenAPI codegen)
- **Plugins** (8): `apigen-plugin-mcp`, `apigen-plugin-api-express`, `apigen-plugin-api-fastify`, `apigen-plugin-cli-output`, `apigen-plugin-jsonschema`, `apigen-plugin-logger`, `apigen-plugin-health`, `apigen-plugin-py-flask`, `apigen-plugin-py-grpc`, `apigen-plugin-openapi`

### Dispatch (6 packages)

DAG-based task orchestration: validate, optimize, execute, cost-estimate.

- **Core**: `dispatch-base-spec` (DAG schema), `dispatch-core-client` (client library), `dispatch-core-optimizer` (DAG optimization)
- **Execution**: `dispatch-orchestrator` (executor), `dispatch-serializer-json` (JSON codec)

### Environment (3 packages)

Zero-config configuration: code defaults → system env → global config → project config → env vars.

- `environment-base-spec` (types), `environment-builder` (runtime cascade), `environment-core-node` (Node-specific)

See [docs/environment/](environment/) for full details and adoption guide.

### Data (3 packages)

Shared utilities: `data-base-transforms` (camelCase, deepCopy, etc.), `data-query-engine` (in-memory/browser DB), `data-core-structures`.

### UI React (2 packages)

Dashboard components (React 18): `ui-react-base-hooks`, `ui-react-base-storybook`.

### Workspace (2 packages)

Monorepo infrastructure: `workspace-codegen-nx` (mandatory package generator), internal build/lint plugins.

## Dependency Flow

**Tiers** (strict hierarchical dependency):

```
┌──────────────────────────────────────┐
│  Entrypoints (agent-mcp, apigen-cli) │  Consumed by external hosts
├──────────────────────────────────────┤
│  Engine (orchestrator, compiler)     │  Orchestration & compilation
├──────────────────────────────────────┤
│  Stores (prompts, tools, policy)     │  Persistence & domain logic
├──────────────────────────────────────┤
│  Core (environment, data, types)     │  Shared logic & config
├──────────────────────────────────────┤
│  Base (specs, shared types)          │  Zero-dependency contracts
└──────────────────────────────────────┘
```

Dependencies **never flow upward** or sideways.

## Platform Isolation

Three execution contexts, each with import guards:

- **`platform:node`** — CLI tools, servers (e.g., agent-mcp, dispatch-cli). Never import browser code.
- **`platform:browser`** — React components (e.g., ui-react-*). Never import Node internals.
- **`platform:shared`** — Universal logic (e.g., environment, data-*). Pure TypeScript, safe in both contexts.

See [AGENTS.md §3](../AGENTS.md#-3-platform-isolation-environment-rules) for the full ruleset.

## Build & Publish Pipeline

1. **Build** (`nx run-many -t build`) — Each package builds to `dist/` (in-source)
2. **Version** (`nx run-many -t version`) — Registry-driven: bumps SOURCE `package.json` only if artifact changed vs npm
3. **Publish** (`nx run-many -t publish`) — Packs and publishes each `dist/` folder to npm

See [PUBLISHING.md](../PUBLISHING.md) for the full workflow, including the `version` task's `dependsOn:[build, ^version]` topological ordering.

## Adding a New Package

Use the workspace generator:

```bash
npx nx g @adhd/workspace-codegen-nx:<tier> \
  --name=<bare-name> --group=<domain> \
  --nxLayer=<layer> --platform=<platform> \
  --dry-run
```

See [AGENTS.md §1](../AGENTS.md#-1-package-scaffolding--always-use-adhd-workspace-codegen-nx) for examples and guidance on which tier to choose.

## Running Commands

- **Build a package**: `CI=true npx nx build <project-name>`
- **Run tests**: `CI=true npx nx test <project-name>` or `CI=true npx nx affected -t test` for consumers
- **Lint**: `CI=true npx nx lint <project-name>` (auto-fixes dependency drift via `sync-deps`)
- **View dependency graph**: `CI=true npx nx graph`

(Note: `CI=true` is required in non-interactive shells due to BUG-REPO-PRECOMMIT-NX-NONINTERACTIVE-001.)

## Further Reading

- **[AGENTS.md](../AGENTS.md)** — Complete agent/developer instructions, testing protocol, commit conventions
- **[PUBLISHING.md](../PUBLISHING.md)** — Version-bump and publish workflow
- **[docs/environment/](environment/)** — Configuration cascade design and adoption guide
- **[README.md](../README.md)** — Product overview and quick links
