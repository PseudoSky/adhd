# Review: docs/testing/STRATEGY.md (v0.2)

Scope: the content of STRATEGY.md only. Cited sources were not re-fetched, so citation fidelity is flagged where a claim looks stronger than its source, not confirmed against the source. Section references are to STRATEGY.md.

Overall: the document is strong on principles, retention, and the separation of authoring from approval. Its weakest area is internal consistency. The decision tree, several gates, and the v0.2 additions (rigor, review debt) contradict each other or the document's own principle P13 (gates enforced by mechanism). Findings are ordered by severity.

## Blocking (the rules cannot be applied as written)

**B1. The tier decision tree assigns the wrong tier to tests that need more than one capability (§6.2).**
The tree says "stop at the first yes", and Q3 (process or loopback) comes before Q4 (foreign runtime) and Q5 (external system). A test that needs a separate process and a foreign runtime, or a process and a paid service, answers yes at Q3 and lands in P. §2.1 defines a tier as a ceiling, so such a test belongs in H or X.
Fix: phrase each question as "needs anything beyond tier N's ceiling?", or evaluate the requirements and take the maximum tier.

**B2. The "stop at first yes" rule also breaks Q1 and Q2 (§6.2).**
Contract tests (Q2) place the consumer side at S, which Q1 would already have claimed. Conformance is sent to H "if one specification must hold across several implementations", but §2.1 reserves H for foreign runtimes, containers, browsers, and similar. A conformance suite over several in-process implementations is S. §2.3 defines `conformance` as a tag, which conflicts with §6.2 using it to choose a tier.
Fix: make Q2 a modifier on the tier chosen by the ceiling questions, not a tier of its own.

**B3. Tier S forbids listening sockets, but §4 recommends an "in-process server" as a fake (§2.1 vs §4, §6.2 Q1).**
An in-process HTTP server listens on a socket. Either S allows in-memory transports only and §4 must say so, or such fakes are P.

**B4. Several MUSTs have no gate and no named reviewer, which violates P13 and §10's own definition of a gate.**
- The rigor record (§6.6) is the central v0.2 addition and is a conformance L1 item, but no G1-G11 gate checks it. G11 covers only changes to test infrastructure.
- Teeth (§6.5, "MUST have been observed red") is checked only by G8, which is L3 (mutation analysis).
- The "not testing" list (§6.1.3) and the per-test header (§6.1.8) are not gated for tier S. G9 covers only P/H/X.
- The G10 requirement that applies when a change ships an artifact (§6.7 "gates that no class relaxes") is in no conformance level (L1-L3), yet §6.7 says no class relaxes it.
Fix: add gates for the rigor record, the header, and the not-testing list, or downgrade the MUSTs to SHOULDs. Place G1 and G10 in a conformance level.

**B5. Standard rigor requires a "not testing" list, but the class table skips step 3 for the classes that default to Standard (§6.6 vs §6.7).**
Defect fix is Standard and applies steps 1, 2, 4-8. Test maintenance is Standard and applies 1, 5, 7, 8. Neither applies step 3, though the Standard row says the list is "required". Only a raised-rigor change is told that §6.6 applies "on top of the class row".
Fix: state that the §6.6 row requirements always apply, or fix the step lists.

**B6. Review debt has no expiry or ceiling (§13.1, §13.2).**
An unbound role leaves clauses as "review debt" on tests. Exceptions need an expiry (§10) and skips expire (§9), but review debt has neither. Standard rigor says independent approval is "required", yet an unbound Auditor or Static reviewer at Standard simply produces debt. A solo session playing every role can therefore ship indefinitely at Standard and below, with no approval and no clearing deadline.
Fix: require an owner, an expiry, and a G4-style failing check for review debt. State which rigor levels may carry debt at all.

## Significant

**S1. G1 contradicts §9.** G1 mentions "no quarantined test is among the gating tests past its deadline". §9 says quarantined tests are removed from the gating run. Intended meaning: a quarantined test past its deadline fails the build. Reword.

**S2. The G10 timing is inconsistent.** §10 says G10 blocks Release. §6.7 lists the artifact check as evidence for configuration and dependency changes and as a gate no class relaxes. §7.1 runs artifact checks at presubmit. State whether G10 blocks at merge or only at release.

**S3. G8 is claimed per change at merge but its cost does not fit the stage budget.** G8 blocks merge on changed-code mutation survivors. Stage D has a 15-minute budget that already includes S, P, H, and artifact checks. Stage F lists "sampled mutation analysis". Metrics list mutation score "per change". Pick one, or say which tier of mutation work runs where.

**S4. The release stage omits H (§7.1 stage G).** Stage E runs H on mainline. Stage G runs "full S and P" on the candidate. A release candidate cut from a branch other than mainline HEAD ships with no H run.

**S5. P6 and G5 disagree.** P6 calls flakiness "a defect-free zone", but G5 defines a flake budget per tier, which tolerates a non-zero flake rate. Say that the budget is a detection/escalation threshold, not a permitted rate. G5 also does not state where flake data comes from at merge time, since repeat-run detection sits in stage F.

**S6. The hourglass heuristic is miscalibrated against the document's own budgets (§5).** S p95 is 100 ms and P p95 is 10 s, a 100x ratio. With a healthy 70/20/10 count ratio, P time exceeds S time by a wide margin, so the "P-by-time exceeds S-by-time" smell fires on a healthy pyramid. Use a per-tier ratio of time to count, or compare against the budgets.

**S7. Performance and accessibility tests have no tier (§2.1, §12, P9).** Performance tests depend on wall-clock timing, which conflicts with S determinism and with "deterministic; any failure blocks" for P and H. Define their tier, noise handling (baselines, thresholds), and stage. The same applies to snapshot or golden tests and fuzzing, which are not mentioned.

**S8. Demand-driven stage F cannot detect external drift or soak failures (§7.4).** Its signals are change-driven (a change touches the group, a duration breach, a flake, a skip past date). Capped X smoke against real services exists to catch drift in systems the repo does not control, and soak and repeat-run flake detection need time or repetition. None of these produce a signal in the described ladder. State that those need a clock.

**S9. The red run against the base commit is a weak teeth proof when authoring is concurrent (§14).** Tests written ahead of the implementation fail on a missing symbol or compile error, which proves nothing about the assertion. Require that the recorded failure be an assertion failure for the intended reason, or that stubs fixed by the specification exist at the base commit.

**S10. "Independent" approval means only a different session (§13.1).** A second dispatch of the same model, given the same code and the same rationale, shares the author's blind spots. The document's own rationale for separated authorship (§14) is that the code's author confirms what the code does. Apply the same information barrier to approvers at Deep: the reviewer sees the specification and the test, not the implementer's reasoning.

**S11. Trigger-to-rigor mapping leaves discretion where §6.6 says rigor is "derived and never chosen".** "Crosses a process, network, or ownership boundary" and "alters a published interface" are triggers (Standard minimum), but "boundary or contract change" is a class defaulting to Deep. Which applies to an interface change is not stated. Define the mapping for each trigger explicitly.

**S12. The §13 "gate with no mechanism" rule contradicts §10.** §10 says a threshold with no enforcing mechanism MUST NOT be written in this document or an IMPLEMENTATION. §13.3 says such a gate is listed as "not yet enforced" with a dated plan. Reconcile (for example, listed as an obligation, not a gate).

**S13. The X-tier statements conflict (§2.1, §9).** §2.1: missing credentials are "a loud failure". §9: environment gating by a flag is permitted for X. State both: flag off means not run and reported as not run; flag on with missing credentials fails. Also require that the flag is set by some stage, otherwise the test violates G2.

## Minor

**M1. Provenance and approval status disagree (header vs §16).** The header says "APPROVED", but §16 says "the listed sections await it" and refers to sections that "keep their owner approval" from a 0.1 that is labelled DRAFT. "Owner decisions D11, D13" are undefined in this document. The provenance reads as edit history inside a normative document; consider moving it out of the portable file or reducing it to a one-line status.

**M2. Tier letters collide with other namespaces.** Tier S/P/H/X collide with source IDs [S#], principle IDs P1-P14, stage H (Production), and stage letters A-H against gates G1-G11 ("Stage G" vs "G1"). Text such as "Earliest C (smoke)" and "P3" is ambiguous. Rename the tiers (for example T1-T4) or prefix the others.

**M3. Undefined quantities.** "Escapes more than its budget" (§11) has no definition of the budget. "≥ 2 times in a window" (§8.2) has no window. "Default 14 days" (§9) has no rationale. The "defect window" in §7.3 has no acceptance criterion.

**M4. Rules with neither a citation nor a rationale.** §1 states that uncited rules are argued in their own rationale. The rigor levels, the 14-day quarantine, the 100 ms/1 s budgets, and the specific stage budgets have none. The "1 s lowering/split candidate [S5]" attribution looks stronger than a blog post about end-to-end tests supports; verify. The same applies to "almost exponentially" attributed to [S4] and to "measure coverage from small tests only" attributed to [S1]. S20 (vendor documentation) supports a general claim about nightly deferral risk; label it as vendor evidence in P8, as is done in the table.

**M5. Granularity conflict.** §6.1.4 says "one test per failure mode, not per code path". §6.4 prescribes partitions, boundary values, and state tables, which produce many tests per failure mode. Say that parameterized cases count as one test, or define "failure mode".

**M6. R3 for tier S.** The fidelity-gap statement applies to P/H/X only, so R3 is vacuous for S. Add an S-side check (for example, "does it exceed its S ceiling or budget").

**M7. Characterization tests have no replace-by date.** §2.3 says they are "expected to be replaced", but nothing expires them, and they conflict with P4 by design. Add an owner and an expiry, like skips.

**M8. Lack of a role-to-clause index.** §13.2 relies on delivering slices of this document to roles, but obligations for a role are scattered (for example, the Test author's across §6.1, §6.4, §6.5, §14). Provide the role-to-clause map in the portable document so that every repository does not derive its own.

**M9. Reviewer attention is missing as a cost.** P5 and §14 argue that authoring cost approaches zero while running and maintenance costs do not. With agent-authored tests, review and triage attention is the scarce cost; naming it would support the net-growth rule in §8.6.

**M10. Ratchet semantics (§10).** "Tightened without ceremony" can turn the next merge red for unrelated work. Specify how existing violators are grandfathered or scheduled.

**M11. Refactor evidence (§6.7).** "No edit to any test file" would reclassify import-path or file-move edits as test maintenance. Clarify that mechanical, behavior-neutral edits to test files that reference moved internals are covered.

## Verified consistent

Internal cross-references checked and valid: §8.3.5 (used in §14), §6.1.3 and §6.1.8 (used in §13.1 and §6.1), gate and stage references in §6.7, the §13 items cited by L1-L3. The quoted claims from S9, S11, and S12 match their well-known wording.
