# Agent Registry — Preliminary Data Model

> **Design-pass notice.** This document represents the data model as understood at the end of
> the initial design conversation. It is a requirements document, not a schema specification.
> Every entity, relationship, field name, and domain boundary described here should be
> interrogated and potentially redesigned during the architecture phase for each package.
> The goal is to make the conceptual requirements clear enough in prose that individual package
> architects can make informed decisions without needing to derive intent from a diagram.
>
> In particular: the separation of concerns between packages (which tables live where), the
> DB topology (shared file vs. separate files), context condition evaluation semantics, eager
> vs. lazy policy inheritance, and composition caching strategy are all open decisions that
> this document deliberately does not resolve.

**See also:** [`SEED_DATA.md`](./SEED_DATA.md) — concrete initial values for every lookup
table, shared prompt component (with actual text content), policy template, tool binding,
model binding, and example agent composition described in this document. The seed file maps
each entry to the Z primitive it satisfies and the CA gap it closes.

---

## Domain 1: Prompt Component Registry

**Package: `@adhd/agent-registry`**

This domain answers the question: what text goes into an agent's system prompt, in what order,
and under what conditions?

### Prompt Types

A seeded lookup table that classifies the semantic function of a component. This is intentionally
not a SQL enum — it is a lookup table with a text primary key so new types can be added without
schema migrations. An `is_system` flag distinguishes types that ship as seed data from
project-defined extensions.

Known seed types, each with a distinct semantic role:

- **role** — what the agent fundamentally is ("You are a senior backend developer...")
- **identity** — mission statement, explicit refusal boundaries, communication posture, learning
  note; the accountability block that makes an agent's behavior predictable
- **capability** — domain knowledge and specialization ("You have deep expertise in...")
- **rule** — invariants and hard constraints that must always apply ("Default verdict is
  NEEDS-WORK...", "Never write credentials to files...")
- **style** — tone, formatting conventions, output structure preferences
- **personality** — behavioral characteristics that persist across interaction types
- **process** — step-by-step workflows the agent follows when invoked
- **invocation** — how to activate the agent: trigger phrase, required inputs, expected outputs,
  deliverable format; the activation card a caller reads
- **success_criteria** — typed criteria for evaluating whether the agent's output is acceptable;
  replaces the separate SUCCESS_CRITERIA table — these are prompt components like any other,
  positioned in the assembly order and subject to context conditions
- **handoff** — structure for transferring state between agents (section template for context,
  files changed, deliverable achieved, evidence, next steps)
- **escalation** — format for escalation reports (attempt history, root cause analysis, impact
  assessment, recommended resolution)
- **posture** — default verdict stance for reviewers; a specialized rule type with distinct
  semantics in the quality gate layer
- **boundary** — explicit declarations of what the agent will not do
- **convergence** — patterns for synthesizing N parallel agent outputs into a structured
  decision document
- **deliverable** — output format templates showing what good output looks like concretely

### Prompt Components

The atomic unit of prompt content. Each component has a unique slug for human reference, belongs
to a type, carries text content, and has an integer version that increments on any content change
(old versions are retained for audit and rollback). A component is flagged as shared if it is
expected to be referenced by multiple agents; non-shared components are still first-class rows,
just not candidates for cross-agent reuse.

A component's content is the text that will appear in the assembled system prompt at the
position specified by the junction. Nothing prevents content from containing template variables
resolved at composition time — this is an extension point for dynamic content, though the
composition engine would need explicit support for it.

### Agents

An agent record holds identity metadata: slug (primary key), display name, description, status
(draft, active, deprecated), a model hint (foreign key to the model registry), a reference to
a tool profile or category, a taxonomy category, a default posture (approve vs. needs-work as a
top-level agent flag separate from any posture component), and timestamps. Agents contain no
prompt text — all content arrives through the junction.

An agent can have multiple success criteria sets. Because success criteria are just prompt
components of type `success_criteria`, an agent can have several attached via the junction with
different context conditions — one set for security reviews, another for refactor reviews,
another for design reviews. The composition engine includes whichever set matches the current
context, or all of them if no condition is specified.

### Agent-Component Junction

The junction between agents and components is where assembly order, version pinning, and context
conditions live. Each row specifies:

- Which component belongs to which agent
- The position in assembly order (determines where in the final prompt this component appears)
- A version pin (null means always use the latest version; an explicit integer pins to a specific
  version, enabling one agent to advance while another stays stable)
- A context condition: a JSON structure specifying when this component should be included (e.g.,
  include this success criteria component only when `ticket_type == "security"`). Null means
  always include.
- An `is_required` flag indicating whether the absence of this component (because its condition
  was not met) should be treated as a composition error

The semantics of context condition evaluation — precedence rules, conflict resolution when
multiple components target the same position, merging behavior — are not defined here and
require explicit design as part of the compiler architecture.

### Use Cases and Component Usage

Use cases are named scenarios or task categories: code-review, security-audit, data-migration,
api-design, incident-response. The junction between components and use cases records which
components are valuable in which scenarios, with an optional weight. This annotation layer is
the seed data for a future component suggestion engine and informs the knowledge graph described
in GOAL.md. It is secondary to the composition system and does not affect runtime behavior.

### Context Rules

Free-standing rules for conditional component inclusion at the agent level, managed separately
from junction-level context conditions. A context rule says: "for agent X, when condition Y
is true, additionally include component Z." The relationship between junction conditions and
free-standing context rules is an open design question — they represent the same underlying
need and may be unified in the final architecture.

### Composed Prompts

The runtime output of the composition engine. Each row captures: the agent slug, a hash of the
context inputs used during assembly (enabling cache lookup), the final flat text content sent
to the LLM, and a JSON record of which version of each component was used. This is the audit
trail that makes behavior changes traceable. If the same agent is invoked in the same context,
the same composed prompt can be reused without re-running assembly.

The composed prompt row is the bridge between the design layer and the runtime layer. It is
written by the compiler and read by agent-mcp when starting a session.

---

## Domain 2: Tool Registry

**Package: `@adhd/agent-tool-registry`**

This domain answers: what can an agent use, what is it called on the target platform, and
what does it require?

### Tools

Canonical definitions of agent capabilities, independent of any platform. A tool has a canonical
name (e.g., `file_read`, `shell_exec`, `web_fetch`, `code_edit`, `search_grep`), a type (io,
compute, network, memory, ui, meta, mcp, lsp), a description, a version, and behavioral flags:
`requires_approval` (should a human confirm before execution), `is_destructive` (can this tool
cause data loss or side effects). A tool also carries a list of dependency tool IDs (other
canonical tools that must be available for this tool to function) and a capabilities array
describing what it can do in machine-readable terms for future tooling.

### Platforms

The runtime environments where agents are deployed: `claude_code`, `claude_api`, `openai`,
`bedrock`, `cursor`, `vscode`. Each platform record specifies its header format
(yaml_frontmatter, json_object, or none) and whether it supports explicit tool selection at
the prompt layer.

### Tool-Platform Bindings

The mapping between canonical tools and their platform-specific names and availability. A
binding row specifies: which canonical tool, which platform, the tool name on that platform
(`Bash` on claude_code, `bash_tool` on openai), an availability flag (available, restricted,
unavailable, requires_permission), whether this tool requires an MCP server to function on this
platform, and an invocation note for platform-specific caveats.

This is the table the compiler joins when building the `tools:` header for a target platform.
The MCP server reference (when `requires_mcp` is true) is used to build the `mcpServers` block.

### MCP Servers

Registrations of Model Context Protocol server packages. Each record identifies the server's
transport type (stdio, SSE, HTTP), the canonical tool IDs it provides, and the configuration
schema required to instantiate it (stored as JSON Schema). The compiler uses this when building
the `mcpServers` block in an agent's header.

### Agent-Tool Junctions

Specifies which canonical tools an agent has access to, at what permission level (full,
read-only, restricted), and optionally under what context condition. The compiler joins this
table with tool-platform bindings to construct the `tools:` header and the MCP servers block
for the target platform.

---

## Domain 2b: Provider Registry

**Package: `@adhd/agent-provider`**

This domain answers: which AI providers exist, what models do they expose, how do models map
across platforms, and how does each provider expect tools to be submitted?

This package was extracted from `agent-mcp` because the provider system and the orchestrator
are separable concerns. The orchestrator uses a provider; it does not need to own one. Extracting
also eliminates the circular dependency that would arise if `agent-compiler` imported `agent-mcp`
to resolve model identifiers at compile time.

### Providers

A seeded table of AI API providers: Anthropic, OpenAI, AWS Bedrock, LMStudio, ClaudeCLI. Each
row records the provider's transport type (HTTP, stdio), authentication pattern, and base URL
or endpoint template. The concrete runtime adapters (classes that implement `ProviderAdapter`)
live in this package alongside the DB tables.

### Models

Canonical model records independent of any provider's naming. Each row carries a canonical
identifier (e.g., `claude_sonnet_4_6`, `claude_opus_4_8`), context window size, output token
limit, capability flags (vision, prompt caching, extended thinking), and a pricing tier. Models
are stored in a table rather than config because they are updated continuously per platform and
queried at both compile time (model resolution) and runtime (capability checks).

`AGENT.model_hint` is a foreign key to this table. The compiler resolves it to the correct
provider-specific identifier at emit time via `MODEL_PLATFORM_BINDING`.

### Model-Platform Bindings

Maps canonical model IDs to provider-specific strings: `claude-sonnet-4-6` on the Anthropic
API, `sonnet` as the Claude Code alias, the corresponding Bedrock model ARN, the OpenAI
equivalent. One row per (model, platform) pair. Updated independently of schema migrations
when providers release new model versions or rename identifiers.

### Provider Tool Formats

Each provider expects tools to be submitted in a different schema shape — Anthropic's tool
definition differs from OpenAI's function definition, which differs from Bedrock's Converse
API format. `PROVIDER_TOOL_FORMAT` records the schema shape per provider so the compiler can
emit correctly structured tool definitions for the target platform without hardcoding format
logic per provider.

### ProviderAdapter Interface

The `ProviderAdapter` interface is defined in `@adhd/agent-mcp-types` (to avoid circular
dependencies) and implemented in this package. The interface is intentionally minimal:

```typescript
interface ProviderAdapter {
  stream(messages, tools, model): AsyncIterable<StreamChunk>
}
```

The existing `ProviderConfig` union in `agent-mcp-types` (`anthropic | openai | lmstudio |
claudecli`) already generalizes the shape of provider configuration. The concrete adapter
classes in this package implement `ProviderAdapter` using those configs and the provider
registry tables for runtime resolution.

---

## Domain 3: Policy Management

**Package: `@adhd/agent-policy`**

This domain answers: what can an agent do, what must it do, what must it never do, and who
enforces these constraints?

### Policy Types

A seeded lookup: `permission` (what tools or actions are allowed), `safety` (what content or
actions are forbidden), `audit` (what must be logged or traced), `rate` (token, call, or time
limits), `scope` (accessible file paths or network domains), `compliance` (regulatory
requirements). Extensible without migrations.

### Policy Templates

Reusable rule definitions. Each template has a slug, a type, a description, and a `rules`
field carrying the structured policy content as a JSON document. The critical field is
`enforcement`, which declares the mechanism (or mechanisms) by which this policy is enforced.
Valid values:

- **runtime** — enforced by the policy engine during task execution (throws on violation,
  propagated to the orchestrator)
- **hook** — enforced via the agent-mcp hook system using enforcement handlers (errors
  propagate; a buggy hook kills the task, not just logs)
- **settings** — enforced via platform or server configuration (e.g., an agent-mcp config
  block, a Claude Code settings.json entry)
- **agent** — encoded as a `rule` type prompt component in the agent's system prompt (the LLM
  is instructed, not code-checked; weakest enforcement)
- **dispatcher** — enforced by the orchestration or delegation layer before a sub-agent is
  called
- **ci** — enforced by a lint or validation script at commit or deploy time
- **convention** — documented expectation with no programmatic enforcement
- **human** — requires a human review step

A policy can carry multiple enforcement values — a `no-credentials` safety policy might be
enforced both as an `agent` rule (LLM instructed) and as a `ci` check (committed files
scanned). Templates have a version field and an `is_system` flag for seed data.

### Agent-Policy Junctions

Attach policies to agents. Each row records: which agent, which policy, optional override
configuration (agent-specific parameter values that customize the template, e.g., a specific
max-rework count), whether the policy is mandatory (cannot be removed by downstream
configuration), and where it was inherited from (taxonomy category slug, or null if applied
directly to the agent).

Category-level policy inheritance works by propagating assignments to all agents in the
category. Whether this fanout is eager (rows written at attachment time) or lazy (resolved at
query time) is an open implementation decision with tradeoffs in query complexity vs. write
amplification.

The compiler reads agent-policy rows when building the permissions block in a compiled header
and when deciding which rule components to include automatically.

---

## Domain 4: Workflow Structures

**Package: `@adhd/agent-registry` or a dedicated `@adhd/workflow-registry`** (TBD)

This domain answers: how are agents sequenced into multi-step processes?

### Playbooks

Named, versioned activation procedures for a class of work. A playbook is a sequence of phases,
each with an associated quality gate. Within each phase, steps specify: which agent to invoke,
in what order (or in what parallel group), which invocation component to use (the activation
card for that step), and whether the step is a convergence point where parallel outputs are
synthesized before proceeding.

### Runbooks

Scenario-specific instantiations of playbooks. A runbook references a parent playbook and
carries a set of component overrides — specific components substituted for the defaults in the
playbook steps. This allows a single `feature-development` playbook to have `startup-mvp`,
`enterprise-feature`, and `regulated-environment` runbooks using the same agent sequence but
with context-appropriate components.

### Deployment Modes

Named configurations for active agent subsets: `full`, `sprint`, `micro`, `investigation`.
Each mode specifies which taxonomy categories are active, a default playbook, and optionally
an explicit agent roster. The SOX supervisor reads the current deployment mode to determine
which agents it is authorized to spawn.

### Strategy and Phases

A strategy record represents the project-level progression model (one per project). Phases are
ordered stages within a strategy, each with a quality gate defining machine-readable promotion
criteria. The phase gate is what `sox gate phase` evaluates — a structured set of criteria that
must all be satisfied before the project advances. This makes `strategy.md` a database concern
rather than a prose document.

---

## Domain 5: Runtime Sink

**Package: `@adhd/agent-mcp`** (existing, extended)

This domain is owned by agent-mcp, documented here as the downstream consumer of the design
layer.

The runtime sink receives compiled prompts from the compiler and records all execution. The
existing schema (agents, sessions, tasks, task_usage, task_events, messages) remains largely
intact. Two tables are added:

**Composed prompt cache.** Each row captures the compiled content for an agent+context
combination. The `sessions` table gains a `composed_prompt_id` foreign key. When a session
starts, the runtime checks whether a valid cached composed prompt exists (same agent, same
context hash, component versions not superseded by a newer pin) before calling the compiler.

**Experiment assignments.** Each row links a session to an experiment variant (control or
variant). After the task completes, the runtime correlates `task_usage` metrics with the
assignment to accumulate experiment outcome data.

The `agents` table transitions from source-of-truth to a compiled-agent cache: its `data`
blob (currently containing `systemPrompt` as a flat string) is populated from compiler output
rather than authored directly. The source of truth for agent definitions moves to the registry.

---

## Cross-Domain Design Decisions (Open)

These decisions are explicitly deferred to the architecture phase for each package. They are
listed here so architects are not surprised by them.

**DB topology.** Should all packages share one SQLite file (simpler cross-package joins,
harder isolation) or use separate files joined via ATTACH DATABASE (better isolation, more
complex compile-time queries)? A single file with table-name prefixes per package is a
pragmatic middle ground.

**Cross-package query at compile time.** The compiler must join tables from agent-registry,
agent-tool-registry, agent-provider, and agent-policy simultaneously. The join strategy follows
from the DB topology decision above.

**Context condition evaluation semantics.** When multiple components target the same position
with different conditions, and more than one condition is satisfied, which component wins?
Or are all included? This needs an explicit rule to avoid non-deterministic assembly.

**Eager vs. lazy policy inheritance.** Fanout at category attachment time (eager) makes policy
queries fast but requires migration when agents move categories. Lazy resolution (join at query
time) is always accurate but adds join complexity and requires careful caching.

**Component versioning across agents.** If component X v2 is released and agent A pins to v1
while agent B takes latest, what happens when the category-level policy that references X v1
is evaluated against agent B? Version pinning semantics need to be consistent across junction
rows, policy references, and experiment definitions.

**Plugin architecture reuse.** The agent-mcp plugin system (`createPlugin` / `IHookRegistry`)
is a candidate for policy enforcement hooks. The decision of whether `@adhd/agent-policy`
registers as a plugin (and thus requires agent-mcp as a peer) or exposes a standalone
enforcement API that agent-mcp calls directly affects the dependency graph.
