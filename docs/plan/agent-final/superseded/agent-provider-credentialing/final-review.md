<!-- markdownlint-disable MD013 -->
# Step 7 — Final review checklist (agent-provider-credentialing)

```text
[x] Definition of Done agreed in Step 1a — README `## Definition of Done` has [dod.1..8] (outcome, old-gone, evidence, non-goals via Execution model, rollback = revert per-state commits). Confirmed with team-lead at the dispatcher-approval gate; dod_provenance stamped via state-transition.js --confirm-dod.
[x] Every [dod.N] is proven by a final-audit check (gap-check.js Check 8 PASS) — audit_credentialing.py --phase audit emits [dod.1..8].
[x] Every BEHAVIORAL [dod.N] declares entrypoint:/observable: and is proven by a check that DRIVES it (dod.2,3 → credential-inference.test.ts; dod.4 → dotenv-load.test.ts; dod.5 → backcompat-normalize.test.ts; dod.6 → openai-compat-roundtrip.e2e.test.ts). Structural dod.1,7,8 stay grep/script.
[x] Artifact-to-artifact seam exercised through the real path — the domain.ts↔zod discriminated-union seam ([ref:provider-discriminated-union]) is exercised by the backcompat preprocess test + the contract/runtime greps; the .env↔loader seam by dotenv-load.test.ts.
[x] Final audit emits a [dod.N] PASS line per clause; terminal DoD gate satisfiable — every clause has a real executed check (the live one runs by default, unflagged).
[x] Final audit written first — every DoD clause + design principle maps to a named check in audit_credentialing.py.
[x] All magic named — the `?? "lmstudio"` placeholder and the lmstudio type are named in present/absent audit checks; the live-test network softening is an explicit, documented special case.
[x] Shorthand/mechanism separated — credentialEnv (shorthand the author writes) preserved; the apiKeyEnv/authTokenEnv dual-field mechanism eliminated, with legacy input still accepted via normalize-on-load.
[x] External caller analysis done — gap-check.js --discover ran clean; all 18 lmstudio-referencing source files are claimed in some state's mutates; deleted symbols (LMStudioProvider, lmstudioProviderSchema) declared in lmstudio-removal changes.
[x] Every node changing a symbol declares it in dag.json `changes` — lmstudio-removal.changes.deletes = [LMStudioProvider, lmstudioProviderSchema]; the "lmstudio" type-literal removal is proven by negative greps (whole-word collision with retained LMSTUDIO_API_KEY/_BASE_URL would make a `changes` declaration unsafe — documented in the node notes).
[x] Every deferral has a forcing function — no open trigger phrases; token rotation is explicitly operational (ADDENDUM §6), not a deferred plan state.
[x] Identity is a stable slug — no positional numbers; sequence comes from depends_on.
[x] dag.json holds structure; state.json holds runtime only.
[x] Slug set in dag.json.nodes == slug set in state.json.states; every context path exists (gap-check Check 1 PASS).
[x] Shared definitions centralized in contexts/_shared.md — [def:]/[shape:]/[inv:]/[ref:] referenced, not restated.
[x] Acceptance criteria present — >=1 per added symbol/file, negative greps per deleted symbol (24 criteria across 6 states).
[x] Criterion IDs slug-keyed and mirror the audit check IDs (gap-check Check 3 PASS).
[x] reservations.mutates populated for every state.
[x] dag.json artifacts == reservations.mutates exactly (gap-check Check 2 PASS).
[x] Commit points present in every work state.
[x] Shared-file merge protocols written — provider-credential-runtime / lmstudio-removal / backcompat-normalizer share validation/agent.ts + openai.ts but are SERIAL (depends_on chain); the serialization rationale is in each context + dag notes. The one parallel branch (dotenv-dual-load) shares no mutable file.
[x] Guards are red->green — contract/runtime structural guards (python --phase) fail on present lmstudio / absent credentialEnv; nx test guards fail until impl+test exist; build guard fails until every lmstudio ref is removed.
[x] All criteria are deterministic commands (present/absent/exists/command/negative-control).
[x] Final audit has negative checks — lmstudio-removal.2..5 + dod.1 assert the old type is gone.
[x] Final audit has a live-data check — dod.5 reads the real ~/.adhd/agent-mcp/agents.db; dod.6 hits the real LM Studio box.
[x] notes field answers the non-obvious — env-var-name retention, serialization, live-test softening + teeth.
[x] dag.json dependency graph matches state-machine.md exactly.
[x] Dispatch-or-orchestrate decision made (automatic dispatch = no); the Dispatch line + human punch list are emitted at hand-off.
```
