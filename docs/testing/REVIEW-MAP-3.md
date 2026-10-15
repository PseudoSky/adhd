# Review: STRATEGY v0.3, STRATEGY_MAP v0.8, STATE v0.6

Scope: `docs/testing/STRATEGY.md`, `STRATEGY_MAP.md`, `STATE.md`, read in full. I did not check sox-ecosystem line citations (`dispatcher.md:430` and the like), because that tree is not a git checkout at `/Users/nix/dev/sox-ecosystem`. I did check the adhd-side claims I could (file sizes, `AGENTS.md`, `.githooks/pre-push`). I recomputed the STATE wave table and critical path from the `depends` fields. Both are correct, apart from the scope-collision notes in finding 17.

Severity: B = blocking (the design cannot work, or contradicts itself or a binding rule), M = material, m = minor.

## Findings

### B1. The red-evidence rule cannot be satisfied by the stubs it prescribes
- STRATEGY §14 and §6.5 require interface stubs whose bodies "throw 'not implemented'". They also require red evidence to be "a failed assertion", and say a missing symbol or compile error "proves nothing".
- A test that calls a stub which throws fails with an uncaught error, not a failed assertion. In most runners that is a different outcome class.
- T22.AC4 and T23.AC8 reject a `red:` record that "does not name a failed assertion". The prescribed happy path therefore fails its own checker.
- §6.5 handles only tests that assert a throw. It does not handle this general case.
- Fix one of these:
  - Change the stub contract. For example, stubs return a typed default, so assertions fail on value.
  - Define red as "fails for a reason other than missing symbol or compile error".
  - Define how the checker tells a thrown "not implemented" apart from a thrown real defect.
- Until then, T22, T23 and T16.AC5 (the separated-authorship protocol) are unimplementable as specified.

### B2. Unmediated mode lets Deep changes through without separated authorship or independent approval
- STRATEGY §6.6 says separated authorship is REQUIRED at Deep.
- §13.1 says review debt is permitted only at Light and Standard, and that an unbound Auditor or Static reviewer at Deep blocks the change.
- MAP §1C.4 says that at "Standard or Deep", when the host cannot dispatch a Test author, the agent writes the tests itself and returns them as unreviewed.
- T44.AC1 and T45.AC1 repeat this with no Deep exception.
- This contradicts STRATEGY on exactly the highest-risk changes (persistence, security, published interface). MAP §1E.4 also lists "Test author" among roles that block at Deep, which STRATEGY itself never says.
- Add an explicit rule: an unmediated Deep change is refused or escalated. Align §13.1 with MAP §1E.4 on the Test author.

### B3. A changed class can bypass the whole path, and nothing checks class against write scope
- Rigor is "derived, never chosen", but the class is chosen by the Classifier.
- T43.AC2 checks only boundary-or-contract, refactor-on-persistence and unknown-class.
- T16.AC6 skips static review and QA for an all-class-None bucket. Class None needs only G1, G2, G4, G10 and G12.
- So a code change recorded as `no-code` skips review, QA and test authoring.
- T43 needs a mechanical consistency check:
  - class `no-code` is invalid if the write scope touches source or test paths;
  - class `refactor` is invalid if the diff adds behavior-bearing files.
- Related: MAP §1C.2 says "the rigor of a change is never an agent's opinion". That overclaims.
  - Triggers such as "crosses an ownership boundary", "security-relevant" and "effect cannot be undone" cannot be detected from path patterns.
  - STRATEGY §6.6 admits some triggers are author-asserted.
  - T43.AC1 takes only (class, write scope), so there is no input for asserted triggers. The testing record has a `triggers:` field, but the command never reads it.

### B4. The ownership check (T46) can be defeated in the same edit
- T46.AC1 exempts any file whose header lacks `authorship: separated`. T34.AC3 treats a missing field as implementer-authored legacy.
- The implementer's dispatch could therefore delete the header line in the same commit that edits the test. The check must read the header from the base commit, not the head. No AC says so.
- T46.AC2 verifies the run line "against the dispatcher's telemetry row". Nothing says where telemetry is stored or whether CI can read it. If telemetry is session output, the check is unverifiable in CI (T46.AC5).

### B5. The repository's own IMPLEMENTATION would be non-conformant to STRATEGY §13
- §13 says an IMPLEMENTATION "at minimum" defines ten items, including item 8, a migration plan "with owners and dates".
- D10 and T02.AC4 replace that with a statement that migration is left to the finished system.
- T02.AC1 lists nine "required sections", which do not map to §13's ten items:
  - Missing: stage mapping, retention bindings, migration plan, decision-tree bindings.
  - Extra: case design, data and fixtures, environments, automation architecture.
- Either amend STRATEGY §13.8 (for example, allow "deferred, with a filed item") or change T02 and D10. As written, the T41 completeness check should fail the first IMPLEMENTATION it sees.

### B6. T40.AC2 collides with an explicit owner decision and an existing mechanical check
- `AGENTS.md` line 34: "e2e is CI-only and paused locally by owner decision, backlog 8963c3cb".
- `.githooks/pre-push` header: `check-lane-reachability.mjs` "fails the push ... if this hook stops running `test` / starts running `e2e`".
- ADR-0009 puts subprocess tests in the e2e lane. T40.AC2 (pre-push runs affected P `smoke`) is subprocess work, so it re-adds the paused work.
- MAP F11 and §4.4 treat the missing pre-push P smoke as a defect. They do not mention 8963c3cb or any need to reverse it.
- Resolve with the owner explicitly, and note that the reachability check must be updated in the same change.

## Material

### M1. Task dependencies are wrong or missing
- **T10** has `depends: none` and sits in wave 1.
  - T10.AC5 checks "each role in `roles.md`" using `roles-covered` declarations. `roles.md` is created by T14 (wave 2). The declarations arrive with T11, T13, T18, T19 and T22 (wave 3 and later).
  - T10.AC2 requires a check that is green only after T12, which itself depends on T10. T10 cannot close in wave 1.
  - Split T10 into a name-resolution part (wave 1) and a role-resolution part (after T14).
- **T45** depends only on T34 and D15.
  - It needs T32: T45.AC3 says "G4 fails the build past the expiry", and G4's scanner is T32.
  - It needs T39: T45.AC2 and T45.AC3 use the standing review item and bump from T39.AC2/AC3.
  - It is also circular in intent. T39.AC1 consumes "open unreviewed-tests items", which are created by T45 (wave 7), after T39 (wave 4).
- **T12 and T13** cite "the routing table (T49)" (T12.AC2, T13.AC4) but do not depend on T49.
- **T02 and T48** both write `docs/standards/testing.md`.
  - T48.AC1 generates the skeleton (wave 3). T02 drafts the file (wave 4) with no dependency on T48.
  - T48.AC3 requires a second run to produce no change, but nothing says how `apply` treats a hand-filled binding table that is not inside a managed block.
  - T57.AC3 later calls the file "generated by `apply testing`".
  - T02 should depend on T48, and the file should have a defined managed region.
- **T03 and T44** both write the `workspace-standards:testing` block (T03.AC1 vs T44.AC1), and both are produced by T48. Ownership is duplicated.
- **Status text.** The `blocked(...)` lists name only some blockers (T05 lists T39 but depends on T02, T39, T40, T41; T12 omits T10; T16 omits T03; T20 lists one of seven).

### M2. Two sources of truth for routing
- D5 puts the task-to-agent routing table in `AGENTS.md`. T12 also rewrites the routing rows in `dispatcher.md`.
- Nothing says which one wins at dispatch time, or how a name in `AGENTS.md` that the dispatcher rows do not list is resolved.
- The T10 guard validates names in `dispatcher.md` and `roles.md`. It does not validate the `AGENTS.md` table (T49.AC1).

### M3. Stage F's failure route is a log line, and the bump rule is inconsistent
- STRATEGY §7.4 requires "a named owner and a failure route" and warns that "a review item nobody works is a lane that never ran".
- T39.AC4's only consequence for an item stuck at the top is that it is "named in the step's output". That is not a mechanism (P13).
- MAP §1G says a signal bumps priority "at most once per signal kind per period". T39.AC2 only proves idempotence per run id, so two mainline pushes in one period can bump twice.
- "Raise by one step" is read-modify-write, and MAP §1G has two writers (the CI step and the dispatcher at 5.8). Nothing makes the bump atomic or deduplicates across writers.
- "Period" is undefined: rolling or calendar, and who evaluates the "lower one step" case (T39.AC7).
- The success of stage F also depends on someone running `qa` on the item. No task schedules or forces that.

### M4. Independence by session is weak, and the dispatch overhead is unmeasured before it becomes default
- A fresh `qa` dispatch counts as a "different party" from an earlier `qa` session (D11, D19). The same model and brief means correlated blind spots, and no diversity is required even at Deep.
- This is a deliberate design trade-off. It deserves an explicit risk statement in STRATEGY §13.1 or §14, not only the mechanical "session" definition.
- D12 and T43 make separated authorship the default at Standard from wave 5. T24 (wave 9) measures the cost after the default is live. MAP §10 step 8 says "measure ... before widening", which contradicts the wave order.
- T24.AC1 measures one bucket of at least four items. Two runs on one bucket cannot support the keep/tighten/relax decision in T24.AC3.
- T22.AC5 passes if the separated tests catch "at least as many" of at least three seeded faults. With n=3 and ties passing, it has little power to reject the design.

### M5. Coverage gaps: STRATEGY obligations with no STATE task
- **G11** (strategy conformance for test infrastructure) is mapped in MAP §4.7 to "CODEOWNERS-style routing ... to `qa` review". CODEOWNERS routes to GitHub identities, not to an agent, and no task builds anything.
- **Metrics (§11):**
  - Signal precision, escape rate by tier and by class and rigor, and change-failure rate and lead time have no producing task. MAP §4.9 points at T39, but T39.AC5 lacks them.
  - T19c.AC1 only records the earliest catching tier; no task aggregates it.
- **§7.3** (deferral rule) and the exception log have only T35.AC4, which documents a convention. No check consumes it.
- **§12** (data, fixtures, automation architecture) is carried by no task or check.
- MAP §11 says every clause id is "placed in §4". Placement is not delivery. The T41 completeness check verifies only binding-table rows, and nothing flags a placed clause with no task.

### M6. Stale or inconsistent measured facts
- MAP §1A.7 states STRATEGY v0.3 is 61,338 bytes (about 15,300 tokens). `wc -c` now gives 65,528 (about 16,400). MAP says to re-measure; it was not re-measured, and the table cannot be trusted as written.
- MAP "Revisions read" cites adhd `14b06b4`, while §4.1 P10 and the 0.6 provenance cite `b76b4bed`. Three adhd revisions appear (`14b06b44` is also cited for the pre-push change).
- STATE T32.AC3 says "no count is quoted in this file", yet STATE §3 stream S4 and §4 quote 81, 878, 28 and 103.
- STATE §4 reports "about 28 modified `package.json` / `CHANGELOG.md` files". `git status --porcelain` currently shows 14 entries, so the figure is stale.
- STATE §1 heads D1–D24 "answered by the owner 2026-10-07".
  - MAP §9 says D19–D24 "were taken in the review round that followed" the owner's "the rest approved".
  - D19–D24 post-date that approval, so the owner's answer to them is not evidenced. T01 still lists D19–D24 as dependencies while Wave 0 says none are open.

### M7. "The system drives the existing specs to resolution" is not a success metric
- D10 and STATE S4 define success as the finished system resolving the existing 81 stub specs, 28 skip blocks, 103 sleeps and the failing CI. No threshold, deadline or measure is given, and the migration is explicitly excluded from the plan.
- The plan cannot say whether it succeeded.
- MAP/STATE §4 notes `ci.yml` failed on 6 of the last 8 mainline runs (out of plan). T40.AC3 (whole-repo mainline run) and G1 (the gate is mainline-green) assume a healthy CI baseline.
- State a measurable criterion (for example, counts at a date) and a sequencing rule for the CI health item.

### M8. No reuse analysis for T62, T14 and T41
- The repo already has `tools/gate/lane-gate.mjs` and `check-lane-reachability.mjs` (MAP PJ-chk), and Nx affected/target orchestration.
- T62 builds a "domain-neutral gate and check engine" and T30 a command table feeding it, with no comparison against existing tools or the existing gate set.
- `AGENTS.md` requires reuse and evaluating third-party tools before authoring. Only T38 has a research step. T14's templated managed blocks and T62 also have off-the-shelf analogues that were not looked at.
- STATE §4 records that the memory/search servers were unavailable during planning, so the design's prior-art check was not done.

### M9. `report` and QA duplicate-run claim
- MAP §1A.5 says the gate runner "removes duplicate suite runs" because QA reads the report instead of rerunning.
- The report is produced at the dispatcher's final run (5.8), after QA (5.6). Nothing runs it before QA. Either QA still runs the suite and the dispatcher reruns it, or the lifecycle order changes. The claim is unsupported.

### M10. Name-independence check ties a portable policy to one roster
- T01.AC2 and T41.AC6 fail STRATEGY if any backticked token matches the live agent list. The tags `security` and `performance` already collide with agent names and are handled by an exclusion table.
- Adding an agent named `smoke`, `property` or `contract` would turn a portable document red. The `--also test-author --also review` flags show names being added by hand.
- Restrict the check to names bound in `roles.md` and the harness's declared roles, or have STRATEGY avoid backticking tag names.

## Minor

- **m1.** Identifier collisions make the documents hard to read: tier `S/P/H/X` vs sources `[S#]` vs STATE streams `S1–S5`; stage `F/G/H` vs gates `G#` vs findings `F#` vs tier `H`; retention `R#` vs principle `P#` vs tier `P`. STRATEGY's Notation paragraph covers only part of this, and STATE and MAP reuse the clash.
- **m2.** STRATEGY §14 requires write scope "declared up front, by file". For an implementer who creates new files this is not knowable in advance; directory or glob patterns are the workable unit (T23.AC2 repeats "by file").
- **m3.** G7 blocks on "a p95 more than 10% above the previous mainline run's". On shared runners this is itself flaky, which is at odds with P6. State a variance control (repeat count, tolerance, or rolling baseline).
- **m4.** STRATEGY P8 and S20: the only source for "deferring slow tests to nightly raises merge risk" is a vendor documentation page. The S5 citation for the 100 ms tier-S budget is not checkable from the document (the document says only the 1 s figure is its own).
- **m5.** MAP §11's section count omits §2.5 (which §4.3 does place) and §10 (placed in §4.7); the list needs updating.
- **m6.** STATE T21 (file the `performance`/`performance-engineer` duplicate) is unrelated to testing. STATE §4 also lists observed issues as "not filed" (the duplicate, the unauthored modified files). The repo rule is to file at discovery, not defer.
- **m7.** STATE T57.AC3 ("`rg -n "docs/testing/" docs AGENTS.md` returns nothing") is not phrased as the exit-code check that STATE line 8 requires (`rg` exits 1 on no match).
- **m8.** STATE T22.AC3 and the playbook cards are stated as ≤4096 bytes, but MAP §1A.7 budgets about 1,000 tokens per card and does not count the inlined tier-mapping excerpt or the routing object, so per-dispatch cost is understated.
- **m9.** STRATEGY §13.1 says review debt "fails the build past its expiry". An unrelated merge can then go red because of an expired debt entry, which the §10 ratchet language ("a tightening never turns unrelated work red by surprise") otherwise avoids. State which scope the failure applies to.
- **m10.** STRATEGY and MAP use `todo` for both "an `it.todo` marker" and "a placeholder"; define one term. STRATEGY's Provenance for 0.3 calls the source review "blind", while STATE and MAP call it an "independent review" (and STATE says a blind re-review is still pending). Use one term.
- **m11.** No task covers releasing the harness changes (new `review`, `test-author`, `workspace-standards` skill, dispatcher version bump, changelog entries) to the installed host. T14.AC9 covers installing only the skill. T12 and T16 take effect only after installed-copy refresh.

## What holds up
- The wave and critical-path computation matches the `depends` fields.
- The class list, the eight `change-class` values and the thirteen roles are consistent across the three documents.
- The role-to-clause index, the one-polarity AC convention, and the explicit "no gate is relaxed by class" rule are carried through cleanly.
- The source quotations I could check from memory (P5/P6/P2/P3) match their sources.
