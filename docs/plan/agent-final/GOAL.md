# GOAL — agent-final: the locked vision

**Status: the main plan goal. 2026-07-16.** This file exists so the agent+dispatch system
is planned **once**, with the whole vision in view — the previous corpus (21 plans, now in
`superseded/`) failed by deciding piecemeal. Rules of this directory: a plan document is
not evidence (`README.md`); check [`INVALIDATIONS.md`](./INVALIDATIONS.md) before acting on
any corpus claim; every plan here is a `<slug>/` with `GOAL.md` + `DEMO.md` +
`UNRESOLVED.md`, and **the demo is the definition of done** — if it isn't demonstrated, it
isn't built.

## The vision

One agent system, four separable concerns, each reusable without the others:

```
 AUTHORING (definitions)      agent-store-prompts        components · compositions · registry_agents
 CAPABILITY (providers/tools) agent-core-provider · agent-store-tools · agent-core-policy†
 RUNTIME (execution)          agent-engine-orchestrator · agent-store-runtime (incl. agents + AgentStore)
 COMPOSITION                  agent-engine-compiler      — the one place concerns meet

 HOSTS: entrypoint/agent-mcp = routing + transport ONLY.
        dispatch-* = plan → token-optimal waves → real dispatch, THROUGH the agent client.
 SUBSTRATE: everything retrieval-shaped (embedding, vectors, graph, hybrid search,
        enrichment, chunking) is @adhd/sox-* — adhd consumes, never reimplements.
```

An agent-building UI could use authoring alone. A provider config carries its own security
parameters with no prompt dependency. Tool definitions are platform-agnostic. That
separability is *why the registry exists* (owner, SYNTHESIS §Settled) — and it is the test
every plan's demo must survive.

## Decided (owner rulings, 2026-07-16 unless noted)

| # | Ruling | Consequence |
|---|--------|-------------|
| D-A | **sox-ecosystem owns all rag / enrichment / graph / embedding / vector work.** "We are choosing not to implement any features in adhd belonging to [those] — they belong in improvements to the sox ecosystem packages." | No retrieval plan exists in adhd. The adhd demos *assert the absence* of workarounds (no cosine/summarize/bespoke-FTS5 in `packages/agent/**`). sox's `retrieval-infrastructure/SPEC.md` is authoritative for the substrate. |
| D-B | **sox's own plans/backlog are authoritative for sox's design** — adhd plan docs guessing at sox internals have been wrong 3-for-4 (INVALIDATIONS I-6/7/8). | Component storage contract = BL-295 Option A: `kind:'generic'` + sub-kind in meta. |
| D-C | **`agents` + `AgentStore` fold into `agent-store-runtime`.** | Plan 1: [`store-move/`](./store-move/GOAL.md). Kills the armed FK regression (I-1) structurally. The arch doc's `store-registry NEW` box is dead (I-13). |
| D-D | **Dispatch uses the agent client — never rewrites it** (SYNTHESIS §Settled). | The mirrored wire types / provider translation / error parsing / bare-`agent_create` path in `agent-runner.ts` get deleted in a seam plan. |
| D-E | **`adhd-build` is the dispatch lineage** — "that plan became exactly dispatcher*"; harvest, don't reinvent. | Demo idiom = its transcript style; the goal→questions→milestones authoring half lives in sox's `workflow:plan-builder`, not here. |
| D-F | **Fix things, don't file debt.** Discovered defects get fixed in-flight or surfaced to the owner — the INVALIDATIONS log replaces re-litigating stale claims. | |
| D-G | **Provider portability (2026-07-17).** (1) **Merge ALL provider registries into one** — dispatch's snake_case `ProviderConfig`, agent-mcp's camelCase `providerConfigSchema`, and `agent-core-provider`'s tables become a single canonical registry; the three-representations debt (SYNTHESIS §1.5) is retired, not mapped. (2) Binding is an **inheritance chain**: agent carries an *optional* model hint (the required welded `provider` field dies) → session holds the live provider/model (new columns; **swap = update the session row**) → task may override one call; resolution `task ?? session ?? agent ?? global`. (3) **Soft swap**: same session, history re-rendered into the new provider's format via the already-built-but-unwired tool-format layer (`emitTool()`, `provider_tool_formats`). (4) Routing = **ordered `models[]` fallback list only** (session + dispatch-unit), no price/latency sort this pass. Grounding: OBS-24 (opencode/OpenRouter comparison — the gap is wiring, not schema). | Demo Act 6; the registry's platform-binding layer finally consumed at runtime. |

† `agent-core-policy`: intended as agent restrictions (tools/files/access modes);
owner-assessed "may be irrelevant at this point" — on hold, unratified as a runtime
enforcer. See Resolved questions O-1.

## The end state (what a green spine demo shows, one run)

1. **Author** an agent from components over the public MCP surface — zero provider deps.
2. **Discover** components via sox-backed hybrid search (`kind:'generic'` nodes,
   `SqliteSearchBackend`) — zero retrieval code in adhd.
3. **Compile** it: deterministic composition, cache hit/miss/drift, two platforms.
4. **Run** it through the real orchestrator; delete the agent; **zero orphaned sessions**.
5. **Dispatch** a plan wave through the same client dispatch uses — no mirrored types.
6. **Plugins** load by name at runtime; their tests actually run (BUG-NXTEST-001 fixed).
7. Host surface byte-stable throughout; every registry claim traceable to a store row.
8. **The same agent completes tasks through two different providers**; a session swaps
   provider mid-conversation without losing context; a dead provider fails over down an
   ordered `models[]` list, visibly in the usage ledger (D-G).

## Structure: ONE plan (owner ruling, 2026-07-16 — O-2 resolved)

agent-final is a **single plan**. The per-subsystem GOAL+DEMO pairs below are its
**milestone gates** — each milestone is done when its demo runs green, and the plan is
done when the spine demo runs green. Not sibling plans; one dag, one story.

| Milestone | Demo artifact | State |
|---|---|---|
| store-move | [`store-move/`](./store-move/GOAL.md) GOAL+DEMO+UNRESOLVED | **written** |
| dispatch | [`superseded/dispatch-completion/demo/DEMO.md`](./superseded/dispatch-completion/demo/DEMO.md) — **retained as-is** (owner, O-3: "I want that demo, i have not confirmed that they are invalid"); its 15 ⟦U#⟧ ledger is the acceptance frame | **exists** |
| client-factory · seam · authoring-lane (consuming sox) · compile · plugins/test-wiring · spine | to author, same idiom | — |

## Resolved questions (rulings on record — OBSERVATIONS.md OBS-21)

- **O-1 · `agent-core-policy` — RESOLVED.** Original intent: restrict the agent — tool
  use, file access, access modes. Owner: "it may be irrelevant at this point." No
  enforcement demo is owed; policy stays on hold; the arch doc's "✅ ENFORCED" target is
  **unratified** — do not build toward it without a new ruling. Disposition of the
  package (retire vs descriptive metadata) is an open item, not a blocker.
- **O-2 · Decomposition — RESOLVED: one plan** (structure above).
- **O-3 · Dispatch demo — RESOLVED: retained.** The demo is the milestone's acceptance
  document. The mechanical facts in OBSERVATIONS OBS-2 (unrun optimizer/plugin tests)
  concern architecture-doc/BACKLOG *claims*, not demo beats, and the owner has not
  confirmed any invalidation against the demo itself.

## Standing constraints (every plan)

- Demos gate on **exit codes**, drive **real loaded MCP tools** (never internals), carry
  **negative controls** proving assertions bite, and mark guessed interfaces ⟦U#⟧ in a
  per-plan `UNRESOLVED.md` driven to zero.
- No plan touches sox-owned territory (D-A). No plan resumes anything in `superseded/`.
- New stale-claim discoveries go to `INVALIDATIONS.md` with file:line — append-only.
