# Step 7 — Final review checklist (usage-tracking)

Before publishing the plan, verify every box. If any item fails, the plan does not ship.

```text
[x] Definition of Done agreed in Step 1a — README has a `## Definition of Done`
    with IDed [dod.N] clauses (outcome, old-gone, evidence, non-goals, rollback).
    NOTE: original DoD was fabricated; replaced via proper elicitation on 2026-06-09.
    New DoD has [dod.1]-[dod.6] + explicit Non-goals section. [dod.2] (usage in MCP
    response body) is a new requirement elicited from the requester.
[x] Every [dod.N] is proven by a final-audit check (gap-check.js Check 8)
[x] Final audit written first — every design principle has a named check
[x] All magic named — every special case referenced in the final audit (present or absent)
    (claudecli undefined-usage path is the magic case, explicitly handled in [audit-final.claudecli.1])
[x] N/A — Shorthand/mechanism separated — this plan introduces new capabilities; no
    shorthand/mechanism conflation to resolve
[x] External caller analysis done — symbols ProviderChatResponse and
    PostModelResponsePayload gain optional fields only; all callers continue to
    type-check without modification. All source-code callers (orchestrator.ts,
    hooks.ts, all provider implementations) are in declared mutates/read_only
    sets. NOTE: `--discover` reports 20 false positives because `grepSymbolFiles`
    includes the `docs/` directory, so plan context files that *mention* these
    symbols as prose appear as "callers". Every actual failure is in
    `docs/plan/usage-tracking/` — zero failures from `packages/` or `apps/`.
    Manual grep confirmed: `grep -rn "ProviderChatResponse\|PostModelResponsePayload"
    packages/` lists only files covered by declared reservations.
[x] Every node changing a symbol declares it in dag.json `changes`
    (provider-token-signal: resigns ProviderChatResponse;
     hook-token-payload: resigns PostModelResponsePayload)
[x] Every deferral has a forcing function — no deferrals; no "during migration period" phrases
[x] Reviewer assigned — code-reviewer subagent (code-review state); planner verifies DB numbers (acceptance-test state)
[x] Old-system disposition explicit — GAPS.md item #4 + ROADMAP.md Phase 1 item #2 updated in docs-and-publish state
[x] Zero-knowledge acceptance test defined — subagent discovers usage without prompting; planner verifies numbers against DB
[x] N/A — No rollback condition specified by requester

Structure (dag.json / state.json / _shared.md):
[x] Identity is a stable slug — no positional state numbers anywhere in the source files
[x] dag.json holds structure; state.json holds runtime only (status, timestamps, logs)
[x] Slug set in dag.json.nodes == slug set in state.json.states; every context path exists
[x] Shared definitions centralized in contexts/_shared.md — no concept restated across contexts

Per-state completeness (verify for every work state):
[x] Acceptance criteria section present — at least one criterion per added symbol,
    one per modified signature, one negative grep per deleted symbol
[x] Criterion IDs are slug-keyed (e.g. [core-types.1]) and match the check IDs in the next audit script
[x] reservations.mutates is populated — every file the state creates or changes is listed
    (context files use prose "**Mutates:**" format; gap-check warns but does not fail)
[x] dag.json node's artifacts array matches reservations.mutates exactly — same files, same order
    (verified manually; gap-check Check 2 warns due to prose format, not machine-parsed)
[x] Commit points section present — mandatory post-guard commit, plus checkpoints for long states
[x] N/A — Shared-file merge protocols written — no parallel states in this plan; all states are sequential

Guards and audits:
[x] Guards are red→green — each guard currently fails before the state's work begins
    (no implementation exists; all guard commands would fail on a fresh checkout)
[x] All criteria are deterministic commands — no prose, AST checks over greps where ambiguous
[x] Final audit has negative checks — [audit-final.neg.1], [audit-final.neg.2], [audit-final.neg.3]
[x] Final audit has at least one live data check — [audit-final.live] (conditional on LMSTUDIO_BASE_URL)
[x] notes field answers "what do I need to know that the context file doesn't make obvious"
[x] dag.json dependency graph matches state-machine.md topology diagram exactly

Hand off:
[x] Dispatch-or-orchestrate decision made; "Dispatch Plan with >" line in README.md
```
