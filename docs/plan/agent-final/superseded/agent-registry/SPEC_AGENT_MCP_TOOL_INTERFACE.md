# SPEC — agent-mcp Registry-Backed Tool Interface

> **Status:** Ratified design spec. This is the authoritative target surface.
> **Supersedes:** the first-pass design in `AGENT_MCP_TOOL_INTERFACE.md` (api-designer stab)
> on the points called out in §13. Where the two disagree, **this doc wins**.
> **Grounded against:** `packages/ai/agent-mcp/src/server.ts`, `tools/agent-crud.ts`,
> `tools/session.ts`, `agent-mcp-types/src/domain.ts`, `packages/ai/agent-registry/src/store/*`,
> `seed/prompt-types.ts`, and Plan 6 (`docs/plan/agent-mcp-refactor/`).
> **Audience:** the planner authoring the agent-mcp authoring/discovery plan; reviewers.

---

## 0. One-paragraph summary

agent-mcp stays a **runtime** ("run agents") with the existing 11-tool hot path **unchanged**.
Plan 6 makes the runtime registry-backed (system prompt resolved via `compileAgent` + cache).
On top of that, this spec adds a **definition lane** so an agent — not just a human CLI — can
*compose* agents from registry components. The authoring agent writes only
`{name, type, content, shared}`; the registry **auto-enriches** every component (embedding,
use-case linkage, weights, summary) so discovery is free. Composition is two idempotent
declarative upserts (`agent_define`, `component_define`) plus a read-rich discovery surface
(`component_search`, `prompt_types_list`, `tool_list`, `model_list`, `policy_list`, …). Identity
is **`name`** everywhere; `slug` never appears on the wire.

---

## 1. Principles (the constraints that shaped every decision)

1. **Runtime-first center of gravity.** agent-mcp is about running agents. Definition management
   is a second, clearly-separated lane — never bloats the runtime path.
2. **Small-model invariance (the graded bar).** The journey a small/local model walks to *run*
   an agent (`agent → task → result`) keeps the same tool count, same required-arg count, same
   shapes as 1.0.1. Definition/discovery tools are **not** in the 11-tool delegation surface, so a
   haiku running a task never sees them.
3. **`name` is the identity key.** Surface speaks `name`; the registry's internal `slug` is an
   implementation detail (`slug = toSlug(name)`), never on the wire.
4. **Write-thin, read-rich.** Two declarative upsert tools mutate state (`agent_define`,
   `component_define`). Everything else an agent needs is read/list/search — safe, cheap, and the
   precondition for composition.
5. **Auto-enrichment over manual filing.** An authoring agent contributes content; the registry
   files it (embedding, use-case linkage, weights, summary) deterministically on write — the
   `memory_write` enrichment pattern. No agent hand-assigns weights or use-cases.
6. **Declarative idempotence.** `agent_define` / `component_define` are upserts keyed by `name`:
   create-or-replace, version-bumped, idempotent on no-change. No `ALREADY_EXISTS` create/patch
   dance.

---

## 2. The three lanes

| Lane | Tools | In delegation surface? | Who uses it |
|---|---|---|---|
| **Runtime (hot path)** | `agent`, `task`, `result`, `task_list`, `task_cancel`, `task_resume`, `session_list`, `session_close`, `session_clear`, `usage_query`, `guide` | **yes (all 11)** | any model, incl. small/local |
| **Discovery (read)** | `component_search`, `component_read`, `component_consumers`, `prompt_types_list`, `tool_list`, `model_list`, `policy_list`, `usecase_list`, `agent_read`, `agent_list`, `agent_compile` | no | composing agents, operators |
| **Authoring (write, upsert)** | `agent_define`, `component_define` | no | composing agents, operators |

Runtime is **unchanged** except one backward-compatible extension to `agent` (§5.1).
`agent_create` / `agent_update` are **retained as deprecated compat shims** (§9), not in the table
above as first-class authoring tools — new authoring uses `agent_define`.

---

## 3. Identity — `name`, not `slug` (and the refactor it implies)

- Every tool references agents and components by **`name`**: `agent_define({name})`,
  `component_define({name})`, `component_search → [{name,…}]`, `agent({name})`, `task({agent_name})`.
- Internal mapping: `slug = name.toLowerCase().replace(/\s+/g,'-')` (identity if already slug-form),
  computed at the tool boundary. No `slug` on any wire schema, in any tool output, or in `guide`.
- **Refactor surface (a finding, not a no-op):** the registry stores currently expose `slug` in
  their *public* types — `PromptComponent.slug`, `ComponentCreateInput.slug`,
  `UseCaseStore.linkComponent(componentSlug, …)`, `componentsFor(useCaseSlug)`,
  `TaxonomyStore` category slugs. Honoring "name on the surface" means the agent-mcp tool layer
  translates `name↔slug`; the stores may keep `slug` internally, but **no slug leaks through the
  MCP boundary**. The planner must add the translation seam, not just an alias comment.

---

## 4. What changes underneath (Plan 6 = agent-mcp-refactor, already authored)

This spec builds on Plan 6, which:
- **`compiler-integration`** — on session start, resolve the system prompt via `compileAgent`
  (from `@adhd/agent-compiler`) through a `composed_prompts` cache keyed by `(agent, context_hash)`;
  on miss compile + upsert; set `sessions.composed_prompt_id`.
- **`agent-store-retire`** — the flat-`systemPrompt` source-of-truth is gone; `AgentDefinition.systemPrompt`
  becomes an optional computed compat shim; `AgentStore` becomes a thin compiled-agent cache.

The hole Plan 6 leaves — *nothing composes an agent from components over MCP* — is exactly what
§5–§7 fill.

---

## 5. Authoring tools (full spec)

### 5.1 `agent` — session start, backward-compatible extension (runtime lane)

```typescript
// Input
{
  name: string;                       // required — identity key (unchanged)
  platform?: string;                  // optional, default "claude_code"
  context?: Record<string, string>;   // optional, default {}
}
// Output: { session_id: string }     // unchanged
// Errors: AGENT_NOT_FOUND
```

`platform` + `context` feed `resolveComposedPrompt(name, platform, context)` → `context_hash`.
**Invariant:** `agent({name})` is identical to `agent({name, platform:"claude_code", context:{}})`.
**Required-arg count stays 1.** This is the *only* runtime-lane change.

### 5.2 `agent_define` — declarative upsert (authoring lane, primary)

`agent_define` is the single tool that composes an agent. It **supersedes** flat `agent_create`/
`agent_update` for registry-backed agents.

```typescript
// Input — the FULL desired state of the agent
{
  name: string;                       // required — identity key
  description?: string;
  model: string;                      // required — model name (resolved via model_list)
  components: Array<{                  // required — the composition, in assembly order
    name: string;                     // component name (must exist; author via component_define)
    position: number;                 // assembly order
    context_condition?: Record<string, string>;  // optional — conditional inclusion
    version_pin?: number;             // optional — null/omitted = latest
    required?: boolean;               // optional, default true
  }>;
  tools?: string[];                   // optional — tool names to grant (resolved via tool_list)
  policy?: string[];                  // optional — policy names to attach (resolved via policy_list)
}

// Output
{
  name: string;
  version: number;                    // bumped iff the resolved composition changed
  composed_prompt_id: string | null;  // cache id of the compiled preview
  compiled_preview: string;           // the assembled prompt (for inspection before running)
  changed: boolean;                   // false => idempotent no-op (spec matched current state)
}

// Errors
// COMPONENT_NOT_FOUND   — a named component isn't in the registry
// TOOL_NOT_FOUND        — a named tool isn't grantable on this platform
// POLICY_NOT_FOUND      — a named policy doesn't exist
// MODEL_NOT_FOUND       — the model name isn't bound in the provider registry
```

**Upsert semantics (ratified):**
- **Create-or-replace.** If `name` doesn't exist → create. If it exists → replace its composition
  with the supplied spec (**full replace of `components`/`tools`/`policy`, not a merge** — the spec
  *is* the desired state).
- **Version-bumped.** A changed resolved composition bumps `version` and invalidates the
  `composed_prompt` cache (new `context_hash`). Open sessions are unaffected (they snapshot at
  creation — existing agent-mcp semantics).
- **Idempotent.** Identical spec in → `changed:false`, no version bump (content-hash compare).
- **Granting is declarative.** `tools`/`policy` are carried *by name inside the spec*; there is no
  free-floating `tool_grant`/`model_bind`/`policy_attach` MCP verb (keeps the surface small and
  keeps privilege grants inside the reviewed agent definition).
- `agent_update` survives only as ergonomic read-modify-write sugar; it is not the primary path.

### 5.3 `component_define` — declarative upsert + auto-enrichment (authoring lane)

```typescript
// Input — the authoring agent writes ONLY content-bearing fields
{
  name: string;                       // required — identity key (upsert key)
  type: string;                       // required — one of prompt_types_list() (role|rule|capability|…)
  content: string;                    // required — the prompt text
  shared?: boolean;                   // optional, default false — reusable by other agents
}

// Output
{
  name: string;
  version: number;                    // bumped iff content changed
  summary: string;                    // AUTO-derived (extractive one-liner)
  use_cases: Array<{ name: string; weight: number }>;  // AUTO-resolved linkage
  changed: boolean;
}

// Errors
// INVALID_TYPE — type not in prompt_types
```

**Auto-enrichment pipeline (runs on write, NOT agent-specified):**
1. **embed** `content`;
2. **resolve use-cases** by similarity against use-case anchor embeddings → write weighted
   `ComponentUsageRow`s (the `weight` = similarity score);
3. **auto-summarize** (extractive) → `summary`.

**Upsert semantics:** keyed by `name`; create-or-replace; version-bumped on content change;
idempotent on identical content (re-define of identical content must NOT churn the index — the
enrichment is cached/deterministic). Editing a `shared:true` component recompiles every consumer
(check blast radius first with `component_consumers`).

**What the agent never supplies:** use-cases, weights, summary, embedding. *Write content, get
discovery for free.*

---

## 6. Discovery tools (full spec) — the vocabulary an agent needs to compose

### 6.1 `prompt_types_list` — the grammar (the slots + order)

```typescript
// Input: {}
// Output
{ types: Array<{ name: string; description: string; position: number }> }
// e.g. role, identity, capability, rule, style, personality, process, invocation,
//      success_criteria, handoff, escalation — the canonical assembly skeleton.
```
This is *how an agent knows what shape an agent can be*. Sourced from `PROMPT_TYPES`
(rows, not an enum — `[inv:lookup-not-enum]`).

### 6.2 `component_search` — semantic discovery (primary; replaces manual taxonomy navigation)

```typescript
// Input
{
  query: string;                      // required — the task intent / need (the task packet text)
  type?: string;                      // optional — restrict to one prompt type (fills one slot)
  shared?: boolean;                   // optional — only shared / only private
  limit?: number;                     // optional, default 10
}
// Output — ranked, auto-weighted; cheap (summary, not full content)
{ results: Array<{ name: string; type: string; summary: string; score: number; shared: boolean }> }
```
The registry resolves `query → use-cases → components` internally via the same embedding that filed
each component. The agent fills each grammar slot from these ranked results, then reads full content
only for finalists.

### 6.3 `component_read` — full content (commit-time inspection)

```typescript
// Input: { name: string }
// Output: { name, type, content, shared, version, summary, use_cases:[{name,weight}] }
// Errors: COMPONENT_NOT_FOUND
```

### 6.4 `component_consumers` — blast radius

```typescript
// Input: { name: string }
// Output: { name, consumers: Array<{ agent_name: string; position: number }> }
```
Call before editing a shared component — shows which agents recompile.

### 6.5 Substrate vocabularies — `tool_list`, `model_list`, `policy_list`

```typescript
tool_list({ platform?: string })
// → { tools: Array<{ name: string; description: string; platforms: string[] }> }

model_list({})
// → { models: Array<{ name: string; provider: string; notes?: string }> }

policy_list({})
// → { policies: Array<{ name: string; description: string; config_shape?: object }> }
```
These let the agent put valid `tools`/`model`/`policy` *names* into `agent_define`. **Read-only and
mandatory** — without them the agent can't write a valid spec. (Granting/binding/attaching remain
declarative inside `agent_define`; these tools only *describe the vocabulary*.)

### 6.6 `usecase_list` — optional introspection

```typescript
// Input: {}
// Output: { use_cases: Array<{ name: string; description: string; component_count: number }> }
```
Demoted to introspection/overlay. The agent's primary path is `component_search` (use-case
resolution is internal machinery), but `usecase_list` exposes the taxonomy for humans/auditing.

### 6.7 `agent_read` / `agent_list` / `agent_compile`

```typescript
agent_read({ name })
// → { name, description, version, model, components:[…], tools:[…], policy:[…],
//     composed_prompt_id, systemPrompt? }   // resolved view, not a stored blob

agent_list({})
// → { agents: Array<{ name, version, component_count, model }> }

agent_compile({ name, platform?, context? })
// → { name, content, composed_prompt_id, cache: "HIT" | "MISS" }   // force compile / preview
```

---

## 7. The composition use-case — task packet → agent shape

The driving scenario: an orchestrating agent receives a task packet and must instantiate a
sub-agent using only what's in the registry.

**Task packet:** *"Audit this OpenAPI spec for security + versioning defects; emit JSON findings
keyed by severity."*

```jsonc
// Phase 1 — learn the grammar (what shapes are valid)
prompt_types_list()
// → slots + order: role, identity, capability, rule, style, process, success_criteria, …

// Phase 2 — semantic discovery: one call per slot, auto-ranked (use-cases resolved internally)
component_search({ query: "audit OpenAPI spec for security & versioning, JSON findings", type: "role" })
// → [{ name:"api-auditor", summary:"…", score:0.91 }, …]
component_search({ query: "…", type: "rule" })
// → [{ name:"security-skeptic", score:0.95 }, { name:"versioning-rules", score:0.71 }, …]
component_search({ query: "…", type: "capability" })   // → openapi-expertise (0.83)
component_search({ query: "…", type: "process" })       // → audit-checklist (0.64)
component_search({ query: "…", type: "success_criteria" }) // → json-findings (0.9)

// Phase 3 — read full content only for the finalists
component_read({ name: "security-skeptic" })

// Phase 4 — pick the substrate
tool_list({ platform: "claude_code" })   // needs file+grep → Read, Grep
model_list()                             // deterministic audit → "sonnet"
policy_list()                            // bulk run → "rate-limit"

// Phase 5 — assemble: one declarative upsert
agent_define({
  name: "oas-auditor",
  model: "sonnet",
  components: [
    { name: "api-auditor",       position: 1 },   // role
    { name: "openapi-expertise", position: 2 },   // capability
    { name: "security-skeptic",  position: 3 },   // rule
    { name: "versioning-rules",  position: 4 },   // rule
    { name: "audit-checklist",   position: 5 },   // process
    { name: "json-findings",     position: 6 }    // success_criteria
  ],
  tools:  ["Read", "Grep"],
  policy: ["rate-limit"]
})
// → { name, version:1, compiled_preview, composed_prompt_id, changed:true }

// Phase 6 — verify + run
agent_compile({ name: "oas-auditor" })            // sanity-check assembled prompt
agent({ name: "oas-auditor" }) → task({ session_id, prompt })
```

**Why each discovery tool is load-bearing:** `prompt_types_list` supplies the *skeleton*;
`component_search` supplies *auto-ranked candidates without reading every body*;
`tool_list`/`model_list`/`policy_list` supply the *substrate vocabulary*. Remove any and the agent
is blind at that phase — composition becomes impossible. If a needed component is **absent**, the
agent authors it (`component_define`) and the enrichment pipeline files it for the next composer.

---

## 8. Small-model preservation analysis

| | 1.0.1 | This spec |
|---|---|---|
| Hot-path tools to run an agent | 3 (`agent_create`,`agent`,`task`) | 3 — or **2** when agent pre-authored |
| `agent`/session-start required args | 1 | 1 (unchanged; `platform`/`context` optional) |
| Delegation surface (what a sub-agent sees) | 11 | **11 (unchanged)** |
| Definition/discovery tools in delegation surface | n/a | **0** |

A small/local model *running a task* sees the same 11 tools it sees today. The discovery/authoring
lanes are loaded only by an agent explicitly tasked with *composing*. **The graded bar holds.**

---

## 9. Compat story — retired flat `systemPrompt`

`agent_create` and `agent_update` are retained as **deprecated compat shims** (no sunset):
- `agent_create({name, provider, systemPrompt})` still works → the flat prompt is wrapped as one
  private inline component (`<name>-inline-<n>`) and composed; behavior identical to today.
- Omitting `systemPrompt` with no components → `COMPILE_NO_COMPONENTS` surfaced at **session start**
  (`agent`), not at create time (preserves create-first/attach-later).
- `systemPrompt` and a component list are **mutually exclusive** → `VALIDATION_ERROR`.
- `guide` text updates to show `systemPrompt` as optional + the deprecation note.

---

## 10. New infrastructure this requires (findings — not tweaks)

1. **Component enrichment pipeline** (`component_define` write path): embed content → match
   use-case anchors → write weighted links → auto-summary. Must be cached/deterministic
   (idempotent re-define). *Does not exist today* — components store `{slug,type,content,isShared}`
   with no embedding, and `UseCaseStore.linkComponent` is a manual weighted insert.
2. **Use-case anchor embeddings** — use-cases need embeddings so component/query resolution has a
   target. New seed/enrichment step.
3. **`name↔slug` translation seam** at the agent-mcp tool boundary (§3) — the stores speak `slug`;
   the wire speaks `name`.
4. **Discovery read tools over the registry stores** — `component_search` (semantic),
   `tool_list`/`model_list`/`policy_list`/`prompt_types_list`/`usecase_list`/`component_consumers`.
5. **`agent_define` composition writer** — transactional upsert across registry+tool+provider+policy
   stores, returning a compiled preview.

These are plan-level additions → a new plan (provisionally **Plan 8: agent-mcp-authoring**),
sequenced after Plan 6's runtime wiring, overlapping Plan 7's corpus import.

---

## 11. Versioning

`agent-mcp@2.0.0`. The required→optional change to `agent_create.systemPrompt` is breaking for
strict-schema callers even though behaviorally additive. `systemPrompt` remains a supported
permanent compat shim across 2.x. Upgrade from 1.0.1 is drop-in for existing runtime callers
(no new required args anywhere on the hot path).

---

## 12. Tool-count summary

- **Runtime (hot path):** 11 — unchanged.
- **Discovery (read):** 11 — `component_search`, `component_read`, `component_consumers`,
  `prompt_types_list`, `tool_list`, `model_list`, `policy_list`, `usecase_list`, `agent_read`,
  `agent_list`, `agent_compile`.
- **Authoring (write upsert):** 2 — `agent_define`, `component_define`.
- **Deprecated compat:** 2 — `agent_create`, `agent_update`.

Read-heavy, write-thin. Every discovery tool is justified by a phase of §7; every write is a single
declarative idempotent upsert.

---

## 13. Where this supersedes the api-designer stab

| Topic | Stab (`AGENT_MCP_TOOL_INTERFACE.md`) | This spec |
|---|---|---|
| Listing components / tools / models / policies | CLI-only | **MCP discovery lane (mandatory)** — agents can't compose blind |
| Use-case linkage | manual / out of scope | **auto-resolved on `component_define`** |
| Discovery model | navigate taxonomy manually | **`component_search` semantic, one call/slot** |
| Primary author tool | `component_define` (attach-centric) + flat `agent_create` | **`agent_define` upsert** + content-only `component_define` |
| Shared-component edit over MCP | no (CLI-only) | **yes** (`component_define` upsert by name) |
| Identity | `name` surface, `slug` internal (alias) | `name` surface + **explicit translation seam refactor** |
| `agent_define` semantics | (not specified) | **declarative create-or-replace upsert, version-bumped, idempotent** |

The stab's correct contributions are kept: hot-path invariance, `agent` `platform`/`context` as
safe-default optionals, the `systemPrompt` compat shim, and `agent-mcp@2.0.0`.

---

## 14. Decisions ratified

- **A — Discovery is on MCP, not CLI-only.** Agents must read the full vocabulary
  (`component_search` + `*_list`) to compose. ✅
- **B — `agent` gains optional `platform`/`context`** with safe defaults; `agent({name})` invariant. ✅
- **C — Authoring is two declarative upserts** (`agent_define`, `component_define`); grants/binds
  are declarative-by-reference inside `agent_define`, not standalone verbs. ✅
- **D — Use-case linkage + weights + summary are auto-derived** on `component_define`; never
  agent-supplied. ✅
- **E — Identity is `name`**; `slug` never on the wire; translation seam is a real refactor. ✅
- **F — `agent-mcp@2.0.0`**; flat `systemPrompt` is a permanent compat shim. ✅

---

## 15. `guide` text (target rendering)

### Runtime section (unchanged from 1.0.1 — "Running agents")
> *No change. The 3-step `agent_create`/`agent` → `task` → `result` workflow and all runtime tools
> render exactly as today. A small model reads only this section.*

### Authoring section (new — "Composing agents from components")

```markdown
## Composing agents from components (optional — only if you are BUILDING an agent)

If the agent you need already exists, skip this — just `agent({name})` then `task(...)`.
This section is for assembling a NEW agent from the registry's components.

An agent is composed from typed **components** (role, rule, capability, process, …).
You write a component's content; the registry files it (summary, use-cases, weights) for you.

### 1. Learn the shape
prompt_types_list()                       // the typed slots + their order

### 2. Find components for your task (auto-ranked — no manual browsing)
component_search({ query: "<your task>", type: "role" })   // one call per slot you need
component_read({ name: "<finalist>" })                      // full content for the ones you'll use

### 3. Pick the substrate
tool_list({ platform: "claude_code" })    // grantable tools
model_list()                              // bindable models
policy_list()                             // attachable policies

### 4. Assemble (one declarative call — create or update)
agent_define({
  name: "my-agent", model: "sonnet",
  components: [ { name: "...", position: 1 }, ... ],
  tools: ["Read","Grep"], policy: ["rate-limit"]
})                                        // → compiled_preview, composed_prompt_id

### 5. Author a missing component (the registry indexes it automatically)
component_define({ name: "my-rule", type: "rule", content: "Always ..." })

### 6. Check blast radius before editing a SHARED component
component_consumers({ name: "shared-rule" })   // which agents recompile if you change it

Then run it like any agent: agent({ name: "my-agent" }) → task({ session_id, prompt }).
```
