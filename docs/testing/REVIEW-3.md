# Review of STRATEGY.md (v0.3)

Blind review: only the document was read. Line numbers refer to STRATEGY.md as reviewed. Findings are ordered by severity within each group. All cross-references (P1-P14, G1-G12, R1-R6, S1-S23, section numbers) were checked and resolve; every source S1-S23 is cited at least once.

## A. Contradictions and logic defects (fix before approval)

**A1. P8 and the §7.2 default placement contradict each other, and §7.3 then makes the defaults non-compliant.**
- P8 (l.38) and §7.2 (l.257) define a test's earliest stage as "the fastest stage whose budget it fits".
- The §7.2 table places non-smoke tier P at stage D, although a 10 s tier P test fits stage C's 5-minute budget.
- Under §7.3 (l.270), any test that runs later than its earliest stage needs a signed deferral. By the document's own definitions, every non-smoke tier P test therefore needs one.
- Fix: define earliest stage as a per-tier default (the table) and drop the "fits" language. Alternatively, state that stage C admits only `smoke` by design. Either way, say that the table is the definition and not a derivation.

**A2. §14 and §2.5 conflict on who commits and verifies the stub commit when there is no coordinator.**
- §2.5 (l.94) says work with no coordinator is "done by a single worker".
- §14 (l.488) says that with no coordinator, "the implementer" commits the stubs. It also makes separated test authorship the default at Standard and REQUIRED at Deep.
- A single worker cannot be a separate test author. The text never says what happens to separation in this case.
- §13.2 (l.479) says only that "review-class checks that need a second party" are missing.
- The implementer committing and then "verifying" its own stub commit is also self-verification of the one artifact that anchors the red-evidence rule.
- Fix: state explicitly that without a coordinator, separation of authorship is impossible, so Standard work falls to review debt and Deep work is blocked. Assign stub-commit verification to a mechanical check (compiles, touches only declared stub files), not to a party.

**A3. The Light row of §6.6 gives no path when no second party exists.**
- Standard says approval "MAY be deferred as review debt". Light says "the single review of the change" and does not say who performs it or what happens if nobody can.
- §13.1 permits review debt at Light and Standard, but only the Standard row connects to it.
- Fix: make the Light row say the same as Standard, or point to §13.1.

**A4. Terminology collisions that the Notation bullet (l.6) does not resolve.**
- "Tier H" versus "stage H" (Production), and "stage G" versus gates "G1-G12". Stage letters A-H and tier letters S/P/H/X overlap on H.
- The §7.2 table (l.259-264) puts tier letters in one column and stage letters in the next ("H | D | E/F"). Unqualified single letters in adjacent cells mean different things.
- The Notation rule is violated in the body: "Size H tests", "Size X tests" (l.111-112) use "size" where the rule says "tier". G9's "every P/H/X test" and §8.3's "P/H/X → a lower tier" give no tier marker. "S/P/H/X" can also be read as the source ids [S#] or the principles P#.
- Fix: rename the stages numerically (stage 1-8) or rename the tiers. Failing that, rewrite the unqualified usages as "tier P/H/X".

**A5. "Lane" is used as a technical term and never defined.**
- It appears in §7.4 ("a scheduled lane"), §12 ("the H lane definition") and §14 ("moving tests to a different lane").
- The vocabulary defines only tier, stage, scope and tag. The prohibition in §14 (l.493), which is one of the central anti-pattern rules, depends on this undefined word.
- Fix: replace "lane" with "tier" or "stage" as appropriate, or define it in §2.

**A6. Review-debt wording is inconsistent: gates versus the derived-rigor requirements.**
- G6, G9 (validity half) and G11 are the only gates that can be met by review debt (l.221, G-table).
- Independent approval at Standard "MAY be deferred as review debt" (l.198), but approval is not a gate and nothing enforces its expiry except G4's catch-all on "every review-debt entry".
- A reader cannot tell whether review debt is a general instrument or a gate-specific one. §13.1 says review debt is "permitted only at Light and Standard", yet §6.7 says it is "the one named satisfaction path" for those three gates. These are two different scopes for the same mechanism.
- Fix: state one rule in §13.1 (what can be debt, at what rigor) and have §6.7, §10 and §6.6 cite it.

**A7. The artifact check (G10) is a P-tier test that the vocabulary exempts from tiering.**
- §2.4 says artifact checks are "not sized". G10 requires that the built artifact's "primary journey runs as a consumer runs it". By §2.1 that is a separate process, on a built artifact, so it is tier P.
- It also overlaps the `smoke` tag ("a shipped artifact starts and serves its primary journey", l.77).
- Consequences: G2, G3, G7, the fidelity-gap statement (G9) and the flake budget (G5) formally do not apply to the most important end-to-end check.
- Fix: define the artifact check as a tier P `smoke` test with a standing gap statement, or say precisely which tier-based rules it is exempt from and why.

**A8. Cache hits versus "runs" (G2, G5, P6).**
- §7.2 caches S and P results on content hash. G2 requires every test to "run" in at least one stage. G5 measures flake rate "over the trailing history of stages D-F and repeat-run reports".
- A cache hit is not a run. Counting hits as runs hides flakes (a cached green never re-rolls) and inflates reachability. Counting only executions makes the denominators in G5 and the pass-rate metric depend on cache hit rate.
- A P test that uses ports, processes or toolchain state has inputs outside the content hash (installed toolchain, OS, ephemeral port availability). Caching it is unsound unless the environment is part of the key.
- Fix: say that cache hits count for G1 but not for G2 reachability evidence or G5 flake measurement, and that stage E and F executions bypass the cache. Define what a tier P/H cache key must contain.

**A9. "Every number reported is one a tool produced" (§11, l.379) conflicts with the escape metrics.**
- "Defects found at a later stage than the earliest that could catch them" requires a human judgment (the Triager's, §8.5). The same applies to signal precision ("real defects ÷ all failures"), where "real" is a human classification.
- Fix: say these metrics are tool-aggregated from human-recorded fields, and name the field and who records it.

**A10. Removal by "redundancy" is unsound as stated (§8.2, l.308).**
- "Another test fails for every fault this one detects" is evaluated against a set of faults (mutants, injected faults, reviewer analysis). A finite fault set can only show that two tests are indistinguishable on those faults, not on all faults a higher-fidelity test would catch. The method has to be stated, but the row still lets a lower-tier test justify removing a higher-tier one.
- Mitigations exist (regression tags in §8.4.2, fidelity-gap statements) but the row never refers to them. The row needs an exclusion: a test whose valid gap statement names a property the cheaper test cannot observe is never redundant to it.

**A11. The §8.2 age rule is stated more strongly than its own sweep row.**
- Reviews are "never triggered by age alone" and "age-based pruning without uniqueness evidence is prohibited" (l.299), yet the sweep row is "periodic". A periodic review is a time trigger. The intended meaning (no pruning on age) is clear, but "never triggered by age alone" is false as written. Reword to "never decided by age alone".

**A12. The two rules on tests that cannot go red.**
- §6.5 requires every behavioral test to have been observed red against a faulty implementation, and G6 requires a recorded failing assertion.
- Characterization tests pin current behavior, pass by construction, and §6.7 (l.234) and §14 allow them to be written after the fact. The only red route is a mutation or a wrong variant, which is expensive for legacy code, and the document does not say whether characterization tests are exempt.
- Fix: state that characterization tests take teeth proof by mutation of the pinned behavior only, or are exempt from G6's "records a red run" with an explicit alternative.

## B. Unverifiable or weakly supported claims

**B1. "100 ms [S5]" (l.60).** S5 (Wacker, "Just Say No to More End-to-End Tests") is the source of the 70/20/10 ratio. I cannot confirm that it gives a 100 ms unit-test budget. Google's size definitions in S1 are expressed as a 60 s timeout for small tests. Verify the figure at the cited URL or relabel it as a design decision of this strategy (the document does this for the 1 s, 10 s and 2 min figures).

**B2. "grows almost exponentially" [S4] (l.38).** Check that ch. 23 of S4 makes this claim. If it does not, drop "almost exponentially", or cite the source that does.

**B3. S19 gloss "includes J. Searls on writing tests that 'only fail for useful reasons'" (l.520).** Confirm the quotation and its attribution appear in the cited page. Vendor and secondary-blog attributions are the likeliest to be wrong.

**B4. S20 (Nx vendor documentation) carries a hard rule.** §7.3 turns "pushing e2e tests to nightly raises merge risk" into "'It's slow' is not a reason to move it to nightly", and P8 repeats it. A vendor page for a task-splitting feature is thin support for a prohibition. The reasoning stands on S4's cost-of-late-defect argument. Cite that as the primary support and use S20 only as an example.

**B5. The G5 default (1%) and G7's 10% regression threshold are labeled "a starting value" (G5) but G7's figure carries no label.**
- G7 compares a p95 with "the previous mainline run's". A single previous run on shared CI hardware is noisy, so the gate itself will flake, which contradicts P6. A 100 ms p95 on a loaded runner varies by far more than 10%.
- Fix: base the comparison on a rolling median of several runs, or on a normalized measure (CPU time, not wall time), and mark the figure as a starting value.

## C. Gaps (omissions that an adopter will trip over)

**C1. Undefined terms:** "plan-scope tests" (Auditor row, l.443), "affected set" (used from l.246; §7.2 describes selection methods but never defines what a test is affected by), and "share of the stage budget" (l.114).

**C2. Does the tier P budget include building the artifact?** Tier H says "provisioning counted in budget" (l.263); tier P is silent, and its definition includes "built artifacts run as a consumer runs them". A reader can legitimately read the 10 s figure either way.

**C3. Non-deterministic components (LLM-backed behavior, randomness at the product boundary).**
- §14 is written for agent-authored tests, but the strategy has no guidance for testing behavior that is itself non-deterministic. Tier X is defined by cost, not by determinism, so a paid model call is X by cost but a local model is H and non-deterministic.
- G5 (flake budget) and P6 ("a flake is a defect") do not accommodate it. State how invariant-based assertions over non-deterministic outputs are classified, and whether they count against the flake budget.

**C4. Rigor "None" combined with escalation triggers.** A no-code change that hits a trigger (for example an irreversible operation) is raised to Deep, but Deep requires a risk map and independent test approval for a change that produces no tests. §6.7 says no new tests for the class. Say what Deep means when there is nothing to test (probably: the review is of the plan, and the approval role is the Risk owner).

**C5. Lowering rigor requires an exception-log entry with an expiry (l.215, l.375).** For a single change, "expiry" has no meaning. Specify that a per-change exception expires at merge, or that the entry is exempt from the expiry rule.

**C6. Gate-set versus conformance-level mismatch.** Stage D "gate checks G1-G12" (l.247) and §10 make every gate block merge, but L1 and L2 do not include G8, so an L1/L2 repository either has an obligation that is not a gate (allowed by §13 item 3) or fails stage D. Say that stage D runs the gates the IMPLEMENTATION has mapped.

**C7. §6.1 step 4 versus step 7 for parameterized tests.** "One test per failure mode ... the parameterized cases of one failure mode are one test", then every new test must be seen red. Say whether one red case suffices for a parameterized test or each case must be shown red.

**C8. §6.2 reads in an order that contradicts its own rule.** The tier is "the highest tier any requirement demands", but Q1 says "yes ... → tier S" before Q2-Q4 are asked, so a reader who stops at the first "yes" gets the wrong tier. Reword Q1 as "S unless a later question raises it".

**C9. Flake and mutation measurement cost at stage D.** G8 (diff-based mutation within a 15-minute stage) may be unbounded for a large diff. The document should say what happens when the mutation run does not fit (sample? defer with debt? fail?).

## D. Portability and presentation

**D1. "Names no ... build tool, test runner, language" (l.4) is not fully true.**
- `todo` markers, page objects, `finally`-equivalent and the source table (StrykerJS, fast-check, Pact, Nx) are drawn from one ecosystem. Sources may name tools, but the body uses `todo`, "page object" and "`finally`" as if universal.
- Reword the claim ("does not depend on") or remove the ecosystem idioms.

**D2. Header status line (l.3) versus provenance (l.528).**
- The header says the revision followed "an independent review" and awaits a blind re-review. The provenance describes a blind review of 0.2 plus a second blind review (round 2). A reader cannot tell which review is outstanding.
- The provenance entry for 0.3 also narrates the review process ("A second blind review (round 2) added ...") inside the normative document. The record belongs with the review, as the entry itself says. Reduce the entry to what changed.

**D3. Formatting.**
- l.221 has a stray bold marker and a missing period: "...which always applies** The step column below ...".
- A blank line separates the 0.2 and 0.1 provenance entries and none separates the others.

**D4. Document size.** At 531 lines with 14 principles, 12 gates, 13 roles and an 11-row class table, the whole is not what any role reads (the document says so at §13.2). The slices and the role-to-clause index are the right mitigation, but none of the slices exist yet, and the document should say the IMPLEMENTATION must produce them before adoption (item 10 of §13 does, but conformance L1 does not require it).

## E. Strengths worth keeping (so edits do not erode them)

- Size defined by enforceable resource ceilings, with scope kept as a separate axis (P2, §2).
- The highest-demanded-tier decision rule with contract and conformance as modifiers (§6.2), and the fidelity-gap statement with a short list of valid and invalid reasons.
- Retention treated as binding as authoring, with a lowering procedure that requires parity proof before the original is retired (§8.3).
- "A gate is a threshold plus a named mechanism plus an owner" (§10), and the refusal to count unmapped gates toward conformance (§13 item 3).
- Review debt with an owner, an expiry and a hard stop at Deep (§13.1), and the explicit statement that the document is not evidence of conformance.

## Verdict

Not ready for approval as 0.3. Items A1, A2, A4, A5, A7 and A8 are structural (the stage placement rule, the no-coordinator case, the notation collisions, the undefined "lane", the artifact check's tier, and caching versus runs). A3, A6 and A9-A12 are wording or scoping fixes. B1-B3 need source verification before the citations can stand.
