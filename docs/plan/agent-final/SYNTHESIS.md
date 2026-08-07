# agent-final — SYNTHESIS (inventory input)

**Status: inventory, not a plan. 2026-07-16.**

Three sections: **§1 what is verifiably real** (established by reading code / `nx graph`,
independent of any plan doc), **§2 what the superseded plans claimed** (unverified — mine
for detail, never cite as decided), **§3 the open questions** that must be answered before
a plan is authored.

---

## §1 — VERIFIED REAL (code, not plan docs)

### 1.1 The package topology

```
agent-base-types  ← everything
agent-store-prompts   standalone   REGISTRY: components, use_cases, compositions,
                                   registry_agents(slug), registry_composed_prompts
agent-store-tools     standalone   canonical tools + platform bindings
agent-core-provider   +base-types  providers, models, tool-formats (SEEDED)
agent-core-policy     +base-types  policy templates (SEEDED) + a rate-policy PLUGIN
agent-store-runtime   +base-types  sessions, tasks, messages, task_usage, task_events
agent-engine-compiler → core-policy, core-provider, store-prompts, store-tools
                                   ← the COMPOSITION POINT (correctly couples them)
agent-engine-orchestrator → base-types, engine-compiler, store-prompts, store-runtime
entrypoint/agent-mcp  → orchestrator(31 sites), store-runtime(14), engine-compiler(3),
                        base-types(3), store-prompts(2), plugin-budget(1)
packages/dispatch/*   → NOTHING in the agent family
```

**The separability intent is honored at the store/core layer.** Every store/core package
is standalone (nothing beyond `agent-base-types`). An agent-building UI *could* consume
`agent-store-prompts` today with zero provider dependency. The compiler is where concerns
compose — that is correct, not a violation.

### 1.2 The one clear separability violation

`entrypoint/agent-mcp` owns the **runtime agent store**:
- `src/store/agent-store.ts:20-152` — a full CRUD store with real business rules
  (`AGENT_ALREADY_EXISTS`, `AGENT_HAS_ACTIVE_SESSIONS`, version bump, patch-merge).
- `src/db/schema.ts:3-9` — `agents` keyed by **name**.

Nothing outside the entrypoint can reuse runtime agent storage. Note there are **two**
`AgentStore` classes and **two** agent tables:

| Store | Table | Location | Reusable? |
|---|---|---|---|
| `agent-store-prompts/src/store/agent-store.ts` | `registry_agents` (**slug**) | package | ✅ |
| `entrypoint/agent-mcp/src/store/agent-store.ts` | `agents` (**name**) | entrypoint | ❌ |

**Direct consequence — BUG-ORCH-012:** `agent-store-runtime/src/db/schema.ts:14` declares
`agentName: text("agent_name")` with **no `.references()`**, while every sibling FK on that
table has one. Migration `0007` dropped the cascade because `agents` lives in a package
that cannot be cross-referenced. **Agent deletion orphans sessions forever.**

### 1.3 What is built and real

- **The deterministic composition stack** — versioned components (head/version split),
  junction-ordered composition, exact-match context-conditional inclusion, SHA-256-keyed
  prompt-assembly cache. All four stores in `agent-store-prompts/src/store/` are real; no
  stubs. `agent-engine-compiler` selects **statically/explicitly** — zero semantic ranking.
- **`agent-mcp`'s `server.ts` is a clean thin router** — every tool case calls an
  orchestrator-exported function. Zero leaks. The wiring lives in `index.ts` and *is*
  hand-assembled.
- **The plugin seam works.** `agent-engine-orchestrator/src/plugins/loader.ts:260-281`
  (`loadExternalPlugins`) imports plugins **by name at runtime** from
  `agent-mcp.config.json` `plugins:[{module,config}]` or `ADHD_AGENT_PLUGINS`.
  `agent-plugin-budget` rides it live. **Plugins correctly have no static importers** —
  which plugins load is a deployment decision.
- **Dispatch's spine is green** — snapshot/optimize/serialize/CLI build and test clean.
- **`agent-generator-plugin`** is a legitimate `nx g` generator (`registry-package`),
  correctly importer-less.

### 1.4 What is NOT built

- **No embedding / vector / cosine / kNN code exists anywhere** in `packages/` or
  `entrypoint/`. No vector column in any schema. **The system cannot do semantic
  retrieval.** The RAG is 100% unbuilt — the deterministic stack it would plug into is
  real; **retrieval is the entire gap.**
- **`@adhd/sox-*` availability** (Plan 8's designed substrate): `sox-embedding-provider@0.1.0`,
  `sox-vector-store@0.1.0`, `sox-ingest@0.1.0`, `sox-memory-core@0.2.1` are **published**.
  `sox-hybrid-search`, `sox-analysis`, `sox-graph-store` are **404**. The published
  embedding provider ships `fastembed` only — no `'hash'` type.

### 1.5 Dispatch ↔ agent, as it actually is

- **No dispatch package depends on any agent package.** `agent-runner.ts:13-16`
  *deliberately* avoids a TS dep and mirrors agent-mcp's wire types locally (`:19-102`).
- It **reimplements the client** over JSON-RPC: provider translation (`:224-253`), error
  parsing (`:181,338-350`), and a **second agent-authoring path** — `ensureAgent`
  (`:353-373`) creates rows in the same `agents` table via bare `agent_create`.
- **The two DAGs are two altitudes, not rivals.** Dispatch's optimizer *collapses* its DAG
  before the agent boundary (`optimize.ts:6-11`: partition by shape+tier, next-fit pack to
  the context window) and fires **flat, ephemeral, synchronous** tasks — `fire()` passes
  only `{agent_name, prompt}`, never `depends_on`. agent-mcp's `DagEngine` operates on
  task-level `depends_on`. **agent-mcp never sees a DAG.** (Note: agent-mcp's `task` tool
  *does* natively support `dependsOn` + cycle rejection — dispatch simply doesn't use it.)
- **Provider is represented three ways** with no mapping: dispatch's snake_case
  `ProviderConfig`, agent-mcp's camelCase `providerConfigSchema`, and `agent-core-provider`'s
  DB registry. `ModelTier`(`Haiku|Sonnet|Opus`) has **zero** mapping to
  `provider_models.pricingTier`(`premium|standard|economy`).

### 1.6 Cross-repo entanglement

Three repos are involved:
- `/Users/nix/dev/node/adhd` — this one
- `/Users/nix/dev/ai/sox-ecosystem` — source of the `@adhd/sox-*` packages
- `~/dev/ai/claude-agents` — the `.md` agent corpus the migration plan imports
  (`superseded/agent-registry-migration/contexts/_shared.md:23`)

adhd's **seed data references both**: `agent-core-policy/src/seed/policy-templates.ts`
hardcodes `gate_command:'sox gate phase'` and `check_at:'cmd_gate_changes_requested'`
(sox-ecosystem CLI verbs) and `escalation_target:'janitor'` (a claude-agents agent).
`agent-store-prompts/src/seed/components.ts` carries 7 `sox` / 3 `cto` / 1 `founder`
tokens. **Unresolved** whether consumer-specific workflow belongs in a registry whose
purpose is separability/reuse.

---

## §2 — WHAT THE SUPERSEDED PLANS CLAIMED (unverified)

**Read as questions, not answers.**

| Claim | Where | Status |
|---|---|---|
| `agents` becomes a **thin compiled cache**; `registry_agents` is source of truth | `agent-mcp-refactor/decisions.md` D1 | **Contradicted by code.** The state implementing it is `complete` with 0 `guard_pass`/30 bypass; the store is still full source-of-truth CRUD. Human view: "completely violates the fact that the graph + rag operate on a db… no idea what constitutes the need for a cache." |
| `enforcement` is an **8-value enum** (`runtime|hook|settings|agent|dispatcher|ci|convention|human`) | `agent-registry/DATA_MODEL.md:270-283` | Schema **does** have a JSON-array `enforcement` column (`agent-core-policy/src/db/schema.ts:23-27`). Seeds declare `['runtime']`×3, `['runtime','ci']`, `['hook']`, `['agent']`×3, `['ci']`, `['settings']`. **But** `RatePolicyPlugin` is pure-config (`maxModelCalls`/`maxToolCalls`) and **never uses** the `db` handle it receives ⇒ `enforcement` reads as **descriptive metadata**, not a wiring directive. |
| "Only 1 of 8 enforcement mechanisms enforces" is an open gap needing a closure pass | `agent-registry/COVERAGE.md` §B | The initiative's own ledger; **no plan owns it**. Human view: the policy package's purpose is now unclear — **hold policy work.** |
| Runtime `name` ↔ registry `slug` seam, `inv:no-slug-on-wire` | `agent-mcp-authoring` `name-slug-seam`, `DATA_MODEL.md:78` | Elaborate and unbuilt. Human view: the two-store split may be an artifact of **packages being incorrectly integrated**, not a real requirement. |
| Plan 7 ∥ Plan 8 can run in parallel; no dag dependency | `agent-registry/CLOSEOUT.md §3`; Plan 8 `README:34-37` | **True mechanically, false in practice** — `agent-registry-migration/contexts/dataset-build.md:70-74` *imports* Plan 8's module. Race. |
| `component_search` can rank a match over the corpus | `agent-registry-migration/contexts/dataset-build.md:38` | **Unachievable as written** — `dataset-build` writes components via raw `ComponentStore`, bypassing `component_define`/`enrichComponent`, so corpus components get no embedding and no FTS5 node. |
| Retrieval backend = Option B (hybrid); "Option A was rejected" | `agent-mcp-authoring/contexts/discovery-tools.md:85-93` | **Self-contradicted** — `decisions.md` D6 flipped to Option A. Tracked OPEN as `AMA-D6-FLIP`. |
| Embedding-based similarity search is **Out of Scope** | `agent-registry/SCOPE.md:157` | Plan 8 builds exactly that. Unreconciled. |
| Governance is fully covered by `@adhd/workspace-standard` | `agent-governance-gaps/SOLUTIONS.md` | `docs/workspace-base/SCOPE.md` exists; **no such package** (`packages/workspace/` = `workspace-codegen-nx`, `workspace-base-tools`). |
| opencode/ADK → `agent_task(depends_on)` orchestration | `agents-full-workflow/RESEARCH.md` | An **alternative** to the dispatch stack. Never a plan (no `state.json`). |

### Undisclosed gaps found in the design corpus

- **`DATA_MODEL.md:309-345` Domain 4 — Workflow Structures** (Playbooks, Runbooks,
  Deployment Modes, Strategy/Phases): **no plan, absent from `COVERAGE.md` entirely.**
- **`RUNTIME_GAPS.md` Gap 1** — provider-native tool forwarding (e.g. Anthropic
  server-side `web_search`) / client-side tool execution: unassigned, not in `COVERAGE.md`.
- **Unread:** `AGENT_MCP_TOOL_INTERFACE.md` (563 lines) + `SPEC_AGENT_MCP_TOOL_INTERFACE.md`
  (493 lines). Requirement-level coverage against these is **unverified**.

---

## §3 — OPEN QUESTIONS (must be settled before authoring)

1. **Is the two-table agent split real?** `registry_agents`(slug)=definition vs
   `agents`(name)=runtime instance *reads* like the stated separability (definitions don't
   depend on provider functionality). Or is it an artifact of bad integration, and one
   entity suffices? Everything downstream (the name↔slug seam, the FK fix, the client
   shape) hangs on this.
2. **Where does the runtime agent store live?** It must leave the entrypoint to satisfy
   separability and to make the sessions FK declarable. Its own package, or fold into
   `agent-store-runtime` (it is runtime state, and the FK resolves in-file)?
3. **What is `agent-core-policy` for?** Purpose currently unclear; policy work is **on
   hold**. Sub-questions: does the registry enforce, or only describe? Do seeds get to
   encode a consumer's workflow (`sox gate phase`, `janitor`)?
4. **RAG substrate:** `sox-hybrid-search`/`-analysis`/`-graph-store` are 404 — publish them
   (in scope per owner), or implement fusion locally? And `fastembed` instead of the
   designed-but-nonexistent `'hash'`.
5. **How much of the superseded work is salvageable?** 12 plans claim `complete` with
   3–48 `guard_bypass_suspected` and 0 `guard_pass`. The shipped packages **are** real
   (v2.1.x, tests pass) — but no plan's DoD can be trusted without re-verification.

## Settled (owner-directed, 2026-07-16)

- **Dispatch USES the agent client and does not rewrite it.** Import the client; delete the
  mirrored wire types (`agent-runner.ts:19-102`), provider translation (`:224-253`), error
  parsing (`:181,338-350`), and the bare-`agent_create` authoring path (`:353-373`).
- **The `@adhd/sox-*` packages are correct** and may be depended on; any needed ones will be
  published by this work.
- **The registry exists for separability/reuse** — independently manageable concepts
  (agent definitions ⊥ provider functionality ⊥ tool definitions ⊥ plugins/prompts), so
  each is reusable in other contexts (e.g. an agent-building UI over the authoring system
  alone; provider configs with their own security parameters).
