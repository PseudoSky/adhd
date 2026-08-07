<!-- markdownlint-disable MD013 -->
# Step 7 — Final review checklist (filled)

Worked through before publish. `gap-check.js` (Check 9) gates on every box ticked.

```text
[x] Definition of Done agreed in Step 1a — README `## Definition of Done` has dod.1–14; team-lead confirmed 2026-07-23; dod_provenance stamped
[x] Every [dod.N] is proven by a final-audit check (gap-check.js Check 8 — exit 0)
[x] Every BEHAVIORAL [dod.N] declares entrypoint:/observable: and is proven at tier 3 (drives the real nx/audit entrypoint)
[x] Any artifact-to-artifact seam exercised together — the parity gate captures the CURRENT server then re-drives the migrated one through the SAME real-consumer procedure (fetch/MCP-sdk/child/HTTP-gRPC), one check spanning both
[x] Final audit emits a [dod.N] PASS line per clause and the terminal advance is DoD-gated (audit_apigen-serve-core.py --phase final)
[x] Final audit written first — every DoD clause + design principle maps to a check (audit script DOD_SUPPORT + criteria.json)
[x] All magic named — the 4 TS route/tool shims + the Python project() re-derivation are the "magic"; each has an absent/negative criterion eliminating it
[x] Shorthand/mechanism separated — OpPlan (shorthand: one projection authority) preserved; the per-plugin re-derivation mechanism eliminated
[x] External caller analysis done — gap-check.js --discover ran CLEAN (it caught mcp tool-naming.spec/generate.spec, now reserved; and the promoted invoker-block callers, all in reserved files)
[x] Every node changing a symbol declares it in dag.json `changes` (fastify/express/mcp/py-flask/py-grpc deletes; serve-core-primitives adds_set_members)
[x] Every deferral has a forcing function — py-grpc streaming + cli --use filed in plan BACKLOG; §8.3 + py-grpc-shape are the py-extract-preflight spike guard (grep DECISION:)
[x] Identity is a stable slug — no positional numbers; slugs are end-state names
[x] dag.json holds structure; state.json holds runtime only
[x] Slug set in dag.json.nodes == state.json.states; every context path exists
[x] Shared definitions centralized in contexts/_shared.md ([def:]/[inv:]/[fix:]) — cited, not restated
[x] Acceptance criteria present — ≥1 per state (floor met; 6–11 per work state); one negative grep per deleted shim
[x] Criterion IDs are slug-keyed ([slug.N]) and mirror criteria.json checks
[x] reservations.mutates populated for every state; artifacts array == mutates
[x] Commit points section present in every work state (golden-capture-first → migrate → neg-control, then post-guard commit)
[x] Shared-file merge protocols — N/A: parallel waves are write-disjoint (different plugin dirs / findings doc); Phase-1 runtime is read-only to Phase-2/3
[x] Guards are red→green — new-module tests / new-file greps / parity specs all fail before the state's work
[x] All criteria are deterministic commands — present/absent/exists/command/negative-control, no prose
[x] Final audit has negative checks — shim absence (resolveRoute/findOperation/buildInvokerForPackage/_route_for_op/…) not just new-symbol presence
[x] Final audit has ≥1 live data check — parity gates drive REAL spawned servers/CLI + verify-dist-load on shipped dist (dod.10)
[x] notes field answers the non-obvious — golden-capture-before-migrate ordering, real-consumer-only driving, write-disjoint waves, F1–F4 folds
[x] dag.json dependency graph matches state-machine.md topology exactly
[x] env-pin-check --strict: all 13 guards PINNED
[x] Interface contracts: interfaces.json non-empty → interface-contract-review.md ticked + interfaces_provenance stamped (architect-reviewer)
[x] Dispatch-or-orchestrate decision made — automatic dispatch = NO (planner ≠ executor); Dispatch line emitted to team-lead
```
