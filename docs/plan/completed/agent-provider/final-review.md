<!-- markdownlint-disable MD013 -->
# Step 7 — Final review checklist — agent-provider (3/7)

```text
[x] Definition of Done agreed in Step 1a — README has `## Definition of Done` with IDed [dod.1..6] (outcome, evidence, structural/behavioral split)
[x] Every [dod.N] is proven by a final-audit check (gap-check.js Check 8 passes)
[x] Every BEHAVIORAL [dod.N] (dod.1/2/3) declares entrypoint:/observable:/negative-control: and is proven by a check that DRIVES the vitest --testFile entrypoint; structural dod.4/5/6 stay grep
[x] Seam: dod.1 binding resolution (canonical→per-platform) asserted by ONE test (binding-store.test.ts) through resolveModelId after reopen; dod.2 server-side+gated-error asserted by ONE test (emit-tools.test.ts)
[x] Each behavioral negative-control references the entrypoint's distinctive token (the `--testFile=…binding-store.test.ts` / `…emit-tools.test.ts` / `…roundtrip.test.ts` filename)
[x] Final audit emits a [dod.N] PASS line per clause; --confirm-dod stamps dod_provenance
[x] Final audit written first — audit_provider.py authored before context bodies; every DoD has a named check
[x] All magic named — FEAT-007 cheap-win boundary (server-side emit vs gated unsupported native vs out-of-scope client-exec loop) stated in README non-goals + _shared.md defs
[x] Shorthand/mechanism separated — N/A: greenfield package; no ergonomic shorthand to preserve
[x] External caller analysis — greenfield package; the only edit to an existing symbol surface is ADDITIVE (ProviderAdapter + StreamChunk added to agent-mcp-types; no rename/removal). tsconfig.base.json additively edited.
[x] Every node changing a symbol declares it in dag.json artifacts — provider-adapter-contract lists agent-mcp-types/src/{domain,index}.ts in its artifacts/reservations
[x] Every deferral has a forcing function — the full client-side execution loop is an explicit README non-goal handed to a later agent-mcp runtime plan (FEAT-007 follow-up), not a silent gap; the emitter THROWS on unsupported natives so the gap is loud

Structure:
[x] Identity is a stable slug — no positional numbers
[x] dag.json holds structure; state.json holds runtime only
[x] Slug set in dag.json.nodes == slug set in state.json.states; every context path exists (gap-check Check 1 passes)
[x] Shared definitions centralized in contexts/_shared.md — defs/invs/refs referenced, not restated

Per-state completeness:
[x] Every work state has goal, semantic distillation/delta spec, reservations, criteria, commit points, notes
[x] Every guard is red→green and env-pinned (env-pin-check --strict: all PINNED)
[x] Every criterion is a command/grep/exists/negative-control, never prose
[x] Reservations (read_only/mutates) declared; shared mutable files (schema.ts, index.ts, drizzle, tsconfig.base.json, agent-mcp-types barrel) noted as append-only/additive across states
[x] Audit states carry no deferrable items

Reviewer: requesting engineer accepts via audit-final; architect-reviewer glances the ProviderAdapter/StreamChunk shape at provider-adapter-contract (Execution model).
```
