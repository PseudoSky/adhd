# Step 7 — Final review checklist

Before publishing the plan, verify every box. If any item fails, the plan does not ship.

**This checklist is also a gate.** Every box is ticked (`[x]`) or marked
`N/A — <reason>`; `gap-check.js` (Check 9) fails the plan while any box is unticked.

```text
[x] Definition of Done agreed in Step 1a — README has a `## Definition of
    Done` with IDed [dod.N] clauses (outcome, old-gone, evidence, non-goals,
    rollback). The 5 goals were supplied verbatim by the requester; the 13
    clauses are their derivation, confirmed at the GATE 2 approval recorded in
    APPROVAL.md, with the provenance marker stamped via --confirm-dod.
[x] Every [dod.N] is proven by a final-audit check (gap-check.js Check 8) —
    13 `dod.N` entries in scripts/criteria.json; gap-check green.
[x] Every BEHAVIORAL [dod.N] declares `entrypoint:`/`observable:` and is proven
    by a check that DRIVES that entrypoint (tier 3) — not a grep/test -e proxy.
    dod.3/5/6/7 are behavioral; each `dod.N` criterion's cmd contains the
    entrypoint's distinctive token and asserts the observable. dod.4/9/10 are
    structural absences, correctly proven by grep/AST.
[x] Any artifact-to-artifact seam is exercised by ONE check through the real
    path. The fast-path contract is the one seam: it is pinned in README
    [dod.5]/[dod.6], realized by `[shape:fast-path-contract]` in _shared.md,
    asserted by the `dod.5`/`dod.6` commands AND driven end-to-end by
    scripts/check-zero-selection.mjs + check-cross-package-selection.mjs —
    one path, two checks, no isolated pair.
[x] Final audit emits a `[dod.N] PASS` line per clause and the terminal
    transition's DoD-confirmation gate is satisfiable. guard_audit_final.py
    refuses green if any declared [dod.N] emitted no executed PASS marker.
[x] Final audit written first — every design principle has a named check.
    The DoD was authored before the `dod.N` proof criteria; each state's
    criteria were authored with its context.
[x] All magic named — every special case referenced in the final audit.
    TOOLS.md §2 "Deliberately not used" names every rejected mechanism
    (`--changed` as a global default, `server.deps.inline`, `--skip-nx-cache`,
    direct `tsc`, `@monodon/rust` removal) with the reason.
[x] Shorthand/mechanism separated — the ergonomic concept ("run only the tests
    that matter") is preserved as an opt-in script, while the fail-open
    mechanism (`--changed` as a global target default) is eliminated outright.
[x] External caller analysis done — `gap-check.js --discover` ran clean.
    Oracle = scoped grep (GitNexus index stale vs the working tree; no
    $PSM_LSP_CMD configured). No FAIL lines.
[x] Every node changing a symbol declares it in dag.json `changes` (deletes/
    resigns/renames). N/A — no state deletes, renames or re-signatures a
    TypeScript symbol. The deletions are config-level (task target
    declarations, compiler-option keys), which the symbol oracle cannot see;
    they are covered by explicit `absent` criteria instead, which is a
    stronger check for an absence assertion.
[x] Every deferral has a forcing function — named state and guard, no "during
    migration period". TOOLS.md §3's gaps G1–G6 each map to a state and its
    guard; no context file contains a trigger phrase without a resolving state.

Structure (dag.json / state.json / _shared.md):
[x] Identity is a stable slug — no positional state numbers anywhere in the
    source files.
[x] dag.json holds structure; state.json holds runtime only (status,
    timestamps, logs).
[x] Slug set in dag.json.nodes == slug set in state.json.states; every context
    path exists (16/16) — enforced by gap-check Check 1.
[x] Shared definitions centralized in contexts/_shared.md — no concept
    restated across contexts. 12 `[def:]/[inv:]/[shape:]/[fix:]` entries.

Per-state completeness (verified for every work state):
[x] Acceptance criteria section present. 82 criteria across 16 states; every
    modified file group has a criterion, and every deletion has a negative
    (`absent`) criterion.
[x] Criterion IDs are slug-keyed (e.g. [core-types.1]) and match the check IDs
    in the next audit script — the criteria.json ids ARE the audit check ids,
    so the mirror holds by construction.
[x] reservations.mutates is populated — every file the state creates or changes
    is listed.
[x] dag.json node's artifacts array matches reservations.mutates exactly —
    verified programmatically for all 16 nodes.
[x] Commit points section present — mandatory post-guard commit on every state.
[x] Shared-file merge protocols written. N/A — the graph is deliberately
    linear (no two states share a mutable file without a depends_on edge), so
    there are no parallel states to reconcile. The cross-branch merge protocol
    that DOES exist is `[fix:absorbing-a-sibling-branch]` in _shared.md.

Guards and audits:
[x] Guards are red→green — each guard currently fails before the state's work
    begins (verified: e.g. no `cacheDirectory` key, no `test:related` script,
    five shims present, 136 shadowing targets present).
[x] All criteria are deterministic commands — no prose, AST checks over greps
    where ambiguous (`absent` on the executor strings is an exact literal, not
    a loose grep).
[x] Final audit has negative checks — absence of the old system, not just
    presence of the new: the shims are gone, the shadowing executors are gone,
    the release/lint executors are gone, and the fast path refuses a zero
    selection.
[x] Final audit has at least one live data check — real artifacts, not just
    fixtures: three real builds, a real package suite, a real bespoke
    second-pass compile, and real spec selection across a package boundary.
[x] notes field answers "what do I need to know that the context file doesn't
    make obvious" — every node carries one.
[x] dag.json dependency graph matches state-machine.md topology diagram
    exactly — state-machine.md is GENERATED from dag.json by a render script,
    so drift is impossible by construction.

Hand off:
[x] Dispatch-or-orchestrate decision made — automatic dispatch = NO (Step 1b);
    the Dispatch line is printed in the closing handoff.
```

## Open items carried, not hidden

- **GATE 2 approval** is recorded in `APPROVAL.md` (committed artifact). Without
  it, `gap-check` fails on the DoD-provenance gate — deliberately.
- **The lint-mutation criterion** (`graph-release-eslint-inferred.5`) is a scope
  extension derived from goal 2, flagged in `SCOPE.md` §2 and `demo/UNRESOLVED.md`.
- **The three post-bump gate failures** have no verdict yet; `gate-triage-absorbed`
  consumes it rather than assuming the bump was clean.
- **The backlog store returned 0 items** on every query (a ~36 MB database serving
  nothing). Findings from this session could not be filed through `adhd-backlog`;
  they are recorded in this plan and in the closing report instead.
