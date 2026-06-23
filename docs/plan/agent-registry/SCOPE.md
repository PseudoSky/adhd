# Agent Registry — Scope

> **Design-pass notice.** This document describes intent and boundary, not final architecture.
> Every section is a requirement statement, not a specification. Package boundaries, DB ownership,
> schema details, and migration sequencing all require dedicated architecture sessions before
> implementation begins. Any part of this proposal should be remodeled more effectively when
> the time comes — the goal here is to represent the idea clearly enough that individual parts
> can be handed off for proper design.

---

## What This Plan Does

Designs and implements a database-backed, composable prompt management system that replaces the
current file-per-agent model used across the claude-agents repository and the flat `systemPrompt`
blob stored by agent-mcp.

Concretely, the plan covers:

- A normalized relational schema decomposing agent system prompts into typed, ordered, versioned
  prompt components
- A composition engine that assembles components into a final system prompt at invocation time,
  conditioned on runtime context
- A tool registry normalizing platform-specific tool names (e.g. `Bash` on Claude Code,
  `shell_exec` as the canonical form) with per-platform binding tables
- A model registry following the same pattern (canonical model IDs → platform aliases)
- A policy management system replacing ad-hoc permission blocks with typed, inheritable,
  variably-enforced policy templates
- A CLI / programmatic API capable of emitting raw markdown text suitable for piping directly
  to `.md` files, making output consumable by existing claude-code and SOX tooling without disruption
- A refactor of agent-mcp so it consumes from the agent-registry rather than owning its own
  agent store and flat systemPrompt blob
- Migration tooling to import existing `.md` agent files and skills into the new schema
- A final removal phase retiring all superseded file-based systems listed below

---

## What This Plan Does Not Do

- Define the runtime execution engine (agent-mcp owns this; the registry is a design-time and
  compile-time concern)
- Replace the SOX ticket state machine, supervisor loop, or channel infrastructure
- Define the A/B testing evaluation methodology (the schema supports it; the analytics layer
  is a separate project)
- Implement a knowledge graph or SP optimizer (these are future consumers of the registry
  data model, described in GOAL.md)
- Migrate agent logic or behavior — only the storage and composition layer changes
- Define MCP server implementations (those remain in agent-mcp and its plugin packages)
- Design the agent-forge authoring UI (forge is a consumer of registry output, not a component
  of this plan)

---

## Package Boundaries (Preliminary)

The system should be split into independently versioned packages where each package owns its
schema migrations and its slice of the database. The exact ownership topology — whether packages
share a single SQLite file with namespaced tables, use separate files joined via ATTACH DATABASE,
or communicate through an in-process API — requires a dedicated architecture decision. This
boundary sketch is not a contract.

| Package | Responsibility | DB domain |
|---|---|---|
| `@adhd/agent-registry` | Agents, prompt components, composition, context rules, use cases | agents, prompt_components, agent_components, context_rules, use_cases, composed_prompts |
| `@adhd/agent-tool-registry` | Canonical tool catalog, platform definitions, tool-platform bindings, MCP servers | tools, platforms, tool_platform_bindings, mcp_servers, agent_tools |
| `@adhd/agent-provider` | Provider runtimes, model catalog, model-platform bindings, provider tool format schemas | providers, models, model_platform_bindings, provider_tool_formats |
| `@adhd/agent-policy` | Policy templates, agent policy assignments, inheritance | policy_types, policy_templates, agent_policy |
| `@adhd/agent-compiler` | Composition engine: reads registry + tool + provider + policy, emits header + body | (consumer; writes composed_prompt cache to runtime DB) |
| `@adhd/agent-mcp` | Orchestrator only: sessions, tool dispatch, DAG, HITL, streaming — delegates provider calls to agent-provider adapters | sessions, tasks, task_usage, task_events, messages, experiment_assignments |
| `@adhd/agent-mcp-types` | Shared interfaces: `ProviderAdapter`, `IHookRegistry`, `AgentDefinition`, `StreamChunk`, `ComposedPrompt` | (no DB) |

The plugin architecture already present in agent-mcp (the `createPlugin` / `IHookRegistry`
pattern) should be reused where applicable — particularly for policy enforcement hooks that
need to fire inside the agent-mcp execution path — rather than reimplemented.

---

## Systems Replaced

Migration and removal of the following systems is explicitly in scope as a final phase,
executed after migration tooling verifies zero data loss and runtime compatibility.

### Category Folders (`categories/`)

The `categories/01-core-development/` through `categories/10-research-analysis/` directory
trees, plus all specialized subdirectories (`cto-system/`, `design/`, `workflow/`,
`marketing-skills/`, `trading/`, etc.), are replaced by `TAXONOMY_CATEGORY` and `AGENT`
rows in the registry. The directory naming convention (`01-`, `02-` numeric prefixes) is
replaced by structured category metadata with explicit ordering. The `00-active/` symlink
roster is replaced by agent status flags and deployment mode configuration.

### Static Agent `.md` Files

All agent definition files under `categories/` (346 non-README files at the time of writing)
are superseded. After migration, agents are defined in the database and emitted as `.md` files
on demand by the compiler CLI:

```bash
agent-registry compile my-agent --platform claude_code > ~/.claude/agents/my-agent.md
```

The `.md` format remains a supported output format for compatibility with Claude Code's agent
resolver. The format is not retired — the files are.

### Skills and Non-Code Plugins

All non-code plugin files — skills (`.claude/skills/*/SKILL.md`), invocation cards, runbook
templates, handoff templates, escalation templates, convergence patterns — are superseded by
`PROMPT_COMPONENT` rows of the appropriate type. The content and intent of each skill is
preserved; the storage format moves to the database. The `.claude/skills/` directory is retired
in the final removal phase.

### agent-mcp Internal Agent Registry

`AgentStore` (currently `packages/ai/agent-mcp/src/store/agent-store.ts`) stores agents as a
JSON blob with a flat `systemPrompt: string`. This is superseded by `@adhd/agent-registry`
plus `@adhd/agent-compiler`. agent-mcp is refactored to delegate agent CRUD and prompt
compilation to those packages, retaining only execution-layer concerns: sessions, tasks, tool
dispatch, DAG orchestration, HITL, streaming.

### Flat `systemPrompt` in `AgentDefinition`

`AgentDefinition.systemPrompt: string` in `@adhd/agent-mcp-types` is replaced by a reference
to a `composed_prompt_id` resolved at session start. The field may be retained as a computed
compatibility shim during the transition window.

### Ad-hoc Policy in Agent Frontmatter

Permission lists currently embedded in agent `.md` frontmatter (`tools:` comma strings,
`allowedAgents:` arrays) are superseded by `AGENT_TOOL` and `AGENT_POLICY` tables. The compiler
reconstructs the correct frontmatter representation from these tables at emit time, per platform.

### `worker-template.md`

The worker template is the current authoritative skeleton for new SOX-managed agent files. After
migration it is superseded by the component library — the `process`, `handoff`, and `invocation`
component types encode the same conventions. The file is retired in the final removal phase.

---

## Out of Scope for This Plan

- The claude-agents workflow plugin system (`.workflow/`, workflow-architect, plan-orchestrator)
- SOX channel infrastructure, ticket routing, supervisor daemon behavior
- API surface design for the registry HTTP/MCP interface
- Embedding-based similarity search for component deduplication
- The catalog authoring tools (workflow:workflow-agent-builder, curator) — these become consumers
  of the registry write API, but their redesign is a separate concern
