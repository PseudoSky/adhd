# agent-mcp Registry-Backed Tool Interface Design

> **Status:** Decision-ready design doc. Review and ratify or amend before any plan is authored.
> Every claim about the current surface is grounded against the real source files:
> `packages/ai/agent-mcp/src/server.ts`, `tools/agent-crud.ts`, `tools/session.ts`,
> `agent-mcp-types/src/domain.ts`, and the Plan 6 contexts in `docs/plan/agent-mcp-refactor/`.

---

## 1. Target Tool Surface — Keep / Change / Add / Deprecate

### Authoritative 1.0.1 Tool Count

The shipped server (`server.ts:548–633`) registers exactly **17 tools**: `agent_create`, `agent_read`,
`agent_update`, `agent_delete`, `agent_list`, `agent`, `session_list`, `session_close`,
`session_clear`, `task`, `task_list`, `task_cancel`, `task_resume`, `result`, `usage_query`, `guide`.

The in-process recursive client (`server.ts:419–478`) exposes a subset of 11 for agent-to-agent
delegation: `agent`, `task`, `result`, `task_list`, `task_cancel`, `task_resume`, `session_list`,
`session_close`, `session_clear`, `usage_query`, `guide`. Notably the 5 `agent_*` CRUD tools are
absent from the delegation surface — a design choice that is preserved here.

### Disposition Table

| # | Tool | Disposition | Notes |
|---|------|-------------|-------|
| 1 | `agent` | **KEEP, minor extension** | Add optional `platform` + `context` params for `context_hash`. Safe-default contract: `agent({name})` must still work for small models. See §3. |
| 2 | `task` | **KEEP, unchanged** | No schema change. The `agent_name` ephemeral mode already works without a prior session. |
| 3 | `result` | **KEEP, unchanged** | Input: `{task_id}`. |
| 4 | `task_list` | **KEEP, unchanged** | |
| 5 | `task_cancel` | **KEEP, unchanged** | |
| 6 | `task_resume` | **KEEP, unchanged** | |
| 7 | `session_list` | **KEEP, unchanged** | |
| 8 | `session_close` | **KEEP, unchanged** | |
| 9 | `session_clear` | **KEEP, unchanged** | |
| 10 | `usage_query` | **KEEP, unchanged** | |
| 11 | `guide` | **KEEP, updated text** | Updated usage guide text to reflect registry-backed authoring; no schema change. |
| 12 | `agent_create` | **CHANGED** | `systemPrompt` becomes optional (compat shim per Plan 6 decision 3); adds optional `components` shorthand (see below). Registry-backed agents need no `systemPrompt`. |
| 13 | `agent_read` | **KEEP, output extended** | Returns existing `AgentDefinition`. Optionally includes `composed_prompt_id` and computed `systemPrompt` field when available. |
| 14 | `agent_update` | **CHANGED** | `patch.systemPrompt` becomes optional (same compat shim). New optional `patch.components` shorthand. |
| 15 | `agent_delete` | **KEEP, unchanged** | `{name, force?}` — no change. |
| 16 | `agent_list` | **KEEP, unchanged** | |
| 17 | `component_define` | **ADD** | Composite "define + attach components to an agent" tool. See §2 and §6 for the boundary rationale. |

**Total hot-path tools: 11 (unchanged).** Total tool count goes from 17 to 18 (one net addition).

---

### Changed Tool Schemas (Full Specification)

#### `agent` — session start, extended

```typescript
// Input (Zod equivalent)
{
  name: string;              // required — the agent's identity key
  platform?: string;         // optional, default "claude_code"
  context?: Record<string, string>;  // optional, default {}
}

// Output (unchanged)
{ session_id: string /* uuid */ }

// Errors (unchanged)
// AGENT_NOT_FOUND — no agent with that name
// SESSION_CLOSED  — impossible here (session is new)
```

`platform` and `context` feed `resolveComposedPrompt(agentSlug, platform, context)` as specified
in Plan 6 `compiler-integration`. Both are optional with safe defaults so `agent({name: "foo"})`
is identical to `agent({name: "foo", platform: "claude_code", context: {}})`.

**Required-arg count: 1 (unchanged from 1.0.1).** Small models see one required arg, exactly as
before. The two new args are never required.

#### `agent_create` — registry-aware, systemPrompt optional

```typescript
// Input
{
  name: string;              // required
  description?: string;      // optional
  provider: ProviderConfig;  // required — provider+model binding
  systemPrompt?: string;     // OPTIONAL (was required in 1.0.1) — compat shim only;
                             // populated from compileAgent() at session start if omitted
  mcpServers?: Record<string, McpServerConfig>;  // optional, default {}
  permissions?: AgentPermissions;                // optional, default {}
  maxToolLoops?: number;     // optional
  allowHumanInput?: boolean; // optional

  // NEW optional shorthand — attach named components at create time
  // If supplied, these are resolved against the registry and stored as
  // agent_components rows. Mutually exclusive with an authored systemPrompt.
  components?: Array<{
    name: string;            // component slug
    position: number;        // assembly order
    context_condition?: Record<string, string>;  // optional context condition
    version_pin?: number;    // optional — null = latest
  }>;
}

// Output (unchanged shape)
AgentDefinition  // systemPrompt field is present as computed compat shim when resolved

// Errors
// AGENT_ALREADY_EXISTS
// COMPONENT_NOT_FOUND — if a named component doesn't exist in the registry
// VALIDATION_ERROR    — if both systemPrompt and components are supplied
```

**Required-arg count: 2 (`name`, `provider`) — was 4 in 1.0.1 (`name`, `provider`, `systemPrompt`,
`mcpServers`).** The removal of the `systemPrompt` required field is actually a small-model UX
improvement: fewer required fields.

#### `agent_update` — patch schema follows same compat

```typescript
// Input (unchanged wrapper)
{
  name: string;  // required
  patch: {
    description?: string;
    provider?: ProviderConfig;
    systemPrompt?: string;    // OPTIONAL (compat shim only)
    mcpServers?: Record<string, McpServerConfig>;
    permissions?: AgentPermissions;
    maxToolLoops?: number;
    allowHumanInput?: boolean;
    // NEW optional shorthand
    components?: Array<{
      name: string;
      position: number;
      context_condition?: Record<string, string>;
      version_pin?: number;
    }>;
  };
}

// Output: updated AgentDefinition
// Errors: AGENT_NOT_FOUND, COMPONENT_NOT_FOUND
```

#### `component_define` — new composite authoring tool

Full schema and rationale in §6. Summary:

```typescript
// Input
{
  // Required
  agentName: string;           // which agent to attach to (by name)

  // Component definition
  component: {
    slug: string;              // unique identifier
    type: string;              // "role" | "rule" | "capability" | "style" | ... (registry types)
    content: string;           // the prompt text
    shared?: boolean;          // default false — if true, reusable by other agents
  };

  // Attachment
  position: number;            // assembly order within this agent
  context_condition?: Record<string, string>;  // optional
  version_pin?: number;        // optional

  // Optionally override rather than create a new component
  existingComponentSlug?: string;  // if set, attach an existing component without re-creating
}

// Output
{
  component_slug: string;
  agent_name: string;
  position: number;
  status: "created_and_attached" | "attached";
}

// Errors
// AGENT_NOT_FOUND
// COMPONENT_ALREADY_EXISTS  — if slug taken and existingComponentSlug not used
// COMPONENT_NOT_FOUND       — if existingComponentSlug given but doesn't exist
```

---

## 2. The Execution / Definition Seam

### Two Lanes, One Server

**Runtime lane (hot path) — 11 tools:**
`agent`, `task`, `result`, `task_list`, `task_cancel`, `task_resume`,
`session_list`, `session_close`, `session_clear`, `usage_query`, `guide`

**Definition-management lane — 7 tools:**
`agent_create`, `agent_read`, `agent_update`, `agent_delete`, `agent_list`,
`component_define`, and (in §6 design) `component_define` only

These lanes are separated by a different cognitive contract: runtime tools act on sessions and
tasks by ID. Definition tools act on named agents and named components. The nouns alone signal
which lane a model is in.

### Mechanism: the `guide` tool as progressive-disclosure gateway

The `guide` tool today contains the full usage narrative (`server.ts:147–408`). After the
registry-backed refactor it should separate into two sections:

**Section 1 — "Running agents" (11 tools).** The cognitive load that any small model needs.
This section is unchanged in length and complexity from 1.0.1.

**Section 2 — "Authoring agents" (7 tools).** Introduced as a clearly labelled optional
section that a model can skip if it already has the agents it needs. The words "you probably
don't need this section" are in the section header.

This is the progressive-disclosure mechanism: no new capability gate, no toolset toggle, just
structured prose. Small models that call `guide` first read Section 1, see the 3-step workflow
(create or assume-exists → `agent` → `task`), and proceed. They are never exposed to the
definition-management complexity unless they scroll or are explicitly given the authoring task.

### Granularity Justification — Composite vs. Many Granular Authoring Tools

The registry's full data model has 5 distinct authoring concerns: component CRUD, agent-component
junctions, tool grants, model/provider binding, and policy attach. The design question (per
constraint #3) is whether each maps to its own MCP tool.

**Recommendation: do not expose all 5 as independent MCP tools.** Rationale:

1. The blast radius for small-model confusion scales with tool count, not just required-arg count.
   Five new granular tools (e.g. `tool_grant`, `model_bind`, `policy_attach`, `component_create`,
   `component_attach`) add 5 new decision points every time a model processes the tool list.

2. The common authoring scenario an agent would perform is "build a new agent from components" —
   a task that currently requires: `agent_create` + N×`component_create` + N×`component_attach`
   + optional `tool_grant` + optional `policy_attach`. Forcing a small model to orchestrate 10+
   serial tool calls for a simple author-then-run pattern violates constraint #3.

3. `component_define` as a single composite tool covers the dominant authoring path (define a
   component and attach it to an agent) in one call. Tool grants and policy attach are
   less common and can be deferred to a CLI/kernel surface (§6) without blocking the primary
   author-then-run workflow.

The right test: "Can a small model author a new agent and run it in 3–5 tool calls?" With this
design the answer is yes: `agent_create({name, provider})` → `component_define` (×N for
components) → `agent({name})` → `task({session_id, prompt})`. That is comparable to the old
workflow: `agent_create({name, provider, systemPrompt})` → `agent({name})` → `task(...)`.

---

## 3. Small-Model Preservation Analysis

### Before (agent-mcp@1.0.1)

**Hot-path tool count for "run an agent":** 3 tools touched (`agent_create`, `agent`, `task`)

**`agent_create` required args:** 4 — `name`, `provider`, `systemPrompt`, `mcpServers`

**`agent` required args:** 1 — `name`

**`task` required args:** varies by mode; session mode needs `session_id` + `prompt` (2);
ephemeral mode needs `agent_name` + `prompt` (2)

**Hot-path required-arg budget:** `agent_create(4)` + `agent(1)` + `task(2)` = **7 required args**
across the 3-call session-backed workflow, or `agent_create(4)` + `task(2)` = **6** for ephemeral.

The guide documents this explicitly (server.ts:196–222 — "Workflow 1").

### After (registry-backed)

**Hot-path tool count: 3 (unchanged).** The same 3 tools, the same order.

**`agent_create` required args: 2** — `name`, `provider`. (`systemPrompt` becomes optional;
`mcpServers` was already `default {}` in Zod and effectively optional for basic use).

**`agent` required args: 1 (unchanged).** `platform` and `context` are optional with safe
defaults.

**`task` required args: 2 (unchanged).**

**Hot-path required-arg budget:** `agent_create(2)` + `agent(1)` + `task(2)` = **5 required
args** — two fewer than today. Small-model cognitive load strictly decreases on the hot path.

### The Registry-Backed "Run an Agent" Journey (Small Model)

```
// Assume an agent already exists in the registry with components attached
// The model has only these 3 tools in scope for this workflow

agent_create({ name: "api-reviewer", provider: { type: "anthropic", model: "claude-haiku-4-5" } })
// → AgentDefinition (systemPrompt computed from registry at session start)

agent({ name: "api-reviewer" })
// → { session_id: "abc-123" }

task({ session_id: "abc-123", prompt: "Review this API design: ..." })
// → { task_id: "t-456", status: "completed", result: "..." }
```

The model calls the same 3 tools in the same order as today. The only visible change is that
`agent_create` needs fewer args, making it easier, not harder.

### If the Agent Already Exists in the Registry

If an agent was authored via the CLI or kernel (the recommended path for production agents, §6),
the small model skips `agent_create` entirely:

```
agent({ name: "api-reviewer" })
// → { session_id: "abc-123" }

task({ session_id: "abc-123", prompt: "..." })
// → { task_id: "t-456", status: "completed", result: "..." }
```

**Hot-path shrinks to 2 tools** when agents are pre-authored. This is the ideal production
steady state: agents are defined once by operators, and models consume them.

### `platform` and `context` on `agent` — safe-default proof

The session-start resolver (`compiler-integration` plan) needs `(agentSlug, platform, context)`
to compute `context_hash`. Both new params default internally:

- `platform` defaults to `"claude_code"` — the same platform every existing caller implies today.
- `context` defaults to `{}` — an empty context, matching today's single-variant behavior.

A small model calling `agent({name: "foo"})` gets identical behavior to today: the resolver
computes `context_hash = SHA256("claude_code" + sorted(componentVersions) + "{}")` and uses
the cached prompt. No behavioral change, no new required arg.

---

## 4. The Compat Story for Retired Flat `systemPrompt`

### The Gap

`agent_create` today requires `systemPrompt: string` (confirmed: `validation/agent.ts:99` —
`systemPrompt: z.string()`). `agent-store-retire` (Plan 6) changes this to `.optional()`.
Any caller that omits `systemPrompt` after the change continues working. Any caller that still
passes it also continues working — the value is accepted as the `[def:compat-shim]`.

### The Compat-Shim Contract

Per `decisions.md` Decision 3:

1. If the caller passes `systemPrompt`, the value is stored and used as the resolved
   `compileAgent` output for that agent. Session start skips the registry lookup and uses the
   stored string directly. This is the **inline compat path** — the agent behaves exactly as
   it does today.

2. If the caller omits `systemPrompt` and the agent has components in the registry, the resolver
   calls `compileAgent(agentSlug, platform, context)` at session start and populates
   `AgentDefinition.systemPrompt` from the returned `content`. This is the **registry path**.

3. If the caller omits `systemPrompt` and the agent has NO components in the registry, the
   resolver should return a meaningful error: `COMPILE_MISSING_COMPONENTS — agent "X" has no
   prompt components and no inline systemPrompt`. This error is surfaced at session start
   (`agent` tool), not at `agent_create` time, to preserve the "create first, attach later"
   authoring pattern.

### Flat Prompt → Inline Component (Migration Upgrade Path)

A caller that previously used `systemPrompt: "You are a code reviewer..."` can optionally
upgrade to the component model without CLI tooling by using the new `components` shorthand on
`agent_create`:

```typescript
// Old — still works after the change
agent_create({
  name: "reviewer",
  provider: { type: "anthropic", model: "claude-haiku-4-5" },
  systemPrompt: "You are a code reviewer..."
})

// New — equivalent, uses component model
agent_create({
  name: "reviewer",
  provider: { type: "anthropic", model: "claude-haiku-4-5" },
  components: [{ name: "my-reviewer-role", position: 1, content: "You are a code reviewer..." }]
})
```

The `components` shorthand on `agent_create` is syntactic sugar that: (a) creates an
auto-named private component (slug derived from `agentName + "-inline-" + position`), and (b)
attaches it via the `agent_components` junction. The resulting compiled prompt is identical to
the old inline string. The component is non-shared by default (private to this agent).

**`systemPrompt` and `components` are mutually exclusive** in the input schema (validated at
the tool layer). Using both is a `VALIDATION_ERROR`.

### Guide Doc Update

The `agent_create` example in `server.ts` USAGE_GUIDE (currently shows `systemPrompt` as
required) must be updated to show the optional pattern and document the compat shim. This is
tracked as a doc change in Plan 6 (`agent-store-retire` notes, BACKLOG.md ref) but is now
specified here to be unambiguous.

---

## 5. Identity: `name` is the Surface Key

**Surface identity is `name`, always.** Every MCP tool that references an agent uses `name`:
`agent_create({name})`, `agent({name})`, `agent_read({name})`, `agent_update({name, patch})`,
`agent_delete({name})`, `component_define({agentName})`, `task({agent_name})` (ephemeral mode).

**The registry internally uses `slug`.** The mapping is simple and one-directional: `slug =
name.toLowerCase().replace(/\s+/g, '-')` (or identity if already slug-form). No slug appears
on any MCP tool surface. No caller ever needs to know a slug exists.

The `resolveComposedPrompt` implementation (Plan 6 `compiler-integration`) calls `compileAgent`
with `agentSlug` — this is an internal concern: `agentSlug = toSlug(agentName)` in the
prompt-resolver, invisible to MCP callers.

This matches the constraint: "agent-mcp keys agents by `name`; keep `name` as the public
identity across authoring, compile, and runtime."

---

## 6. Component Authoring Over MCP — The Open Fork Resolved

### The Tension

The product framing states two things simultaneously:
- "agent-mcp is about ONE thing: running agents" — keep execution-management as the center.
- The owner leans "agent-managed" — agents should be able to author, not just consume.

If we take both seriously, the question is not "should definition power exist in agent-mcp at
all?" but "what is the minimal definition surface that enables agent-authored agents without
shifting agent-mcp's center of gravity?"

### Recommendation: One Composite Tool, Not a Full Registry Surface

**Expose `component_define` as a single MCP tool. Do not expose the full registry surface
(component CRUD, tool-grant, model-bind, policy-attach) as MCP tools.**

Justification:

**For constraint #1 (agent-mcp is a runtime, not a registry):**
`component_define` is a tool with a runtime purpose — it lets an orchestrating agent build
sub-agents at runtime, which is a legitimate orchestration pattern (the delegation system already
supports this). The tool's implementation calls into the registry as a side-effect, but the
intent is "enable an agent to instantiate another agent". That is a runtime concern with a
definition side-effect, not a registry-management operation.

Exposing `component_list`, `component_read`, `component_delete`, `tool_grant`, `model_bind`,
`policy_attach` as MCP tools crosses from "enable runtime orchestration" into "turn agent-mcp
into a registry management API". That would shift the center of gravity and bloat the tool list.

**For constraint #3 (small-model usability):**
`component_define` adds 1 tool that small models will never see unless they are explicitly
given an authoring task. Adding 6–8 granular registry tools to the tool list is the failure mode.
The composite approach caps the definition-management surface at 7 total tools (the existing 5
`agent_*` plus the new `component_define`, plus `agent_create`'s `components` shorthand which
is not a new tool).

**For the "agent-managed" use case:**
An orchestrating agent that needs to dynamically create a sub-agent for a specialized task can:
1. `agent_create({name, provider})` — define the agent shell.
2. `component_define({agentName, component: {slug, type, content}, position})` — attach
   the role/rule/capability components it needs.
3. `agent({name})` → `task({session_id, prompt})` — run it.

This is the "agent-managed" capability the owner wants. It works with 4–5 tool calls. It does
not require exposing the full registry surface.

### What Lives Outside agent-mcp

The following operations are CLI/kernel-only and are NOT exposed as MCP tools:

- `component list` / `component read` / `component delete` — registry browsing and maintenance.
- `tool_grant` / `tool_revoke` — security-sensitive; should require explicit operator action.
- `model_bind` / `policy_attach` — configuration operations with infrastructure implications.
- `agent-registry compile` — the CLI command for emitting `.md` files.

These are operators' tools, not runtime agent tools. They belong in the `@adhd/agent-registry`
CLI, not in agent-mcp's MCP surface.

### The Concrete Boundary

| Operation | Surface | Rationale |
|-----------|---------|-----------|
| Create an agent shell | `agent_create` MCP tool | Core — enables dynamic sub-agents |
| Attach prompt components | `component_define` MCP tool, or `agent_create.components` shorthand | Minimal author-then-run surface |
| Read an agent definition | `agent_read` MCP tool | Needed for introspection |
| List agents | `agent_list` MCP tool | Needed for delegation routing |
| Browse component library | CLI only (`agent-registry components list`) | Registry management, not runtime |
| Grant tools to an agent | CLI only | Security-sensitive operator action |
| Bind model/provider | Via `agent_create.provider` field | Already part of the existing schema |
| Attach policies | CLI only (`agent-policy attach`) | Infrastructure config |
| Compile to `.md` | CLI only (`agent-registry compile`) | Emit artifact, not runtime |

### Handling the "Shared Component Reuse" Case

The `component_define` tool accepts `existingComponentSlug` to attach a pre-existing shared
component without creating a new one. This is how an orchestrating agent can reuse library
components (e.g. attach the shared `default-skeptic` rule component to a dynamically-created
reviewer) without needing a `component_read` tool.

If an agent needs to discover available shared components, `agent_read` on an existing agent
reveals its attached components' slugs — this is a lightweight discovery path. Full component
browsing stays in the CLI.

---

## 7. Migration and Versioning

### Is This a Major Version?

**Yes, agent-mcp@2.0.0** — because `agent_create` changes a previously-required field
(`systemPrompt: string`) to optional. Under semver this is breaking for any caller that
relied on the field being validated as present (e.g. a TypeScript caller passing a
discriminated union against the schema shape). In practice the behavioral change is additive
(fewer required args = no runtime break for existing callers that still pass `systemPrompt`),
but the schema change is technically breaking.

**The compat window:** `systemPrompt` continues to work as the inline compat shim for the
entire 2.x lifecycle. Callers need not change anything. This is not a hard cut — it is a
flag-day-free migration where old callers keep working and new callers get the component model.

### Rolling Forward for Small-Model Integrations

Small models using agent-mcp@1.0.1 that call `agent_create({name, provider, systemPrompt, ...})`
see zero behavioral change after upgrading to 2.0.0:
- `systemPrompt` is now optional but still accepted — no schema rejection.
- The agent behaves identically.
- No new required args anywhere on the hot path.

The upgrade from 1.0.1 to 2.0.0 is a drop-in for existing integrations.

### Deprecation Notice

In 2.0.0: `AgentDefinition.systemPrompt` as an **authored** field is soft-deprecated. The field
remains in the output of `agent_read` / `agent_list` (populated from compiled output). The USAGE
_GUIDE will note: "Passing `systemPrompt` directly is a compatibility path; prefer defining
components using `component_define` or the `components` shorthand on `agent_create` for
composable, registry-tracked agents."

No forced migration. No sunset date on the compat shim. The authoring path (pass `systemPrompt`)
is a supported permanent compat mechanism, not a temporary shim with a deadline.

---

## Decisions Requested

The following forks require explicit ratification or amendment before any plan execution begins.

**Decision A (§2 — Granularity):** Ratify or amend the recommendation to expose exactly one new
MCP tool (`component_define`) as the definition-authoring surface, rather than a full granular
registry surface. Specifically: does the owner accept that `tool_grant`, `model_bind`, and
`policy_attach` remain CLI-only and are never MCP tools in the 2.x lifecycle?

**Decision B (§3 — Small-model hot path):** Ratify or amend the `agent` tool extension adding
optional `platform` and `context` params. These are required by the `context_hash` resolver
but must remain optional with safe defaults. Confirm that `agent({name})` with no other args
is the supported small-model call pattern and that the resolver must never fail on it.

**Decision C (§6 — agent-managed boundary):** Ratify or amend the boundary table in §6. The
specific fork: should `component_define` also accept an `existingComponentSlug` to attach
pre-existing library components, or should shared-component attachment remain CLI-only?
(This document recommends allowing it — it is the critical enabler for the agent-managed pattern
without exposing a full browse API.)

**Decision D (§7 — Versioning):** Ratify or amend the recommendation to version this as
`agent-mcp@2.0.0`. The alternative is to call it a non-breaking minor (`1.2.0`) on the grounds
that `systemPrompt` becoming optional is purely additive. The counter-argument is that callers
with strict schema validation may break. Which semver position does the owner want to take?
