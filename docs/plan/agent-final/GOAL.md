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

† `agent-core-policy`'s purpose is **open** — see O-1.

## The end state (what a green spine demo shows, one run)

1. **Author** an agent from components over the public MCP surface — zero provider deps.
2. **Discover** components via sox-backed hybrid search (`kind:'generic'` nodes,
   `SqliteSearchBackend`) — zero retrieval code in adhd.
3. **Compile** it: deterministic composition, cache hit/miss/drift, two platforms.
4. **Run** it through the real orchestrator; delete the agent; **zero orphaned sessions**.
5. **Dispatch** a plan wave through the same client dispatch uses — no mirrored types.
6. **Plugins** load by name at runtime; their tests actually run (BUG-NXTEST-001 fixed).
7. Host surface byte-stable throughout; every registry claim traceable to a store row.

## Plan sequence

| # | Slug | State | Gate it proves |
|---|------|-------|----------------|
| 1 | [`store-move/`](./store-move/GOAL.md) | **GOAL+DEMO written** | FK disarm · store importable · host thins |
| 2+ | *deliberately deferred* — owner: "Lets make 1 right now then come back." Candidates from the verified gap list: client-factory · seam (dispatch-on-client) · authoring lane (consuming sox) · compile hardening · plugins/test-wiring · spine. | — | — |

## Open questions (blocking their plans, not plan 1)

- **O-1 · What is `agent-core-policy` for?** SYNTHESIS says hold; the arch doc's target
  says ENFORCED; §2E says descriptive-metadata-as-designed. Contradiction unresolved —
  the enforcement demo beat ("the policy actually blocks the call") can only be written
  once the owner rules. *(Asked 2026-07-16; unanswered.)*
- **O-2 · Decomposition of plans 2+** (one-per-subsystem vs shipping-unit vs
  target-moves). *(Asked; owner deferred.)*
- **O-3 · The dispatch demo** — `superseded/dispatch-completion/demo/DEMO.md` is
  owner-endorsed ("correct less some of the underlying implementation") with 15 ⟦U#⟧
  items; keep-verbatim vs re-ground its stale claims (I-2, I-4) when its plan is cut.

## Standing constraints (every plan)

- Demos gate on **exit codes**, drive **real loaded MCP tools** (never internals), carry
  **negative controls** proving assertions bite, and mark guessed interfaces ⟦U#⟧ in a
  per-plan `UNRESOLVED.md` driven to zero.
- No plan touches sox-owned territory (D-A). No plan resumes anything in `superseded/`.
- New stale-claim discoveries go to `INVALIDATIONS.md` with file:line — append-only.
