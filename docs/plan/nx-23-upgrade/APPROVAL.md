# APPROVAL — `nx-23-upgrade`

**GATE 2 sign-off.** This is the committed audit trail downstream states reference.
A working-tree-only or chat-only approval is not an approval; this file is.

| Field | Value |
|---|---|
| Plan | `nx-23-upgrade` |
| Branch | `perf/nx-upgraded` |
| Approver | human (repo owner), interactive session |
| Approved at | 2026-09-22T02:05:27Z |
| Base ref at approval | `301e2882f1ee8e48eb2badada7988650db0543a5` |
| Gate | GATE 2 — explicit approval of the finalized DEMO.md **and** TOOLS.md |

---

## Approved artifacts

| Artifact | SHA-256 |
|---|---|
| `demo/DEMO.md` | `3be06206af3b3bfffc2444170ba9a54e24ec1910bfdad2331dd859533da64937` |
| `TOOLS.md` | `53ceab1f621b7b0ef42d4e9bcfbdbb41ba4c09e2783018706d3d51da22093a61` |
| `SCOPE.md` | `58692b8034e67677e5f16794504b453ca300916e2cfec626b4b616befea0765c` |
| `USE_CASES.md` | `b2f7b5f5ebcde5f4f79249a2d1cacb50d31219e1ecdf44024450ae8606362179` |
| `README.md` (13 DoD clauses) | `1e3c5dfb69df6b17a7e3e026e56a038562dbfdf41128259a0753a7eac2ab6153` |

**`DEMO.md` is the Definition-of-Done source.** Every binary pass/fail assertion in
it maps to a `[dod.N]` clause and to at least one state's acceptance criteria.
**`TOOLS.md` is the tooling contract.** Executors consume its interface contracts
(§5) and must not re-derive them.

---

## What was approved

1. **The Definition of Done** — 13 clauses (`[dod.1]`…`[dod.13]`) in `README.md`,
   each proven by an executed final-audit check. Provenance stamped via
   `state-transition.js --confirm-dod`.
2. **The demo** — 3 acts, a climax, a resilience sweep and a teardown; 28
   requirements and 10 capabilities all traceable to ≥1 beat;
   `validate_demo.py` exits 0 with 0 warnings.
3. **The tooling verdicts** — 14 capabilities, 6 gaps, one verdict each: five
   reuse/extend, zero build-from-scratch. Five mechanisms explicitly rejected with
   reasons.
4. **Plan location** — authored and committed on `perf/nx-upgraded` in
   `.worktrees/nx-perf-upgraded`, per goal 5.

---

## Decisions taken at this gate

| Decision | Outcome |
|---|---|
| Remodel breadth (goal 2) | All five executor families, phased with an audit hold between each |
| Sibling branches (goal 5) | Absorb `perf/nx-cfgfix` and `perf/test-resolve-fix` into the upgrade branch; keep the publish-gate restoration |
| Compiler shims | Delete all five; prove parity empirically rather than by assertion |
| Test selection (goal 4) | Fail-safe opt-in. Full suite stays the default; zero-selected is a hard failure. Re-validate the 3-defect verdict on the current toolchain before relying on it |
| Lint-mutation criterion | **KEPT** — `graph-release-eslint-inferred.5` requires the lint path to depend on the check-only sibling. Derived from goal 2's "correctly", confirmed by the approver at this gate |

---

## Standing constraints accepted with this approval

- **No landing.** No state pushes, merges to the default branch, or publishes.
  `audit-final` is a hold; the landing decision is a separate human call.
- **`test.dependsOn` keeps `lint`.** Dropping it removes the publish gate (BUG-060).
- **`^build` stays in the test path.** Measured inconclusive for speed; load-bearing
  for the four child-process projects.
- **A zero-selection test run is a failure**, never a success.
- **The commit gate is not narrowed.**

---

## Open items carried into execution

1. **The three post-bump gate failures have no verdict yet** (`apigen-cli`,
   `backlog`, `apigen-plugin-java-javalin`). `gate-triage-absorbed` consumes the
   triage result; no state may assume the vite bump was clean.
2. **The backlog store returned 0 items** on every query against a ~36 MB database.
   Findings from this session could not be filed through `adhd-backlog`; they are
   recorded in this plan and in the authoring session's closing report.
3. **Three ⟦U#⟧ stubs** in the demo (wrapper message wording, selection-summary
   shape, post-remodel project count) are resolved by the states that deliver them.
