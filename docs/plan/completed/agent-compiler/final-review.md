<!-- markdownlint-disable MD013 -->
# Step 7 — Final review checklist — agent-compiler

```text
[x] Definition of Done agreed in Step 1a — README has `## Definition of Done` with IDed [dod.1..7] (outcome, evidence, structural/behavioral split)
[x] Every [dod.N] is proven by a final-audit check (gap-check.js Check 8 passes)
[x] Every BEHAVIORAL [dod.N] (dod.1..5) declares entrypoint:/observable:/negative-control: and is proven by a check that DRIVES the vitest --testFile entrypoint; structural dod.6/7 stay grep
[x] Headline DoD is the convergence proof — dod.1 drives the REAL compileAgent against REAL seeded rows in all four DB prefixes and asserts a platform-shaped observable (frontmatter tools: resolved from tool_platform_bindings + body in junction order), not a mock or a shape check
[x] Seam: dod.1/2/3 are all asserted by ONE e2e suite (compile-e2e.test.ts) through the real compileAgent — not isolated greps
[x] Final audit emits a [dod.N] PASS line per clause; --confirm-dod stamped dod_provenance
[x] Final audit written first — audit_compiler.py authored before context bodies; every DoD has a named check whose command contains the entrypoint token
[x] Every work state in some DoD delivered-by (compiler-design, scaffold-package, composition-resolve, tool-header-emit, model-and-policy-emit, platform-markdown-emit, compile-cli, composed-prompt-caching, compile-fixtures-e2e all covered)
[x] All magic named — N/A: greenfield package, no special cases/parallel caches
[x] Shorthand/mechanism separated — N/A: greenfield, no ergonomic shorthand to preserve
[x] External caller analysis — N/A: greenfield package (plan_kind greenfield); no existing symbols deleted/renamed. tsconfig.base.json is additively edited.
[x] Every node changing a symbol declares it in dag.json artifacts — N/A: greenfield, no resigns/deletes
[x] Every deferral has a forcing function — the context-precedence + topology assumptions are CONSUMED from plan 1 and forced by compiler-design's guard + decisions.md grep criteria; an under-specified upstream rule forces a planner-class amendment

Cross-plan:
[x] Depends on plans 1–4 (agent-registry-schema, agent-tool-registry, agent-provider, agent-policy) — declared in README "Cross-plan dependency note", scaffold-package package.json deps, and scaffold-package.6 / dod.6 audit checks
[x] Single-DB / table-name-prefix topology cited from agent-registry-schema decisions.md, not re-decided (compiler-design.4 grep; [inv:one-db-handle])
[x] Reads resolveComposition / tool_platform_bindings / model_platform_bindings / agent_policy; writes composed_prompts (delta specs + audit greps)

Structure:
[x] Identity is a stable slug — no positional numbers
[x] dag.json holds structure; state.json holds runtime only
[x] Slug set in dag.json.nodes == slug set in state.json.states; every context path exists (gap-check Check 1 passes)
[x] Shared definitions centralized in contexts/_shared.md — defs/invs/refs/ups referenced, not restated

Per-state completeness:
[x] Every work state has goal, semantic distillation/delta spec, reservations, criteria, commit points, notes
[x] Every guard is red→green and env-pinned (env-pin-check --strict: all PINNED)
[x] Every criterion is a command/grep/exists, never prose
[x] Reservations (read_only/mutates) declared; shared mutable files (compile.ts, index.ts, tsconfig.base.json) noted as append-only across states
[x] Audit states carry no deferrable items

Reviewer: requesting engineer accepts via audit-final; architect-reviewer reviews decisions.md at compiler-design (Execution model).
```
