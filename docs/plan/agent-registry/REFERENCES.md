# Agent Registry — References and Project Relationships

> **Design-pass notice.** These relationships are described as understood at the time of the
> initial design pass. Exact integration contracts, API surfaces, dependency directions, and
> import paths for each project require dedicated architecture sessions. Package names and
> collaboration patterns here are illustrative, not final.

---

## Primary Source: claude-agents

**Repository:** `~/dev/ai/claude-agents`
**Relationship:** Origin system being superseded; primary use case; migration source.

The claude-agents repository is both the system whose limitations motivated this plan and the
primary consumer of its output. It provides 346 agent definitions, the SOX runtime that manages
their execution, skills, catalog tooling, and the agents.db runtime sink.

### SOX Runtime / System Prompt Compiler Integration

The SOX supervisor (`tools/cli/supervisor/`, `daemon.js`, `spawner.js`) manages agent process
lifecycle. Currently, when an agent is spawned, its system prompt is read directly from the
`.md` file. After migration, the spawner calls `@adhd/agent-compiler` to resolve the composed
prompt for the agent and target platform before instantiation. The spawner's interface to
`AgentDefinition` does not change — only where `systemPrompt` comes from.

The cmd-gate (`tools/cli/cmd-gate.js`) enforces routing flag conditions before accepting a
verdict. After migration, quality gate configuration — evidence schemas, rework limits, verdict
requirements — is read from agent-policy and agent-registry stores. The `@adhd/agent-policy`
package's enforcement handlers can register on the agent-mcp `IHookRegistry` as enforcement
hooks (errors propagate, as opposed to observational hooks whose errors are swallowed), plugging
into the existing enforcement flow without changes to the core engine.

The `tools/cli/stuck-tickets.js` rework detection and escalation logic maps directly to a
`rate` policy template with `runtime` enforcement. After migration, `max_rework` is a policy
parameter rather than a hardcoded env var or team.yaml field.

### Agent Definition Files (`categories/`)

All non-README agent `.md` files (346 at time of writing) under `categories/01-core-development/`
through `categories/10-research-analysis/` and specialized subdirectories (`cto-system/`,
`design/`, `workflow/`, `marketing-skills/`, `trading/`, `generalist/`, `portfolio-management/`)
are the primary migration source.

The migration tool parses each file's YAML frontmatter and markdown body, creates or updates
agent rows and prompt component rows in the registry, verifies that `agent-registry compile
<slug>` produces equivalent output, and flags any content that requires human review before
removal. Files are not deleted until the round-trip is verified for every agent.

The current frontmatter fields map to registry concepts as follows:

| Current field | Registry concept |
|---|---|
| `name:` | `AGENT.slug` |
| `description:` | `AGENT.description` |
| `tools:` comma list | `AGENT_TOOL` rows → `TOOL_PLATFORM_BINDING[claude_code]` |
| `model:` alias | `AGENT.model_hint` → `MODEL_PLATFORM_BINDING[claude_code]` |
| Body text | One or more `PROMPT_COMPONENT` rows, typed by section |

### Skills (`.claude/skills/`)

Skill packages (`.claude/skills/*/SKILL.md` plus supporting files) are non-code plugins that
define reusable invocable behaviors: convergence patterns, sox-init procedures, ticket creation
workflows, gitnexus exploration guides, strategy authoring, and others. After migration, each
skill's text content becomes a `PROMPT_COMPONENT` of the appropriate type — typically `process`
or `invocation`. The skill's invocation trigger and cost class become metadata on the component
or use case record.

The `.claude/skills/` directory is retired in the final removal phase. The compiler replaces
the concept of "installing a skill" with "including a component of type invocation or process
in an agent's component set."

### Catalog (`docs/catalog/`)

The catalog contains RATIONALE, DESIGN, PROCESSES, CHANGELOG, and LEDGER files for each agent,
maintained by the workflow:workflow-agent-builder and workflow:curator agents. After migration,
catalog authoring metadata (rationale, design decisions, capability descriptions) migrates to
`AGENT` record metadata and `PROMPT_COMPONENT` descriptions. The catalog directory structure
is retired in the final removal phase; the curator and agent-builder agents become consumers
of the registry write API rather than file writers.

### `agents.db`

The SQLite database at the repository root, managed by Drizzle ORM, is the runtime execution
sink. Its existing schema (agents, sessions, tasks, task_usage, task_events, messages) remains
largely intact. Two tables are added: `composed_prompts` (compiler output cache, referenced
by sessions) and `experiment_assignments` (A/B variant tracking per session). The `agents`
table transitions from source of truth to a compiled-agent cache.

### Worker Template (`worker-template.md`)

The authoritative skeleton for SOX-managed worker agents, encoding the pull loop, heartbeat,
handoff structure, and drain signals. After migration, this content is superseded by a set of
`process`, `handoff`, and `invocation` component types in the registry. The template is retired
in the final removal phase. During the migration window it remains as a reference document.

### Tooling (`tools/cli/`)

The sox CLI tools operate on the ticket state machine and are not directly replaced. Several
will be extended to consume registry data:

- `cmd-gate.js` reads policy enforcement config and evidence schema requirements
- `cmd-create.js` reads phase gate criteria from the PHASE table
- `spawner.js` calls the compiler to resolve system prompts before agent instantiation
- A new `sox gate phase` command evaluates `QUALITY_GATE` criteria against current project state

These integrations are implementation concerns for each tool, not for the registry packages.

---

## New Package: agent-provider

**Repository:** `~/dev/node/adhd/packages/ai/agent-provider` (new)
**Package:** `@adhd/agent-provider`
**Relationship:** Extracted from agent-mcp. Owns the provider runtime adapters and the
provider/model registry tables. Sits between agent-mcp-types (interfaces) and agent-mcp
(orchestrator) in the dependency graph.

agent-provider was separated from agent-mcp because the two concerns — how to talk to an AI
API, and how to manage a task — are independently evolvable. New providers (Gemini, Ollama,
Bedrock) are rows in `PROVIDER` plus a new `ProviderAdapter` implementation, with no changes
to the orchestrator. The model catalog lives here as a table (not config) because model
identifiers and capabilities change per platform on a continuous basis.

The `ProviderAdapter` interface is defined in `@adhd/agent-mcp-types` and implemented here.
The existing `ProviderConfig` union (`anthropic | openai | lmstudio | claudecli`) already
provides the generalized shape — the concrete adapter classes in this package implement against
it. The `agent-compiler` package reads `MODEL_PLATFORM_BINDING` and `PROVIDER_TOOL_FORMAT`
from this package's DB domain to resolve model identifiers and emit correctly shaped tool
definitions without importing the full orchestrator.

**Dependency direction:** `agent-mcp-types` ← `agent-provider` ← `agent-mcp`. The compiler
reads from agent-provider; agent-mcp uses agent-provider adapters at runtime. No cycles.

---

## Collaborator: agent-mcp

**Repository:** `~/dev/node/adhd/packages/ai/agent-mcp`
**Package:** `@adhd/agent-mcp`
**Relationship:** Orchestrator only; primary consumer of compiled prompt output; owner of
the runtime sink schema. Collaborator, not a subordinate.

agent-mcp handles session management, task orchestration, tool dispatch, DAG dependencies,
HITL suspension, and streaming. Provider-specific concerns (model resolution, API call
format, streaming adapter) are delegated to `@adhd/agent-provider`. agent-mcp receives a
`ProviderAdapter` instance and calls `adapter.stream()` — it does not know which provider
it is talking to.

### What Changes in agent-mcp

The `AgentStore` (`src/store/agent-store.ts`) currently owns the full agent definition as a
JSON blob with a flat `systemPrompt: string`. After refactor, agent-mcp delegates agent
definition resolution to `@adhd/agent-registry` and `@adhd/agent-compiler`. The `AgentStore`
is either removed or retained as a thin cache layer that stores compiler output. The `agents`
table in agents.db transitions from source of truth to compiled cache.

`AgentDefinition.systemPrompt: string` in `@adhd/agent-mcp-types` is populated from compiler
output rather than user-provided input. The field may be retained as a compatibility shim
during transition or replaced by a `composedPromptId` reference.

### Plugin Architecture — Reuse, Not Replace

The existing plugin system (`src/plugins/loader.ts`) is the right integration point for
policy enforcement hooks. The loader discovers plugins from `agent-mcp.config.json` or the
`AGENT_MCP_PLUGINS` env var, validates config against each plugin's `configSchema`, and calls
`plugin.install(hooks)` to register handlers on the `IHookRegistry`.

The hook distinction already present is directly applicable to policy enforcement:
`hooks.emit()` for observational policy handlers (errors swallowed; violations logged but
not fatal) and `hooks.enforce()` for enforcement handlers (errors propagate to the
orchestrator and fail the task). The `@adhd/agent-policy` package should expose its runtime
enforcement as a plugin following the `@adhd/agent-mcp-budget` reference implementation.

The plugin architecture should be reused or extended — not reimplemented in the registry
packages.

### Platform-Native Tools — Runtime Gap

Granting agents provider/platform-native tools (web search, code execution, native browser, local
built-ins) is covered by this plan only at the **declaration + compile** layer (`AGENT_TOOL` +
`TOOL_PLATFORM_BINDING` + `PROVIDER_TOOL_FORMAT`). The **runtime** half — provider adapters
forwarding compiled platform tools to the API and executing client-side ones — is an agent-mcp
concern that remains open even after the registry lands (e.g. `toAnthropicTools()` does not yet
emit Anthropic server-side tool types). This boundary, the three uncovered native-tool cases, and
the recommended handoff are documented in [`RUNTIME_GAPS.md`](./RUNTIME_GAPS.md) and tracked as
**FEAT-007** in `packages/ai/agent-mcp/BACKLOG.md`.

### `PolicyEngine` (`src/engine/policy.ts`)

Currently enforces three invariants: recursion depth limit, tool call loop limit, and
allowed-agent delegation lists. After migration, these invariants are expressed as `rate`
and `permission` policy templates in `@adhd/agent-policy` and enforced through the existing
`PolicyEngine.check()` interface, which can be extended to read limits from the policy store
rather than from hardcoded `PolicyConfig` values.

### `@adhd/agent-mcp-types`

Defines shared interfaces with no runtime dependencies: `AgentDefinition`, `HookRegistry`,
`ProviderConfig`, `ProviderAdapter`, `StreamChunk`, `Task`, `Session`, `ComposedPrompt`. The
`HookRegistry` class and `ProviderAdapter` interface live here specifically so that
`agent-provider`, `agent-compiler`, and plugin packages can depend on them without a circular
dependency on the full orchestrator package.

`ProviderAdapter` is the abstraction that decouples agent-mcp from concrete provider
implementations. Its presence in `agent-mcp-types` (rather than `agent-provider`) means the
orchestrator can type-check against it without importing `agent-provider` directly.

New types shared between registry packages and agent-mcp — `PromptComponent`,
`ComposedPrompt`, `AgentPolicyAssignment` — should extend `@adhd/agent-mcp-types` following
the same no-circular-dep constraint rather than duplicating the pattern in a new types package.

### `@adhd/agent-mcp-budget`

The reference implementation of the plugin pattern. It demonstrates: Zod `configSchema`
export for config validation, enforcement hook registration, and `PluginContext.db` access.
The `@adhd/agent-policy` package should follow this pattern when exposing runtime enforcement
as an agent-mcp plugin.

---

## Data Consumer: Agent Forge

**Relationship:** Authoring and design tool; consumer of registry read/write API.

Agent Forge is the tooling layer for composing and authoring agents. It consumes the
registry's API to browse existing components, suggest relevant components for a new agent's
purpose based on `COMPONENT_USAGE` data, preview assembled prompts before committing, and
diff agent compositions across versions.

Forge writes back to the registry via the agent CRUD API when creating or modifying agents
and components. It does not own any database tables. The `COMPONENT_USAGE` and `USE_CASE`
tables are the primary data source for Forge's component suggestion feature. The
`COMPOSED_PROMPT` audit trail supports Forge's diff and preview capabilities.

---

## Related Packages in the adhd Monorepo

**`@adhd/agent-mcp-budget`** (`packages/ai/agent-mcp-budget`): Reference plugin showing the
full plugin lifecycle. The canonical pattern for how `@adhd/agent-policy` should expose
runtime enforcement to agent-mcp.

**`@adhd/agent-mcp-types`** (`packages/ai/agent-mcp-types`): Shared type definitions and the
`HookRegistry` implementation. New cross-package types should be evaluated for placement here
vs. a new `@adhd/agent-registry-types` package.

**`@adhd/data`** (`packages/data`): Data access utilities in the monorepo. The Drizzle schema
and migration patterns in `agent-mcp/src/db/` are the reference implementation for how the
registry packages should structure their own schema files.

**`@adhd/shared`** (`packages/shared`): Shared utilities. Evaluate for reuse before adding
utility code to registry packages.

---

## Superseded Systems — Removal Targets

Migration and removal of these systems is in scope as the final phase of this plan. Nothing
is removed until migration tooling verifies zero data loss and runtime compatibility.

| System | Current location | Superseded by |
|---|---|---|
| Agent `.md` files | `claude-agents/categories/` | Registry `AGENT` rows + compiler emit |
| Skill `.md` files | `claude-agents/.claude/skills/` | `PROMPT_COMPONENT` rows (type: process, invocation) |
| `worker-template.md` | `claude-agents/` | Component templates in registry |
| `categories/` directory tree | `claude-agents/categories/` | `TAXONOMY_CATEGORY` + `AGENT` tables |
| `00-active/` symlink roster | `claude-agents/categories/00-active/` | `AGENT.status` + `DEPLOYMENT_MODE` |
| `AgentStore` blob model | `agent-mcp/src/store/agent-store.ts` | `@adhd/agent-registry` + compiler |
| `AgentDefinition.systemPrompt` flat string | `@adhd/agent-mcp-types` | `composed_prompt_id` → compiled content |
| Ad-hoc `tools:` frontmatter lists | All agent `.md` files | `AGENT_TOOL` + `TOOL_PLATFORM_BINDING` |
| Hard-coded policy in frontmatter | All agent `.md` files | `AGENT_POLICY` + `POLICY_TEMPLATE` |
| `docs/catalog/` per-agent files | `claude-agents/docs/catalog/` | `AGENT` metadata + component descriptions |
| `docs/catalog/INDEX.md` | `claude-agents/docs/catalog/` | Registry query API |
