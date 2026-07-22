# @adhd/agent-core-policy

SQLite-backed policy engine for agent authorization and execution constraints. Part of the agent registry family. **No database import-time side effects** — use `@adhd/agent-core-env` to resolve the shared registry DB path.

**Status:** Shipped v2.1.2  
**Platform:** `platform:node` (runs in Node/CLI, not browser)  
**Consumers:** `@adhd/agent-mcp`, `@adhd/agent-engine-compiler`

## What it does

- **Policy Template Store** — manages reusable policy templates (access control rules, execution constraints, etc.)
- **Agent Policy Store** — assigns policies to agents with category-based inheritance
- **Policy Resolution** — resolves effective rules for an agent, handling category inheritance
- **Constraint Enforcement** — evaluates whether an action is permitted given agent policies
- **Database Migrations** — runs schema setup via `runMigrationsOn(db)`

## Usage

First, resolve the shared registry database path:

```typescript
import { resolveRegistryDbPath } from '@adhd/agent-core-env';
import Database from 'better-sqlite3';
import { runMigrationsOn, PolicyTemplateStore, AgentPolicyStore, resolveEffectiveRules } from '@adhd/agent-core-policy';

const dbPath = resolveRegistryDbPath(); // e.g., ~/.adhd/agent-registry/production/data/registry.db
const db = new Database(dbPath);

// Run migrations
await runMigrationsOn(db);

// Create stores
const policyStore = new PolicyTemplateStore(db);
const agentPolicyStore = new AgentPolicyStore(db);

// Create a policy template
const template = await policyStore.create({
  name: 'read-only',
  description: 'Read-only access to data',
  rules: { actions: ['read'], denyActions: ['write', 'delete'] },
});

// Attach policy to an agent
await agentPolicyStore.attach(agentId, {
  templateId: template.id,
});

// Resolve effective rules (includes category inheritance)
const effective = await resolveEffectiveRules(agentId);
```

## Key exports

| Export | Purpose |
|--------|---------|
| `PolicyTemplateStore` | Policy template management |
| `AgentPolicyStore` | Agent policy grants |
| `resolveEffectiveRules(agentId)` | Resolve effective rules with inheritance |
| `runMigrationsOn(db)` | Initialize database schema |
| Schema tables | Available via `export *` from schema module |

## Architecture

- **Tier**: `core` (depends on base)
- **Schema**: Tables for policy templates, agent↔policy junctions, and category-based inheritance
- **No import-time side effects** — DB path and connection are external (via `agent-core-env`)
- **Part of agent registry family**: `agent-store-prompts` + `agent-store-tools` + `agent-core-policy` + `agent-core-provider` + `agent-engine-compiler`

See `/entrypoint/agent-mcp/` for the agent MCP server (primary consumer).
