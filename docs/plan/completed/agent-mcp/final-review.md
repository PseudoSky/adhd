# Step 7 — Final review checklist (plan 0.0.6)

```text
[x] Definition of Done agreed in Step 1a — README has a `## Definition of
    Done` with IDed [dod.N] clauses covering all 20 items (dod.1–dod.20)

[x] Every [dod.N] is proven by a final-audit check (gap-check.js Check 8)
    — dod.1-dod.20 all referenced in audit_006.py's DoD coverage map

[x] Final audit written first — every design principle has a named check

[x] All magic named — LMStudio inheritance (extends OpenAIProvider — no edit
    needed), claudecli no-stop_reason (columns will be NULL), severity-wins
    ordering, recovery instruction text, and provider-error-dispatch order
    all documented in context files and _shared.md

N/A — Shorthand/mechanism separated — no ergonomic shorthands in this migration;
    all changes are additive fields or targeted bugfixes; no mechanism
    elimination needed

[x] External caller analysis done — resigns declared in dag.json for all changed
    symbols: TokenUsage, AgentMcpErrorCode (stop-reason-types), taskUsageTable
    (schema-migration, cache-tokens), UsageSummary/TaskUsageReport/buildTaskUsageReport
    (usage-report-stop), errorCodeSchema (context-error-code, provider-error-codes).
    All callers covered in mutates/read_only across work states.

[x] Every node changing a symbol declares it in dag.json `changes`
    (deletes/resigns/renames) — work nodes all have changes blocks; audit
    nodes have none (correct — audits produce no symbol changes)

N/A — Every deferral has a forcing function — no deferrals in this plan; all
    Gap #6, Gap #7, and correctness-fix work is in-scope

Structure (dag.json / state.json / _shared.md):
[x] Identity is a stable slug — all 16 state names are kebab-case slugs; no
    positional state numbers anywhere

[x] dag.json holds structure; state.json holds runtime only (status, timestamps, logs)

[x] Slug set in dag.json.nodes == slug set in state.json.states; every context path
    exists — verified: both sets are identical (16 slugs each)

[x] Shared definitions centralized in contexts/_shared.md — severity map
    [inv:stop-reason-severity], windowMessages algorithm [inv:window-messages],
    normalised-stop-reason table [ref:normalised-stop-reason], provider-error-dispatch
    [inv:provider-error-dispatch], claudecli auth recovery [inv:claudecli-auth-recovery],
    ProviderAuthError definition [def:ProviderAuthError] all in _shared.md

Per-state completeness (verify for every work state):
[x] Acceptance criteria section present — each work state has at least one criterion
    per added symbol, one per modified signature

[x] Criterion IDs are slug-keyed (e.g. [stop-reason-types.1]) and match the check
    IDs in the audit scripts — verified by audit_006.py criterion mapping

[x] reservations.mutates is populated — all context files declare their mutated files
    under **mutates:** (format differs from Reservations fenced block; gap-check.js
    will WARN but not FAIL since dag.json artifacts are populated)

[x] dag.json node's artifacts array matches reservations.mutates — same files in both;
    gap-check.js Check 2 will emit warnings for non-fenced format but no failures

[x] Commit points section present — all work states have ## Commit points with R2 commit
    messages; audit states have R2 post-guard commits

N/A — Shared-file merge protocols written — plan is linear sequential; no parallel
    states; orchestrator.ts mutations are sequenced precisely to avoid merge conflicts

Guards and audits:
[x] Guards are red→green — each guard currently fails (the new columns, functions,
    and enum values do not yet exist); passes only after state's work completes

[x] All criteria are deterministic commands — grep/python assertions; no prose checks;
    context-error-code.3 and robustness-fixes.2 use regex-bounded window checks
    (stronger than grep)

[x] Final audit has negative checks — context-error-code.3 verifies context-length
    patterns are inside CONTEXT_WINDOW_EXCEEDED; robustness-fixes.2 verifies old
    PROVIDER_ERROR+string-match cancellation pattern is absent; audit-foundation
    ref-* checks verify old-style inline usage access is not present

[x] Final audit has at least one live data check — audit-final.dod.17 runs
    `npx nx test agent-mcp`, which exercises real in-memory SQLite via drizzle

[x] notes field answers "what do I need to know that the context file doesn't make
    obvious" — all dag.json nodes have notes covering provider-specific caveats,
    timing issues, SDK quirks, and ordering invariants

[x] dag.json dependency graph matches state-machine.md topology diagram exactly
    — linear chain of 16 states verified

Hand off:
[x] Dispatch-or-orchestrate decision made — Automatic dispatch = yes (linear
    sequential; code-review state is human hold point); Dispatch line printed below
```

## Dispatch

```
Dispatch Plan with > Resume the state-machine plan at docs/plan/0.0.6/. Read state.json + dag.json, take current_state, read its context file (and contexts/_shared.md for referenced definitions), do the work within the declared file reservations, run the guard until it exits 0, update state.json (status, timestamps, transition_log), commit every plan write (R1) and honor the context's Commit points, then stop at the state boundary. At the code-review state (kind=review), pause and wait for the human reviewer to create docs/plan/0.0.6/.code-review-complete before advancing. Never skip the guard.
```
