# Step 7 — Final review checklist

Before publishing the plan, verify every box. If any item fails, the plan does not ship.

**This checklist is also a gate.** Every box is ticked (`[x]`) or marked
`N/A — <reason>`; `gap-check.js` (Check 9) fails the plan while any box is unticked.

```text
[x] Definition of Done agreed in Step 1a — README has a `## Definition of
    Done` with IDed [dod.N] clauses (outcome, old-gone, evidence, non-goals,
    rollback). The 5 goals were supplied verbatim by the requester; the 15
    clauses are their derivation. dod.1–dod.13 were confirmed at the GATE 2
    approval recorded in APPROVAL.md, with the provenance marker stamped via
    --confirm-dod. dod.14/dod.15 were added by the 2026-09-21 repair pass from
    measured defects the original 13 did not cover, and are recorded in
    APPROVAL.md § Amendment 2026-09-21 as pending owner re-acknowledgement.
[x] Every [dod.N] is proven by a final-audit check (gap-check.js Check 8) —
    15 `dod.N` entries in scripts/criteria.json; gap-check green.
[x] Every BEHAVIORAL [dod.N] declares `entrypoint:`/`observable:` and is proven
    by a check that DRIVES that entrypoint (tier 3) — not a grep/test -e proxy.
    dod.3/5/6/7/14/15 are behavioral; each `dod.N` criterion's cmd contains the
    entrypoint's distinctive token and asserts the observable. dod.4/9/10 are
    structural absences, correctly proven by grep/AST. dod.14 drives the BUILT
    apigen-cli artifact as a real child process; dod.15 drives the built browser
    bundles and asserts the token's absence.
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
    migration period". TOOLS.md §3's gaps G1–G9 each map to a state and its
    guard; no context file contains a trigger phrase without a resolving state.
    G7 (no state proved an artifact loads) and G8/G9 (the bundler token, and the
    browser package's two independent failures) were closed by the 2026-09-21
    repair pass, each with a named owning state.

Structure (dag.json / state.json / _shared.md):
[x] Identity is a stable slug — no positional state numbers anywhere in the
    source files.
[x] dag.json holds structure; state.json holds runtime only (status,
    timestamps, logs).
[x] Slug set in dag.json.nodes == slug set in state.json.states; every context
    path exists (20/20) — enforced by gap-check Check 1.
[x] Shared definitions centralized in contexts/_shared.md — no concept
    restated across contexts. 17 `[def:]/[inv:]/[shape:]/[fix:]` entries,
    including the two the repair pass added (`[def:empty-import-meta]`,
    `[inv:bump-lands-with-its-fix]`, `[inv:guards-prove-the-artifact-loads]`).

Per-state completeness (verified for every work state):
[x] Acceptance criteria section present. 109 criteria across 20 states; every
    modified file group has a criterion, and every deletion has a negative
    (`absent`) criterion. The negative-control criteria
    (`vite-cjs-import-meta-repair.9`, `browser-cjs-umd-repair.6`,
    `tsconfig-shim-removal.5`, `typecheck-teeth-restored.1`) perturb the
    exact primitive their guard measures, in the gitignored build artifact.
[x] Criterion IDs are slug-keyed (e.g. [core-types.1]) and match the check IDs
    in the next audit script — the criteria.json ids ARE the audit check ids,
    so the mirror holds by construction.
[x] reservations.mutates is populated — every file the state creates or changes
    is listed.
[x] dag.json node's artifacts array matches reservations.mutates exactly —
    verified programmatically for all 20 nodes.
[x] Commit points section present — mandatory post-guard commit on every state.
[x] Shared-file merge protocols written. N/A — the graph is deliberately
    linear (no two states share a mutable file without a depends_on edge), so
    there are no parallel states to reconcile. The cross-branch merge protocol
    that DOES exist is `[fix:absorbing-a-sibling-branch]` in _shared.md.

Guards and audits:
[x] Guards are red→green — each guard currently fails before the state's work
    begins (verified: e.g. no `cacheDirectory` key, no `test:related` script,
    five shims present, 136 shadowing targets present). For the repair-pass
    states: `vite-cjs-import-meta-repair`'s atomicity leg is red today (the
    plugin is untracked, so its last-touching SHA ≠ `package.json`'s);
    `browser-package-build-repair`'s build leg is red today (`Found 4 errors`);
    `browser-cjs-umd-repair` is red today both because its spec does not exist
    and because the token is reported present in the bundles.
[x] The audit gates actually RUN — **this was false until the 2026-09-21 repair
    pass.** Three compounding defects made every `guard_audit_*.py` red by
    construction, and one made them non-terminating. All four are fixed; the
    reconcile gate now completes in ~55s and emits 39 real `[id] PASS/FAIL`
    markers instead of `[audit.no-criteria] FAIL`. See *Open items* below for the
    full list. Re-verify by running
    `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_reconcile.py`.
[x] All criteria are deterministic commands — no prose, AST checks over greps
    where ambiguous (`absent` on the executor strings is an exact literal, not
    a loose grep).
[x] Final audit has negative checks — absence of the old system, not just
    presence of the new: the shims are gone, the shadowing executors are gone,
    the release/lint executors are gone, and the fast path refuses a zero
    selection.
[x] Final audit has at least one live data check — real artifacts, not just
    fixtures: three real builds, a real package suite, a real bespoke
    second-pass compile, real spec selection across a package boundary, and (new
    in the repair pass) two built CommonJS entrypoints executed as real child
    processes plus the browser package's built bundles read off disk.
[x] notes field answers "what do I need to know that the context file doesn't
    make obvious" — every node carries one.
[x] dag.json dependency graph matches state-machine.md topology diagram
    exactly. **Corrected 2026-09-21:** the previous claim here — that
    state-machine.md is generated from dag.json by a render script, so drift is
    impossible by construction — was **false**. No such renderer exists in the
    plan-state-machine skill (`templates/state-machine.template.md` is a
    template; no script reads dag.json to emit the render). The file is
    hand-maintained, so drift is possible and must be checked by eye after every
    structural change. Filed as a tooling gap in the closing report; do not
    re-assert the generation claim until a renderer actually exists.

Hand off:
[x] Dispatch-or-orchestrate decision made — automatic dispatch = NO (Step 1b);
    the Dispatch line is printed in the closing handoff.
```

## Open items carried, not hidden

- **`[dod.14]` / `[dod.15]` post-date the GATE 2 approval.** They are derived from
  measured defects (`BUG-BUILD-002` and the React-19 build breakage), not from new goals, but
  they were authored after the approval recorded in `APPROVAL.md`. That file carries an
  *Amendment 2026-09-21* section naming them as pending owner re-acknowledgement. The
  `dod_provenance` marker in `state.json` still records the original 13 — deliberately not
  re-stamped, because re-stamping would claim a confirmation that has not happened.
- **The plan-state-machine skill ships no `state-machine.md` renderer.** `final-review.md`
  previously asserted one existed. It does not — `templates/state-machine.template.md` is a
  template, and no script in the skill reads `dag.json` to emit the render. The render is
  therefore hand-maintained and can drift. The false claim has been removed; the missing
  renderer is reported to the operator rather than filed to the backlog store, which this
  session was instructed not to touch.

### Four audit-gate defects, found and fixed 2026-09-21

All four are **plan-local** (they live in this plan's `scripts/`, not in the skill), and all
four are invisible to `gap-check` and `env-pin-check` — which is why the plan reviewed clean
while its hold points could not have passed. They were found by *running* the gates.

1. **The guards could not find their own criteria file.** `guard_audit_*.py` invoke
   `run-audit.js` with `cwd=REPO_ROOT`, but the runner resolves `criteria.json` relative to
   `process.cwd()`. The criteria *commands* are repo-root-relative (`./node_modules/.bin/nx`),
   so both cannot be satisfied by one `cwd`. Every guard reported
   `[audit.no-criteria] FAIL` regardless of the plan's real state.
   *Fix:* pass the runner its criteria file explicitly —
   `--criteria <plan>/scripts/criteria.json` (checked first, honours an absolute path) —
   keeping `cwd=REPO_ROOT` for command execution.
2. **The guards passed a phase list the runner rejects.** `PHASES = "intake,reconcile"` (and
   longer variants) were passed as `--phase "intake,reconcile"`, but the runner accepts **one**
   phase name and *accumulates* every phase declared before it:
   `--phase "intake,reconcile" is not a declared phase`. The guards contradicted the
   accumulation contract their own docstrings and `TOOLS.md` §5.4 describe.
   *Fix:* `PHASES` is now the terminal phase only — `reconcile`, `config`, `graph`, `tests` —
   which yields exactly the "this phase plus all prior phases" behaviour intended.
3. **Five audit criteria were self-recursive.** `audit-{reconcile,config,graph,tests,final}.2`
   ran `python3 …/guard_audit_<phase>.py`, which re-ran the audit, which ran that criterion
   again — unbounded recursion, and for `audit-final` it re-ran *every* criterion. Defects 1
   and 2 masked this: the guard died on `[audit.no-criteria]` before recursing.
   *Fix:* each is now a non-recursive `present` check asserting the guard passes the runner
   `--criteria`, which also pins defect 1 against regression.
4. **A false claim about generation.** See the corrected checklist item above.

**Verified after the fix:** `guard_audit_reconcile.py` completes in ~55s and emits 39 real
markers — the correct red/green pattern for a plan whose work has not started (the
`upgrade-baseline` toolchain checks, the `vite-cjs-import-meta-repair` artifact-load proof and
its negative control, and the corrected audit criteria all PASS; every not-yet-done state's
criteria FAIL).
- **The browser bundle token was not independently reproduced.** See `demo/UNRESOLVED.md`.
  `browser-cjs-umd-repair` re-confirms it as its first step.
- **GATE 2 approval** is recorded in `APPROVAL.md` (committed artifact). Without
  it, `gap-check` fails on the DoD-provenance gate — deliberately.
- **The lint-mutation criterion** (`graph-release-eslint-inferred.5`) is a scope
  extension derived from goal 2, flagged in `SCOPE.md` §2 and `demo/UNRESOLVED.md`.
- **The three post-bump gate failures** have no verdict yet; `gate-triage-absorbed`
  consumes it rather than assuming the bump was clean.
- **The backlog store returned 0 items** on every query (a ~36 MB database serving
  nothing). Findings from this session could not be filed through `adhd-backlog`;
  they are recorded in this plan and in the closing report instead.
