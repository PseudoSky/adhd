<!-- markdownlint-disable MD013 -->
# Step 0 item 8 — Interface & contract-wiring checklist (filled)

Contract-design pass for the four new serve-core primitives was DISPATCHED to
`architect-reviewer` (agent run this session) and adjudicated by team-lead, who
returned a **GO-WITH-CHANGES** verdict with four mandatory folds (F1–F4) + two GO
decisions (§8.1 mount-through-invoker, §8.2 wire-streaming) + a topology fold
(invoker promotion). All folds are reflected in `interfaces.json`, `_shared.md`
`[fix:]` decisions, the affected context files' "Review folds" sections, the DoD
(dod.11–14 + dod.5 refine), and the repo BACKLOG (FEAT-005 / FEAT-009).

```text
[x] Triage gate run — the four interfaces every Delta Spec is built against and that
    do not yet exist in the repo are enumerated as interfaces.json entries: op-plan,
    transport-adapter, create-package-invoker, dispatch-for-plan. Nothing skipped as
    "obvious"; all four are new primitives built ON cited in-repo types.
[x] Tiered resolution executed — vendored-source tier: each shape is grounded in the
    INSTALLED repo types read this session (invoke.ts:68-82,94-102,133-209;
    naming.ts:94-177; describe-params.ts; core-client plugin.ts:87-117,332-375;
    stream.ts; validate-layer.ts:225-235; cli-output run.ts:53-59,300-306). No docs/
    spike tier needed (brownfield, types installed).
[x] Contract design pass written — every `shape` is the concrete signature two
    executors would produce the same call site from, incl. the F1 LayerResult return
    types, F2 cliFlags.envVar, and F3 OpPlan.transport stamping.
[x] Greenfield forcing function applied where applicable — N/A: brownfield plan; NO
    entry is left `confidence: assumed`. All four are `vendored`.
[x] interfaces.json validated — flat, slug-keyed object (no wrapper); every entry
    populates interface/shape/provenance/confidence/resolved_version and a source;
    matches interfaces.schema.json.
[x] Every `[iface:<slug>]` citation is wired into the states whose Delta Spec depends
    on the contract — serve-core-primitives defines/cites all four; fastify/express/
    mcp/cli/py contexts cite them via the shared entries and the F1/F2/F3 folds.
[x] provenance/confidence reflect REALITY — `vendored-source`/`vendored` because the
    installed types were actually read; the architect-reviewer dispatch + team-lead
    adjudication (F1–F4) corrected the proposal's un-type-checking sketch rather than
    rubber-stamping it.
[x] Provenance marker stamped — `state-transition.js --confirm-interfaces --agent
    architect-reviewer` recorded after the folds landed.
```
