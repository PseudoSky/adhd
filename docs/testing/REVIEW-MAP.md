# Review of STRATEGY.md (0.2), STRATEGY_MAP.md (0.7), STATE.md (0.5)

Scope: the three documents only, read in full. Citations are `file:line`. Facts I measured are marked (measured); everything else is from reading the text. External source claims (S1-S23) were not re-fetched.

## Severity summary

| # | Severity | Finding |
|---|---|---|
| 1 | High | STATE: acceptance criteria of T02 depend on checks that T41 builds, and T41 depends on T02 (cycle) |
| 2 | High | STATE: T01 is `done` but its AC2 and AC3 are not met as written |
| 3 | High | STRATEGY: rigor derivation contradicts itself between 6.6 and 6.7, and STATE T43.AC2 encodes the weaker reading |
| 4 | High | STRATEGY/MAP: independent confirmation of QA removals (8.4.5, 6.7) is replaced by a mechanical check (D9); QA also approves its own in-lifecycle test edits |
| 5 | High | MAP/STATE: "red against the base commit" is not a teeth proof for new symbols |
| 6 | Medium | STATE: T10.AC1 and T10.AC2 contradict each other under D17 |
| 7 | Medium | STATE: T22.AC6 cannot be met inside T22; T12 has an undeclared dependency on T22 |
| 8 | Medium | MAP 1G: demand-driven stage F saturates and drops half of what stage F is for |
| 9 | Medium | STRATEGY 6.7 omits steps that 6.6 requires for default-Standard classes |
| 10 | Medium | Dispute path: the disputed party adjudicates, and there is no ceiling |
| 11 | Medium | "Closest available agent" is not computable by a script as claimed |
| 12 | Medium | STATE: location and portability of the conformance checker and gate runner are contradictory |
| 13 | Medium | STATE: stale statuses and undeclared dependencies |
| 14 | Low | STRATEGY: approval status contradicts its own provenance text |
| 15 | Low | STRATEGY: tree Q2 sends every conformance suite to tier H |
| 16 | Low | Stale or drifted measured numbers |
| 17 | Low | Smaller inconsistencies (list) |

## High

### 1. T02 and T41 form a cycle through their acceptance criteria
- T41 `depends: T02, T14, T30` (STATE.md:272). T02's own ACs require T41's outputs: AC2 "the T41 completeness check passes on it" (STATE.md:64), AC3 "the T41.AC6 name-independence check exits 1 on it" (:65), AC5 "conformance level per the checker's output" (:67).
- T02 is wave 2 and T41 is wave 3 (STATE.md:43-44), so the wave table schedules T02 before the tool that defines "done" for it. T44.AC2 (:294) and T01.AC2 (:58) also cite T41.AC6 before T41 exists.
- Fix: split T02 into "draft" (no checker needed) and "accept" (after T41), or make T41's generic checks (T41.AC1-4, AC6) a task that precedes T02 and depends only on STRATEGY and a binding-table schema.

### 2. T01 is marked `done` with two ACs not satisfied as worded
- T01.AC3: "The clause-id coverage script reports no missing id" (STATE.md:59). The status line itself says the script reported "missing only 7.1" (STATE.md:56) and MAP:762 says the same. A script reporting a missing id does not "report no missing id"; the exemption is prose, not a property of the script.
- T01.AC2: "the name-independence check exits 1 on STRATEGY.md ... exits 1 on the current file and exits 0 on a seeded `qa`" (STATE.md:58). T41.AC6 says the opposite polarity: a seeded `qa` "fails" (STATE.md:278), and T02.AC3 / T44.AC2 say a clean document "exits 1". Three documents use two incompatible conventions (clean = exit 1 versus violation = failure). It reads like `rg` semantics (no match = exit 1) leaking into a checker spec. As written, a checker that exits 1 on a clean file and 0 on a violating file is the inverse of every other gate in STRATEGY 10, and cannot be wired as a blocking check.
- The T01 status evidence also cites checks "run 2026-10-07" with no command lines, contradicting STRATEGY 14 ("Evidence ... MUST come from a run the agent produced, with the command and exit status").
- The exclusion list in T41.AC6 ("excluding `security` and `performance`") is hand-kept, while the same AC says the list is "read from that list, not hand-kept".
- Fix: define one polarity (violation = non-zero), reword AC3 so the script takes an explicit allow-list (`7.1 -> stage table`), and record command plus exit status for T01.

### 3. Rigor derivation: persistence trigger yields Deep in 6.6 but "at least Standard" in T43.AC2
- STRATEGY 6.6: any trigger raises rigor "to at least Standard"; "a boundary or contract change, or a trigger on persistence, security, data migration, or irreversible effect, raises it to Deep" (STRATEGY.md:192).
- STATE T43.AC2: "a refactor whose write scope hits a persistence trigger yields at least Standard" (STATE.md:287). Under 6.6 that case is Deep (separated authorship required, independent approval required, an unbound auditor blocks the change). The checker spec would accept a Standard derivation the strategy forbids, and T43.AC3 only fails records "below the derived rigor", so the error would be self-consistent and silent.
- MAP 1D "Raised rigor" (MAP.md:335) says only "the higher level's requirements", leaving the same ambiguity.
- Consequence not costed anywhere: the trigger list ("touches persistence or concurrent writers", "crosses a process, network, or ownership boundary", "alters a published interface") will match most changes in a repository whose packages are stores, servers and published libraries. If the persistence/boundary triggers send those changes to Deep, then separated authorship is the common case, and MAP 1A.3 / 1A.7 cost estimates (which assume Light/Standard as typical) understate dispatch counts. T24 (the only measurement) is the last task in the plan (STATE.md:50), after every Deep-path mechanism is built.
- Fix: state the trigger-to-level table once in STRATEGY 6.6 (one row per trigger), have T43 encode that table, and add an IMPLEMENTATION requirement to report the observed distribution of derived rigor.

### 4. Independent confirmation of QA's test removals is replaced by a mechanical check
- STRATEGY 8.4.5: "Reviewers other than the remover confirm"; 6.7 Test maintenance: "a reviewer other than the one who edited the tests" (STRATEGY.md:211, 309).
- MAP D9 resolves F12 with "mechanical parity evidence recorded by QA and verified by a checker" (MAP.md:713, 736), and T39.AC6 implements only that (STATE.md:264). A parity checker satisfies 8.3.2 (parity proof) but not the 8.4.5 confirmation by a second party. The in-lifecycle audit also makes QA both editor and approver: Step 6 has QA "apply simple fixes ... audit tests (merge duplicates, remove the unnecessary)" and Step 7 loops "QA until QA reopens nothing" (MAP.md:424), so the same QA session approves the tests it just changed, against STRATEGY 14 ("An agent MUST NOT approve tests it wrote").
- The MAP independence rule ("a fresh `qa` dispatch is a different party", MAP.md:212, 374) fixes this only for tests authored earlier by a Test author, not for edits QA makes in the same session.
- Fix: either (a) QA's in-plan edits to tests go to a different party (Test author `maintain`, then QA audits in a fresh dispatch), or (b) add the mechanical check as a necessary condition and state explicitly which 8.4.5 clause is waived, with an exception-log entry. Today the documents claim conformance.

### 5. Red against the base commit is not the teeth proof the documents call it
- STRATEGY 14 calls the failing run on the base commit "the first half of the teeth proof"; MAP 1B.4 step 2 says tests fail "for the stated reason"; STATE T22.AC4 and T23.AC5 record only command, non-zero exit, and failing test names.
- In the parallel mode the interfaces are fixed by a spec while the code does not exist at the base commit. For any new module or symbol, every test fails on a missing import or compile error regardless of what it asserts. A test that asserts nothing useful (or a tautology) is red on the base and green after implementation. Red/green on its own therefore does not show the test fails when behavior is wrong (6.5 requires observed red against a *faulty implementation*).
- No gate in L1 or L2 closes this. Mutation (G8) is L3. The documents do not say how a failure "for the stated reason" is distinguished from a resolution failure.
- Fix: require the Planner/architect to commit interface stubs (compiling, throwing `not implemented`) before the red run, require `red:` evidence to name the assertion that failed (not a resolution error), and make the check part of T23 and the static-review card.

## Medium

### 6. T10.AC1 contradicts T10.AC2 under D17
- AC1: the guard fails when a named agent has no extension, no closest available agent exists for its role, and the role is not declared unbound (STATE.md:90). Under D17 / MAP 1E.4, `backend` and `refactor` resolve to the closest eligible agent (`typescript`, per MAP.md:156), `review` resolves to a read-only agent such as `qa` (MAP.md:378: "With `review` absent, the rule picks the closest eligible read-only agent"), and `general` is not a role.
- AC2: the guard is "Red on `27be064c`, naming `review`, `backend`, `refactor`, `test`, `general`" (STATE.md:91).
- Both cannot hold: under AC1 at most `test` (and maybe `general`) is reported. MAP.md:378 ("fails only when a routed name resolves nowhere **and** the role is not declared unbound") has the same ambiguity: "resolves nowhere" is read as a name lookup in AC2 and as role resolution in AC1.
- Fix: split into two checks (name-resolution report, which is what F1 is, and role-resolution, which D17 governs) with separate polarity and fixtures.

### 7. T22.AC6 is unsatisfiable inside T22, and T12 depends on T22 without saying so
- T22.AC6 requires the roster guard to exit 0 "with the dispatcher's test-authoring route resolving to this agent, and no routing row in `dispatcher.md` still names the undefined `test` agent" (STATE.md:170). T22's scope is `extensions/agents/test-author/` only (STATE.md:164); the dispatcher edit belongs to T12, which is wave 4 and sequenced after T22 (wave 3).
- T12.AC1 ("No routing row names an agent without an extension") and AC2 (route test authoring to the Test author) need `test-author` to exist, but T12 `depends: T10, T11, T13` (STATE.md:102), not T22. It works only because T22 happens to land in an earlier wave.
- Fix: move AC6 to T12 (or T20), and add T22 to T12's dependencies.

### 8. Stage F as demand-driven review saturates and omits scheduled content
- Signals include "a change that touched it" (MAP.md:408, STATE.md:259). On a mainline push every touched group gets a bump; the rule is monotone up with a cap (MAP.md:409) and resets only when `qa` resolves the item. Any active group is therefore pinned at the top, which makes "an item at the top for longer than the limit is named" (T39.AC4) permanently true for busy groups and the priority carries no information. There is no decay, threshold, or batching.
- STRATEGY 7.1 stage F lists soak/long-running P/H, repeat-run flake detection, sampled mutation analysis, retention report, and capped X smoke. MAP 1G and T39 realize only the signals and the review; nothing triggers repeat-runs (so the "flake" signal has no producer beyond the same CI history), mutation sampling, soak, or X smoke. T36.AC1 builds a repeat-run mode but nothing in T39/T40/T05 invokes it.
- STRATEGY 7.4 allows demand-driven realization only if "the signals and the priority ladder are stated in the IMPLEMENTATION"; a ladder that cannot de-escalate is not a usable ladder.
- Fix: bump on thresholds (counts or rates) rather than on touch; add decay or a per-period cap; assign the repeat-run, mutation and X-smoke work to named review-item actions, or give stage F a minimal clock for them.

### 9. STRATEGY 6.7 omits steps that 6.6 requires at Standard
- 6.6 requires at Standard: a ranked risk map and a "not testing" list (STRATEGY.md:189).
- 6.7 lists the 6.1 steps that apply per class: Defect fix "1, 2 (the escaped failure mode), 4-8", Dependency (Standard on a shipped path) "1, 2, 4", Test maintenance (Standard) "1, 5, 7, 8" (STRATEGY.md:205, 208, 211). Step 3 (the "not testing" list) is absent for all three, and step 2 (the risk map) is absent for test maintenance. The "Raised rigor" paragraph (:213) covers only classes raised *above* their default, so these default-Standard classes are specified two ways.
- Fix: state that the class row lists steps *in addition to* what the rigor level in 6.6 requires, or make the rows consistent with 6.6.

### 10. Dispute path: interested adjudicator, no ceiling
- STRATEGY 14: disputes go "to the test author or the auditor, who decide". MAP 1B.4 step 5 and T23.AC3 route every dispute back to the Test author, i.e. the author rules on its own test. Neither document gives the implementer recourse if the author rejects, and "a dispute is not a retry and does not consume the retry ladder" (MAP.md:202, STATE.md:175) removes the only bound. A re-dispute loop is possible.
- Fix: route disputes to the auditor (a fresh `qa` dispatch) or architect-decision, cap rounds (for example one), and make the outcome a recorded item for the risk owner.

### 11. "Closest available agent" is described as script-computable and is not
- MAP 1E.4 ranks eligible agents "by the number of the role's obligations the agent's own description and declared capabilities cover" and calls it "a rule a script can run" (MAP.md:371-375, D17). Agent descriptions are free text; the roster in this environment has free-text descriptions and wildcard tool grants. Counting covered obligations from prose is a judgment call, so T47.AC1 ("resolves each role by the rule") and T47.AC4's seeded roster cannot be a deterministic test unless a machine-readable obligation tag per agent exists, which no task creates (T14.AC7's `roles.md` lists role obligations, not agent capabilities).
- An agent with a wildcard tool set is eligible for every role; with free-text scoring it can be chosen as a Static reviewer or Auditor.
- Fix: define the data the rule reads (a per-agent capabilities declaration, added in the agent edits T11/T13/T18/T19/T22), or demote the rule to "hints plus eligibility" with the choice recorded as a judgment.

### 12. Where do the conformance checker and gate runner live, and are they portable?
- MAP 1E.3 and T41.AC8 say the generic checks are "implemented once and run by `review gates` for every registered standard", and T60.AC2 requires the checker to run in sox-ecosystem. T41's scope is `tools/nx-plugins/test/` (STATE.md:272), an adhd Nx plugin location, and T30's runner is likewise an adhd Nx target (STATE.md:211). MAP placement rule L1 puts mechanical enforcement in PROJECT, so a harness-resident "run once" checker contradicts L1, and an adhd-resident one cannot run in a repo without Nx.
- T60 depends on T14 and T41 only, so nothing delivers a checker or runner for a non-Nx repository (T49.AC6 files a backlog item instead).
- Fix: decide the home (harness-owned generic engine reading a repo-supplied command table, with Nx bindings in adhd) and put that in T41/T49 scope and T60 dependencies.

### 13. Stale statuses and undeclared dependencies in STATE
- Statuses contradict waves: STATE.md:3 and :12 say every decision is answered, yet T11 is `blocked(D1)`, T35 `blocked(D4)`, T03 lists `D5`; T02 and T14 are `blocked(T01)` while T01 is `done`. Wave 1 lists T11 and T35 as startable (STATE.md:41).
- STATE.md:6 says "once the owner approves this list, each task is filed", while the header says the list is APPROVED (STATE.md:3). It is unclear whether filing is authorized.
- T03 needs commands that T30 and T43 produce (AC2-AC4) but declares `depends: T02, T48, T49`; T05.AC2 and T44.AC2 use T41 checks, undeclared. The wave arithmetic (computed) is correct for the declared edges (I recomputed all waves and the critical path T01, T14, T48, T03, T16, T23, T24: they match), but they depend on these undeclared edges being satisfied by accident of wave number.
- T19a/b/c are tasks, but their acceptance criteria are `T19.AC1-3` and T20 depends on `T19`, so the stable-id promise (STATE.md:8) fails for these.
- T57.AC1 promises "a table gives every file in `docs/testing/` a destination", but names only STRATEGY, STRATEGY_MAP, STATE and HANDOFF; `docs/testing/` also contains `REVIEW.md`, `REVIEW_REQUEST.md` and this file (measured with `rg --files`). T57.AC3's `rg -n "docs/testing/" docs AGENTS.md` check would also fail while any of them or STATE's own text exists.
- T38.AC1 requires the decision record to state that "the memory server was unreachable during planning" (STATE.md:255): an environmental accident of the authoring session written into a deliverable's acceptance criteria. It will be false by the time the task runs. The same note appears at STATE.md:350.
- Section 5 log order is not chronological (created first, then newest-first), has no entry for 0.5, and the 4th and 5th entries narrate versions the header no longer describes.

## Low

### 14. STRATEGY approval wording contradicts itself
- Header: "Version 0.2 (APPROVED by the owner 2026-10-07)" (STRATEGY.md:3). Provenance 0.2: "Sections not listed above are unchanged from 0.1 and keep their owner approval; the listed sections await it." (STRATEGY.md:484), in the same paragraph that says "APPROVED". The sentence is stale.

### 15. Decision tree Q2 maps conformance to tier H unconditionally
- STRATEGY.md:136: "If one specification must hold across several implementations -> conformance (Tier H)". Tier H requires foreign runtimes, containers, browsers or heavyweight resources (STRATEGY.md:61), and 6.2 forbids a tier without a valid fidelity-gap statement. Conformance across several in-process implementations is tier S. Say "conformance, at the tier its implementations require".
- Similarly STRATEGY.md:59 calls an S test over 1 s "a lowering/split candidate"; S is the lowest tier, so lowering is impossible (split or fix).

### 16. Measured numbers that have drifted or cannot be reproduced
- MAP 1A.7: "`STRATEGY.md` v0.2 is 51,365 bytes (`wc -c`)" (MAP.md:140). `wc -c docs/testing/STRATEGY.md` now gives 53,523 (measured). The roughly 12,800-token figure derived from it is stale, and MAP 1A.7 labels it "measured".
- STATE T32.AC3 and MAP quote "81 stub specs, 878 `it.todo`" at `b76b4bed`. `rg -c "it\.todo"` over `*.ts`/`*.tsx` in the current tree (dirty) gives 86 files and 884 occurrences (measured; my pattern may differ from the original `git grep`). The figures need to be produced by the T32 scanner, not hand-quoted in ACs.
- STATE.md:356 refers to "The 48 rollout tasks"; the task list as it stands has 45 task ids (43 if T19a/b/c counts once). Not reproducible from the document.

### 17. Smaller inconsistencies and gaps
- STRATEGY 9 permits environment gating for tier X, while 2.1 says missing credentials for X are "a loud failure" and G2 requires every test to run in at least one stage. Reconcile (gate = which stage runs it, not a skip).
- STRATEGY 7.1 stage E runs H over the whole integrated state; STATE T40.AC3 covers S and P only, and no task provisions the H lane or authorizes X (D7 gives the authorizer, no mechanism).
- STRATEGY 3 ("Decisions in 6-8 are made on size first") and 8.1 as a section have no row in the MAP coverage statement (MAP.md:762).
- STATE T46: the "dispatcher's record" that verifies the run-line trailer is not defined, and a local `.githooks` check is bypassable with `--no-verify`; T46 scope lists no CI job.
- Fakes and test support code (STRATEGY 4 prefers fakes) often live in production-path packages; the parallel scheme assigns "test paths" to the Test author and "production paths" to the implementer (MAP 1B.4 step 3) without saying who owns a fake or fixture library.
- T57.AC1 says "the IMPLEMENTATION becomes the `apply testing` template", while STRATEGY 13 defines an IMPLEMENTATION as repository-specific (risk map, X authorizer, migration plan). T48.AC1 says "skeleton"; use that word.
- STATE T22.AC5 and T44.AC4 have judgmental, non-binary outcomes (a golden-set comparison on one case; a "walkthrough") despite STATE.md:8 ("binary and checkable").
- STRATEGY cites a vendor product page (S20, flagged as vendor documentation) as the sole support for P8's claim about nightly deferral; the claim is argued, not evidenced.
- The single-session design is Light-heavy for no-code and refactor classes and says "no gate is relaxed by class", but MAP 1D / T16.AC6 skip static review and QA for class None. This is consistent with 6.7 only because None has no tests; the checker (T43.AC4) should state that explicitly so G-gates stay uniform.

## What holds up
- STRATEGY clause ids and counts reconcile with the MAP coverage statement (27 sections, 8 steps; I recounted).
- STATE wave and critical-path arithmetic is correct for the declared dependency edges.
- The 13.1 role table has twelve roles, matching the MAP binding table (plus the harness-only conflict resolver).
- Citations to S1, S5, S6, S9, S11, S12 match the claims they carry as I know them (not re-fetched).

## Unacknowledged items to file
All of findings 1-13 are defects in planning documents and have no backlog entries; STATE section 4 lists none of them. Filing is for the document owner.

## Gates
No code was changed; no gate applicable. Commands run: `wc -c docs/testing/STRATEGY.md` (exit 0), `rg --files docs/...` (exit 0), `sed -n 1,14p .githooks/pre-push` (exit 0), `rg -c "it\.todo"` pipeline (exit 0).
