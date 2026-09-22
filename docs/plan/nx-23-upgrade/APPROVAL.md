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

> The SHAs above are the artifacts **as approved at GATE 2** and are kept as the historical
> record. `README.md`, `SCOPE.md`, `TOOLS.md` and `DEMO.md` have since been amended by the
> 2026-09-21 repair pass (see *Amendment 2026-09-21* below); their current SHAs differ.

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

## Amendment 2026-09-21 — bump-safety repair (planner-performed, `replan`)

The plan as approved at GATE 2 had a **verified gap**, found by review and re-confirmed by
measurement: `upgrade-baseline` committed the `vite ~6.4.3 → ^8.3.0` bump on its own, and
**no state owned the fix that makes the bump safe**. The guard only compared a version string,
so it went green while the tree was broken.

### What the defect was

- Vite 8's Rolldown lowers `import.meta.url` to the empty object in browser-platform `cjs`
  output, emitting the token `{}.url`. Every shipped `createRequire(import.meta.url)` then
  throws `ERR_INVALID_ARG_VALUE` **at module load**. Measured: `apigen-cli:test` 28 files /
  188 tests green on vite 6.4.3 → 26 failed / 162 passed on vite 8.3.0.
- `packages/ui-react/ui-react-base-hooks` (public, publishable) was independently broken:
  four React-19 type errors made `nx build ui-react-base-hooks` fail outright (no `dist/`
  emitted), and — per the reviewing pass — once built, both its CJS and UMD bundles carried
  the same token, breaking `useFileDownload`'s worker path.

### What changed

| Change | Detail |
|---|---|
| New state | `vite-cjs-import-meta-repair` — lands the CJS fix **and** the bump in one commit |
| New state | `browser-package-build-repair` — conforms the browser package to the installed React 19 types |
| New state | `browser-cjs-umd-repair` — removes the empty-import-meta token from its CJS/UMD bundles |
| Moved responsibility | The bump is no longer committed by `upgrade-baseline`; that state now measures and records it as **pending** |
| Re-pointed edge | `gate-triage-absorbed` now depends on `browser-cjs-umd-repair` (the fixes land before the verdict is consumed) |
| New DoD clauses | `[dod.14]` (the built CJS entrypoint loads and runs) and `[dod.15]` (the browser package builds and its bundles are clean) |
| New criteria | 22 added — 104 total, up from 82 |
| New invariants | `[inv:bump-lands-with-its-fix]`, `[inv:guards-prove-the-artifact-loads]`; `[def:empty-import-meta]` |
| Demo | Beats 2.4, 2.5, 5.5 added; `REQ-019`–`REQ-021`, `CAP-011`–`CAP-012`; `validate_demo.py` still PASS (0 warnings) |

The five original goals are unchanged, and every state that already covered them is untouched
apart from `gate-triage-absorbed`'s single inbound edge.

### Approval status of this amendment

`[dod.14]` and `[dod.15]` are **derived from measured defects**, not from new goals: `SCOPE.md`
O3 already promised vite "installed and building", and a build whose artifact throws at load is
not building. They nonetheless post-date the GATE 2 sign-off above.

- **`dod.1`–`dod.13`, the demo's original beats, and TOOLS.md's original verdicts remain
  approved** as recorded above.
- **`[dod.14]`, `[dod.15]` and the three new states are pending owner re-acknowledgement.**
  They are not fabricated as approved. `state.json`'s `dod_provenance.dod_ids` still lists the
  original 13 and has deliberately **not** been re-stamped — re-running `--confirm-dod` would
  claim a confirmation that has not happened.
- The amendment is logged in `state.json`'s `amendment_log` as a `replan` performed by the
  planner (not an executor escalation), so the plan stays dispatchable.

### Verification performed for this amendment

- `gap-check.js` PASS (0 FAIL, 0 WARN); `env-pin-check.js --strict` — all 19 guards pinned.
- `nx run-many -t build` over the 66 JS/TS projects: **exactly one** failing target
  (`ui-react-base-hooks:build`), which bounds the React-19 blast radius.
- Negative control executed non-destructively on the real artifact: with the CJS shim reverted
  to `{}.url`, `node entrypoint/apigen-cli/dist/index.js --help` exits **1** with
  `ERR_INVALID_ARG_VALUE`; restored, it exits **0**, and the restored file is byte-identical
  (sha256 verified).
- The `apigen-cli` acceptance spec run directly via vitest: **4/4 green** in ~1.5s.
- Format gate measured across the workspace: 11 built `.mjs` keep native `import.meta.url`,
  **0** `.mjs` carry the CJS shim, 22 built CJS bundles carry it.

---

## Open items carried into execution

1. **The three post-bump gate failures have no verdict yet** (`apigen-cli`,
   `backlog`, `apigen-plugin-java-javalin`). `gate-triage-absorbed` consumes the
   triage result; no state may assume the vite bump was clean. It now runs *after* the
   bump-safety fixes, so `apigen-cli` and `backlog` are known-good entrypoints by then.
2. **The backlog store returned 0 items** on every query against a ~36 MB database.
   Findings from this session could not be filed through `adhd-backlog`; they are
   recorded in this plan and in the authoring session's closing report. This session was
   additionally instructed not to touch the production backlog store at all.
3. **Three ⟦U#⟧ stubs** in the demo (wrapper message wording, selection-summary
   shape, post-remodel project count) are resolved by the states that deliver them.
4. **`[dod.14]`/`[dod.15]` and the three new states await owner re-acknowledgement** — see
   *Amendment 2026-09-21* above.
5. **The browser bundles' red state is reported, not re-measured** — the reviewing pass
   built the package past its type-check; the repair pass could not, because the build fails
   earlier on the React-19 type errors. `browser-cjs-umd-repair` re-confirms it first.
6. **The plan-state-machine skill ships no `state-machine.md` renderer**, despite
   `final-review.md` previously asserting one existed. The false claim is removed; the render
   is hand-maintained. Reported to the operator rather than filed (constraint 2).
