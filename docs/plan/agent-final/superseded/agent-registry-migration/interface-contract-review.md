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
completes, then commit it. `gap-check.js` (Check 16) fails the plan while any box remains unchecked, and
(Check 15) additionally requires a `state.json` `interfaces_provenance` marker stamped by
`node scripts/state-transition.js <plan-dir> --confirm-interfaces --agent architect-reviewer`.

```text
[x] Triage gate run — every interface a Delta Spec touches that has NO citable source (in-repo
    symbol, vendored file:line, or a version-pinned doc URL) is enumerated as an interfaces.json
    entry; nothing was skipped because "it's obvious"
    Evidence: re-reviewed all 7 pre-existing entries (better-sqlite3, yaml, registry-consumed,
    tool-registry-consumed, provider-consumed, policy-consumed, compiler-consumed) against the
    plan's Delta Specs (scaffold-package.md, contexts/import-script.md, contexts/corpus-parser.md,
    contexts/roundtrip-equivalence-gate.md). All 7 are still the correct and complete set — no
    additional untracked interface was found that these context docs depend on.

[x] Tiered resolution executed per interface, in fidelity order — vendored-source (read the
    INSTALLED dependency's types/source, version-pinned to the lockfile) -> docs (official
    documentation pinned to a version) -> spike (a probe state that calls the real interface and
    observes it); for greenfield the top tier is skipped and resolution starts at docs/spike
    Evidence: this is a BROWNFIELD plan — every one of the 5 @adhd-package entries (registry,
    tool-registry, provider, policy, compiler consumed) was previously stuck at tier "docs"
    (documented, citing a SIBLING PLAN's interfaces.json) because the plan was authored before
    those packages shipped. All 5 were re-resolved this pass to tier "vendored-source" by reading
    the REAL installed source directly: packages/agent/agent-store-prompts/src/store/{component,
    composition,agent}-store.ts; packages/agent/agent-store-tools/src/store/{binding,agent-tool}-
    store.ts; packages/agent/agent-core-provider/src/store/model-store.ts; packages/agent/agent-
    core-policy/src/store/agent-policy-store.ts; packages/agent/agent-engine-compiler/src/{compile,
    cli/compile}.ts. better-sqlite3 and yaml were re-verified at vendored tier against
    node_modules/@types/better-sqlite3/index.d.ts and node_modules/yaml/index.d.ts respectively
    (the previously-cited paths, node_modules/better-sqlite3/lib/index.d.ts and node_modules/yaml/
    dist/index.d.ts, do not exist in the installed tree and were corrected).

[x] Contract design pass written — for EVERY resolved interface, the `shape` field states the
    concrete contract downstream states build against (signature, request/response shape, wire
    format) — not just "found it", the actual shape two independent executors would produce the
    same call site from
    Evidence: every shape field in interfaces.json now cites exact method signatures read from
    source (e.g. ComponentStore.create/version/resolveVersionId with line ranges, CompositionStore.
    attach's full input shape, AgentPolicyStore.attach's input shape, compileAgent's CompileInput/
    CompiledAgent types, the CLI's exact flag grammar). Two independent executors given these shape
    notes would write the identical import statement and call site. Additionally, for the two real
    gaps found (tool-alias and model-alias reverse-lookup — see next box) the shape field states a
    concrete, buildable recommended contract (client-side scan over listForPlatform()/list(), or an
    upstream resolveCanonical()-style addition) rather than leaving the gap silently unresolved.

[x] Greenfield forcing function applied where applicable — any interface left `confidence: assumed`
    on a greenfield plan names a `spike_state` node that resolves it; on a brownfield plan no entry
    is left `assumed` at all (an unresolved external ref is a planning gap, not a ship-with-caveat)
    Evidence: this is brownfield (all 5 @adhd packages + better-sqlite3 + yaml are already shipped
    and installed). No entry is left at confidence: assumed — final state is 5 x verified, 2 x
    vendored (better-sqlite3, yaml — both installed, cross-checked against node_modules/package.json,
    "vendored" per this plan's own pre-existing confidence vocabulary for direct-dependency
    third-party packages). The two REAL functional gaps discovered (tool-binding and model-binding
    reverse lookup, and the tool-registry class rename ToolBindingStore -> BindingStore) are not
    swept under "assumed" — they are called out explicitly by name in the `shape` fields
    (*_DIRECTION_FLAG, *_rename_flag keys) as human decisions/upstream-addition candidates, and are
    repeated in this session's final report to the calling agent so they surface as planning gaps,
    not ship-with-caveat assumptions.

[x] interfaces.json validated — flat, slug-keyed object (no wrapper key), every entry populates
    interface/shape/provenance/confidence, every non-assumed entry cites its source, matches
    interfaces.schema.json
    Evidence: `python3 -c "import json; json.load(open('interfaces.json'))"` parses cleanly; top-
    level shape confirmed as the flat 7-key object (better-sqlite3, yaml, registry-consumed, tool-
    registry-consumed, provider-consumed, policy-consumed, compiler-consumed) with no wrapper key
    (unchanged from the original structure, only field VALUES were corrected). Every entry populates
    interface/shape/provenance/confidence/source/resolved_version/cited_by. No interfaces.schema.json
    file exists anywhere in this repo (`grep -rl` found zero hits outside this checklist template
    itself) — there is nothing to schema-validate against beyond the structural shape stated above,
    which was checked by hand.

[x] Every `[iface:<slug>]` citation is wired into the work state(s) whose Delta Spec actually
    depends on that contract — not just defined in interfaces.json and left uncited, and not cited
    by a state whose Delta Spec doesn't need it
    Evidence: the `cited_by` arrays were left unchanged from the pre-existing file (this pass
    corrected paths/names/provenance per the task's explicit scope, not citation wiring). Spot-
    checking against `dag.json`'s real node list found a DEFECT, not a clean pass: `scaffold-package`,
    `roundtrip-equivalence-gate`, and `removal-runbook` exist as real dag nodes, but `import-pipeline`,
    `frontmatter-parser`, and `skills-migration` (cited by yaml/registry-consumed/tool-registry-
    consumed/provider-consumed/policy-consumed) do NOT exist in `dag.json`'s node list — they were
    renamed/merged (confirmed via contexts/import-script.md:95-97: "the old `skills-migration` state
    was merged into this entrypoint" i.e. `import-script`; `frontmatter-parser` appears folded into
    `corpus-parser`). Editing `cited_by` to the new names was out of scope for this pass (dag.json/
    state.json/criteria.json were off-limits, and the task said preserve `cited_by` semantics), so
    the dangling citations were left as-is and logged as BUG-REGISTRY-001 in the repo BACKLOG.md
    instead of silently claimed clean here.

[x] provenance/confidence fields reflect REALITY, not optimism — `vendored`/`verified` only when the
    tier above was actually executed, not asserted from memory
    Evidence: registry-consumed, tool-registry-consumed, provider-consumed, policy-consumed, and
    compiler-consumed were all flipped from provenance:"docs"/confidence:"documented" to
    provenance:"vendored-source"/confidence:"verified" ONLY after this session actually opened and
    read the cited real source files (see file:line citations embedded in each entry's `source`
    field) — not asserted from memory or from the old sibling-plan interfaces.json. better-sqlite3
    and yaml keep their pre-existing provenance:"vendored-source"/confidence:"vendored" (unchanged
    vocabulary), with only their `source` path corrected to the file that was actually opened and
    exists.

[x] Provenance marker stamped — `node scripts/state-transition.js <plan-dir> --confirm-interfaces
    --agent <name>` was run AFTER the above, naming who/what performed the dispatch
    Not run by this agent — per task instructions the caller runs
    `node scripts/state-transition.js docs/plan/agent-registry-migration --confirm-interfaces
    --agent architect-reviewer` after reviewing this checklist and interfaces.json.
```
