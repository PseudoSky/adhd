# @adhd/agent-* — Agent Registry Family

A 12-package modular ecosystem for building, managing, and executing AI agents across multiple LLM providers.

**All packages in this directory:**
- Write to a **shared SQLite registry** (default: `~/.adhd/agent-registry/production/data/registry.db`)
- Are coordinated via `@adhd/agent-core-env` (DB path resolution + lazy opening)
- Follow the **no import-time side effects** rule (only open DBs when explicitly called)
- Use `tier:store` / `tier:core` / `tier:engine` architecture with strict upward-only dependency flow

## Package Breakdown

### Core & Types (3)

- **`agent-base-types`** — Shared type definitions (no dependencies)
- **`agent-core-env`** (NEW v0.0.1) — Registry DB path resolver + lazy connection factory via Environment DI
- **`agent-core-policy`** — Policy engine: templates, agent→policy bindings, constraint resolution

### Stores (3)

All persist to the shared registry database; all export migrations and seed data.

- **`agent-store-prompts`** — Component/composition/usecase/composed-prompt stores
- **`agent-store-tools`** — Tool registry, bindings (HTTP/MCP/CLI/etc), MCP server configs, agent grants
- **`agent-store-runtime`** — Runtime agent execution logs and state

### Model & Provider (1)

- **`agent-core-provider`** — LLM provider/model registry, tool format specs, platform bindings

### Orchestration & Compilation (2)

- **`agent-engine-compiler`** — Compile registry configs into agent manifests (resolve components, tools, policies, models)
- **`agent-engine-orchestrator`** — Execute compiled agents: DAG task runner, delegation, HITL suspension/resume, cost tracking

### Extensions (2)

Optional plugins for the orchestrator.

- **`agent-plugin-budget`** — Token/cost/wall-clock budget enforcement per agent/task/session
- **`agent-plugin-sanitize`** — Output sanitization for HITL (prompt-injection defense)

### Tooling (1)

- **`agent-generator-plugin`** — Nx generator plugin that scaffolds new registry packages per the established patterns

## Usage

### Spawn an Agent (Typical Use Case)

```typescript
import { resolveRegistryDbPath, openRegistryDb } from '@adhd/agent-core-env';
import { AgentStore } from '@adhd/agent-store-prompts';
import { runMigrationsOn as migratePrompts } from '@adhd/agent-store-prompts';
import { runMigrationsOn as migrateTools } from '@adhd/agent-store-tools';
import { compileAgent } from '@adhd/agent-engine-compiler';

// 1. Resolve DB and open a connection
const dbPath = resolveRegistryDbPath(); // e.g., ~/.adhd/agent-registry/production/data/registry.db
const db = openRegistryDb();

// 2. Run all 5 package migrations (idempotent)
await migratePrompts(db);
await migrateTools(db);
// ... (repeat for core-policy, core-provider, agent-engine-compiler)

// 3. Compile an agent from the registry
const compiled = await compileAgent(db, {
  agentId: 'customer-support-agent',
  platform: 'mcp', // or 'http', 'json', etc.
  stores: { ... },
});

// 4. Execute via the orchestrator
```

See individual package READMEs for detailed examples.

## Database Schema

The registry is a single SQLite file with 24 tables (5 packages, 5 migration sets):

- **provider_*** (agent-core-provider) — LLM providers, models, tool formats, platform bindings
- **tool_*** (agent-store-tools) — Tools, MCP servers, tool→platform bindings, agent→tool grants
- **policy_*** (agent-core-policy) — Policy templates, agent→policy attachments
- **registry_*** (agent-store-prompts) — Agents, components, compositions, use cases, composed prompts
- **compiler_*** (agent-engine-compiler) — (Compilation-specific metadata; read-only)

All migrations must run in this order to satisfy foreign key constraints:
1. `agent-core-provider`
2. `agent-store-tools`
3. `agent-core-policy`
4. `agent-store-prompts`
5. `agent-engine-compiler`

(See each package's `src/db/migrate-runner.ts` for the actual run function.)

## Key Rules

1. **No import-time DB opens** — Importing a package must never create files or open connections as a side effect. DB path resolution and opening are explicit, caller-controlled steps.
2. **Shared registry, one per instance** — In a typical deployment, all agents in one process share one registry file (via `agent-core-env`'s canonical `Environment` resolver). Multiple instances run multiple registries (per `instanceId` or explicit override).
3. **Lazy, safe DB access** — `openRegistryDb()` is called only when execution begins, and the handle is passed explicitly to stores/compiler, not stored in module scope.
4. **Store classes inject connections** — Every store constructor takes a `db` parameter (database connection); they do not open their own.

## Primary Consumer

**`entrypoint/agent-mcp`** — The MCP server that uses this family to spawn and manage agents for Claude Desktop / LLM hosts.

## Learn More

- **[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)** — Full monorepo structure and tier diagram
- **[AGENTS.md](../../AGENTS.md)** — Agent/developer guidelines and conventions
- **[PUBLISHING.md](../../PUBLISHING.md)** — Versioning and publishing workflow
