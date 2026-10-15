# REVIEW_TRIAGE — disposition of REVIEW.md and REVIEW-MAP.md

- **Inputs:** `REVIEW.md` (B1–B6, S1–S13, M1–M11 on STRATEGY 0.2) and `REVIEW-MAP.md` (findings 1–17 on STRATEGY 0.2, STRATEGY_MAP 0.7, STATE 0.5). Both are kept unedited as the record.
- **Author of the fixes:** the same party that wrote the documents. The fixes below are therefore **unapproved**: STRATEGY 0.3, STRATEGY_MAP 0.8, and STATE 0.6 await a fresh blind review and owner approval. No finding is marked closed here; "applied" means an edit was made, not that it was verified by someone else.
- **Owner decisions taken for this round (2026-10-07):** D19 (QA edits and removals: mechanical parity **and** a second party), D20 (red evidence: interface stubs specified by the architect and committed by the dispatcher on the bucket branch before either party starts, failure must be an assertion), D21 (dispute path: the auditor decides, one round; review debt has an owner, an expiry, and a failing check). The extensions S10, MAP#11, MAP#3 were left to the author and are accepted as D22 (approver information barrier at Deep), D23 (machine-readable capabilities declaration per agent), D24 (rigor distribution reported by the routing checker).

Verdicts: **applied** (edit made) · **applied-partly** (some of the finding) · **rejected** (reason given) · **backlog** (filed, not edited here).

## A. Findings that appear in both reviews (merged)

| Merged | REVIEW | REVIEW-MAP | Verdict | Where |
|---|---|---|---|---|
| Step lists of §6.7 omit what §6.6 requires | B5 | 9 | applied | STRATEGY §6.7 states the §6.6 row always applies; the class row lists steps in addition |
| Red against the base commit is a weak teeth proof | S9 | 5 | applied (D20) | STRATEGY §14, §6.5; MAP §1B.4 and swimlane step 5a; STATE T19a, T22, T23 |
| Conformance sent to tier H unconditionally | B2 | 15 | applied | STRATEGY §6.2 rewritten |
| Approval status and provenance disagree | M1 | 14 | applied | STRATEGY header and §16 |
| Tier X gating vs loud failure | S13 | 17 (1st bullet) | applied | STRATEGY §2.1, §9 |
| Stage G omits tier H | S4 | 17 (2nd bullet) | applied | STRATEGY §7.1 stage G; STATE T40 |
| Demand-driven stage F cannot detect drift and saturates | S8 | 8 | applied | STRATEGY §7.4; MAP §1G; STATE T39 |

## B. REVIEW.md (STRATEGY)

| # | Verdict | Disposition |
|---|---|---|
| B1 | applied | §6.2 asks what the failure needs beyond each tier's ceiling and takes the highest tier any requirement demands |
| B2 | applied | contract and conformance are modifiers on the tier, not tiers; `conformance` stays a tag |
| B3 | applied | tier S allows in-memory transports only; a listening socket is tier P; §4 says so |
| B4 | applied | new gate G12 (planning record: rigor record, "not testing" list, test header on every tier); G6 extended to red evidence on new tests; G1 and G10 placed in L1; mutation (G8) stays L3 |
| B5 | applied | see A |
| B6 | applied (D21) | §13.1: review debt has an owner and a 14-day default expiry, is allowed only at Light and Standard, and G4 fails past expiry |
| S1 | applied | G1 reworded: a quarantined test past its deadline fails the build |
| S2 | applied | G10 blocks merge for a change that ships or alters an artifact, and always blocks release |
| S3 | applied | G8 runs diff-based on changed lines within stage D's budget; the sampled whole-suite run is stage F; a repository that cannot fit it lists G8 as an obligation and does not claim L3 |
| S4 | applied | see A |
| S5 | applied | P6 states that a flake budget is an escalation threshold, not a permitted rate; G5 names its data source |
| S6 | applied | the shape smell compares measured time with count × budget per tier |
| S7 | applied | §12 gives performance, accessibility, snapshot, and fuzz tests a tier, noise handling, and a stage |
| S8 | applied | see A |
| S9 | applied | see A |
| S10 | applied (D22) | §14: at Deep an approver receives the specification and the tests, not the implementer's reasoning |
| S11 | applied | §6.6 trigger table gives each trigger its minimum level and its detection; interface alterations are the boundary-or-contract class |
| S12 | applied | §13 item 3: a gate with no mechanism is listed as an obligation, not as a gate |
| S13 | applied | see A |
| M1 | applied | see A |
| M2 | applied-partly | renaming the tiers would touch every document and every gate; instead the header's notation bullet fixes how tiers, stages, principles, gates, and sources are written, and a list after "tier" or "tiers" is a list of tiers |
| M3 | applied | budgets are defined by the IMPLEMENTATION with stated defaults; windows and the defect-window criterion are given |
| M4 | applied-partly | verified against the saved sources: the "almost exponentially" wording [S4] and the coverage-from-small-tests note [S1] match their sources and stay; [S5] supports 100 ms ("one tenth of a second is considered slow for unit tests"), not 1 s, so the 1 s figure is now this strategy's own; rationale added for the rigor levels and the quarantine default |
| M5 | applied | parameterized cases of one failure mode count as one test |
| M6 | applied | R3 for tier S is "within the S ceiling and budget" |
| M7 | applied | characterization tests carry an owner and an expiry |
| M8 | applied | §13.1 gains a role-to-clause index |
| M9 | applied | P5 names review and triage attention as a cost |
| M10 | applied | §10: a tightened threshold applies to new and changed tests; existing violators get dated exception entries |
| M11 | applied | §6.7 refactor row allows mechanical, behavior-neutral edits to test files that reference moved internals |

## C. REVIEW-MAP.md (STRATEGY_MAP, STATE)

| # | Verdict | Disposition |
|---|---|---|
| 1 | applied | T41 no longer depends on T02 (its generic checks are proven against fixture tables) and T02 now depends on T41, so T02's acceptance criteria run those checks on the real file |
| 2 | applied | polarity confirmed by reading how the check was run (`rg` exits 1 on no match, which was leaking into the criteria); every check is now specified as "violation = non-zero"; T01.AC3 takes an explicit allow-list; the hand-kept exclusion is removed; T01 is reopened for STRATEGY 0.3, and the commands and exit statuses are recorded on it |
| 3 | applied (D24) | T43.AC2 now yields Deep for a persistence trigger, per the §6.6 trigger table; the routing checker reports the observed rigor distribution |
| 4 | applied (D19) | mechanical parity is a necessary condition and a second party confirms; QA's in-lifecycle test edits are approved by a fresh dispatch |
| 5 | applied | see A |
| 6 | applied | T10 split into a name-resolution report and a role-resolution check with separate fixtures |
| 7 | applied | T22.AC6 moved to T12; T12 depends on T22 |
| 8 | applied | see A; plus a rate threshold and per-period reset |
| 9 | applied | see A |
| 10 | applied (D21) | disputes go to the auditor, one round |
| 11 | applied (D23) | roles read a machine-readable capabilities declaration per agent; free text only breaks ties |
| 12 | applied | the generic checks and the gate runner are one harness-owned engine (new task T62) reading a repository command table; Nx bindings live in adhd (T30); T41, T49, and T60 depend on it |
| 13 | applied | statuses, dependencies, the T19 ids, T57.AC1 (now covering the review files), T38.AC1, the log order |
| 14 | applied | see A |
| 15 | applied | see A (B2) and the S-tier wording |
| 16 | applied | the baseline counts are produced by the T32 scanner, not hand-quoted; the document size is not quoted; the task count is derived |
| 17 | applied-partly | applied: X gating, H lane provisioning and the stage that sets each X flag (T40.AC5, AC6), STRATEGY §3 and §8.1 added to the coverage statement, the fixture ownership rule, the `apply` skeleton wording, non-binary ACs rewritten, the class-None statement. T46's "dispatcher's record" is defined as the run line in the commit trailer plus the telemetry row, and the check is a CI job as well as a hook |

## D. Rejected or reduced

| Finding | Why |
|---|---|
| M2 (rename tiers) | cost across all documents exceeds the benefit; notation rule instead |
| MAP#16, reviewer's `it.todo` count of 884 in 86 files | the reviewer's figure matches a re-run of the original `git grep` on the current tree (884 in 86 files; the earlier 878 was taken at an older commit); the documents no longer quote the number |

## E. Not edited here

- The unrelated gates and the open items in `HANDOFF.md` are unchanged.
- No rollout task is filed in the backlog; filing was not requested.

## F. Round 2 (STRATEGY 0.3 only; verdict FAIL)

The round-2 review file was overwritten by a later run that reused its name; the dispositions below are the surviving record. Round 3 is in `REVIEW-3.md` and `REVIEW-MAP-3.md`.

Owner decision: F6 resolved as a bounded MAY in STRATEGY §9 (D25); the rest left to the author.

| # | Verdict | Disposition |
|---|---|---|
| F1 | applied | §6.7 step column is the union with the rigor row (defect fix 1–8, refactor 1–2, test maintenance 1–3, 5, 7, 8); the parenthetical removed |
| F2 | applied | review debt is the one named satisfaction path for G6, G9 (validity), G11 at Light and Standard, in §6.7 and the §10 Blocks column |
| F3 | applied | L1 now requires stage mapping for stages B, D, E and the retry half of G5; the flake budget moves to L2 |
| F4 | applied | §14 carves out the §6.7 mechanical refactor edits |
| F5 | applied | §2.5 defines work unit, base commit, coordinator, stub commit; Coordinator added to both §13.1 tables; "bucket" and "dispatch" removed; the stub committer is the coordinator, or with none the implementer before the test author starts |
| F6 | applied (D25) | §9 bounded optional-binary skip; no AGENTS.md amendment needed |
| F7 | applied | §7.3 accepts an ADR with a review date |
| F8 | applied | provenance sentence and rationale for the 10 s and 2 min budgets |
| F9 | applied | §8.1 summary matches the table |
| F10 | applied | the first forced refactor edit is recorded as maintenance; a second within the window mandates rewrite |
| F11 | applied | Q2 asks about real elapsed time |
| F12 | applied | "the system under test does not own" in Q1 and §4 |
| F13 | applied | tier P toolchains are those of the package or deliverable under test, listed by the IMPLEMENTATION |
| F14 | applied | keyword-less imperatives carry MUST force; deviations via the exception log |
| F15 | applied | a stub failure counts only on the intended assertion; others take teeth after implementation |
| F16 | applied | notation normalized, §5 test restated, flake and regression defaults, G11 in L2, multi-class rule, blank line |
| 11 | backlog | the 15 unverified sources are for a source-verifying reviewer; not done here |

## G. Round 3 (`REVIEW-3.md` on STRATEGY 0.3; `REVIEW-MAP-3.md` on STRATEGY 0.3, STRATEGY_MAP 0.8, STATE 0.6; the source-check pass produced no file)

Decisions taken by the author on the owner's instruction "you decide the remainder", awaiting approval: D26.

### G.1 REVIEW-3.md (STRATEGY)

| # | Verdict | Disposition |
|---|---|---|
| A1 | applied | §7.2 states that the table is the definition of the earliest stage; P8 reworded |
| A2 | applied | no coordinator means no separated authorship: Standard becomes review debt, Deep does not proceed (§14, §13.2); stub verification is a mechanical check |
| A3 | applied | Light row points to review debt |
| A4 | applied-partly | unqualified `P/H/X` and "Size H" rewritten as "tier"; stages keep letters, the §7.2 columns are headed "stage" |
| A5 | applied | "lane" removed |
| A6 | applied | §13.1 states once what may be review debt; §6.7 cites it |
| A7 | applied | artifact checks are tier P tests with a standing gap statement (§2.4) |
| A8 | applied | cache hits are not executions for G2 or G5; cache key defined |
| A9 | applied | §11 names the field and recorder for human-recorded inputs |
| A10 | applied | redundancy row excludes tests whose gap statement names an unobservable property |
| A11 | applied | "decided by age alone" |
| A12 | applied | characterization tests take a mutation teeth proof and skip the red run |
| B1 | rejected | [S5] says "one tenth of a second is considered slow for unit tests"; verified against the saved page in two earlier checks |
| B2 | rejected | [S4] ch. 23 says "the cost of a bug grows almost exponentially the later it is caught"; verified against the saved page |
| B3 | applied | S19 gloss now quotes only what the page says (the Searls attribution is dropped) |
| B4 | applied | [S4] added as primary support beside [S20] |
| B5 | applied | G7 baseline is the median of the previous five mainline runs |
| C1–C9 | applied | terms defined (§2.5), tier P budget excludes the build, non-deterministic behavior (§12), None+Deep, per-change exception expiry, stage D runs mapped gates, parameterized red per equivalence class, Q1 reworded, G8 sampling |
| D1–D4 | applied | portability claim softened; provenance reduced to what changed; formatting; L1 requires the role slices |

### G.2 REVIEW-MAP-3.md

| # | Verdict | Disposition |
|---|---|---|
| B1 | applied (D26) | stubs return typed defaults or a marker error; red is a failed assertion or the marker error of a stub the test reached (STRATEGY §6.5; T22.AC4, T23.AC8, AC9) |
| B2 | applied (D26) | Deep in unmediated mode is refused or escalated (STRATEGY §13.2; MAP §1C.4; T43.AC8; T44.AC1); the Test author is in the Deep block rule |
| B3 | applied | T43.AC7 class-consistency check; asserted triggers can only raise rigor (MAP §1C.2; T43.AC1) |
| B4 | applied | T46 reads the header from the base commit and states where the run record lives |
| B5 | applied | STRATEGY §13.8 allows a deferral statement; T02.AC1 maps to the ten §13 items |
| B6 | applied | T40.AC2 keeps pre-push at S only per `8963c3cb`; P smoke at presubmit; MAP F11 records it |
| M1 | applied | T10 split (T10, T10b); T45, T12, T13, T02 dependencies; T03/T44 marker ownership; statuses regenerated from `depends` |
| M2 | applied | the `AGENTS.md` table wins; T10 validates both (T12.AC4, T49.AC7) |
| M3 | applied | signal job exits non-zero and files an escalation item; priority computed from counts; period defined; status table lists the items |
| M4 | applied-partly | risk statement in STRATEGY §13.1; Standard authorship stays with the implementer until the T24 pilot reports; pilot of three buckets; five seeded faults. The statistical power of T22.AC5 stays modest by design |
| M5 | applied | T63 (metrics, exception log, G11); §12 stated as carried by the IMPLEMENTATION and static review |
| M6 | applied | revisions unified, counts qualified, decision provenance stated, size re-measured |
| M7 | applied | success of D10 is a measured decrease against the first measurement |
| M8 | applied | T14.AC11 and T62.AC5 require a recorded reuse decision |
| M9 | applied | MAP §1A.5 no longer claims removed duplicate runs unless the report-producing run moves before QA |
| M10 | rejected | the check excludes every tag defined in §2.3, not two names, so a new agent named like a tag cannot turn STRATEGY red; the bound names come from the harness list |
| m1 | partly | notation extended; the cross-document collisions remain |
| m2–m4, m7–m10 | applied | by-file-or-glob scope, G7 baseline, rg polarity, card cost, debt scope, term consistency |
| m5 | applied | the section tally removed from MAP §11 |
| m6 | applied | the duplicate is already filed (`9a866182`); T21 marked done |
| m11 | applied | T64 releases the harness changes |
