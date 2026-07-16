# Agent + Dispatch — How the Systems Actually Connect

**Written:** 2026-07-16 · **Status:** verified against code, not design intent

Every box/edge below was verified by reading source or `nx graph` — not inferred from a
plan doc. Plans describe *intent*; this describes *reality*. Where they disagree, the
plan is wrong.

---

## 1. CURRENT STATE (as of 2026-07-16)

```
                 ┌───────────────────────────────────────────────┐
                 │  Orchestrating agent / human                  │
                 └────┬──────────────────────────────┬───────────┘
                      │                              │
        ┌─────────────▼───────────────┐  ┌───────────▼─────────────────────┐
        │ DISPATCH SYSTEM             │  │ agents-full-workflow            │
        │ docs/plan/dispatch-         │  │ (RESEARCH doc, NO state.json)   │
        │ completion · LIVE 0/24      │  │                                 │
        │                             │  │  opencode (ADK)                 │
        │  dag.json                   │  │    • creates worktrees          │
        │    └→ dispatch-base-spec    │  │    • agent_task(background:true,│
        │         validate/snapshot   │  │        depends_on:[...])        │
        │    └→ dispatch-core-        │  │    • polls agent_result         │
        │         optimizer (pack)    │  │                                 │
        │    └→ dispatch-core-client  │  │  ⚠️ COLLISION #1                │
        │         DagClient  ⚠DAG-B   │  │  Same job as DISPATCH, built on │
        │    └→ dispatch-orchestrator │  │  agent-mcp's NATIVE DagEngine   │
        │         agent-runner.ts     │  │  instead of the dispatch stack. │
        │         IDispatchAgentRunner│  └───────────┬─────────────────────┘
        │         ensureAgent/fire/   │              │
        │         poll/cancel         │              │
        └─────────────┬───────────────┘              │
                      │                              │
                      │  ❌ MCP WIRE ONLY            │
                      │  JSON-RPC over stdio.        │
                      │  agent-runner.ts:13-16       │
                      │  DELIBERATELY avoids a TS    │
                      │  dep; mirrors wire types     │
                      │  locally at :19-102.         │
                      │  Hand-parses `[CODE] msg`    │
                      │  (:181,338-350) + provider   │
                      │  translation (:224-253).     │
                      ▼                              ▼
        ┌───────────────────────────────────────────────────────────┐
        │ entrypoint/agent-mcp                        (THE HOST)    │
        │                                                           │
        │  server.ts   thin router, zero leaks                   ✅ │
        │  index.ts    hand-assembled dep graph                  ❌ │
        │                                                           │
        │  ⚠️ store/agent-store.ts:20-152  AgentStore               │
        │      152 lines of REAL persistence + business rules       │
        │      (AGENT_ALREADY_EXISTS, AGENT_HAS_ACTIVE_SESSIONS,    │
        │       version bump, patch-merge) — STRANDED IN THE HOST   │
        │  ⚠️ db/schema.ts:3-9  agents(name)  ← RUNTIME agent       │
        └───────────────────────────┬───────────────────────────────┘
                                    │
                                    ▼
        ┌───────────────────────────────────────────────────────────┐
        │ agent-engine-orchestrator        "THE CLIENT" (incomplete)│
        │                                                           │
        │  Orchestrator · PolicyEngine · HookRegistry               │
        │  BackgroundQueue · McpClientRegistry · providers          │
        │  DagEngine  ⚠️ DAG-A  (task-level depends_on)             │
        │                                                           │
        │  agentCrud (agent-crud.ts:9-15) — INTERFACE ONLY,      ❌ │
        │      never implemented. Impl lives in the HOST above.     │
        │  no createAgentEngineClient() factory                  ❌ │
        └──┬──────────────────┬───────────────────┬────────────────┘
           │                  │                   │
           ▼                  ▼                   ▼
   ┌──────────────┐  ┌──────────────────┐  ┌─────────────────────────┐
   │store-runtime │  │ store-prompts    │  │ engine-compiler         │
   │              │  │ = THE REGISTRY   │  │ COMPILE-TIME ONLY       │
   │ sessions     │  │                  │  │                         │
   │  .agentName  │  │ registry_        │  │ resolves ─┐             │
   │  ❌ NO FK!   │  │  components      │  │           │             │
   │ tasks        │  │  use_cases       │  └───────────┼─────────────┘
   │ messages     │  │  agents(SLUG)    │              │
   │ task_usage   │  │  compositions    │              ▼
   │ task_events  │  │  composed_prompts│   ┌────────────────────────┐
   │              │  │                  │   │ core-policy            │
   │ ⚠️ DEAD      │  │ ❌ NO embeddings │   │ core-provider (SEEDED) │
   │ composed_    │  │    NO vectors    │   │ store-tools            │
   │ prompts      │  │    NO semantic   │   │                        │
   │ :99-115      │  │    search        │   │ ❌ RESOLVED, THEN      │
   │ 0 consumers  │  │                  │   │    THROWN AWAY         │
   └──────────────┘  └──────────────────┘   └────────────────────────┘
```

### The registry is DECORATIVE — it gates nothing

| Registry | Intent | Reality | Evidence |
|---|---|---|---|
| `core-policy` | per-agent/category rate + permission rules | `policyTemplateRules` **never set** → `undefined` → `readRateLimit`/`readPermissionAllowlist` no-op. Compiler renders policies as **prose in the system prompt** — advisory text a model may ignore. Real enforcement = `ADHD_AGENT_*` env vars. | `index.ts:148-151`, `policy.ts:22-46`, `resolve/policy.ts:57-60` |
| `core-provider` | DB-backed provider/model/binding registry, **seeded** | **Zero runtime consumers.** Provider resolution = hardcoded env vars + `switch` on 3 literal types. | `config.ts:70-86,208-242`, `factory.ts:8-26` |
| `store-tools` | per-agent tool grants + permission levels | `toResolveResult` **discards `compiled.tools`**. Runtime gating uses static `allowedTools` from `agent_create`. | `prompt-resolver.ts:46-48`, `registry.ts:123-136` |

---

## 2. NOT COLLISIONS — intended design (tested and refuted)

These *look* like competing concepts. They are not. Each was checked against the design
docs and the code; each is deliberate. **Do not "fix" them.**

**A — Two DAGs are two ALTITUDES, not a duplication.**
`DagEngine` (`dag-engine.ts:35`) is agent-mcp's **runtime task-dependency** engine
(`taskId`, `enqueue`, `cancel`). Dispatch's `dag.json` + `DagClient` + optimizer is a
**planning/packing/cost** structure. Dispatch's optimizer **collapses its DAG before the
agent boundary** — `optimize.ts:6-11` partitions eligible milestones by shape+tier and
next-fit packs them until the context window fills, emitting flat `DispatchUnit`s.
Dispatch never sends `depends_on`/`background` (zero hits in `agent-runner.ts`); it fires
flat ephemeral **synchronous** tasks. **agent-mcp never sees a DAG.** They cannot contend.

**B — `agents.name` vs `registry_agents.slug` is a SPECIFIED seam, not a conflation.**
`DATA_MODEL.md:78` makes slug the registry PK. Plan 8's `name-slug-seam` owns the bridge:
`registry/name-slug.ts` (`toSlug()`) + `registry/registry-bridge.ts` translate `name→slug`
inbound and **strip `slug`** outbound, so no slug ever appears on the wire
(`inv:no-slug-on-wire`). Explicitly additive — "the registry stores keep their `slug`
vocabulary byte-for-byte". Two identities is the design: **runtime** agent vs **authored**
agent.

**C — Policy-as-prompt-text is a DESIGNED mechanism, not decoration.**
`DATA_MODEL.md:270-283` defines an 8-value `enforcement` enum: `runtime`, `hook`,
`settings`, **`agent`** ("encoded as a `rule` type prompt component in the agent's system
prompt … the LLM is instructed, not code-checked; *weakest enforcement*"), `dispatcher`,
`ci`, `convention`, `human`. The compiler rendering policy prose into the system prompt
**IS** the `agent` mechanism, working as specified. `enforcement` is a JSON **array**
(`agent-core-policy/src/db/schema.ts:23-27`, `[inv:enforcement-is-array]`) — a policy can
declare several.

**D — Plugins have zero static importers BY DESIGN.**
`agent-core-policy/plugin` (`RatePolicyPlugin`) and `agent-plugin-sanitize` are `Plugin`
implementations loaded **by name at runtime** via `loadExternalPlugins`
(`loader.ts:260-281`) from `agent-mcp.config.json` `plugins:[{module,config}]` or
`ADHD_AGENT_PLUGINS`. Which plugins load is a **deployment** decision, not a code one.
Counting host imports is the wrong test — `agent-plugin-budget`'s single "reference" is
just its e2e test. Same shape as `agent-generator-plugin` (an `nx g` generator).

**E — `enforcement` is DESCRIPTIVE metadata, not a wiring directive.**
A seeded row like `{rules:{check_at:'cmd_gate_changes_requested',
escalation_target:'janitor'}, enforcement:['runtime']}`
(`seed/policy-templates.ts:115-125`) **documents which layer enforces that policy** — it
does not promise agent-mcp auto-wires it. `RatePolicyPlugin` is pure-config
(`maxModelCalls`/`maxToolCalls`); it accepts a `db` handle and **never uses it** (`this.db`
appears only in the constructor). So the registry is an **authoring/composition layer**
whose output is a compiled prompt; runtime enforcement is separately configured machinery.
Both are working as designed.

## 3. THE REAL GAPS

Short list. The architecture is coherent and largely built.

**#1 — `AgentStore` stranded in the host → FK lost (BUG-ORCH-012).**
`entrypoint/agent-mcp/src/store/agent-store.ts:20-152` + `db/schema.ts:3-9`.
`sessionsTable.agentName` (`agent-store-runtime/src/db/schema.ts:14`) is a bare
`text("agent_name")` with **no `.references()`** while every sibling FK on that table has
one — migration `0007` dropped the cascade because `agents` lives in a package that
**cannot be cross-referenced**. Agent deletion orphans sessions forever. Fix: move
`agents` + `AgentStore` into `agent-store-runtime` (it *is* runtime state; the FK then
resolves in-file). Real bug, independently corroborated.

**#2 — Dead duplicate table.** `agent-store-runtime:99-115` defines `composed_prompts`
(no `registry_` prefix), **zero consumers**, shadowing the live
`registry_composed_prompts`. A future author will write to the wrong one.

**#3 — RAG unbuilt.** No embedding/vector/cosine code anywhere in `packages/`. The
deterministic composition stack it plugs into is real and tested — **retrieval is the
entire gap.** Plan 8 (`agent-mcp-authoring`, 0/13) owns it.

**#4 — `agent-registry-migration` (Plan 7) is stale.** 25 dead `packages/ai/*` paths
across all 14 states' guards/artifacts; 8 guards unrepairable by tooling (no `set-guard`).

**#5 — Governance defers to a package that doesn't exist.**
`agent-governance-gaps/SOLUTIONS.md` (`Status: Deferred`) routes all governance to
`@adhd/workspace-standard` per `docs/workspace-base/SCOPE.md`. The SCOPE exists; **no
package does.**

**#6 — `agents-full-workflow` is superseded research.** Its `## Architecture` proposes
opencode/ADK → `agent_task(depends_on)` → agent-mcp's native DagEngine — an *alternative*
to the dispatch stack. `dispatch-completion/SCOPE.md` §2 already settled it ("OUT —
replacing the execution layer… the dispatch layer is the shipped substrate"). RESEARCH
doc, no `state.json`. Archive; do not build.

## 3b. TARGET-DRIVEN (not bugs — owner-stated intent)

These are **not** defects in the current design; they are changes the owner wants:

- **agent-mcp on a shared client.** Today `index.ts` hand-assembles the dep graph and
  owns `AgentStore`. Target: `agent-engine-orchestrator` exposes
  `createAgentEngineClient()`; the host becomes routing+transport only. (Overlaps #1 —
  the store move is the load-bearing half.)
- **dispatch on the same client, in-process.** Today `agent-runner.ts:13-16`
  **deliberately** avoids a TS dep and mirrors wire types locally (`:19-102`) — an
  intentional isolation choice, not an accident. Changing it is a target decision.

---

## 3. TARGET STATE

```
        ┌──────────────────────────┐   ┌──────────────────────────┐
        │ DISPATCH                 │   │ entrypoint/agent-mcp     │
        │  dag.json → optimizer    │   │  thin MCP host ONLY      │
        │  → orchestrator          │   │  (routing + transport)   │
        │     agent-runner         │   │                          │
        │       ├ InProcessRunner ─┼───┤                          │
        │       └ AgentMcpRunner ··┼···┤ (wire — remote only)     │
        └──────────┬───────────────┘   └───────────┬──────────────┘
                   │  ✅ in-process TS dep         │
                   └──────────────┬────────────────┘
                                  ▼
        ┌───────────────────────────────────────────────────────────┐
        │ agent-engine-orchestrator = THE AGENT OPERATING CLIENT    │
        │                                                           │
        │  ✅ createAgentEngineClient(config)                       │
        │       wires AgentStore + Session/Task/ComposedPrompt      │
        │       + Orchestrator + PolicyEngine + Hooks + Queue       │
        │       + optional compiler integration                     │
        │  ✅ reenqueueOrphanedPendingTasks() · verifyAgentEnvRefs()│
        │  ✅ ENFORCES policy / provider / tool-grants at runtime   │
        └──┬──────────────┬──────────────┬───────────────┬─────────┘
           ▼              ▼              ▼               ▼
   ┌──────────────┐ ┌───────────┐ ┌──────────────┐ ┌──────────────┐
   │store-registry│ │store-     │ │store-prompts │ │ core-policy  │
   │ ✅ NEW       │ │runtime    │ │ = REGISTRY   │ │ core-provider│
   │ agents(name) │ │ sessions  │ │ + ✅ vectors │ │ store-tools  │
   │ AgentStore   │◄┤  .agentName│ │ + ✅ anchors │ │              │
   │ impl         │ │  ✅ FK     │ │ + ✅ semantic│ │ ✅ ENFORCED  │
   └──────────────┘ └───────────┘ │   search     │ └──────────────┘
                                  └──────────────┘
```

Key moves:
1. `agents` + `AgentStore` leave the host → `agent-store-registry` → **FK restored**.
2. One factory assembles a runnable client; both hosts call it.
3. The registries become **load-bearing** (enforced), not prompt decoration.
4. Dispatch gets an **in-process** runner; the wire runner survives for remote only.
5. The RAG (embeddings/vectors/semantic search) plugs into the *existing, real,
   tested* deterministic composition stack — retrieval is the entire gap.

---

## 4. What is REAL today (do not rebuild)

- The deterministic composition stack: versioned components, junction-ordered
  composition, exact-match context rules, SHA-256-keyed prompt cache — all 4 stores in
  `agent-store-prompts/src/store/` are real, no stubs.
- `server.ts` routing — clean, host-only, zero leaks.
- The plugin seam (`loader.ts:260-281`) — proven live by budget.
- Dispatch's snapshot/optimize/serialize/CLI spine — builds green, 30 tests pass.
- `agent-generator-plugin` — a legitimate `nx g` generator (correctly importer-less).
