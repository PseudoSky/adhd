<!-- markdownlint-disable MD013 -->
# Step 7 — Final review checklist — agent-registry-migration

```text
[x] Definition of Done agreed in Step 1a — README has `## Definition of Done` with IDed [dod.1..6] (outcome, evidence, structural/behavioral split); --confirm-dod stamped
[x] Every [dod.N] is proven by a final-audit check (gap-check.js Check 8 passes)
[x] Every BEHAVIORAL [dod.N] (dod.1/2/3/4) declares entrypoint:/observable: and is proven by a check that DRIVES the vitest --testFile entrypoint; structural dod.5/6 stay grep/structural
[x] Headline byte/behavioral equivalence: dod.1 drives import → agent-registry compile <slug> --platform claude_code → normalized diff == empty against the original .md (the team-lead's named central DoD)
[x] Zero-loss removal gate: removal-runbook DEPENDS ON roundtrip-equivalence-gate + audit-migration in the DAG; retire() refuses unless the equivalence report is all-PASS (dod.4 forcing function)
[x] Teeth: [roundtrip-equivalence-gate.4] negative-control corrupts a migrated component → round-trip diff fails → gate reports FAIL → removal blocks. Deterministic, exit-code gated, no sleeps
[x] Removal clauses structural+behavioral: dod.6 proves the fixture .md is gone (!existsSync) AND compile still produces the agent (removal didn't break it)
[x] Final audit emits a [dod.N] PASS line per clause; --confirm-dod stamped dod_provenance
[x] Final audit written first — audit_migration.py authored before context bodies; every DoD has a named check
[x] All magic named — the all-PASS forcing function, the cross-repo boundary, and the equivalence normalization set are documented in decisions.md + _shared.md, not implicit
[x] Cross-repo SAFETY boundary encoded — README "Cross-repo safety boundary" + [boundary:cross-repo] + RUNBOOK.md: guards touch ONLY in-repo fixtures; the real claude-agents removal is a documented operator runbook step gated on a full-corpus all-PASS report, never an automated guard
[x] External caller analysis — brownfield plan_kind; this plan ADDS a new package and CONSUMES published @adhd/agent-registry + @adhd/agent-compiler; it deletes NO existing in-repo symbols (the real file deletions are out-of-repo runbook steps). tsconfig.base.json is additively edited.
[x] Every node changing a symbol declares it in dag.json artifacts — yes; src/index.ts is the shared append-only barrel
[x] Every deferral has a forcing function — the cross-repo corpus removal is deferred to RUNBOOK.md, forced by the all-PASS report requirement

Structure:
[x] Identity is a stable slug — no positional numbers
[x] dag.json holds structure; state.json holds runtime only
[x] Slug set in dag.json.nodes == slug set in state.json.states; every context path exists (gap-check Check 1 passes)
[x] Shared definitions centralized in contexts/_shared.md — defs/invs/refs/boundary referenced, not restated
[x] Fixtures checked in (src/__fixtures__/code-reviewer.md + ticket-creation.SKILL.md) — the in-repo proxy for the external corpus

Per-state completeness:
[x] Every work state has goal, semantic distillation/delta spec, reservations, criteria, commit points, notes
[x] Every guard is red→green and env-pinned (env-pin-check --strict: all 10 PINNED)
[x] Every criterion is a command/grep/exists/negative-control, never prose
[x] Reservations (read_only/mutates) declared; shared mutable file src/index.ts noted as append-only across states
[x] Audit states (audit-migration, audit-final) carry no deferrable items

Reviewer: requesting engineer accepts via audit-final; architect-reviewer reviews decisions.md at migration-design (Execution model).
```
