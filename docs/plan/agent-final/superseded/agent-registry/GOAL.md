# Agent Registry — Goal

> **Design-pass notice.** This document articulates motivation and future direction. Specific
> implementations of future capabilities (knowledge graph, SP optimizer, A/B engine) are
> illustrations of generalization value, not designs. Each one requires its own architecture
> pass before implementation.

---

## The Problem With Files

The claude-agents repository defines agents as markdown files with YAML frontmatter. Each file
is a complete, standalone definition: the system prompt is a monolithic text block, tool
permissions are a comma-separated string, and any shared behavior must be manually copied into
every agent that needs it.

This model has three compounding problems:

**Token footprint grows with every improvement.** Every gap we close that involves adding text
to agent definitions — identity blocks, invocation cards, success criteria, handoff templates,
escalation templates — multiplies across every agent that needs it. Adding an identity block to
all 346 agents adds ~52,000–86,000 tokens to the corpus. That cost recurs on every invocation,
for every agent, forever. The system gets more expensive to run as it improves.

**Shared behavior requires N edits.** If the default-skeptic posture rule needs to change —
say, the verdict vocabulary shifts from NEEDS-WORK to REJECT — every reviewer agent file must
be updated. There is no single authoritative source. The same applies to handoff section
templates, escalation formats, success criteria structures, and any other cross-cutting
convention.

**The composition is invisible.** When a reviewer agent is invoked, there is no record of which
version of which component was included in its system prompt. If a behavior changes, there is
no way to audit which prompt change caused it. A/B testing is structurally impossible because
there is only one version of each agent — the file.

agent-mcp has the same problem at the API level: `AgentDefinition.systemPrompt` is a flat
string blob. The database records what was stored, but not what it means or how it was composed.

---

## What the Registry Enables

### Shared Components, Single Authorship

A `rule` component — "Default verdict is NEEDS-WORK. Explicitly justify any PASS verdict." —
is authored once and referenced by every reviewer agent via the junction table. Updating the
rule updates all reviewers in one write. Adding a new reviewer agent means creating an agent
row and inserting junction rows — no copy-paste, no divergence, no 346-file sweep.

The same pattern applies to identity blocks, handoff templates, invocation cards, escalation
templates, convergence patterns, and every other cross-cutting prompt element.

### Runtime Composition and Context Sensitivity

The composition engine assembles the system prompt at invocation time from the ordered set of
components attached to the agent, filtered by context conditions. A code-reviewer invoked in a
security audit context can receive different success criteria than the same agent invoked in a
refactor review — not because two agents were defined, but because context rules specify which
components activate under which conditions.

Agents become adaptive without becoming complex. The authoring surface (individual components)
stays simple; the composition engine handles conditional assembly.

### Platform Portability

The same agent definition compiles to:

- Claude Code YAML frontmatter (`tools: Read, Write, Bash`) via `TOOL_PLATFORM_BINDING[claude_code]`
- Claude API system prompt with a structured `tools` array via `TOOL_PLATFORM_BINDING[claude_api]`
- OpenAI-compatible format via `TOOL_PLATFORM_BINDING[openai]`
- Raw markdown text piped to a file for any bespoke use

The design layer is authored once. The compiler produces platform-specific output. Adding a new
platform means seeding new binding rows, not editing agent definitions.

### Audit Trail

Every invocation writes a `COMPOSED_PROMPT` row capturing the exact content and the component
versions used. When a behavior changes, the audit trail shows which component version changed
and which agents were affected. Quality regressions become traceable.

### A/B Testing

`EXPERIMENT` rows define what is being tested: agent slug, component, control version, variant
version, metric. The compiler assigns sessions to variants at invocation time and records the
assignment. Outcomes are correlated with `TASK_USAGE` metrics (token efficiency, latency, stop
reason, completion rate). Testing whether a more detailed handoff template improves downstream
task quality is a data operation, not a deployment.

### Variable Policy Enforcement

`POLICY_TEMPLATE` rows define governance rules with an explicit enforcement mechanism: `runtime`
(policy engine during task execution), `hook` (agent-mcp enforcement hook — propagates throws),
`settings` (platform or server configuration), `agent` (encoded as a rule component in the
system prompt), `dispatcher` (orchestration or delegation layer), `ci` (lint or validation
script at commit time), `convention` (documented expectation, not programmatically enforced),
or `human` (requires human review). A policy can carry multiple enforcement mechanisms.

This replaces the current model where enforcement is implicit and inconsistent — some rules are
in agent files, some in cmd-gate.js, some in team.yaml, some undocumented.

### Policy Inheritance

Attach a `reviewer-posture` policy to the `04-quality-security` taxonomy category as mandatory.
Every agent in that category gets it, including any agent added in the future, without touching
individual definitions. Category-level policies cascade automatically.

---

## Why It Is More Maintainable

The file-based model couples authoring to storage. To understand what an agent does, you read
its file. To change shared behavior, you edit N files. To add a new agent, you copy a template
and modify it.

The registry decouples these:

- **Authoring:** create or update individual components in isolation
- **Storage:** the database is the authoritative state; files are compiled output
- **Discovery:** query by type, use case, agent slug, or taxonomy category
- **Change propagation:** update a shared component; all agents referencing it pick up the
  change on next compilation
- **Rollback:** pin `version_pin` on a junction row to hold an agent on a previous component
  version while others advance
- **Onboarding:** an engineer who has never seen the repository can compose a new agent from
  existing components without reading another agent's file

---

## Adaptability: Future Use Cases Through Generalization

The data model is designed to grow without restructuring.

### New Prompt Component Types

Adding a new `PROMPT_TYPE` — `chain_of_thought`, `output_schema`, `tool_guidance`,
`few_shot_examples` — requires no schema migration. Seed a row in the lookup table and start
authoring components of that type. The composition engine includes them automatically by
position.

### Knowledge Graph and Component Suggestion Engine

`COMPONENT_USAGE` records which use cases each component is valuable for. `COMPOSED_PROMPT`
records which components were used together in which invocations. `TASK_USAGE` records the
outcome. Over time, this data supports a graph of (component → use_case → outcome) relationships
that can suggest which components to include for a given agent purpose. This is a query layer on
top of existing tables — no schema changes required.

### Task-Based System Prompt Optimizer

`EXPERIMENT` rows plus `TASK_USAGE` outcomes provide the training signal for optimizing
component selection per task type. An optimizer agent can read component candidates from the
registry, read outcome data from task_usage, and propose component reorderings or substitutions
as new `AGENT_COMPONENT` rows with refined context conditions. The registry is the read/write
surface for the optimizer — no new infrastructure needed.

### Dynamic Component Content

Nothing prevents a `PROMPT_COMPONENT.content` from being a template with variables resolved at
composition time rather than static text. The composition engine can interpolate context values
(current phase, ticket type, team size, model ID) into component content as an extension,
without changing the schema.

### Multi-Tenant and Role-Scoped Registries

`POLICY_TEMPLATE.scope_context` can be extended to `tenant | project | team` without
restructuring. Components can be scoped by adding a scope column, allowing organizations to
maintain shared global components alongside project-specific ones. The registry's query API
resolves the correct scope at lookup time.

### Model-Specific Composition

Context rules can condition component inclusion on the model being used. A reasoning model
(opus) can receive a chain-of-thought component that would be redundant on a faster model. The
MODEL and MODEL_PLATFORM_BINDING tables make model-aware composition possible without
branching the agent definition.
