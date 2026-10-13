# Testing Strategy

- **Version:** 0.4 (APPROVED by the owner 2026-10-07, without a fourth blind review; 15 of the 23 sources are not yet verified against their claims)
- **Kind:** portable strategy. It does not depend on any repository, build tool, test runner, language, or machine; sources and examples may name them. A repository adopts it by writing an IMPLEMENTATION document that maps every rule here onto that repository (see §13).
- **Normative words:** MUST, MUST NOT, SHOULD, MAY carry their RFC 2119 meaning. A prohibition or imperative written without a keyword ("never", "is prohibited") carries MUST / MUST NOT force, and a deviation from it goes through the exception log (§10).
- **Notation:** in prose a size tier is written "tier S" and a workflow stage "stage F"; a list after the word "tier" or "tiers" (S/P/H/X, "S, P, and H") is a list of tiers. Principles are P1–P14, gates G1–G12, sources [S#], retention questions R1–R6, and these never stand for a tier or a stage.
- **Citations:** `[S#]` refers to the source table in §15. A rule with no citation is a design decision of this strategy and is argued in its own rationale.

## 0. What this document is for

A test suite is a purchase: every test costs authoring, execution, and maintenance time for as long as it lives, and pays back only as *signal* — a trustworthy failure when behavior breaks. This strategy exists to answer four questions with a procedure rather than with taste:

1. **What** must be tested for a given change? (§6)
2. **Where** in the pyramid should each test live? (§5, §6)
3. **When** does each test run in the development workflow? (§7)
4. **When** should a test be lowered, rewritten, quarantined, or removed? (§8)

A strategy that cannot say when to delete a test only ever grows the suite until the suite is too slow to run and too noisy to trust. The retention rules in §8 are therefore as binding as the authoring rules.

## 1. Principles

Each principle states the rule, then why it holds.

**P1 — A test's value is signal per unit cost.** Signal is the probability that a failure means a real defect (*predictive*, *specific*) multiplied by the probability the test fails when behavior breaks (*behavioral*). Cost is authoring, running, and maintaining it. Beck's desiderata name the properties to trade off: isolated, composable, deterministic, fast, writable, readable, behavioral, structure-insensitive, automated, specific, predictive, inspiring. Some properties support each other and some interfere, so test value is optimized by choosing trade-offs, never by maximizing one property [S10].

**P2 — Speed and determinism are the primary qualities, so size is defined by enforceable resource ceilings.** A test's *size* is what it is allowed to consume — process count, network reach, installed toolchains, external services — because those limits are what predict speed and flakiness and are what infrastructure can enforce. Scope (how much code a test validates) is a separate, human-judged axis [S1]. Large tests are measurably more flaky: across binary size, RAM, and library count, "the larger the test … the more likely it is to be flaky" [S12].

**P3 — Verify at the lowest tier that can observe the failure.** "Push your tests as far down the test pyramid as you can." If a higher-level test finds a defect and no lower-level test fails, write the lower-level test [S6]. Higher tiers exist to buy *fidelity* — resemblance to how the system really runs [S3] — and are justified only by a failure the lower tiers cannot observe.

**P4 — Test behavior, not structure.** The ideal test is unchanging: it changes only when requirements change. A test that fails when production code is refactored with no behavior change is brittle, and brittleness taxes every future change [S2]. Tests assert observable outcomes through public interfaces; they do not assert call sequences, private state, or incidental structure.

**P5 — Every test is a liability that must keep earning its place.** "Every single test in your test suite is additional baggage and doesn't come for free" [S6]. A test has a lifecycle (author → run → review → keep, lower, rewrite, quarantine, or remove, §8). The cost of writing a test approaching zero does not change the cost of running and maintaining it, nor the reviewer's attention it consumes; with automated authors, review and triage attention is the scarce cost, which is why net suite growth is a reviewed quantity (§8.6).

**P6 — Determinism is the standard; a flake is a defect.** A test that passes and fails on the same code is defective, not unlucky: it destroys trust in the whole suite [S8]. Even with heavy investment a large organization sees about 1.5% of test runs flaky and almost 16% of its tests with some flakiness, because insertion keeps pace with fixing [S11]. Therefore flakiness is controlled by mechanism (isolation, injected time and randomness, condition-based waiting, quarantine with a deadline), not by retry (§9). A flake budget (G5) is an escalation threshold: crossing it escalates, and staying under it never makes a flake acceptable.

**P7 — Boundaries are verified by contracts, not by standing up the neighbor.** A test whose result depends on the correctness of another system — spinning up other services, sharing a test environment — is an *integrated test*, and is fragile [S13]. Verify an integration point by checking each side in isolation against a shared, executable description of the messages crossing it [S14]. Contract tests keep doubles honest.

**P8 — Fast feedback, earliest sufficient stage.** The cost of a defect grows almost exponentially the later it is caught [S4]. Each test therefore runs at the earliest workflow stage that §7.2 gives its tier. Slow tests are not made harmless by deferring them: pushing e2e-class tests to nightly or weekly builds raises the risk of merging a bad change [S4, S20]. A test that cannot meet an early stage is split, lowered, or has its deferral accepted in writing by a named owner (§7.3).

**P9 — Test everything you do not want to break (the Beyoncé Rule).** This includes failure handling, security, performance, and accessibility, not just the happy path [S1]. What is *not* tested is stated, not implied (§6.1).

**P10 — A test that does not run does not count.** A skipped, disabled, `todo`, or unreachable test provides no signal and presents false coverage. These are debt with an expiry, never a state a suite may rest in (§9, gate G4). Likewise a test that no workflow stage executes MUST be fixed or removed (gate G2).

**P11 — Coverage finds gaps; it does not certify quality.** "Test coverage is a useful tool for finding untested parts of a codebase … of little use as a numeric statement of how good your tests are"; a target invites tests written to satisfy the number [S9]. Measure coverage from small tests only to avoid inflation from large ones [S1]. Test efficacy is measured by fault injection (mutation analysis): inserting small faults and checking that tests catch them [S15, S16].

**P12 — Tests are code, written for the reader.** Clear tests are trivially correct on inspection: straight-line, no logic, descriptive failure messages, tolerant of duplication when it aids clarity (DAMP over DRY) [S2].

**P13 — Gates are enforced by mechanism, not intention.** A rule that no tool or named reviewer enforces is a wish. Every gate states its enforcement (§10). The strategy does not certify itself: conformance is shown by the outputs of the enforcing mechanisms in the adopting repository.

**P14 — Shape is an outcome, not a quota.** The pyramid (many fast tests at the bottom, few slow tests at the top) is what the decision procedure produces; the proportions are diagnostics. Inverted (ice-cream cone) or hourglass shapes signal that tests are in the wrong place [S5, S7]. Shape claims differ across authorities (pyramid, trophy, honeycomb) and agree on the invariant: invest where the cheapest reliable confidence is [S13, S19].

## 2. Vocabulary

### 2.1 Test size — resource ceiling (enforceable)

Every test has exactly one size, declared by its location or label and enforced mechanically (gate G3). Size is the *maximum* the test may consume; a test that needs less belongs in a smaller tier.

| Tier | Name | Ceiling | Default budget (per test, p95) | Failure semantics |
|---|---|---|---|---|
| **S** | Sealed | One process. No child processes, no listening sockets, no network (in-memory transports between in-process components are allowed), no wall-clock waits (time and randomness are injected). Filesystem limited to a private per-test scratch location. In-process embedded datastores allowed. | 100 ms [S5]; any test over 1 s is a split-or-fix candidate (the 1 s figure is this strategy's own) | Deterministic; any failure blocks |
| **P** | Process | One machine. Multiple processes and loopback networking on ephemeral ports. Built artifacts run as a consumer runs them. Only toolchains the package or deliverable under test needs to build and run itself (building the artifact is counted in the stage budget, not in the per-test budget) (the IMPLEMENTATION lists them; any other toolchain is tier H). | 10 s | Deterministic; any failure blocks |
| **H** | Heterogeneous | One machine. Requires foreign runtimes or toolchains, containers or VMs, or other heavyweight local resources (large models, browsers). | 2 min | Deterministic; missing prerequisite is a hard failure, never a skip |
| **X** | External | Reaches anything the owner does not control or that costs money or quota: paid services, shared environments, production. | Metered (time and spend cap) | Explicitly authorized; never in presubmit. A flag that enables it is set by some stage (G2); with the flag set, a missing credential is a loud failure; with the flag unset it is reported as not run (§9) |

Default budgets are starting values; the IMPLEMENTATION sets the numbers it can enforce. Tiers S, P, and H are the "small / medium / large" ladder of [S1] split where this strategy needs a distinct *cost and determinism* decision: S is cacheable and massively parallel, P is serial or bounded-parallel, H needs provisioning, X needs authorization and money. The tier P and tier H budgets (10 s, 2 min) are this strategy's own: a process-level test that needs more than 10 s is usually waiting rather than working, and 2 min is the longest a presubmit stage can absorb for one test inside its 15-minute budget.

### 2.2 Test scope — what is validated (human-judged)

*Narrow* (one unit of behavior), *medium* (a few collaborating components), *broad* (system-level or emergent behavior) [S1]. Scope and size are independent: a broad-scope test can be tier S (in-process, doubles at the true external edge) and is then preferred over a size-P test of the same behavior.

### 2.3 Purpose tags — why the test exists (orthogonal, for selection)

A test carries zero or more tags used to select subsets at a workflow stage. Tags never create new tiers or stages.

| Tag | Meaning |
|---|---|
| `smoke` | Minimal proof that a shipped artifact starts and serves its primary journey |
| `contract` | Verifies one side of a boundary against a shared executable description (P7) |
| `conformance` | One shared executable specification run against several implementations |
| `regression:<id>` | Guards one fixed defect; the id links to the defect record |
| `concurrency`, `durability` | Multi-actor safety and persistence-across-restart properties |
| `security`, `performance`, `accessibility` | Non-functional properties (P9) |
| `property` | Generated-input test asserting an invariant [S21] |
| `characterization` | Pins legacy behavior before change; carries an owner and a replace-by date (§6.4) |

### 2.4 Non-test verification

Static analysis, type checking, and dependency checks are not sized; they gate without being tests. An *artifact check* loads and exercises the built, shipped artifact as a consumer would, because tests that resolve to source can pass while the shipped artifact is broken. It runs a built artifact in its own process, so it is a tier P test (tier H if it needs a foreign runtime) that carries the standing gap statement "the shipped artifact fails to load only from its published path", counts as the `smoke` subset where it runs the primary journey, and gates under G10; G2, G3, G5, G7 and G9 apply to it like any tier P test.

### 2.5 Work-unit vocabulary

- **Work unit:** the smallest group of changes planned, implemented, and verified together (one ticket, or a group of related tickets).
- **Base commit:** the commit a work unit starts from.
- **Coordinator:** the party that sequences the parties of a work unit, commits the stub commit, joins parallel work, and runs the gate set; a person, an orchestrating agent, or a script. Work with no coordinator is done by a single worker (§13.2).
- **Stub commit:** the commit holding the interface stubs of §14.
- **Affected set:** the tests whose dependency graph contains a changed file, as computed by the IMPLEMENTATION's selection method (§7.2).
- **Plan-scope tests:** the tests of every work unit in a plan, run together before the final run.
- **Share of a stage budget:** the fraction of that stage's time budget the IMPLEMENTATION assigns to a tier.

## 3. The three axes in one sentence

*Size* says what a test costs and how far it can be trusted to be deterministic; *scope* says what it validates; *tags* say why it exists and let a workflow stage pick it. Decisions in §6–§8 are made on size first.

## 4. Doubles policy

Prefer, in order: the real implementation in-process → a fake that behaves like the real thing (an in-memory datastore, a server reached over an in-memory transport; a server that listens on a socket is tier P) → a stub returning canned values → an interaction-verifying mock. State verification outlasts interaction verification across refactors [S22, S2]. Doubles replace only boundaries the system under test does not own (the same wording as §6.2 Q1), and every double of a boundary that matters MUST be kept honest by a contract test (P7). Never replace the thing under test.

## 5. The pyramid as a decision outcome

Expected steady-state shape, measured by count *and* by execution time:

- The overwhelming majority of tests, and nearly all logic and error-path assertions, are tier S.
- A thin layer of tier P tests covers what only a process or network boundary can show: cross-process safety, startup and shutdown, built-artifact behavior, wire formats.
- Tier H tests cover what only a foreign toolchain can show: cross-language conformance, real third-party runtimes.
- Tier X tests are rare, authorized, and capped.

As a first guess for review, a 70/20/10 split between narrow, medium, and broad tests is a common heuristic [S5]; treat it as a smell detector, not a target. If a tier's p95 duration exceeds its budget, or its total time exceeds its share of the stage budget it runs in, or if many tier P tests assert only data transformation, the suite is mis-shaped and §8 demotion applies.

## 6. Deciding what to test

### 6.1 The change procedure

For every change, before writing tests. Which steps are mandatory, and at what depth, follows mechanically from the change's class and rigor (§6.6, §6.7); no step is skipped by discretion.

1. **Classify the change:** new behavior · defect fix · refactor (no behavior change) · configuration · dependency · boundary or contract change · no-code (documentation, investigation, coordination) · test maintenance (lowering, rewriting, removing, quarantining, or un-stubbing tests, §8). The class is recorded as a field of its own on the work item; it does not depend on the tracker's item types, which differ by repository. A change that spans several classes takes the class with the highest default rigor and is split where the evidence rows differ.
2. **List behaviors and failure modes** the change could break (P9): normal, boundary values, malformed and adversarial input, partial failure, concurrency, persistence, security, non-functional. Rank each by impact × likelihood. This is the change's *risk map*.
3. **Write the "not testing" list:** failure modes deliberately left untested and why. A change with an empty list claims everything was considered.
4. **For each ranked failure mode, choose the tier by §6.2.** One test per failure mode, not per code path; the parameterized cases of one failure mode (§6.4) are one test, and each equivalence class among them shows red at least once.
5. **Check for duplication:** search existing tests for the same failure mode. If a lower-tier test already observes it, do not add a higher one (P3). If a higher-tier test observes it and a lower-tier test is feasible, write the lower one and queue the higher for demotion (§8).
6. **Apply the case-design techniques (§6.4).**
7. **Prove teeth:** each new test fails when the behavior is broken — shown by reverting the fix, injecting a fault, or a deliberately wrong variant (§6.5).
8. **Record the test's header:** the failure mode it guards, its tier, and (for tiers P, H, X) the fidelity-gap statement (§6.2).

A *refactor* needs no new behavior tests; it needs the existing tests to pass unchanged. If a refactor forces a test edit, the first such edit is recorded as test maintenance (§6.7) and the tests are marked structure-coupled; a second forced edit within the window of §8.2 mandates rewriting them to assert behavior (P4).

A *defect fix* requires a regression test at the lowest tier that fails before the fix and passes after. A defect found at a higher tier than necessary triggers §8.5.

### 6.2 The tier decision tree

A test's tier is the **highest** tier that any requirement of the failure demands. Ask every question below; each "yes" sets a minimum, and the tier is the largest minimum. Contract and conformance are modifiers on that result, not tiers of their own.

```
Q1. Can the failure be made visible by calling code in-process, with doubles only at
    boundaries the system under test does not own (contract-verified) and only in-memory transports?
      yes → tier S, unless a later question raises it.
      (Use scope narrow/medium/broad as the behavior demands.)

Q2. Does the failure need a separate process or loopback network (process boundary,
    OS signals, stdio/ports, a listening socket, concurrent writers, restart/persistence,
    a built artifact run as a consumer runs it, or an assertion that depends on real elapsed time such as a performance measurement)?
      yes → at least tier P.

Q3. Does it need a foreign runtime/toolchain, container/VM, browser, or a
    heavyweight local resource?
      yes → at least tier H.

Q4. Does it need a system we do not control, or something that costs money/quota?
      yes → tier X (authorized, capped, never presubmit). First ask whether a tier H/P
            fake or contract could reduce the residual risk to something X need only sample.
```

**Modifiers (apply after the tier is chosen).**

- **Contract.** If the failure lives in the message crossing a boundary between two owners or two implementations, the test is a contract test (P7): the consumer side runs against the shared contract at the tier its double needs (normally S); the provider side runs the real implementation at the tier that implementation needs.
- **Conformance.** If one specification must hold across several implementations, the same suite runs against each. Its tier is the highest tier any implementation requires (several in-process implementations: tier S). The `conformance` tag selects the suite; it does not choose the tier.

**Fidelity-gap statement (mandatory for P, H, X).** The test header states, in one sentence: *"This cannot be observed at tier T-1 because ___."* Valid reasons name a concrete property that disappears below this tier (e.g. "two OS processes hold concurrent connections", "the shipped bundle fails to load only when required from its published path"). Invalid reasons: "it's more realistic", "it's the real flow", "it was easier to write". A test lacking a valid statement MUST be written at a lower tier (gate G9).

### 6.3 What the tiers are *not* for

- **Not for logic.** Validation rules, error mapping, merge semantics, state transitions, route derivation, schema derivation: tier S.
- **Not for "the whole thing works" as a substitute for the parts.** Broad confidence comes from many S tests plus a few P smoke journeys, not from enumerating cases at P [S5].
- **Not for exercising someone else's system.** Contract it (P7).

### 6.4 Case-design techniques

Apply the technique that fits the input, explicitly, and name it in the test where non-obvious:

- **Equivalence partitioning** — one case per class of equivalent input.
- **Boundary values** — min−1, min, max, max+1, empty, oversize, zero, negative, Unicode edges.
- **Negative and adversarial cases** — malformed, missing, duplicated, hostile input must fail as the contract says and never crash.
- **State transitions and decision tables** — enumerate transitions and rule combinations.
- **Property-based tests** — assert invariants over generated inputs and shrink failures [S21]; prefer them for parsers, codecs, merges, and anything with round-trip or idempotence laws.
- **Concurrency** — prove with barriers and latches, never sleeps; verify persistence by reopening the store.
- **Characterization** — pin current behavior of legacy code before changing it, tagged for replacement with an owner and a replace-by date; past the date it follows the skip rule (§9, G4).

A case names its input, its action, and its expected result, and anyone can run it.

### 6.5 Teeth

A test that stays green when the code is wrong proves nothing. Every behavioral test MUST have been observed red at least once against a faulty implementation: by reverting the fix, by a deliberately wrong variant, or by a mutation tool [S15, S16], and the recorded failure MUST be a failed assertion for the intended reason (G6). A stub returns a typed default where the language allows it, so that assertions fail on value; where it cannot, it throws a marker error. A run against a stub counts as red when the test reaches the stub and fails an assertion, or fails with the marker error raised by a stub the test called (not a missing symbol or a compile error). A test that cannot go red against a stub (for example one that asserts a throw) takes its teeth proof after implementation, by a deliberately wrong variant or a mutation, and so does every failure mode ranked high-impact. A characterization test passes by construction; its teeth proof is a mutation of the pinned behavior, and it is exempt from the recorded red run on the original code. A test written before its implementation is run against committed interface stubs (§14); a failure from a missing symbol or a compile error proves nothing about the assertion and is not red evidence. Changed-code mutation survivors are reviewed (gate G8).

### 6.6 Rigor: how much planning a change needs

Planning effort is proportional to risk, because planning is itself a cost (P1). A change carries one **rigor level**, derived and never chosen. The levels are design decisions of this strategy: effort is graded in steps because the decisions it gates (who authors, who approves) change at the steps, not between them.

| Level | Risk map | "Not testing" list | Author | Independent approval (§14) |
|---|---|---|---|---|
| **None** | not applicable | not applicable | not applicable | not applicable (no tests are written) |
| **Light** | one line per acceptance criterion | MAY be "none" | the implementer MAY author | the single review of the change; if no party can perform it, review debt (§13.1) |
| **Standard** | ranked by impact × likelihood | required; accepted by the risk owner when any entry is high-impact | separated authorship (§14) is the default; the IMPLEMENTATION MAY set the implementer for a class | required; a role other than the author; MAY be deferred as review debt with an owner and an expiry (§13.1) |
| **Deep** | ranked, with every boundary crossing and failure mode of the escalation triggers | required and accepted by the risk owner | separated authorship is REQUIRED | required; includes the contract and gap-statement review |

**Derivation.** Rigor = the higher of (a) the class default in §6.7 and (b) the highest level demanded by any **escalation trigger** the change hits. Triggers are class-independent facts about the change:

| Trigger | Minimum rigor |
|---|---|
| Crosses a process, network, or ownership boundary (adds or changes a call across it) | Standard |
| Alters a shipped artifact's entry point | Standard |
| Touches persistence or concurrent writers | Deep |
| Security-relevant (authentication, authorization, secrets, input from outside the trust boundary) | Deep |
| Alters a published interface (anything a consumer outside the repository depends on); this is the boundary-or-contract class | Deep |
| Migrates data | Deep |
| Its effect cannot be undone | Deep |

A repository lists its triggers, each with the path patterns or labels that detect it, in its IMPLEMENTATION (§13); a trigger a tool can detect is detected by the tool, not asserted by the author. The IMPLEMENTATION also reports the observed distribution of derived rigor over recent changes, because a trigger list that sends most changes to Deep makes separated authorship the norm and its cost must be visible.

**Lowering rigor** below the derived level is a deviation: it needs an entry in the exception log (§10: owner, risk accepted, compensating control, expiry; an entry for a single change expires at that change's merge). For a change that produces no tests, Deep applies to the plan: the risk map and the "not testing" list cover the effects of the change, and the approver is the risk owner. An item with no recorded class is treated as new behavior at Standard and the default is recorded on the item.

**The record.** Every change leaves a **rigor record** on its work item (or in its change description when no item exists): class, derived rigor, and for each trigger whether it was hit. A reduced path is therefore visible to whoever reviews, audits, or later investigates an escape (§8.5, §11).

### 6.7 Applicability by change class

The table states what each class requires **in addition to the gates** and **in addition to the row of §6.6 for the derived rigor, which always applies**. The step column below is the union with that row. No class and no rigor level relaxes a gate: every gate in §10 applies to every change, and a class only determines whether a gate has anything to check; review debt (§13.1) is the one named satisfaction path, and §13.1 states what may be debt. What a class removes is *planning and authoring work with no payoff*, never enforcement.

| Class | Default rigor | §6.1 steps that apply | New tests | Evidence the work is done |
|---|---|---|---|---|
| New behavior | Standard | 1–8 | One per ranked failure mode | tests cite the work item and criterion; teeth shown (§6.5) |
| Defect fix | Standard | 1–8 (step 2 scoped to the escaped failure mode) | A regression test at the lowest tier | the same test run failing before the fix and passing after, with both commands and exit codes; §8.5 record |
| Refactor | Light | 1, 2 (one line per touched behavior: no behavior change) | None | the existing tests pass with no edit to any test file, except mechanical, behavior-neutral edits that follow a moved internal (an import path, a file move), which are listed in the change; any other forced test edit reclassifies that edit as test maintenance and the tests as structure-coupled (P4) |
| Configuration | Light | 1, 2 (one line), 4 | Only where the configuration changes observable behavior | the artifact check (G10) and any `smoke` subset the change reaches |
| Dependency | Light; Standard when the dependency is on the runtime path of a shipped artifact | 1, 2, 4 | None, unless a boundary it provides changed | the artifact check (G10) and the contract tests of the boundaries it touches |
| Boundary or contract change | Deep | 1–8, both sides of the boundary (P7) | Consumer-side and provider-side | the contract artifact and both sides' results |
| No-code | None | 1 | None | the checks that exist for the output (for example format or link checks); if the work produces code, that code is a separate item with its own class |
| Test maintenance | Standard | 1–3, 5, 7, 8, plus §8.3 or §8.4 | The replacement, where a test is lowered or rewritten | the parity proof (§8.3); a reviewer other than the one who edited the tests |

**Raised rigor.** When a trigger raises a change above its class default (for example a refactor that touches persistence, which is Deep, or a configuration change that crosses a boundary, which is Standard), the rigor level's requirements in §6.6 apply on top of the class row: the risk map and "not testing" list at that depth, independent approval, and the authorship rule. If the behavior the change touches has no covering test, a test that pins it (a characterization test) is written before the change, whatever the class says about new tests.

**Gates that no class relaxes**, listed because they are the ones a reduced path is most tempted to skip: G1 (the required tests pass), G2 (every test is reachable), G4 (no silent skip, including a placeholder left behind), G10 (the artifact check, whenever the change ships or alters an artifact), G12 (the planning record), and the release stage (§7.1, stage G).

## 7. Where tests run: the development workflow

### 7.1 Stages

| Stage | Trigger | What runs | Default feedback budget |
|---|---|---|---|
| **A. Author loop** | Save / watch | tier S for the unit being edited | ≤ 10 s |
| **B. Pre-commit** | Commit | Static checks; tier S for the changed units | ≤ 60 s |
| **C. Pre-push** | Push | tier S for the *affected set*; tier P `smoke` for affected deliverables | ≤ 5 min |
| **D. Presubmit** | Change proposed | Static checks; S and P for the affected set; H for affected deliverables that declare an H dependency; artifact checks; gate checks for the gates the IMPLEMENTATION has mapped (G8 diff-based on the changed lines; an unmapped gate is an obligation, §13). **Never X.** | ≤ 15 min wall |
| **E. Mainline** | Change merged | S, P, H over the *whole* integrated state (not only affected), to catch affected-selection escapes | Wall time reported |
| **F. Scheduled** | Nightly/weekly | Soak and long-running P/H; repeat-run flake detection; sampled mutation analysis; retention report (§8); capped X smoke against real services | Reported, owned |
| **G. Release** | Release candidate | Full S, P, and H; `smoke` and `contract` on the candidate artifact; artifact check from the package as consumers install it; X only when release risk demands it and is authorized | Blocking |
| **H. Production** | After release | Synthetic probes and monitors (outside the test suite); defects found here trigger escape analysis (§8.5) | Continuous |

Defaults are starting values; every adopting repository sets and enforces its own numbers.

### 7.2 Tier-to-stage assignment

A test's **earliest stage** is the one this table gives its tier; the table is the definition, not a derivation from budgets (stage C admits only `smoke` by design, to keep pre-push inside its budget, so a tier P test that would fit stage C is not thereby deferred). Its **latest tolerated stage** is the stage by which a regression must be caught to keep the cost of that defect acceptable. Default placement:

| Tier | Earliest stage | Latest tolerated stage | Selection | Parallelism and caching |
|---|---|---|---|---|
| S | A | D | Impact-selected (changed units → affected set) | Fully parallel, cached on content hash |
| P | C (`smoke`), D (rest) | E | Impact-selected; full on E | Serial or bounded parallel; cached on content hash |
| H | D (when affected and declared) | E/F | Impact-selected for D; full on E | Bounded; provisioning counted in budget |
| X | F or G | G | Never impact-selected | Serial; spend-capped |

A cache hit counts for G1 but is not an execution: it is not evidence for G2 reachability or for G5 flake measurement, and stages E and F bypass the cache. The cache key of a tier P or H test includes the toolchain versions, the operating system, and the environment variables the test reads; a test whose inputs the key cannot capture is not cached. Selecting tests by tags, pre-calculated dependency graphs, or test-impact analysis are the conventional ways to shorten a run [S23]. Any selection can miss a test that should have run, so stage E exists to catch those misses and each one is counted as a metric (§11).

### 7.3 Deferral rule

A test may run later than its earliest stage only if the owner of the risk it guards records, in the test's header or the strategy exception log, that the *defect window* (the longest a regression may go undetected, stated in days or merges) is acceptable, with an expiry. A standing placement decision recorded in an accepted architecture decision record counts, with that record's review date in place of an expiry. Otherwise the test is split, lowered, or made faster. "It's slow" is a reason to lower or split it, not a reason to move it to nightly [S20].

### 7.4 Reachability and ownership

- Every test is in exactly one tier and is reached by at least one stage (G2).
- Every scheduled stage has a named owner and a failure route; a scheduled stage nobody triages is a stage that never ran.
- Stage F MAY be realized as demand-driven review instead of a clock: a standing review item per group of tests whose priority rises when a signal crosses a threshold stated in the IMPLEMENTATION (a change touching the group, a duration over budget, a flake, a skip past its date; counted per period, not per touch) and resets when the item is worked, so that priority can fall as well as rise. The item has the same owner and failure route, and the signals, thresholds, and priority ladder are stated in the IMPLEMENTATION (§13). A review item nobody works is a stage that never ran.
- Work that depends on elapsed time or repetition rather than on change cannot be signalled by change history: soak runs, repeat-run flake detection, sampled mutation analysis, and capped X smoke against systems the repository does not control (drift). A demand-driven stage F MUST give each of these a clock or a named review-item action that runs it, or record an exception for it.
- A stage that selects by tag (e.g., `smoke`) lists the tags in its definition; no test silently falls out of every selector.

## 8. Retention: keep, lower, rewrite, quarantine, remove

### 8.1 The retention question set

For any test under review, ask in this order:

| # | Question | If "no" |
|---|---|---|
| R1 | **Predictive.** Does it assert something that matters, and would it fail if that behavior broke (has it ever been seen red against a fault)? | Strengthen with an assertion that has teeth, or remove |
| R2 | **Unique.** Does it detect a fault no cheaper test also detects? | Remove (or merge into the cheaper test) |
| R3 | **Right tier.** Is there a valid fidelity-gap statement (§6.2) for its tier; for tier S, is it within the S ceiling and budget (G3, G7)? | Lower (§8.3); for tier S, split or fix |
| R4 | **Specific and structure-insensitive.** When it fails, is the cause obvious, and does it survive behavior-preserving refactors? | Rewrite to assert behavior |
| R5 | **Affordable.** Is it within its tier's time budget and flake budget? | Fix, split, or lower; quarantine with deadline (§9) |
| R6 | **Alive.** Does it run in at least one stage, un-skipped? | Run it or remove it (§9) |

A test passing all six is kept. Failing R1 gives *strengthen or remove*; failing R3 gives *lower* (tier S: *split or fix*); failing R4 gives *rewrite*; failing R2 gives *removal*; failing R5 or R6 gives *repair or removal on a deadline*.

### 8.2 Triggers and evidence

Retention reviews are triggered by events, plus a periodic or signal-driven sweep (§7.1, stage F); they are never decided by age alone. A test that has never failed is not therefore useless — it may be a sound guard. Age-based pruning without uniqueness evidence is prohibited.

| Trigger | Evidence required | Action |
|---|---|---|
| A defect escaped to a higher stage than the earliest that could catch it | Escape record (§8.5) | **Add** the missing lower test; review the tier that caught it for lowering |
| Test touched during a change | Reviewer applies R1–R6 | Keep / rewrite / lower / remove in the same change |
| Behavior-preserving refactor forced a test edit ≥ 2 times in the window the IMPLEMENTATION sets (default: 90 days) | Change history | **Rewrite** at the public-behavior level (R4) |
| Test exceeds its tier's budget or was moved later by deferral | Duration metric | **Lower, split, or fix**; deferral requires §7.3 sign-off |
| Flake detected (same code, both results) | Repeat-run or CI history | **Quarantine** with deadline (§9), then fix or remove |
| Another test (same or lower tier) fails for every fault this one detects | Per-test mutation-kill sets, fault injection, or reviewer analysis with the method stated | **Remove** (it is redundant); never when the test's valid gap statement names a property the cheaper test cannot observe |
| Every assertion is observable at a lower tier (no valid fidelity statement) | Reviewer analysis of the assertion path | **Lower** (§8.3) |
| Requirement removed or behavior deliberately changed | Requirement/ADR record | **Remove or update** with the requirement |
| `skip` / `todo` / disabled / unreachable | Static scan | **Run, replace, or remove** before expiry (§9) |
| Sweep (periodic or signal-driven) | Retention report (§11): per-test duration, flake count, failure history, tier, kill-set uniqueness where available | Feed the triggers above |

### 8.3 Lowering procedure (tiers P, H, X → a lower tier)

Lowering is a replacement, never a deletion followed by hope:

1. **Write the lower-tier test** capturing the same assertions, using an in-process real, fake, or contract-verified double at the boundary that previously required the higher tier.
2. **Prove parity** — inject each fault the original guards (revert the fix, mutate the code, or run the original's own negative control) and show the new test fails.
3. **Keep the original** until parity is shown; then retire it in the same change.
4. **Preserve traceability:** the new test inherits the original's tags and its `regression:<id>` links, and the change record names old test, new test, and the defects the pair covers.
5. **Never lower to a placeholder.** A `todo`, an empty stub, or a skipped test is not a lower-tier test (P10).
6. **If no honest lower-tier equivalent exists** (the fidelity gap is real), the test stays; record the gap statement in its header so it is not re-litigated.

### 8.4 Removal procedure

1. State which retention question failed and the evidence.
2. If the test carries `regression:<id>` tags, show that the defect is still covered (by the cheaper test, by parity proof) or that the requirement is gone.
3. Remove in the same change that supplies the evidence; never batch removals without per-test evidence.
4. Record: test id, reason, evidence, covering test or retired requirement.
5. Reviewers other than the remover confirm (the approval boundary is outside the author).

A removal that cannot show coverage of the guarded failure mode is a *risk acceptance*, and requires a named owner and the exception log.

### 8.5 Escape analysis and raising

When a defect is found at a stage later than the earliest stage that could have caught it:

1. Identify the lowest tier that can observe it.
2. If a test at that tier is missing, **write it** (this is how the pyramid corrects itself).
3. If the defect was observable only at a higher tier, record the fidelity gap and add a test at that tier **with** the gap statement.
4. Record the escape in the metrics (§11) so the stage and tier that missed it are visible.

### 8.6 Test-suite budget per change

A change that adds tests lists the tests it makes obsolete or lowers, or states "none" with the reason. Net suite growth is a reviewed quantity, not an accident.

## 9. Flakes, skips, and quarantine

- **Cause removal comes first.** Remove shared state, wall-clock dependence, real network, unordered output, resource leaks, and fixed sleeps; wait for conditions with bounded deadlines, not fixed sleeps [S1, S8].
- **Quarantine is temporary and visible.** A quarantined test is removed from the gating run, still executed and reported, tracked by an item with an owner and a deadline (default 14 days: long enough for a fix to be reviewed and merged, short enough to stay a deadline; the IMPLEMENTATION may set another). At the deadline it is fixed or removed. Quarantine never exceeds its deadline silently [S8].
- **No permanent retries.** An automatic retry is a recorded known flake with a tracking item and a fix date; a retry that silently turns red green is prohibited. Flake-detection tooling that reruns suspect tasks is acceptable only if it records, reports, and escalates each hit.
- **Skips expire.** Any skip, `todo`, or disabled marker names a tracking item and an expiry. Past expiry, the build fails (G4). A prerequisite that is missing fails loudly; it never skips (tier H, X rules). The one bounded exception: a single assertion that depends on an optional diagnostic binary, not required to build or run the system, MAY self-skip with a visible warning, and is reported as not run, never as passed; it MUST NOT mask a failure in the code under test.
- **Environment gating** (e.g., "run only when a flag is set") is permitted only for tier X, and only when its sole cause is cost or an uncontrolled external system; the gate and its owner are documented where the test lives. With the flag unset the test is reported as not run (never as passed); with the flag set a missing prerequisite fails loudly; some stage MUST set the flag (G2).

## 10. Gates

A gate is a threshold plus a named enforcing mechanism plus an owner. A threshold with no enforcing mechanism is not a gate and MUST NOT be written here or in an IMPLEMENTATION. Gates ratchet forward: a threshold may be tightened without ceremony and relaxed only through the exception log. A tightened threshold applies to new and changed tests at once; existing violators are listed in the exception log with dated entries, so that a tightening never turns unrelated work red by surprise.

| ID | Gate | Blocks | Enforcement class |
|---|---|---|---|
| G1 | Required tests pass; a quarantined test past its deadline fails the build | Merge, release | Mechanical |
| G2 | **Reachability:** every test belongs to exactly one tier and runs in ≥ 1 stage | Merge | Mechanical |
| G3 | **Tier conformance:** tests do not exceed their tier's ceiling (e.g., an S test does not spawn a process, open a socket, or sleep) | Merge | Mechanical (static scan + runtime guard where available) |
| G4 | **No silent skips:** every skip/todo/disabled/characterization marker has a tracking item and an unexpired date; every review-debt entry (§13.1) has an owner and an unexpired date | Merge | Mechanical |
| G5 | **Flake budget** per tier not exceeded, measured over the trailing history of stages D–F and repeat-run reports; no unrecorded retry; default budget: at most 1% of a tier's runs flaky (a starting value, cf. [S11]) | Merge (regression), release | Mechanical |
| G6 | **Regression-with-fix and red evidence:** a defect fix includes a test that failed before the fix; every new behavioral test records a red run that failed on an assertion (§6.5) | Merge, or a review-debt entry (§13.1) at Light and Standard; never at Deep | Review (reviewer other than author) |
| G7 | **Time budgets:** per-test and per-stage budgets hold; breaches trigger §8.2; a regression is a p95 more than 10% above the median of the previous five mainline runs (a starting value) | Warn → block on regression | Mechanical |
| G8 | **Changed-code efficacy:** surviving mutants and uncovered lines in the changed code are reviewed; diff-based, within stage D's budget (when the run does not fit, it samples the changed lines and records the rest as an obligation on the item, never silently skipping); the sampled whole-suite run is stage F; no repository-wide percentage target (P11) | Merge | Mechanical report + review |
| G9 | **Fidelity-gap statement** present and valid on every tier P, H, or X test | Merge (validity review: or a review-debt entry at Light and Standard) | Mechanical presence check + review of validity |
| G10 | **Artifact check:** the built artifact loads and its primary journey runs as a consumer runs it | Merge (a change that ships or alters an artifact), release | Mechanical |
| G11 | **Strategy conformance:** changes to test infrastructure and gates cite this strategy and the exception log | Merge, or a review-debt entry (§13.1) at Light and Standard; never at Deep | Review |
| G12 | **Planning record:** every change has a class and a rigor record (§6.6); a change at Standard or Deep has a "not testing" list; every new test has a header with its failure mode and tier (§6.1.8) | Merge | Mechanical presence check |

**Exception log.** A deviation from any MUST requires: a named owner, the risk accepted, the compensating control, and an expiry. An exception without an expiry is a defect in the exception.

## 11. Metrics

Every number reported is one a tool produced; a number aggregated from a human-recorded field (the escape record, the classification of a failure as a real defect) names that field and who records it; a metric not measured is reported as "not measured", never estimated.

| Metric | Why it matters | Cadence |
|---|---|---|
| Pass rate and failure count per tier and stage | Basic health | Per run |
| **Flake rate** per tier and per test (same code, both outcomes) | P6; budgets G5 | Per run, trended |
| **Duration** p50/p95 per test, tier, and stage; **suite wall time** | P8; budgets G7 | Per run, trended |
| **Shape:** count and time by tier | Detects ice-cream cone / hourglass (P14) | Scheduled |
| **Signal precision:** failures that were real defects ÷ all failures, per test | Retention evidence for R1/R4 | Scheduled |
| **Escape rate:** defects found at a later stage than the earliest that could catch them, by tier of the missing test | Drives raising and lowering (§8.5) | Per defect |
| **Escape rate by class and rigor level** (§6.6): defects that escaped, grouped by the rigor record of the change that introduced them | Tests whether reduced paths are safe; a Light or None path that escapes more than the budget the IMPLEMENTATION sets for it is raised | Scheduled |
| **Selection escapes:** failures found at stage E that stage D's affected selection missed | Validates impact selection | Per run |
| **Skipped / `todo` / quarantined count and age** | P10, G4 | Per run |
| **Changed-code mutation score** (diff-based) and uncovered changed lines | G8 [S15] | Per change |
| **Test growth vs obsolescence:** tests added, lowered, removed per period | §8.6 | Scheduled |
| **Change-failure rate and lead time for changes** (delivery outcomes) | Whether the test system supports delivery; fast, reliable feedback is the purpose of test automation and CI [S17, S18] | Release |

## 12. Test data, environments, automation

**Test data and fixtures.** Create per test, from factories; isolate from production data; seed deterministically. Inject time, randomness, and identifiers; assert on neither wall-clock nor generated ids. Every test owns a private scratch location, ephemeral ports, and its own datastore; cleanup runs in a `finally`-equivalent so a failing run still cleans up. No test mutates shared or tracked state; no test depends on another's order.

**Environments.** Each tier has one documented command that reproduces it locally and the same command runs it in CI. Provisioning of H prerequisites is part of the tier H definition and is exercised by it. Tests never touch production data or systems without explicit authority (X rules).

**Automation architecture.** One abstraction per surface (one page object / client / actor per screen, API, or user intent). Selectors and wire shapes are stable and semantic (roles, labels, published names), never positional or stylistic. Wait for conditions with bounded deadlines; a fixed sleep is a latent flake. Tests are independent and atomic: each sets up its own state and asserts one behavior.

**Contracts, performance, accessibility.** Contract tests cover shape, status, error bodies, and authentication, on both sides of the boundary. Performance claims need a baseline and a gate on the measured number. Accessibility is a requirement: assert keyboard operation, accessible names and roles, and contrast, and record what must stay manual.

**Non-deterministic behavior.** Behavior that is itself non-deterministic (a model call, randomness at the product boundary) is tested by invariants over a recorded fixture (tier S) or over repeated live samples (tier X when paid, tier H when local) with a stated pass rate; a sampled test that meets its stated rate is not a flake for G5.

**Tiers for non-functional and generated tests.** A performance test measures wall-clock time and so cannot be tier S: it is tier P (tier H when it needs a foreign runtime), compares against a recorded baseline with a stated tolerance, and runs at stage E or F unless its budget fits stage D. An accessibility assertion over rendered structure in-process is tier S; one that needs a real browser is tier H. A snapshot test is tier S and counts as structure-coupled (P4): each snapshot is reviewed as an assertion, and a change that updates one states why. Fuzzing and long property runs belong to stage F; a failing input they find is committed as a tier S regression test.

## 13. Adopting this strategy in a repository

A repository adopts this strategy by committing one **IMPLEMENTATION** document that, at minimum, defines:

1. **Tier mapping:** the concrete mechanism for each tier (file convention, directories, runner configuration, build targets), the numeric budgets, and the single source of truth for tier membership.
2. **Stage mapping:** the concrete hook, CI job, or schedule for stages A–H; selection method (affected set, tags); caching and parallelism per tier.
3. **Gate mapping:** for each G1–G12, the tool or script that enforces it, its threshold, and its owner. A gate with no mechanism is listed as an *obligation, not yet a gate*, with a dated plan, not omitted; it does not count toward a conformance level.
4. **Decision-tree bindings:** worked examples from this repository for each branch of §6.2, and the header format for the fidelity-gap statement.
5. **Retention bindings:** how §8 triggers are detected (reports, scans), where the exception log and the escape records live.
6. **Metrics bindings:** where each §11 metric is produced and viewed.
7. **Risk map:** the repository-specific failure modes, ranked, with the tier that covers each.
8. **Migration plan:** how existing tests are classified into tiers, which are lowered, which removed, and what is quarantined, with owners and dates; or a statement that migration is left to the adopted system, with the filed items that track it, their owner, and a review date.
9. **Class and rigor bindings:** the escalation triggers (§6.6) with how each is detected; the default change class for each of the tracker's item types (the types are the repository's; this strategy assumes none); where the rigor record lives; the observed distribution of derived rigor (§6.6); and, per class and rigor level, whether authorship is separated (§14).
10. **Delivery to roles:** how each role in §13.1 receives its slice of this strategy (§13.2).

**Conformance levels** (an IMPLEMENTATION states its level):

- **L1 Foundation:** required tests pass (G1); tiers declared and mechanically assigned (G2); no silent skips (G4); stage mapping implemented for at least stages B, D, and E; quarantine and no unrecorded retry (§9, the retry half of G5); defect fixes carry regression tests (G6); the artifact check where an artifact ships (G10); every change carries a planning record (G12, §6.6); each role's slice (§13.2) exists.
- **L2 Enforced:** tier ceilings checked mechanically (G3); fidelity-gap statements (G9); time budgets (G7); the flake budget (G5); strategy conformance (G11); every stage mapped; retention reports generated.
- **L3 Measured:** changed-code mutation analysis (G8); escape and selection-escape metrics; signal precision; per-test kill-set uniqueness for retention.

The IMPLEMENTATION and the repository's enforcing mechanisms are the evidence of conformance. This document is not evidence of anything.

### 13.1 Roles

A role is an obligation, not an identity. A repository binds each role to whoever holds it (a person, an agent, a script) in its own configuration; neither this document nor an IMPLEMENTATION names the holder.

| Role | Obligation |
|---|---|
| Risk owner | Accepts "not testing" lists and exceptions (§6.1.3, §10) |
| Classifier | Records the class on every work item (§6.1.1); applies the triggers (§6.6) |
| Planner | Decides interfaces and contracts at boundaries (P7) |
| Test author | Produces the risk map, the tier per failure mode, the test plan, and the tests themselves (§6.1.2–8, §14) |
| Implementer | Produces the behavior the tests describe; does not alter tests it did not author (§14) |
| Static reviewer | Judges tier and gap validity, teeth, and structure coupling (G9, R3, R4) |
| Auditor | Runs plan-scope tests, applies the retention questions, judges removals and lowerings (§8) |
| Triager | Finds root cause and the earliest tier that could have caught a defect (§8.5) |
| Verifier and release owner | Runs the repository's gate set and releases (§7, G1–G12) |
| Record-keeper | Holds items, evidence, and the exception log |
| Strategy owner | Owns the IMPLEMENTATION and its conformance (§13) |
| Mechanism owner | Owns hooks, pipelines, checkers, runner configuration, and budgets |
| Coordinator | Sequences the parties of a work unit, commits and verifies the stub commit, joins parallel work, and runs the gate set before merge (§14, §13.2) |

A **party** is one working session with its own context: two sessions of the same agent are two parties, and one session is one party however many roles it plays. A role MAY be held by one party if no rule in this strategy forbids it. The rule that does forbid it: the party that authored a test MUST NOT be the one that approves it (§14); the Test author and the Auditor and Static reviewer are therefore never the same party for the same test.

**Who holds a role.** A repository states, for each role, its obligations, the tools it needs, and the independence constraints that apply (§14). The holder is the **closest available party**: among the parties present that can use those tools and break no independence rule, the one covering the most of the role's obligations (ties go to the party holding the fewest other roles in the same change), and the choice is recorded with the evidence for it. **When no party is eligible,** the role is **unbound**: the work proceeds, the clauses that role would have applied are recorded as **review debt** on the affected tests (the same mechanism as work with no coordinator, §13.2), the mechanical checks apply unchanged, and the conformance report lists the unbound role and the clauses left to debt. Each debt entry has an owner (the risk owner by default) and an expiry (default 14 days), is cleared when a party eligible for the role records the review, and fails the build past its expiry (G4). **What may be review debt:** the clauses of an unbound role, the independent approval at Standard (§6.6), and the review-class gates G6, G9 (validity), and G11. It is permitted only at Light and Standard rigor; at Deep an unbound Test author, Auditor, or Static reviewer blocks the change, because Deep requires separated authorship and independent approval (§6.6). Expiry fails the change that carries the debt and the next change that touches the same tests, never an unrelated merge. Independence by session shares a model's blind spots; where a different model or a person is available, the IMPLEMENTATION SHOULD require one for Deep approval. An unbound role never silently disappears from the report.

**Role-to-clause index.** The clauses a role applies, so that no repository derives its own:

| Role | Clauses |
|---|---|
| Risk owner | §6.1.3, §6.6, §10 (exception log), §13.1 (review debt) |
| Classifier | §6.1.1, §6.6, §6.7 |
| Planner | P7, §6.2 (contract), §14 (interface stubs) |
| Test author | §6.1.2–8, §6.2, §6.4, §6.5, §14 |
| Implementer | §6.7 (Light), §14 |
| Static reviewer | §6.2 (gap statement), §6.5, R3, R4, G9, G12 |
| Auditor | §8, §13.1, §14 (disputes, confirmation) |
| Triager | §8.5 |
| Verifier and release owner | §6.7 (gates no class relaxes), §7, §10 |
| Record-keeper | §6.6 (record), §8.4, §10 (exception log), §13.1 (debt) |
| Strategy owner | §13 |
| Mechanism owner | §10, §12, §13 items 1–3 |
| Coordinator | §14 (stub commit, join), §13.2 |

### 13.2 Delivery: no role reads this document whole

This document is the source of truth, not a reading assignment. A role applies a **slice**: the clauses for its obligations, compressed to what it must decide, with the repository's concrete bindings (from the IMPLEMENTATION) attached. A repository MUST deliver the slice at the moment the role acts: inside the instruction or brief that asks for the work, or as a tool the role invokes, or as a check that refuses the work. It MUST NOT rely on a role choosing to look the strategy up.

Order of preference, cheapest first: a mechanical check that refuses a violating change; a field the role fills in; a slice carried in the brief; a judgment step by a role that was given the relevant slice. A clause that a mechanical check can carry MUST NOT be carried by a judgment step. A clause delivered by none of these is not enforced, whatever this document says.

Work that has no coordinator (a person directing one worker with no orchestration) is covered by the same rule: the repository's top-level instruction file carries a short pointer that names the class list, the rigor record, and where the slices are; the mechanical checks apply unchanged. What such work lacks is the review-class checks that need a second party (§14), and a Deep change in it is refused or escalated to the owner, because Deep requires separated authorship; the IMPLEMENTATION states how that debt is recorded and who clears it.

## 14. Test authorship by AI agents

Marginal authoring cost near zero removes the natural brake on test volume without removing the cost of running or maintaining each test (P5). Therefore, when tests are authored or modified by automated agents:

- The author MUST state the failure mode each test guards and its tier; for tiers P, H, X, the fidelity-gap statement (G9).
- The default tier for any new test is S. A higher tier needs a valid gap statement.
- An agent MUST NOT approve tests it wrote; a reviewer outside the authoring agent applies §8.1 (G6, G11). Edits and removals made by the auditor are confirmed by a different party (§8.4), and at Deep rigor the approver receives the specification and the tests, not the implementer's reasoning, so that approval is not a restatement of the code's author.
- **Authorship MAY be separated from implementation.** A test author derives the tests from the specification (acceptance criteria, interfaces, contracts), not from the implementation, and records the failing run (command, exit status, and the failing assertion) against the work unit's base commit, which is the first half of the teeth proof (§6.5). Authoring MAY run concurrently with the implementation when the specification fixes the interfaces, with disjoint write scopes. Where the interfaces do not yet exist in code, the planner specifies compiling interface stubs that fail loudly (for example by throwing "not implemented"), and the coordinator commits them to the work unit's branch **before either party starts** and a mechanical check (not a party's attestation) MUST verify that the stub commit exists, compiles, and touches only the declared stub files before either party starts. Without a coordinator a single worker is one party, so separated authorship is impossible: Standard work records its authorship as review debt (§13.1) and Deep work does not proceed (§13.2); the red run is taken against that commit, and a failure from a missing symbol or a compile error is not red evidence. From the moment both parties start the stubs belong to the implementer, and the test author never edits them; if the interfaces change afterwards the work unit restarts from a new stub commit rather than being patched. When the specification does not fix the interfaces, the tests are written first. Separation is REQUIRED at Deep (§6.6) and the default at Standard, where the IMPLEMENTATION states the mode per class; below Deep the implementer MAY author, including at Light rigor and for characterization tests written after the fact. The reason is that tests written by the party that wrote the code tend to confirm what the code does rather than what was asked.
- **The implementer MUST NOT edit, skip, delete, or loosen a test it did not author** to make it pass, except the mechanical, behavior-neutral edits that §6.7 permits for a refactor, which are listed in the change and confirmed by the reviewer. If it believes a test is wrong, it reports the dispute with evidence to the auditor (a party that is neither the implementer nor the test author), who decides once and records the outcome where the risk owner can see it; the test changes only through that path. A rejected dispute that the implementer still contests goes to the risk owner as an exception request, never back to the author.
- **A test author MUST NOT edit production code**, and the write scope of each party is declared up front, by file or glob pattern, so a check can verify it from the change itself. Test support code (fakes, fixtures, builders) belongs to the test author even where it lives beside production code.
- **A batch is a unit of planning, not of execution.** One test author MAY plan the tests for a group of related work items together (to share fixtures, find duplicates, and see the whole risk map), but authoring is divided into independently verifiable units, each with its own failing-then-passing evidence. A single unit of authoring that grows without bound is a defect in the work breakdown.
- An agent adding tests MUST also report tests made obsolete or lowered (§8.6).
- Moving tests to a different tier or stage to make a local check faster, leaving a placeholder (`todo`, empty stub, skipped block) behind, is prohibited (P10, §8.3.5). The move and the behavior-preserving lowering are separate steps, and the first never substitutes for the second.
- Evidence for any claim of passing, counts, or coverage MUST come from a run the agent produced, with the command and exit status; counts are never estimated.

## 15. Sources

All retrieved 2026-10-07; living documents are labeled by retrieval date.

| ID | Source | URL |
|---|---|---|
| S1 | *Software Engineering at Google*, ch. 11 "Testing Overview" (test size vs. scope; small/medium/large constraints; Beyoncé Rule; coverage note) | https://abseil.io/resources/swe-book/html/ch11.html |
| S2 | *Software Engineering at Google*, ch. 12 "Unit Testing" (brittle tests, unchanging tests, no logic in tests, DAMP, clear failures) | https://abseil.io/resources/swe-book/html/ch12.html |
| S3 | *Software Engineering at Google*, ch. 14 "Larger Testing" (fidelity, hermeticity) | https://abseil.io/resources/swe-book/html/ch14.html |
| S4 | *Software Engineering at Google*, ch. 23 "Continuous Integration" (fast feedback, cost of late defects, which tests when) | https://abseil.io/resources/swe-book/html/ch23.html |
| S5 | Mike Wacker, "Just Say No to More End-to-End Tests", Google Testing Blog, 2015 | https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html |
| S6 | Ham Vocke, "The Practical Test Pyramid" (duplication rules; push tests down) | https://martinfowler.com/articles/practical-test-pyramid.html |
| S7 | Martin Fowler, "Test Pyramid" (ice-cream cone) | https://martinfowler.com/bliki/TestPyramid.html |
| S8 | Martin Fowler, "Eradicating Non-Determinism in Tests" (quarantine) | https://martinfowler.com/articles/nonDeterminism.html |
| S9 | Martin Fowler, "Test Coverage" | https://martinfowler.com/bliki/TestCoverage.html |
| S10 | Kent Beck, "Test Desiderata" | https://testdesiderata.com/ |
| S11 | "Flaky Tests at Google and How We Mitigate Them", Google Testing Blog, 2016 | https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html |
| S12 | "Where do our Flaky Tests Come From?", Google Testing Blog, 2017 | https://testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html |
| S13 | Spotify Engineering, "Testing of Microservices" (honeycomb; integrated tests) | https://engineering.atspotify.com/2018/01/testing-of-microservices |
| S14 | Pact documentation, "What is contract testing?" | https://docs.pact.io/ |
| S15 | Petrović and Ivanković, "State of Mutation Testing at Google" (ICSE-SEIP 2018; diff-based mutation) | https://research.google/pubs/state-of-mutation-testing-at-google/ |
| S16 | StrykerJS documentation, mutant states and metrics (killed / survived / no coverage) | https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/ |
| S17 | DORA, "Test automation" capability | https://dora.dev/capabilities/test-automation/ |
| S18 | DORA, "Continuous integration" capability | https://dora.dev/capabilities/continuous-integration/ |
| S19 | Kent C. Dodds, "The Testing Trophy and Testing Classifications" (quotes the aim of tests that "only fail for useful reasons") | https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications |
| S20 | Nx documentation, "Automatically Split Slow Tasks by File (Atomizer)" (nightly deferral raises merge risk) — vendor documentation | https://nx.dev/ci/features/split-e2e-tasks |
| S21 | fast-check documentation, property-based testing | https://fast-check.dev/docs/introduction/ |
| S22 | Martin Fowler, "Mocks Aren't Stubs" (classical vs. mockist) | https://martinfowler.com/articles/mocksArentStubs.html |
| S23 | "The Rise of Test Impact Analysis" (selection by tags, dependency graphs, impact analysis) | https://martinfowler.com/articles/rise-test-impact-analysis.html |

## 16. Provenance

- **0.4 (2026-10-07), APPROVED by the owner.** Revised after three blind reviews. Changes against 0.2: decision tree on the highest required tier; trigger table; gate G12; review debt bounded and defined in one place; work-unit vocabulary and the coordinator role; red evidence against stubs; auditor-decided disputes; stage placement defined by the table; cache rules; non-deterministic behavior; artifact checks as tier P; explicit rules for the no-coordinator and Deep cases.
- **0.2 (2026-10-07), APPROVED by the owner.** Added change classes, rigor levels and the rigor record, applicability by class, escape rate by rigor, roles and delivery, separated authorship, demand-driven stage F, and the closest-available-holder rule with review debt.
- **0.1 (2026-10-07), DRAFT.** Initial portable strategy, produced from the sources above to separate principles and workflows (this document) from repository mapping (an IMPLEMENTATION per repository). Motivating observation: suites grow by moving behavior into slow lanes and leaving placeholders behind, so retention (§8), reachability (G2), and tier conformance (G3) are first-class rules rather than hygiene. Tier names and default numeric budgets other than the tier S figure [S5] are design decisions of this strategy, argued in §2.
