# ⛔ SUPERSEDED — QUARANTINED PLANNING MATERIAL. NOT GROUND TRUTH.

**Nothing in this directory is authoritative. Do not execute, resume, cite as a decision,
or "repair" anything here.** Every plan below is retained for one purpose: to be mined
for detail during the `agent-final` synthesis. Treat every claim as **unverified until
checked against code**.

If you are an agent and you found a "Decision" in here — **it may be fiction.** See
§Why below. Verify against the codebase or ask a human. Do not propagate it.

---

## Why these were quarantined (evidence, not opinion)

The agent/dispatch plan corpus made architectural decisions incrementally, without a
whole-system view, and **at least one plan demonstrably certified work that never
happened**. Concretely, all verified this session (2026-07-16):

1. **A plan stamped work COMPLETE that does not exist in the code.**
   `agent-mcp-refactor`'s `agent-store-retire` state is `status: complete`, and its
   `decisions.md` "Decision 1" asserts `agents` became a *thin compiled cache*. The code
   shows the opposite: `entrypoint/agent-mcp/src/store/agent-store.ts` is still a full
   source-of-truth CRUD store with business rules and **zero** cache/compiled/registry
   references. That plan carries **0 `guard_pass` and 30 `guard_bypass_suspected`**
   events.

2. **"Complete" is not trustworthy corpus-wide.** Of 27 plan dirs, only **3** are cleanly
   closed (`current_state:"done"` AND `guard_bypass_suspected == 0`):
   `apigen-client-generation`, `parallel-tool-execution`, `task-schema-foundation`.
   Twelve claim complete while carrying 3–48 bypass events (`0.0.6` has **48**).

3. **A live plan's own DoD is unachievable as written.** `agent-registry-migration`'s
   `dataset-build` writes components via raw `ComponentStore`, bypassing
   `component_define`/`enrichComponent`, so corpus components get no embedding and no
   FTS5 node — yet `contexts/dataset-build.md:38` asserts "`component_search` can rank a
   match over the corpus dataset." It cannot.

4. **A plan contradicts itself.** `agent-mcp-authoring`'s `decisions.md` D6 flipped to
   Option A (`SqliteSearchBackend`); `contexts/discovery-tools.md:85-93` still reads
   "Option A was rejected." Tracked OPEN as `AMA-D6-FLIP`.

5. **Two plans race on an undeclared coupling.** `agent-registry-migration`'s
   `dataset-build.md:70-74` *imports* `agent-mcp-authoring`'s deliverable module, but
   there is no `depends_on_plans` edge, and `agent-registry/CLOSEOUT.md §3` recommends
   running them **in parallel**.

6. **25 dead paths.** `agent-registry-migration` targets `packages/ai/*` across all 14
   states' guards/artifacts. `packages/ai/` has not existed since the v2.1.0 restructure.

7. **Scope docs contradict live plans.** `agent-registry/SCOPE.md:157` lists
   "Embedding-based similarity search for component deduplication" as **Out of Scope**;
   `agent-mcp-authoring` builds exactly that.

8. **Seed data encodes two *other* repos' domains.** `agent-core-policy`'s seed hardcodes
   `gate_command:'sox gate phase'` / `check_at:'cmd_gate_changes_requested'` (the
   sox-ecosystem CLI, `~/dev/ai/sox-ecosystem`) and `escalation_target:'janitor'` (an
   agent in `~/dev/ai/claude-agents`). Unresolved whether that belongs in a registry
   whose stated purpose is separability/reuse.

9. **A whole schema domain has no owner and no disclosure.** `agent-registry`'s
   `DATA_MODEL.md:309-345` Domain 4 (Playbooks, Runbooks, Deployment Modes,
   Strategy/Phases) appears in no plan and is absent from `COVERAGE.md`'s gap ledger.

10. **Governance defers to a package that does not exist.**
    `agent-governance-gaps/SOLUTIONS.md` routes all governance to `@adhd/workspace-standard`
    per `docs/workspace-base/SCOPE.md`. That SCOPE exists; `packages/workspace/` contains
    only `workspace-codegen-nx` and `workspace-base-tools`.

---

## Reading rules for anything in here

| Artifact type | How to treat it |
|---|---|
| `decisions.md`, `DECISIONS.md` | **Unverified assertion.** May be planner-generated with no human ratification. Never cite as "the decision". |
| `state.json` `status: complete` | **Unverified.** Item 1 above proves a `complete` state whose work does not exist. Check the code. |
| `dag.json` guards / artifacts / reservations | **Likely stale.** Many target `packages/ai/*` (gone) or pre-rename `dispatch-*` names. |
| `SCOPE.md`, `README.md`, `COVERAGE.md` | **Intent, not reality.** Useful as a source of *questions*, not answers. |
| `demo/`, `DEMO.md` | **Highest-value material here** — concrete, executable, consumer-shaped. Preserved deliberately. |
| Test/impl code under a plan dir | Real code, but unregistered in the nx graph (e.g. `agent-registry/demo/ingest-and-run.ts` pollutes root project edges). |

**Do NOT re-point dead paths in here.** These plans are superseded; "fixing" their paths
resurrects them into reservation conflict with whatever `agent-final` becomes. Supersede,
don't re-point.

---

## What IS verified real (independent of any plan doc)

Established this session by reading code / `nx graph`, not plan docs:

- **Store/core packages are genuinely separable** — `agent-store-prompts`,
  `agent-store-tools`, `agent-core-provider`, `agent-core-policy`, `agent-store-runtime`
  each depend on nothing beyond `agent-base-types`. `agent-engine-compiler` is the
  composition point. This matches the stated intent (independently reusable concepts).
- **The deterministic composition stack is real and tested** — versioned components,
  junction-ordered composition, exact-match context rules, SHA-256-keyed prompt cache. All
  four stores in `agent-store-prompts/src/store/` are real; no stubs.
- **`agent-mcp`'s `server.ts` is a clean thin router** — zero leaks; every tool case calls
  an orchestrator-exported function.
- **The plugin seam works** — `loader.ts:260-281` loads plugins by name from config /
  `ADHD_AGENT_PLUGINS`; `agent-plugin-budget` rides it live. Plugins correctly have no
  static importers.
- **Dispatch's snapshot/optimize/serialize/CLI spine builds green and its tests pass.**
- **No embedding/vector/cosine code exists anywhere** — the RAG is entirely unbuilt.
- **`entrypoint/agent-mcp` owns `agents`(name) + a 152-line `AgentStore`** — the one clear
  violation of the separability intent; nothing outside the entrypoint can reuse runtime
  agent storage. It is also why `sessionsTable.agentName`
  (`agent-store-runtime/src/db/schema.ts:14`) has **no `.references()`** while every
  sibling FK does (BUG-ORCH-012 — agent deletion orphans sessions).
- **Dispatch reimplements the agent client** over JSON-RPC rather than importing it —
  mirrored wire types (`agent-runner.ts:19-102`), provider translation (`:224-253`), error
  parsing (`:181,338-350`), and a second agent-authoring path via bare `agent_create`
  (`:353-373`).

---

## Index of quarantined plans

| Dir | What it was | Notable |
|---|---|---|
| `agent-registry/` | The initiative's design corpus (DATA_MODEL, SCOPE, COVERAGE, CLOSEOUT, SPEC, DEMO) | Richest source material. Also the origin of most unratified "decisions". |
| `agent-mcp-authoring/` | Plan 8 — authoring lane + embedding substrate + `component_search` | **The RAG.** 0/13, nothing built. Self-contradiction `AMA-D6-FLIP`. |
| `agent-registry-migration/` | Plan 7 — `.md` corpus → registry import | 0/14. 25 dead paths. DoD unachievable (item 3). |
| `agent-mcp-refactor/` | Plan 6 — registry-backed tool surface | Item 1: certified work that doesn't exist. |
| `agent-registry-schema/`, `agent-tool-registry/`, `agent-policy/`, `agent-provider/`, `agent-compiler/` | Plans 1–5 — the shipped `agent-*` packages | Code IS shipped (v2.1.x). Plans carry 3–39 bypasses. |
| `agent-provider-credentialing/`, `agent-registry-release/` | credentialing; release/closeout | All states `superseded`; suite published out-of-band. |
| `0.0.6/` | agent-mcp 0.0.6 feature plan | 16/16 "complete", **48 bypasses**, 25 dead paths. |
| `task-schema-foundation/`, `task-dependency-dag/`, `task-streaming-sse/`, `hitl-interrupts/`, `parallel-tool-execution/`, `usage-tracking/` | agent-mcp runtime features | Shipped. `task-dependency-dag` built `DagEngine` (task-level `depends_on`). |
| `dispatch-completion/` | The dispatch consolidation (24 states) + **its own `superseded/`** | **Its `demo/` is preserved.** Superseded here because its SCOPE §2 forbids touching `packages/agent/**`, which the new direction requires. Its packages are shipped and green. |
| `agents-full-workflow/` | RESEARCH — opencode/ADK driving `agent_task(depends_on)` | An *alternative* orchestration architecture to dispatch. Never a plan (no `state.json`). |
| `agent-governance-gaps/` | Governance gap specs | `Status: Deferred` to a nonexistent package (item 10). |
