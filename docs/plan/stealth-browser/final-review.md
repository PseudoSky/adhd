<!-- markdownlint-disable MD013 -->
# Final review - stealth-browser

Checked 2026-10-12 against the authored plan (gap-check, env-pin-check, consistency-check, check-disjoint all exit 0).

```text
[x] Definition of Done agreed - README `## Definition of Done` has [dod.1]-[dod.9]; provenance stamped with state-transition.js --confirm-dod
[x] Every [dod.N] is proven by a final-audit check (scripts/audit_dod.py check("dod.N"...); gap-check Check 8 passes)
[x] Every BEHAVIORAL [dod.N] (dod.2, dod.3, dod.9) declares entrypoint/observable/negative-control and is proven by a check that drives that entrypoint
[x] Artifact seams exercised through the real path - the e2e drives library, CLI and MCP in one run; the cutover is probed by a real MCP stdio client
[x] Final audit emits a `[dod.N] PASS|FAIL` line per clause (audit_dod.py; guard.py audit-final and agent-search-cutover print the same lines)
[x] Final audit written first - every design principle has a named check (audit-final.1-9 and the four ref checks)
[x] All magic named - search-flavoured leftovers, .js twins and the nested cdp-connection package are named in SCOPE.md and have forcing states
[x] Shorthand/mechanism separated - apigen hosts are projected from src/api.ts, not hand-rolled
[x] External caller analysis done - agent-search callers mapped in SCOPE.md; the cutover state owns every touched scratch path; gap-check --discover ran (grep oracle, no changes block declared: the plan adds one package and deletes nothing in the monorepo)
[x] Every node changing a symbol declares it - N/A for the monorepo (new package only); the scratch deletions are owned by agent-search-cutover and guarded
[x] Every deferral has a forcing function - release/publish is hb-release-decision + merge-readiness.2; the sox-service-proxy redesign is out of scope and recorded as follow-up work

Structure (dag.json / state.json / _shared.md):
[x] Identity is a stable slug - no positional state numbers
[x] dag.json holds structure; state.json holds runtime only
[x] Slug set in dag.json.nodes == slug set in state.json.states; every context path exists (gap-check)
[x] Shared definitions centralized in contexts/_shared.md

Per-state completeness:
[x] Acceptance criteria section present - 155 criteria across 30 states
[x] Criterion IDs are slug-keyed and match the guard.py check ids
[x] reservations.mutates is populated for every state
[x] dag.json artifacts match reservations.mutates (set-reservation syncs them)
[x] Commit points section present in every context
[x] Shared-file merge protocols - N/A, no two concurrently runnable states share a mutable file (check-disjoint.py: 54 concurrent pairs, 0 overlaps)

Guards and audits:
[x] Guards are red before the work begins - verified: guard.py scaffold exits 7, guard.py mig-foundation exits 4, audit-final reports [dod.6]-[dod.8] FAIL
[x] All criteria are deterministic commands (criteria.json, no prose)
[x] Final audit has negative checks - source untouched until cutover, no Runtime.evaluate, no --enable-automation, no apigen.* namespace
[x] Final audit has a live data check - real Chrome e2e and a real MCP stdio probe of agent-search
[x] notes field answers what the context file does not make obvious (executor and tier plus gotchas)
[x] dag.json dependency graph matches the topology in README.md and TOOLS.md section 6

Hand off:
[x] Dispatch decision made - plan-orchestrator execute stealth-browser, printed in README `## Dispatch`
```
