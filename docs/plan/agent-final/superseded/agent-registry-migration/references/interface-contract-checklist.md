<!-- markdownlint-disable MD013 -->
<!-- Checklist items are single lines that intentionally exceed 80 cols. -->
# Step 0 item 8 — Interface & contract-wiring checklist

For **code projects**, resolving an unknown interface and designing its contract is not a lookup —
it is generative, load-bearing work (SKILL.md Step 0 item 8's "Contract design pass (mandatory)").
Once a plan's `interfaces.json` is non-empty, that work must be **dispatched to an architect role**
(`architect-reviewer`, per Step 1c's existing precedent) — never silently authored inline by the
planner. This checklist is that architect's per-substep process-compliance record.

**This checklist is also a gate.** Copy this file into the plan directory as
`interface-contract-review.md`, tick every box (`[x]`) or mark it `N/A — <reason>` as each substep
completes, then commit it. `gap-check.js` (Check 16) fails the plan while any box is `[ ]`, and
(Check 15) additionally requires a `state.json` `interfaces_provenance` marker stamped by
`node scripts/state-transition.js <plan-dir> --confirm-interfaces --agent architect-reviewer`.

```text
[ ] Triage gate run — every interface a Delta Spec touches that has NO citable source (in-repo
    symbol, vendored file:line, or a version-pinned doc URL) is enumerated as an interfaces.json
    entry; nothing was skipped because "it's obvious"
[ ] Tiered resolution executed per interface, in fidelity order — vendored-source (read the
    INSTALLED dependency's types/source, version-pinned to the lockfile) → docs (official
    documentation pinned to a version) → spike (a probe state that calls the real interface and
    observes it); for greenfield the top tier is skipped and resolution starts at docs/spike
[ ] Contract design pass written — for EVERY resolved interface, the `shape` field states the
    concrete contract downstream states build against (signature, request/response shape, wire
    format) — not just "found it", the actual shape two independent executors would produce the
    same call site from
[ ] Greenfield forcing function applied where applicable — any interface left `confidence: assumed`
    on a greenfield plan names a `spike_state` node that resolves it; on a brownfield plan no entry
    is left `assumed` at all (an unresolved external ref is a planning gap, not a ship-with-caveat)
[ ] interfaces.json validated — flat, slug-keyed object (no wrapper key), every entry populates
    interface/shape/provenance/confidence, every non-assumed entry cites its source, matches
    interfaces.schema.json
[ ] Every `[iface:<slug>]` citation is wired into the work state(s) whose Delta Spec actually
    depends on that contract — not just defined in interfaces.json and left uncited, and not cited
    by a state whose Delta Spec doesn't need it
[ ] provenance/confidence fields reflect REALITY, not optimism — `vendored`/`verified` only when the
    tier above was actually executed, not asserted from memory
[ ] Provenance marker stamped — `node scripts/state-transition.js <plan-dir> --confirm-interfaces
    --agent <name>` was run AFTER the above, naming who/what performed the dispatch
```
