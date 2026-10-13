# STRATEGY_MAP — who does what, in which layer, for every clause of the testing strategy

- **Version:** 0.9 (APPROVED by the owner 2026-10-07, including D22–D24 and D26, which the author had decided on the owner's instruction; no fourth blind review was run; see §9)
- **Maps:** `docs/testing/STRATEGY.md` v0.4 (approved by the owner 2026-10-07). Every principle (P1–P14), procedure (§6), tier, stage (A–H), retention rule (R1–R6, §8), gate (G1–G12), role (§13.1), and metric is placed in a row below.
- **Does not do:** change any agent, skill, hook, or checker. It is the plan those changes are cut from and the evidence base for the IMPLEMENTATION draft.
- **Revisions read:** adhd `b76b4bed` (tree and counts) and `14b06b44` (pre-push hook); sox-ecosystem `27be064c` (dispatcher **2.0.0**, the delivery lifecycle). The dispatcher, `dispatch-contract`, `dispatch-direct`, `dispatch-plan`, and `dispatch-triage` files cited here are byte-identical at sox-ecosystem `fbba2f88` (`git diff --stat 27be064c..fbba2f88` over those paths is empty; checked 2026-10-07).
- **Citations:** `dispatcher.md:N` is `sox-ecosystem/extensions/agents/dispatcher/dispatcher.md` at `27be064c`; `contract:N` is `extensions/skills/dispatch-contract/SKILL.md`; `direct:N` is `extensions/skills/dispatch-direct/SKILL.md`; `plan:N` is `extensions/skills/dispatch-plan/SKILL.md`; `triage:N` is `extensions/skills/dispatch-triage/SKILL.md`. A claim marked *(unverified)* was not confirmed by reading the artifact.

## 1. The two layers and their systems

**HARNESS** is portable across every repository. It owns *routing, briefing, and judgment*: the sox-ecosystem extension set plus the host that runs it. **PROJECT** is one repository. It owns *facts, commands, thresholds, and mechanical enforcement*. Every actor passes through it: any agent host, a human, CI.

### 1.1 HARNESS systems

| Code | System | What it is | Where it lives |
|---|---|---|---|
| **HR-host** | Host runtime | Agent tool set, models, permissions, task tools, hooks. Claude-specific and machine-local. | `~/.claude/settings.json:50-93` (hooks are `swarm-cost` caps and GitNexus enrichment) |
| **HR-orch** | Orchestrator | `dispatcher` with its delivery lifecycle (Step 5) and the playbooks `dispatch-direct`, `dispatch-triage`, `dispatch-plan`, `dispatch-priority`, `backlog-intake`, `definition-of-ready`, `dispatch-contract` | `extensions/agents/dispatcher/dispatcher.md`; `extensions/skills/*/SKILL.md` |
| **HR-spec** | Specialist agents | `product`, `architect`, `architect-decision`, `debug`, `typescript` (implementer), `qa`, `review`, `backlog-operator`, `git-manager`, `devops`, `performance`, `security`, `researcher`, `agent-manager`, `doc-*` | `extensions/agents/<name>/<name>.md` |
| **HR-skill** | Shared procedure skills | `project` (capability binding) today; the new `workspace-standards` skill (§1E), with `testing` as its first standard | `extensions/skills/` |
| **HR-doc** | Portable policy | `STRATEGY.md` | `docs/testing/STRATEGY.md` (to be homed in the harness repo, decision D3) |

### 1.2 PROJECT systems

| Code | System | What it is | Where it lives (this repo) |
|---|---|---|---|
| **PJ-doc** | Instruction file and capability binding | `AGENTS.md` with a `## Capabilities` table | `AGENTS.md`: **no `## Capabilities` section** (`rg "^## .*Capabilit" AGENTS.md` matches nothing) |
| **PJ-impl** | IMPLEMENTATION | The per-repo mapping of STRATEGY: tier mechanism, budgets, stage and gate bindings, risk map, exception log | `docs/standards/testing.md` (one file per standard under `docs/standards/`, generated as a template by `apply testing`), not yet drafted |
| **PJ-run** | Runner and task graph | Test runner config, build-graph targets, caching, file→lane convention | `nx.json` `targetDefaults`; per-project `vite.config.ts`; `tools/vite-plugins/e2e-globs.mjs` |
| **PJ-chk** | Checkers and scanners | Scripts that fail a build when a rule is broken | `tools/gate/lane-gate.mjs`; `tools/nx-plugins/test/executors/wiring/check-lane-reachability.mjs`, `check-agent-lane-spawn.mjs`, `check-test-wiring.mjs` |
| **PJ-hook** | Git hooks | Pre-commit and pre-push | `.githooks/pre-commit`, `.githooks/pre-push:1-12` |
| **PJ-ci** | CI workflows | Mainline and PR pipelines | `.github/workflows/ci.yml`, `pull-request.yml`; `docs/PIPELINE.md` §2 |
| **PJ-bl** | Backlog store | Items, claims, transitions, **obligations and attestations** | `entrypoint/backlog`; usage `entrypoint/backlog/skill/SKILL.md` |
| **PJ-rep** | Report outputs | Generated run, flake, shape, and retention reports | not present |
| **PJ-skill** | Repo-local skills and workflows | `.claude/skills`, `.claude/workflows` | present; none about testing |

### 1.3 Placement rules (how every row below was decided)

- **L1 — Mechanical enforcement lives in PROJECT.** A rule only a Claude hook enforces is skipped by Codex, opencode, a human, and CI. `HR-host` hooks are machine-local and cannot carry a portable rule.
- **L2 — Judgment lives in HARNESS.** Whether a fidelity-gap statement is valid, whether a test is redundant, and which tier a failure belongs to are decisions, not checks. They belong to specialist agents, bound to PROJECT facts through the IMPLEMENTATION.
- **L3 — HARNESS text names capabilities, never tools or commands.** `dispatcher.md:95,473` already say "the project's full gates"; the `project` skill defines the binding seam (`extensions/skills/project/SKILL.md:8-17`). PROJECT supplies the commands.
- **L4 — Policy in STRATEGY, numbers and commands in IMPLEMENTATION.** A test policy stated inside a HARNESS skill is a defect (finding F15).
- **L5 — A rule enforced only by wording is review-class, not mechanical** (class **T** below).

### 1.4 Enforcement classes

| Class | Meaning |
|---|---|
| **M** | Mechanical: a script, runner, hook, CI job, or the backlog gate refuses the change |
| **MR** | Mechanical presence, reviewed validity: a tool checks the field exists; an agent or person judges it |
| **R** | Review: an actor other than the author applies the rule and records the result |
| **J** | Judgment, unenforced: the rule rests on an agent following its brief |
| **T** | Text-pinned: a test pins the *wording* of an agent spec, not any run's behavior |

Status marks: ✔ implemented · ◐ partial · ✖ absent.

## 1A. Operating model — the performant mapping

STRATEGY and IMPLEMENTATION speak in **roles** and never name an agent; this map is the only place a role is bound to an agent. A repository's testing success therefore stands on the strategy, the mechanisms, and the conformance check, not on any agent's name.

### 1A.1 Roles and their binding (sox-ecosystem agents assumed available: the 21 in `extensions/agents`, plus the two proposed in §1A.8)

The roles are the thirteen in STRATEGY §13.1 plus one harness-only role. Neither STRATEGY nor IMPLEMENTATION names a holder.

| Role (STRATEGY §13.1) | Obligation | Bound to | Gap |
|---|---|---|---|
| Risk owner | accepts "not testing" lists and exceptions | `product`; the human owner for exceptions | — |
| Classifier | records the change class; applies the escalation triggers (§6.6) | `product` while grouping tickets (a by-product of work it already does); `backlog-operator` refuses an unclassified filing; the working agent for unmediated work | the class field does not exist (F6) |
| Planner | interfaces and contracts at boundaries (P7) | `architect` for specced work | spec has no contract section keyed to boundaries (`architect.md:342-360`) |
| **Test author** | risk map, tier per failure mode, test plan, the tests; plans a bucket as a batch, authors per unit (STRATEGY §14) | **new agent `test-author`**, which replaces the undefined `test` routing row (`dispatcher.md:430`); `performance` and `security` author their tagged tests | no such agent exists (F1); briefs assume the implementer writes tests (F18) |
| Implementer | the behavior the tests describe; never edits a test it did not author | any specialist agent the routing table maps the task to (for example `typescript` or `ui`); a role, not one agent | `typescript`'s description is type-system-narrow; it demands a workload-wide coverage target (F3) |
| Static reviewer | tier and gap validity, teeth, structure coupling (G9, R3, R4) | **new `review`** (read-only; static and blind modes chosen by the brief) | no such agent exists |
| Auditor | plan-scope run, triage, simple fixes, reopen, retention audit (§8); never audits tests it authored | `qa` | audit has no criteria (F16) |
| Triager | root cause, earliest catching tier, escape record (§8.5) | `debug` | no escape field |
| Verifier and release owner | runs the project's gate set, releases | `dispatcher` | gate set unbound (F4) |
| Record-keeper | items, evidence, exception log | `backlog-operator` and the backlog store | the testing record is a convention in the item body (F6) |
| Strategy owner | IMPLEMENTATION, conformance, adoption in a new repo | `qa` (playbooks `adopt`, `conformance`) | persona blocks it (F2) |
| Mechanism owner | hooks, CI, checkers, runner, budgets, stage F | `devops` | no stage F |
| Coordinator | sequences the parties of a work unit, commits and verifies the stub commit, joins parallel work (§14) | `dispatcher` (swimlane steps 5a and 9) | — |
| (harness only) Conflict resolver | merge and rebase conflicts | `git-manager` | — |

### 1A.2 Carriers, ranked by cost to the agent

| Carrier | What it is | Agent tokens | Used for |
|---|---|---|---|
| **C0 mechanical** | checker, hook, CI job, runner config, backlog gate | 0 | G1–G5, G7, G10, tier map, skip expiry, AC-citation scan, header lint, reports, conformance |
| **C1 template field** | a field in the ticket, brief, return block, test header, audit record | ≈0 (fill-in) | change class, rigor record, risk map, "not testing", tier, gap statement, `tests-obsoleted`, `test-authorship`, `test-dispute`, AC ids |
| **C2 role card** | a ≤4 KB slice of the strategy for one role, inlined in the brief | ≈1k per use | the decision trees and retention questions a role applies |
| **C3 judgment dispatch** | an LLM step that decides | full | the judgment points in §1A.3 only |
| **C4 human** | an owner decision | — | exceptions, X-tier authorization, tier policy |

A clause is carried by the cheapest carrier that can carry it; judgment clauses (P3, P4, R2–R4, §6.1.2–3, §8.3–8.4) cannot go below C2.

### 1A.3 The judgment points, and what they add to the dispatch count

| # | Judgment | Role | Dispatch it joins | New dispatches per change |
|---|---|---|---|---|
| J0 | classify the change; apply triggers | Classifier | product's grouping, backlog filing, or the dispatcher's intake | 0 (a field filled by an actor already working) |
| J1 | risk map, tier per failure mode, test plan, tests | Test author | **new**: one planning dispatch per bucket, then one authoring dispatch per unit (§1B.3) | **≈1 per bucket + N per unit (estimate, unmeasured)** at Standard or Deep; **0 at Light** (the implementer fills the one-line plan from the card) and at None |
| J2 | tier and gap validity, teeth, structure coupling | Static reviewer | static review, Step 5.4 | 0 |
| J3 | retention audit with R1–R6; independence check on authorship | Auditor | QA stage, Step 5.6 | 0 |
| J4 | escape analysis | Triager | triage dispatch (`dispatch-triage`) | 0 |
| J5 | adoption and conformance | Strategy owner | once per repo, then at stages E and F | 0 per change |

Everything else on the per-change path is C0 or C1. With the implementer writing its own tests (Light and None), the strategy adds no dispatch. With separated authorship (Standard and Deep), J1 adds a planning dispatch per bucket and moves test authoring out of the implementer's dispatch into per-unit dispatches. The implementer's dispatch shrinks by the tests it no longer writes, so total tokens may move less than the dispatch count suggests; that is an estimate until task T24 measures it from the dispatcher's telemetry rows.

### 1A.4 Delivery: one source, inline carrier

- **Source of truth:** one `workspace-standards` skill (§1E). Its `testing` standard holds role slices (classifier, implementer-at-Light, static reviewer, auditor, triager), the Test-author cards (§1B.2), and playbooks for the three verbs `run`, `apply`, `review`, plus `retention-audit` and `flake-triage`. Not preloaded into any agent body.
- **Carrier:** the dispatcher inlines the role's card, plus the project's tier-mapping excerpt, into the brief of every dispatch that plans, writes, reviews, or audits tests. The contract already requires inlining over referencing: "Never reference a file for the executor to open when it can be inlined" (`contract:126`; `:21`). Delivery is therefore deterministic and costs no skill call, and nothing depends on an agent choosing to load a skill.
- **Where the card's content comes from:** the card cites STRATEGY clause ids; the project excerpt comes from IMPLEMENTATION through the `test-gates` capability.

### 1A.5 One producer, many consumers: the gate runner

The gate runner is one command that knows the registered gates and applies them correctly for the context it is given: the lifecycle step, the change class and rigor, and the changed paths. It selects the gates that have something to check (no gate is relaxed by class, STRATEGY §6.7), runs them, and writes one structured report. It does not release anything; release remains the dispatcher's Step 7. A named gate set (the testing standard's is `test-gates`) is what it runs. The report holds: per-tier pass and fail, per-test duration, skip and `todo` counts and ages, quarantine, header-lint results, and repeat-run flake data when asked. Its consumers:

| Consumer | Reads the report for |
|---|---|
| dispatcher, Step 5.8 | green or red, raw exit codes (G1) |
| `qa`, Step 5.6 | triage of failures; no second full run, only reruns of failing or suspect tests |
| CI, stages D–F | required checks; retention and shape reports |
| conformance checker | whether each gate produced output |
| status table | a measured "test health" row |

It gives every metric in STRATEGY §11 one source. It removes QA's duplicate suite run only if the report-producing run happens before QA (Step 5.6); today the dispatcher's final run (Step 5.8) comes after, so T16 either moves the report-producing run before QA, in which case QA reads the report and reruns only failing tests, or keeps both runs and says so (`dispatcher.md:471,473`).

### 1A.6 Confirming a repository's workflow covers the strategy

The IMPLEMENTATION carries a **binding table**: one row per STRATEGY clause id (P1–P14, §6 steps, tiers, stages A–H, R1–R6, G1–G12, metrics), each with mechanism class (C0–C4), command or path, owning role, and status (enforced, partial, or not-yet with a dated plan). A `strategy-conformance` checker (itself a C0 mechanism) verifies the table instead of trusting it:

1. **Completeness:** every clause id in `STRATEGY.md` has exactly one row. (This session's coverage script is the prototype: it extracted ids from the strategy and diffed them.)
2. **Liveness:** every referenced path and command exists and runs.
3. **Reachability:** the stage a gate is bound to actually invokes it (as `check-lane-reachability.mjs` does for lanes).
4. **Teeth:** every C0 gate has a seeded-violation fixture it must fail on (STRATEGY §6.5 applied to the gates themselves).
5. **Level:** the checker reports L1, L2, or L3 from the rows that passed.

It runs at stage E on every mainline push and whenever a stage F review item is worked, and it is what `/workspace-standards review testing` runs (§1E.1). A table row that claims "enforced" with no passing check is a conformance failure.

**Home of the checker and the gate runner.** Both are one harness-owned engine that reads a repository-supplied command table (gate id, command, stage, mechanism class). The engine carries no build-tool knowledge; a repository binds its own commands in the table (adhd binds Nx targets), so the same engine runs in a repository without Nx. The engine is generic (completeness, liveness, reachability, teeth, level) and a standard adds only its own checks. This keeps mechanical enforcement in the project's table (placement rule L1) while the engine is written once.

### 1A.7 Cost comparison of the candidate architectures

Basis: `STRATEGY.md` v0.4 is 68,403 bytes (`wc -c`); at about 4 bytes per token that is roughly 17,100 tokens (an estimate, not a tokenizer count); re-measure with `wc -c` whenever this table is used. The card figure excludes the tier-mapping excerpt and the routing object that ride in the same brief, so the per-dispatch cost is higher than the card alone and is unmeasured. The card budget is a design target (≤4 KB ≈ 1,000 tokens), not yet measured. There are 21 agent extensions.

| Architecture | Tokens added per test-touching dispatch | New dispatches per change | Drift risk | Delivery reliability | Covers judgment clauses |
|---|---|---|---|---|---|
| A. Strategy copied into each agent body | ≈17,100 (all 21 agents pay, even those that never touch tests) | 0 | 21 copies | high | yes |
| B. One skill each agent loads on demand | ≈17,100 if whole, plus a tool round trip | 0 | none | low: depends on agent initiative | yes |
| **C. Role cards inlined by the brief, templates, one gate runner, one routing command (recommended)** | ≈1,000 for test author, implementer (at Light), reviewer, auditor; 0 for others | 0 at Light and None; ≈1 per bucket plus N per unit at Standard and Deep (estimate, unmeasured) | none | high: brief carries it | yes |
| D. Mechanical checks only | 0 | 0 | none | high | **no**: cannot judge tier validity, redundancy, or risk |

C is the fastest design that accomplishes all tasks: it matches D's cost on every mechanical clause and spends tokens only where judgment is unavoidable.

### 1A.8 Suggested agent and skill changes

| Change | Kind | Why |
|---|---|---|
| Add `review` (read-only; static mode and blind mode chosen by the brief) | **new agent** | The lifecycle's Steps 5.4 and 5.9 route to it and no agent exists (F1). One agent, two modes: both read a diff and differ only in the context the brief carries. |
| Do not broaden `typescript`. Implementer is a role: the routing table in `AGENTS.md` maps each implementation or refactor task to the closest specialist (for example `typescript` or `ui`), and the unbacked `backend` and `refactor` routing rows are dropped. Replace `typescript`'s coverage target with a change-scoped efficacy standard: every behavior a change adds or alters has a test that fails when that behavior is deliberately broken (shown by a seeded fault or a diff-based mutation run), and the changed lines left uncovered or surviving are reported per change. The measure is taken on the diff, never as a percentage of the whole repository, so it neither depends on nor rewards the size of the existing workload | **routing change + description change** | Replaces the unbacked `backend` and `refactor` rows with the role-to-specialist mapping; resolves F3 with a measurable standard bounded to the change (STRATEGY P11, G8). |
| Keep `qa` as one agent; move adoption, conformance, retention audit, and flake triage into the `workspace-standards` skill's `testing` standard (verbs `apply`, `review`, and the two playbooks) | **no split** | Plan-scope QA is frequent and cheap; strategy-level work is rare and is loaded only when dispatched. The brief sets the model tier. |
| Add a roster guard: every name in the dispatcher's routing rows must resolve to an installed agent or to the closest available agent for its role (§1E.4), or the role must be declared unbound | **mechanical check** | Fixes the known open item `3fe895f3` (`definition-of-ready/SKILL.md:145`) and prevents a repeat without failing a workspace that lacks some agents. |
| Add `test-author`: the Test author (§1B). The dispatcher's routing text names an undefined `test` agent (`dispatcher.md:430`); the routing edit (T12) replaces that row with `test-author`. The name is distinct from the repository's `test` lane and target so the name-independence check can read the agent list without a collision | **new agent** | Separated authorship (STRATEGY §14) needs a role that is neither the implementer nor the auditor. `qa` cannot hold it: it audits (Step 5.6) and a party may not approve tests it wrote. |
| Remove `general` from the dispatcher's routing text | **spec fix** | Not an agent; `dispatch-direct` already calls it a last resort (`direct:32`). |
| Dedupe `performance` and `performance-engineer` | **observed, out of scope** | Two near-identical extensions; file, do not fix here. |

## 1B. The Test author: one role, playbooks by class

**Why a role of its own.** STRATEGY §14 lets authorship be separated from implementation and forbids a party from approving tests it wrote. The auditor (`qa`) approves; the implementer (`typescript`) writes production code. A third role holds test planning and authoring, so that the people who judge tests, the people who write code, and the people who write tests are three different parties. The dispatcher's routing text names a `test` agent (`dispatcher.md:430`) that no extension defines (F1); the routing edit replaces that row with the new agent.

### 1B.1 The agent

- **Name and size:** `test-author`. The body holds the role's invariants only (write scope is tests; never production code; never approves; evidence is a run). Everything class-specific is in playbook cards (§1B.2); the agent body is not a copy of the strategy.
- **Tools:** read, search (`rg`, `gx`), shell for running tests, and write/edit restricted by the **write scope the brief declares** (`direct:26` already requires a declared write-scope per bucket). The brief states `model` and `tools` (global dispatch rule).
- **Input it receives:** the bucket's items (ticket text with AC ids and class), the architect's interface/contract notes, the output of the routing command (§1C.2: rigor, authorship, playbook), and the **one** playbook card for the work. It does not receive STRATEGY.
- **Output it returns:** per item, the rigor record, risk map (as the rigor demands), "not testing" list, tier per failure mode, the AC-to-test map, and for authoring units the committed tests plus `red:` evidence (command, non-zero exit, names of the failing tests).

### 1B.2 Playbooks (each a card of at most 4,096 bytes; the brief inlines only the one that applies)

| Playbook | Class and rigor it serves | Unit of work | Output |
|---|---|---|---|
| `plan-bucket` | any class at Standard or Deep; optional at Light | one bucket (at most 5 items per dispatch; larger buckets are split by cohesion) | per-item plan blocks; duplicate findings across the bucket; shared-fixture decisions |
| `author-new-behavior` | new behavior | one item or one cohesive module | failing tests (tier S default), headers, `red:` evidence, committed to the bucket branch |
| `author-regression` | defect fix | one defect | a test that fails against the pre-fix commit (command and exit recorded); the §8.5 record fields it owes |
| `author-contract` | boundary or contract change | one boundary | consumer-side and provider-side tests against the shared contract |
| `characterize` | refactor of thinly covered code; legacy | one module | tests that pin current behavior before the refactor begins |
| `select-checks` | configuration, dependency | one item | which artifact check and `smoke` or `contract` subset cover the change; adds a smoke test only if none does |
| `maintain` | test maintenance (lower, rewrite, remove, un-stub) | one retention ticket | the edit plus the parity proof (§8.3, §8.4); the auditor judges it |
| *(no playbook)* | no-code | none | the rigor record `None` is written by the classifier; no dispatch |

### 1B.3 Cost shape: batch the planning, fan out the authoring

AGENTS.md §13 measured that one continuous dispatch looping over many independent items re-reads its whole history every turn (399 calls and 155M tokens in one measured example). "One specialist writes the tests for a batch" must therefore not mean one long dispatch. The rule the playbooks carry:

- **Planning** a bucket (`plan-bucket`) is one dispatch. It is cheap because it reads ticket text and the interfaces, not a whole codebase.
- **Authoring** is one bounded dispatch per unit in the table above. Above five units in a bucket, the dispatcher fans out one authoring dispatch per unit in parallel (the `pipeline()` form named in AGENTS.md §13), not one loop.
- A dispatch that passes about 100 sequential tool calls with the same shape of work ahead stops and returns the remaining list to the dispatcher.
- The planning pass is where batching pays: shared fixtures are decided once, and duplicate failure modes across items are found before anything is written.

### 1B.4 Order of work inside a bucket: parallel by default (replaces "the implementer writes the tests")

1. **Fix the interfaces and commit stubs.** The architect's spec fixes the interfaces and contracts that the tests and the code both meet and includes the stub files as part of the spec (interfaces only, each body throws "not implemented"). The architect has edit access but no git commit permission and the bucket branch does not exist when the spec is written, so the stubs travel in the spec; once the bucket branch exists the dispatcher applies and commits them as the **stub commit** (swimlane step 5a) and verifies that it compiles and touches only stub files. The pair is dispatched only after that verification, so there is no moment at which the Test author and the implementer race the stubs (a missing or unverified stub commit is a refusal). If the spec does not fix the interfaces, the bucket runs in sequence instead: the Test author first, from the acceptance criteria, then the implementer (D20).
2. **Run concurrently.** The Test author (write scope: test paths) and the implementer (write scope: production paths) are dispatched together with disjoint declared write scopes (`direct:26`). The Test author records `red:` evidence against the **stub commit**: the command, the non-zero exit, and the failing assertion for each test. A failure from a missing symbol or a compile error is not red evidence (STRATEGY §6.5, §14). From the start of the concurrent run the stub files belong to the implementer, and the Test author never edits them; if the interfaces change afterwards the dispatcher restarts both parties from a new stub commit.
3. **The implementer's brief:** make the acceptance criteria true; write-scope is production paths only; do not edit, skip, or delete a test it did not author. It may run the author's tests as they land.
4. **Join.** When both return, the dispatcher verifies from the branch, not from the returns (`dispatcher.md:468`): each side's diff touches only its declared paths; it merges the two (disjoint, so no conflict) and runs the tests. Green: proceed. Red: classify. If the code is wrong the implementer gets one correction; if a test is wrong the dispute path applies.
5. **Dispute.** An implementer that believes a test is wrong returns a `test-dispute:` block (test id, evidence, proposed change) instead of editing. The dispatcher re-invokes the Test author by id with the text (`direct:34` allows follow-ups to a running or completed dispatch). The dispatcher routes the dispute to a fresh `qa` dispatch (the Auditor, a party that is neither the implementer nor the Test author), which decides once and records the outcome where the risk owner can see it; the Test author then applies a changed test. A rejected dispute that the implementer still contests goes to the risk owner as an exception request. A dispute is not a retry and does not consume the retry ladder (`direct:35`), and there is no second round (D21).
6. **Own the evidence.** Rule 15 (`dispatcher.md:188-190`) requires a test citing the item id, seen red then green. Red is the Test author's evidence (against the stub commit) and green is the join run's; both go in the item's record. Step 5.3 (`:468`) has the implementer verify every AC before the ff-merge; the dispatcher's join run is the proof it checks.
7. **At Light rigor and for refactors** none of this applies: the implementer writes the tests from the inline card, and the ownership rule in step 3 is the only one that survives (a refactor never edits a test).

Concurrency saves wall-clock time and costs a reconciliation risk: the two sides can disagree about an interface the spec left loose. The join and the dispute path are what bound that risk (decision D13).

What this changes in existing harness text (finding F18): rule 15, `contract:17` ("every test the executor writes cites…"), `contract:35` (the test standard rides "every brief that writes or changes tests"), and the Step 5.3 wording all assume the implementer writes the tests. Each needs the `test-authorship:` field and a clause for who owns red and who owns green (tasks T23, T15).

### 1B.5 Why a separate agent, not a `qa` playbook

A session may not approve what it authored (STRATEGY §13.1, §14), but a fresh `qa` dispatch is a different party from the session that authored the tests, so `qa` may audit tests that `test-author` wrote. Authoring tests inside `qa` would force two `qa` dispatches with a hand-off between them and blur the audit, so authorship stays with its own agent and its own process (decision D11, the owner's "separate test author with a clear process").

## 1C. Three ways work arrives: who does what, and how each actor knows

STRATEGY §13.2: no role reads the strategy whole; the slice arrives at the moment of work, as a check that refuses, a field to fill, or a slice in the brief.

### 1C.1 The three modes

| | **Plan** | **Dispatcher direction** | **Unmediated** |
|---|---|---|---|
| Entry | `dispatch-plan`: the user asked for a plan, or a plan item covers the area (`plan:14-17`) | `dispatch-direct`: explicit user direction to the dispatcher (`direct:3`), and fixes arriving from `dispatch-triage` (`triage:13-14`) | the user talks to a working agent; no dispatcher |
| Grouping | `product` groups open tickets into releasable buckets; `architect` specs each into consolidated executable items (`plan:30-34`) | the dispatcher groups into buckets by cohesion and write-scope (`direct:25`) | none; one branch |
| Lifecycle | the dispatcher's Step 5, then Step 7 (`plan:39-43`) | the same: `direct:36-37` | none |
| Classifier | `product`, as a by-product of grouping | the dispatcher at intake; `backlog-operator` refuses an unclassified filing | the working agent |
| Test planning and authoring | Test author, per bucket; implementer at Light | same | the working agent; the Test author when the host can dispatch one |
| Independent approval | static review (5.4), QA (5.6), one blind review (5.9) | the same | **none in the session** (see §1C.4) |
| Release | the dispatcher, Step 7 (rules 13, 18) | the same | the agent follows the release guide; a push needs human approval (AGENTS.md rules) |

Dispatcher direction already runs the full lifecycle (`direct:36`, hard rule `direct:45`), so QA and the dispatcher's own final run apply to it; only the first two steps differ from a plan.

### 1C.2 The routing command: how an actor learns what applies without reading the handbook

The repository binds a command to the capability `test-routing` (a row in the AGENTS.md capability table). Input: change class and the declared write-scope. Output (one JSON object): the derived **rigor**, the triggers hit (detected from path patterns in the IMPLEMENTATION), the **authorship** mode (separated or implementer), the **playbook** to use, and the gate subset. The derivation is code from the class, the triggers detected from path patterns, and the triggers the item's testing record asserts (an assertion can only raise rigor, never lower it), so an agent's opinion cannot lower the rigor of a change. The command also refuses an inconsistent class: `no-code` with a write scope that touches source or test paths, or `refactor` with a diff that adds behavior-bearing files.

| Who | When it runs the command | Result |
|---|---|---|
| dispatcher (plan and direction) | at bucket brief time, with the bucket's class and declared write-scope | fills `rigor`, `test-authorship`, `playbook` in every brief for the bucket |
| working agent (unmediated) | before it writes the first test | same object; it then reads the one playbook card the object names |
| checker (all modes) | in pre-push, CI, and the scheduled run | refuses a change whose recorded rigor is below the derived rigor (the check that makes a reduced path trustworthy) |

### 1C.3 Plan mode, with the new actions marked

```
 dispatcher: gather open tickets (backlog ready view) ───────────────────────────► existing
   │
   ▼
 product: group into releasable buckets
   [+] writes change-class on each ticket as it groups (by-product; 0 new dispatches)
   │
   ▼
 architect: spec each bucket into consolidated executable items
   [+] names interfaces and contracts at every boundary, and any escalation trigger it sees
   │
   ▼
 dispatcher: create plan branch from main; for each parallelizable bucket create plan-branch-bucket-N
   [+] runs `test-routing` per bucket (class + declared write-scope) → rigor, authorship, playbook
   │
   ├──────────────── per bucket, in parallel ────────────────┐
   ▼                                                          ▼
 bucket-1                                                 bucket-N
   │  authorship = specialist (Standard/Deep)?
   │   yes ─► [+] Test author `plan-bucket` (1 dispatch) → plans for all items
   │          then, in PARALLEL with the implementer (spec fixes the interfaces; disjoint write scopes):
   │          [+] Test author authoring units (1 each; fan out when > 5) → tests with `red:` evidence on the base commit
   │   no  ─► implementer writes tests from the inline card (Light)
   ▼
 implementer(s) (in parallel): make the AC true; production paths only; [+] test-dispute path if a test looks wrong
   ▼
 join [+]: dispatcher verifies each diff touches only its declared paths, merges the two, runs the tests (green at the join)
   ▼
 static review per bucket [~ checks tier, gap, teeth, coupling] → one correction per bucket
   ▼
 ◄──────────────────────── fan back in ─────────────────────────►
 QA on the plan branch [~ R1–R6; refuses to audit tests it authored] → reopen loop
   ▼
 dispatcher final run: `test-gates` on the plan branch [+ one report, raw exit codes]
   ▼
 one blind review → ff-only merge → Step 7 release → live confirmation → resolve
   ▼
 scheduled retention review (stage F) [+] keeps the suite honest between releases
```

### 1C.4 Unmediated mode: the hard case

There is no dispatcher, no static or blind review, and possibly no QA. The only carriers are: the repository's instruction file (AGENTS.md, which every host loads), the capability binding it contains, one playbook card the agent reads on demand, and the mechanical gates.

**What the working agent does** (a pull, where plan mode pushes through the brief): read the testing block in AGENTS.md (written by `/workspace-standards apply testing`, §1E; a few lines: the class list, "run `test-routing` before writing a test", "record the rigor line in the commit message", "never edit or skip a test you did not author"); run `test-routing`; read the single playbook card it names; write the tests; run `test-gates`. At Standard or Deep, invoke the Test author when the host can dispatch one. Otherwise at Standard write the tests by the card and return them in the final message as unreviewed, filed as one follow-up backlog item with an owner and an expiry for a later fresh `qa` dispatch to review; at Deep the agent stops and escalates to the owner, because separated authorship is required there and a single session cannot supply it.

**What this mode guarantees, all mechanical** (these are the only guarantees; none depends on the agent choosing to comply):

| Guarantee | Mechanism | Today |
|---|---|---|
| lint, secret scan, staged specs | pre-commit | ✔ (`docs/PIPELINE.md` §2) |
| affected unit tests before a push | pre-push (`.githooks/pre-push:6-10`; e2e excluded since `14b06b44`) | ✔ |
| rigor not below the derived rigor; rigor record present | checker over the commit or change description | ✖ (T43) |
| header present with tier and gap statement (G9) | header lint | ✖ (T34) |
| no silent skip or `todo` (G4) | scanner | ✖ (T32) |
| tier ceilings (G3) | generalized checker | ◐ agent family only |
| nobody edited a test after its red commit without the owner's trailer | test-ownership check | ✖ (T46) |
| `smoke` subset and the full gate set in CI | `test-gates` | ✖ (T30, T40) |
| CI mainline | `ci.yml` | ✔ |

**What this mode loses** (review-class clauses that need a second party): tier and gap validity (R3, G9 validity), structure coupling (R4), teeth judgment, the retention audit (R1–R6), and independent approval (§14). **What catches it later:** the filed follow-up item, which names the unreviewed tests, ages in the group's standing review item, and is cleared by a fresh `qa` dispatch with a recorded review (T45); CI; and the human who approves the push. The debt is therefore visible and bounded, not hidden.

### 1C.5 How each actor learns its part

| Actor | Carrier | Size (design budget, unmeasured) |
|---|---|---|
| `product` | brief template: "write `change-class` per ticket as you group" with the class list | a few lines |
| `architect` | brief template: contract and trigger notes; no test planning | a few lines |
| dispatcher | the capability bindings (`test-gates`, `test-routing`); never the handbook | 0 beyond the binding |
| Test author | the one playbook card, inlined | ≤ 4 KB |
| implementer | brief fields: `test-authorship`, test paths, "do not edit tests"; at Light, the author card | a few lines; ≤ 4 KB at Light |
| static reviewer | review card: tier, gap, teeth, coupling | ≤ 4 KB |
| Auditor | audit card: R1–R6, the independence check, the record format | ≤ 4 KB |
| working agent, unmediated | the AGENTS.md block, then one playbook card by pull | block of a few lines; ≤ 4 KB |
| everyone | the checks refuse a violation whether or not the actor knew the rule | 0 |

## 1D. Class applicability across the lifecycle

What each class does at each lifecycle step. Every row still passes the final run and the release gate (STRATEGY §6.7); the dispatcher's lifecycle steps are unconditional today, so skipping a dispatch for a class is itself a harness change (T16).

| Class (rigor) | Plan | Authoring | Implementer | Static review (5.4) | QA (5.6) | Final run (5.8) and release |
|---|---|---|---|---|---|---|
| New behavior (Standard) | `plan-bucket` | `author-new-behavior`, red first | makes green | tier, gap, teeth, coupling | R1–R6; independence | full gates |
| Defect fix (Standard) | `plan-bucket` for the escaped failure mode | `author-regression`, red on the pre-fix commit | fixes | same | same; §8.5 record present | full gates |
| Refactor (Light) | rigor record only | none (tests unchanged) or `characterize` first | refactors; may not edit any test | checks the diff has no test-file change | run; a forced test edit reclassifies it | full gates |
| Configuration (Light) | rigor record; `select-checks` | none unless behavior is observable | implementer, from the card | light | run | full gates; artifact check; `smoke` |
| Dependency (Light, or Standard on a shipped runtime path) | rigor record; `select-checks` | none unless a boundary changed | implementer | light | run | full gates; artifact check; `contract` subset |
| Boundary or contract (Deep) | `plan-bucket`; risk owner accepts the "not testing" list | `author-contract`, both sides, required | makes green | gap-statement review | audit plus changed-code efficacy (G8) | full gates; `contract` subset |
| No-code (None) | rigor record `None` | none | the document or investigation author | not dispatched | not dispatched | the existing checks for the output; the final run still runs |
| Test maintenance (Standard) | from the retention ticket | `maintain` | n/a | checks the parity record | judges; a different party than the editor confirms (D19) | full gates |

**Raised rigor.** A trigger can lift a class above its default (STRATEGY §6.6, §6.7). A refactor, configuration, or dependency change that hits a trigger gets the higher level's requirements on top of its row (a persistence trigger gives Deep, a process or network boundary Standard; the trigger table is STRATEGY §6.6): the risk map and "not testing" list at that depth, independent approval, and the authorship rule. Where the touched behavior has no covering test, the `characterize` playbook runs first. The routing command (§1C.2) returns the raised rigor, the playbook, and the authorship mode in one object.

The backlog's own item types are the repository's business: the IMPLEMENTATION maps each type to a default class, and the class recorded in the item's testing record can be overridden on a single item. Nothing in this table depends on an item type's name. The backlog's structure is used as it is: the class, rigor, and plan live in a testing-record section of the item body (§1F).

## 1E. The `workspace-standards` skill: one entry point for every standard

Testing is the first standard, not the only one. One skill audits, runs, and applies any workspace standard, so deployment, implementation, documentation, organization, and styling standards can follow the same process once their playbooks exist. Two concerns are not domain-specific and are separated from every standard: **routing** (which agent holds which role) and **gates** (which checks block which stage). A standard supplies its domain content to them; it does not re-implement them.

### 1E.1 Command

`/workspace-standards <review|run|apply> [<target>|all]`, where a target is a **foundation** (`routing`, `gates`) or a registered **standard** (`testing`, later others). The verb loads the target's playbook and follows it.

| Verb | Foundation targets | Standard targets (testing, as the first) |
|---|---|---|
| `apply` | `routing`: writes the task-to-agent routing table in `AGENTS.md` (every task a registered standard defines, mapped to agents in the capability roster by name), the role bindings (`roles.md`), and the capability rows that expose them, composed from the roles every registered standard declares. `gates`: writes the gate registry, the stage bindings, and the capability row for the one domain-neutral gate runner, composed from the gates every registered standard declares. Each standard contributes a named gate set (the testing standard's is `test-gates`) that the runner executes and reports in one structured report (§1A.5) | `testing`: writes only the testing-specific parts: the short testing block in `AGENTS.md`, the `test-routing` capability row and the class table behind it (classification is domain-specific, so it is not a `routing`-foundation row), the cards, the header and record formats, and the IMPLEMENTATION skeleton with its binding table. Files backlog items for mechanisms it cannot write (a checker, a hook) |
| `run` | `routing`: resolves a role to the closest available agent for a work item and returns it with the closeness evidence. `gates`: runs the gate set for a lifecycle step and returns the report | `testing`: classify the change, call the routing command, return the rigor, authorship mode, and the one playbook card (§1C.2) |
| `review` | `routing`: role availability (holder chosen with its closeness evidence, or unbound), roster names that resolve nowhere. `gates`: completeness, liveness, reachability, and teeth of every registered gate | `testing`: the testing-specific checks (name independence of STRATEGY and IMPLEMENTATION, conformance level, managed-block drift) on top of the foundation reviews |

`apply all` and `review all` run the foundations first and then each registered standard. **Unless a standard says otherwise, `apply routing` and `apply gates` write the routing and gate content and `apply <standard>` writes only that standard's domain content.** A standard says otherwise in its declaration (§1E.2) with `routing: own` or `gates: own`, and then `apply` leaves that part to the standard's own playbook and `review` checks it there.

### 1E.2 Structure

- **Registry:** one index of the foundations and standards, with each one's status (playbook present or planned), its portable policy document, and where its repo-side binding lives.
- **Standard contract:** what a standard must provide to register: a portable policy that names no agent; a machine-readable **declaration** of its roles (with each role's obligations, the tools it needs, and the roles it must not be the same party as), its work classes for routing, and its gates (id, threshold, enforcing mechanism, stage); a carrier for each clause (check, field, brief slice, or card, in that order of preference, STRATEGY §13.2); a conformance specification a script can run; an `apply` template; and optional `routing: own` or `gates: own`. A standard missing any of these is a finding in `review all`.
- **Per target:** `POLICY` (for testing, `STRATEGY.md`), one playbook per verb, cards of at most 4,096 bytes, and the conformance specification.
- **Managed blocks:** `apply` writes only between marker comments in `AGENTS.md` (`workspace-standards:<target>:begin` and `:end`), one block per target. Re-running changes only the block, and `review` detects hand edits inside it as drift. Everything outside the blocks belongs to the repository.
- **Where it lives:** in the harness (sox-ecosystem `extensions/skills/workspace-standards/`), installed with the other skills. A repository carries only what `apply` generated plus its IMPLEMENTATION.

### 1E.3 What this closes

- **Writing the standard into `AGENTS.md`:** `apply routing`, `apply gates`, and `apply testing` generate the capability rows, the routing rules, the gate bindings, and the testing block. The testing block is of fixed shape and stays under 12 lines (T44).
- **Conformance as a repeatable process:** the generic checks are one engine (§1A.6) run by `review gates` and `review routing` and reused by every standard; `review testing` adds only what is testing-specific (T41).
- **Every future standard follows the same three verbs,** so adding one is a declaration, a policy, and playbooks, not another skill and another way to audit.

### 1E.4 Role availability: the closest available agent

Not every role has a holder in every workspace. A role's holder is the **closest available agent**, chosen by a rule a script can run and recorded with the choice.

1. **Candidates:** the agents installed in the workspace.
2. **Eligibility:** an agent is eligible only if it can use the tools the role needs and breaks no rule in the role's declaration for this change (the independence constraints of STRATEGY §13.1 and §14, where a party is one session: a session never approves what it authored, so a fresh dispatch of the same agent is a different party and may audit).
3. **Closeness:** among eligible agents, rank by the number of the role's obligations that the agent's **machine-readable capabilities declaration** lists (each agent edit adds a short `roles-covered` list of obligation ids drawn from `roles.md`; free-text descriptions are never scored, D23), then by the fewest other roles the agent already holds in the same change. A `hints` list in `roles.md` names preferred agents and only breaks ties; it never overrides eligibility or closeness.
4. **Result:** the closest eligible agent holds the role, and the closeness evidence (covered obligations, tools matched) goes in the dispatch's telemetry row. If no agent is eligible, the role is **unbound**: the work proceeds, the clauses the role would have applied become review debt on the affected tests, the mechanical checks apply unchanged, and `review routing` lists the unbound role and lowers the reported level. At Deep rigor, an unbound Static reviewer, Auditor, or Test author blocks the change (STRATEGY §6.6, §13.1).

Typical hints for the first standard (illustrative; the rule above decides): Test author `test-author`; Static reviewer `review`; Auditor `qa`; Triager `debug`; Classifier `product`; Planner `architect`; Verifier and release owner `dispatcher`; Record-keeper `backlog-operator`; Strategy owner `qa`; Mechanism owner `devops`. With `review` absent, the rule picks the closest eligible read-only agent; a fresh `qa` dispatch is eligible, a `qa` session that authored the tests is not. The roster guard (T10) has two checks: a name-resolution report (every routed name must resolve to an installed agent, which is finding F1) and a role-resolution check (a role with no eligible agent must be declared unbound).

## 1F. The testing record: the existing backlog structure, used as it is

The backlog's structure does not change: an item has a title, a free-text body, a kind, a status, a priority, citations, relations, and obligations. The testing standard adds a convention inside the body, which the backlog already carries and the filing boundary already inspects.

```
## Testing record
change-class: new-behavior | defect-fix | refactor | configuration | dependency | boundary-contract | no-code | test-maintenance
rigor: none | light | standard | deep      (derived by the routing command and recorded, never chosen)
triggers: <the triggers hit> | none
ac: AC1 <criterion> ; AC2 <criterion> ; …
not-testing: <failure modes left untested, and why> | none
plan: <failure mode → tier → AC>           (one line per AC at Light)
expires: <date>                            (exception items only)
```

| Concern | Existing mechanism it uses |
|---|---|
| Presence and validity of the record at filing | the filing boundary in `backlog-operator` and `definition-of-ready` (agent-definition edits, T17), not a store change |
| AC-citation scan (G6) | the scanner reads the `ac:` ids through the existing `get` and `query` verbs (verified: `get` with `fields:["body"]` returns the body, `SKILL.md:390-391`; T33.AC1 still proves the scanner end to end) |
| Regression-test evidence | an evidence obligation of the existing kind with a `path:` anchor to the test file (presence only, F7) plus the dispatcher's red and green evidence |
| Exceptions and retention work | ordinary items. An exception carries an `expires:` line and a relation to the item it excuses; a retention ticket is an ordinary item citing the group's standing review item |
| Item types | whatever the repository defines; the IMPLEMENTATION maps each type to a default `change-class`, and the record's value wins |

## 1G. Stage F as demand-driven review, not a clock

A scheduled event is a backlog item whose priority rises with evidence.

- **Standing review item per test group.** A test group is a repository-defined set of tests (for example one project's tests, or one tier within a project), listed in the IMPLEMENTATION. Each group has one open item titled for the group, created by `apply` at base priority.
- **Signals.** Each run's `test-gates` report lists, per group: a change that touched it, a test over its duration budget, a flake, a skip or `todo` past its date, and tests with an open unreviewed-tests follow-up item. These are measured values from the report, never estimates.
- **Bump rule.** A signal raises the group's item priority by one step on the priority ladder named in the IMPLEMENTATION only when its count or rate over the IMPLEMENTATION's period crosses that signal's threshold (a change that merely touched the group does not bump by itself), at most once per signal kind per period, capped at the top step. Working the item resets it to base priority, and a period with no crossing lowers it one step, so the ladder moves both ways. The bump is an existing `update` of the item's priority only (a non-body update, which keeps the item's uid; T39.AC2 proves it) plus an existing `add-citation` whose context names the run id and the signal; a citation already carrying that run id and signal prevents a double bump. The CLI has no separate note verb, so the citation is the record.
- **Who bumps.** A CI step on mainline push, so unmediated work is covered; the dispatcher at Step 5.8 through the record-keeper, so plan and direction work is covered the same way.
- **Who works it.** The ready view is ordered by priority, so the item surfaces when it reaches the top. `qa` applies R1–R6 to the group, files the lowering, rewrite, and removal tickets as ordinary items, clears review debt, and resolves the item, which re-creates it at base priority.
- **Failure route.** An item that sits at the top unworked is the lane that never ran (STRATEGY §7.1). The signal step reports items at the top for longer than the limit the IMPLEMENTATION sets.
- **Work that needs a clock.** Change history cannot signal repeat-run flake detection, sampled mutation analysis, soak runs, or capped X smoke against external systems (STRATEGY §7.4). Each is a named action on the standing review item (the item's checklist names it and the `qa` review runs it) or has a clock; the CI step runs the repeat-run mode (T36) on a schedule the IMPLEMENTATION states, and an exception is recorded for any that is not run.

## 2. The dispatcher's delivery lifecycle, and where STRATEGY stages land in it

Dispatcher 2.0.0 carries every plan through one lifecycle (`dispatcher.md:90-97`, Step 5 at `:462-475`). The STRATEGY's workflow stages A–H are different from these ten steps; this table is the join.

| Lifecycle step (Step 5) | Actor | Tests involved | STRATEGY stage | Source |
|---|---|---|---|---|
| 1–2 plan and bucket worktrees | dispatcher | none | n/a | `dispatcher.md:466-467` |
| 3 implement, verify **every AC**, ff-merge bucket into plan branch, issue → `review` | implementer | writes and runs tests | **A** author loop | `:468` |
| 4 static-analysis review per bucket (guided; does **not** run the suite) | `review` | reads the tests in the diff | review input to **G9**, R3, R4 | `:469`; `contract:32` |
| 5 aggregate findings, one correction per bucket | dispatcher → implementer | corrections are not reviewed again | A | `:470` |
| 6 **QA**: run unit tests, triage failures, apply simple fixes, reopen complex failures with notes, **audit tests** (merge duplicates, remove the unnecessary, enforce the test standard) | `qa` | runs unit tests; edits tests | retention at plan scope (§8) | `:471`; `contract:35-38` |
| 7 reopens → corrections → QA until QA reopens nothing | dispatcher | — | A | `:472` |
| 8 **final test run — the dispatcher's own**: "the project's full gates (tests, typecheck, build)" in the plan worktree | dispatcher | the project's gate set | **D** presubmit, executed locally before merge | `:473`, `:95` |
| 9 **exactly one blind review** of the plan's whole diff | `review` | reads the diff only | none (no retention judgment possible blind, F12) | `:474`; `contract:33` |
| 10 ff-only merge to target | dispatcher (`git-manager` only on conflict) | — | merge | `:475` |
| Step 7 release by the dispatcher, live confirmation, resolve | dispatcher, `backlog-operator` | artifact checks | **G** release | `:482-485`; rules 13, 18 |
| after push | PJ-ci | affected gates | **E** mainline | `docs/PIPELINE.md` §2 |
| demand-driven review (stage F) | **none** | — | **F** | no standing review item and no signal producer exist |

**QA's test edits (D19).** Step 6 lets `qa` edit tests. Each edit or removal carries a parity record checked mechanically (D9) **and** is confirmed by a different party: a fresh `qa` dispatch, given the audit record, the parity evidence, and the test-file diff only, runs after Step 7 and before Step 8. If no second party is available the confirmation becomes review debt with an owner and an expiry (STRATEGY §13.1). The blind review at Step 9 sees only the diff and is not this confirmation.

The decisive binding is **Step 5.8**. "The project's full gates" is the lifecycle's presubmit (stage D). The lifecycle names only "unit tests" (QA, 5.6) and "tests, typecheck, build" (5.8); it has no concept of P, H, or X tiers or of `smoke` subsets. The IMPLEMENTATION must therefore bind a `test-gates` capability that resolves, for this repository, which tiers run at Step 5.6, which at Step 5.8, and the exact commands (finding F4, F17).

## 3. The actors and their testing roles

The dispatcher is one tool for applying the strategy; the specialists and the PROJECT mechanisms do the work and the enforcement. The dispatcher never writes implementation or documentation files (`dispatcher.md:58`), but it now runs the lifecycle's git and the final test run itself (`:95`, rule 23).

| Actor | Layer | Testing role under the strategy | Today (cited) |
|---|---|---|---|
| **dispatcher** | HR-orch | Elicits and gates AC; applies definition-of-ready; runs the routing command per bucket and carries `rigor`, `test-authorship`, `playbook` in briefs; verifies red from the branch before the implementer starts; runs Step 5.8; resolves only with evidence; dispatches `qa` for audit and retention | Rules 15, 18, 20 (`dispatcher.md:182-192,210,221-223`); Step 5 |
| **product** | HR-spec | Priority and acceptance criteria; Classifier (writes `change-class` while grouping tickets); accepts the "not testing" list as the risk decision at Deep | AC and a verification reference required (`product.md:36-37,377`); the reference points at `test`/`review` |
| **architect** | HR-spec | Interfaces and contracts at every boundary, and the escalation triggers it sees; it no longer plans tests | Spec has a flat unit/integration/UX test list (`architect.md:342-360`), no tier, gap, or contract section |
| **test-author** (new) | HR-spec | Test author: plans a bucket's tests as a batch, authors per unit, in parallel with the implementer; cards by class (§1B) | Not defined; the routing row exists (`dispatcher.md:430`) |
| **architect-decision** | HR-spec | One-shot decisions: a tier exception, a deferral acceptance (§7.3), a contested lowering | Exists; not used for tests |
| **implementer** (`typescript`; `backend` row has no installed agent) | HR-spec | Makes the Test author's red tests green and never edits them; at Light rigor writes its own tests at the lowest tier from the author card; verifies every AC before the ff-merge; reports obsoleted tests and test disputes | `typescript.md:45` demands "Test coverage exceeding 90%" (F3) |
| **qa** | HR-spec | Plan-scope test run, triage, simple fixes, reopen, **test audit**; owns the strategy mapping and flake triage; never approves its own changes | Routed for "QA, test runs and test audit" (`dispatcher.md:430`; `direct:30`); persona owns one strategy file (`qa.md:19-24`, F2) |
| **review** | HR-spec | Per-bucket static analysis (guided); one blind review per plan | Named in routing (`dispatcher.md:430`); **no installed agent has this name** (F1) |
| **debug** | HR-spec | Root cause; regression test at the lowest tier; escape record | Requires coverage "so it can't silently regress" (`debug.md:93`); no tier or stage recorded |
| **backlog-operator** | HR-spec | Files with the filing-boundary subset; resolves only when every AC is cited by a passing test and artifact-class evidence holds | `backlog-operator.md:32-65`; AC proof "each cited by a passing test" (`:49`) |
| **git-manager** | HR-spec | Merge-conflict resolution only | `dispatcher.md:249-256` (rule 23) |
| **devops** | HR-spec | Owns the stage definitions and budgets; wires stages C–G | Requires a pipeline definition (`devops.md:28-53`) |
| **performance, security** | HR-spec | Own `performance` / `security` tagged tests and X-tier authorization | `performance.md`; `security.md:29-34` |
| **researcher, agent-manager** | HR-spec | Update the strategy from new research; build and A/B-test new or changed agents | `agent-manager.md:109-155` |
| **CI, hooks, checkers, backlog gate** | PROJECT | Run and enforce | §4 |

## 4. The map

Columns: **Decides** (policy owner) · **Does** (writes or runs) · **Enforces** · **Records** · **Layer/System** · **Lifecycle** (Step 5 step or STRATEGY stage) · **Class** · **Today → required**.

### 4.1 Principles P1–P14

| Clause | Decides | Does | Enforces | Records | Layer/System | Class | Today → required |
|---|---|---|---|---|---|---|---|
| **P1** value = signal ÷ cost | qa | qa at Step 5.6; scheduled report | §8.1 questions | audit record on the ticket | HR-spec qa + PJ-rep | R | ✖ audit exists (`dispatcher.md:471`) with no criteria → testing skill supplies R1–R6 |
| **P2** size by ceiling | STRATEGY | implementers declare | **G3** | tier in header and location | PJ-run + PJ-chk | M | ◐ two lanes only; `check-agent-lane-spawn.mjs` covers the agent family (ADR-0009 D4) → generalize |
| **P3** lowest tier | architect (plan), implementer (author) | implementer | §6.2 tree, G9, static review | spec test plan; header | HR-spec + PJ-chk | MR | ✖ no tier field anywhere → spec template and header check |
| **P4** behavior not structure | qa | implementer | static review (5.4); R4 | review finding | HR-spec review | R | ✖ not in `typescript.md` → testing skill |
| **P5** each test a liability | qa | implementer reports | §8.6 change budget | return block field | HR-orch contract + HR-spec | R | ✖ → `tests-obsoleted:` in the return block |
| **P6** determinism | qa | implementer | G5, §9 | flake ledger | PJ-chk + PJ-ci | M | ✖ no flake measurement |
| **P7** contracts at boundaries | architect | implementer | `contract` tag; G2 | contract artifact | HR-spec + PJ-run | R | ◐ parity suites exist as e2e; no `contract` tag |
| **P8** earliest sufficient stage | devops + qa | devops wires | §7 table, G7 | stage table in IMPLEMENTATION | PJ-impl + PJ-hook + PJ-ci | MR | ◐ B and E exist, C reduced, F absent (§4.4) |
| **P9** Beyoncé rule | product + architect | architect, implementer | §6.1 steps 2–3 | risk map and "not testing" list on the ticket | HR-spec + PJ-bl | MR | ✖ no ticket field (F6) |
| **P10** a skipped test doesn't count | STRATEGY | implementers | **G2, G4** | skip register | PJ-chk | M | ✖ 81 stub specs (878 `it.todo`) pass green today (`git grep`, 2026-10-07, adhd `b76b4bed`) |
| **P11** coverage finds gaps | qa | PJ-chk | **G8** | changed-code report | PJ-chk + PJ-rep | MR | ✖ and **contradicted** by `typescript.md:45` (F3) |
| **P12** tests are code | qa | implementer | static review | review finding | HR-spec review | R | ✖ → testing skill |
| **P13** gates by mechanism | STRATEGY | — | placement rules L1–L5 | gate table in IMPLEMENTATION | PJ-impl | — | n/a |
| **P14** shape is an outcome | qa | PJ-rep | shape metric (§11) | report | PJ-rep | J | ✖ → shape report |

### 4.2 Procedures §6

| Clause | Decides | Does | Enforces | Records | Layer/System | Lifecycle | Class | Today → required |
|---|---|---|---|---|---|---|---|---|
| **§6.1.1** classify the change | Classifier (`product` while grouping; dispatcher at intake; the working agent when unmediated) | same | `backlog-operator` refuses an unclassified filing; `definition-of-ready` first-fire check (`extensions/skills/definition-of-ready/SKILL.md:39-44`) | `change-class` line in the item's testing record | HR-orch + HR-spec + PJ-bl | intake | MR | ◐ routes by symptom, not change class → eight-value `change-class` line in the testing record (F6, T17) |
| **§6.1.2** list failure modes (risk map) | architect; qa for high-risk; implementer for small | architect, implementer | backlog filing boundary | ticket `## Risk` | HR-spec + PJ-bl | plan | MR | ✖ filing boundary checks AC, scope, citations, dependencies only (`backlog-operator.md:32-42`) |
| **§6.1.3** "not testing" list | product accepts | architect, implementer | same | ticket | HR-spec + PJ-bl | plan | MR | ✖ required ticket section |
| **§6.1.4** choose the tier | architect, implementer | implementer | G3, G9 | spec; header | HR-spec + PJ-chk | 5.3 | MR | ✖ |
| **§6.1.5** duplication check | implementer | implementer with `code-intel` | static review | spec note | HR-spec + `code-intel` capability | 5.3 | R | ✖ capability exists (`gx`); no instruction uses it for tests |
| **§6.1.6** case design | qa guidance | implementer | static review | — | HR-skill + HR-spec | 5.3 | R | ◐ taught in `qa.md:59-66`, not given to implementers |
| **§6.1.7** teeth | implementer | implementer; QA reruns | **G6**, G8 | test cites ticket and AC id | PJ-bl obligation + PJ-chk | 5.3, 5.6 | MR | ◐ rule 15 requires a test citing the item id seen red then green (`dispatcher.md:188-190`); the dispatcher checks by reading |
| **§6.1.8** header record | implementer | implementer | **G9** | test file | PJ-chk | 5.3 | MR | ✖ |
| **§6.2** tier decision tree | qa maintains | architect (plan), implementer (author), review (check) | G9 validity by static review | header | HR-skill + HR-spec | plan, 5.3, 5.4 | R | ✖ one shared skill (§7) |
| **§6.2** fidelity-gap statement | static review judges | implementer writes | G9 presence check | header | PJ-chk + HR-spec | 5.3, 5.4 | MR | ✖ |
| **§6.3** what tiers are not for | qa | — | static review; R3 | — | HR-spec | 5.4 | R | ✖ |
| **§6.4** case-design techniques | qa | implementer | static review | — | HR-skill | 5.3 | R | ◐ `qa.md` only |
| **§6.5** teeth | implementer | implementer | G6, G8; mutation at L3 | tool report | PJ-chk | 5.3, 5.6 | MR | ✖ no mutation tool |

### 4.3 Tiers, doubles, pyramid (§2, §4, §5)

| Clause | Decides | Does | Enforces | Records | Layer/System | Class | Today → required |
|---|---|---|---|---|---|---|---|
| **§2.1** tiers S / P / H / X | STRATEGY | implementers declare | **G2, G3** | tier mapping table | PJ-impl, PJ-run, PJ-chk | M | ◐ the repo has `test` (unit) and `e2e` lanes: `e2e-globs.mjs:17-21`; no P/H/X split. The harness test standard is binary unit/e2e (F15) |
| **§2.1** budgets | IMPLEMENTATION | PJ-run | **G7** | config | PJ-run | M | ◐ spawn-timeout helper for e2e; no per-tier budget |
| **§2.2** scope | implementer | — | static review | — | HR-spec | R | — |
| **§2.5** work-unit vocabulary (work unit, base commit, coordinator, stub commit) | STRATEGY | the dispatcher is the coordinator | T16, T23 | — | HR-orch | R | ✖ (T16, T23) |
| **§3** size first | STRATEGY | every decision in §6–§8 starts from the tier | G2, G3 | tier mapping table | PJ-impl | M | ✖ (same as §2.1) |
| **§2.3** purpose tags | IMPLEMENTATION | implementers | tag registry; strict-tag mode | tags | PJ-run | M | ✖ installed Vitest 4.1.9 contains `tagsFilter` and `strictTags` (verified in `node_modules`) |
| **§2.4** non-test verification | devops | PJ-ci | **G10** | CI | PJ-ci | M | ✔ `verify-dist-load` (`docs/PIPELINE.md` §2 step 6) |
| **§4** doubles policy | qa | implementer | static review; contract tests | — | HR-spec | R | ◐ the harness test standard says "mock every library that spawns a process or touches a third-party network" (`contract:36`), which fits unowned boundaries; the STRATEGY ordering (real, fake, stub, mock) is absent |
| **§5** pyramid shape | qa | PJ-rep | shape metric | report | PJ-rep | J | ✖ |

### 4.4 Stages A–H (§7)

| Stage | Owner of the stage definition | Does | Enforces | Layer/System | Today → required |
|---|---|---|---|---|---|
| **A** author loop | implementer | runs S for the unit; verifies every AC before the ff-merge (Step 5.3) | brief done-state; dispatcher verifies from state (`dispatcher.md:439-460`) | HR-spec + HR-orch | ◐ AC verification exists; tier S selection undefined |
| **B** pre-commit | devops | PJ-hook | hook exit code | PJ-hook | ✔ lint, secret scan, staged specs (`docs/PIPELINE.md` §2) |
| **C** pre-push | devops | PJ-hook | hook | PJ-hook | ◐ `test` only; e2e excluded since `14b06b44` (`.githooks/pre-push:6-10`); no `smoke` subset |
| **D** presubmit | devops defines; dispatcher runs at Step 5.8 | the project's full gates in the plan worktree | raw exit codes read by the dispatcher (`dispatcher.md:95,473`) | HR-orch + PJ-impl + PJ-run | ◐ the gate set is unbound (F4); CI repeats it after push |
| **E** mainline | devops | PJ-ci on push to `main` | CI | PJ-ci | ◐ `nx affected` only; no full-repo run, so selection escapes go unmeasured |
| **F** demand-driven review | `qa` owns the item; the signal step is a PROJECT mechanism | a CI step and the dispatcher's final run raise the item's priority from `test-gates` signals (§1G, via `update` and `add-citation`); `qa` works it when it reaches the top | owner and failure route are the item's | PJ-bl + PJ-ci + PJ-rep | ✖ no standing items, no signal step (`.github/workflows` has `build-docker`, `ci`, `publish-embed-cdn`, `pull-request` only) |
| **G** release | dispatcher (Step 7) | runs the release guide and live confirmation | rules 13, 18; `docs/PIPELINE.md` §3 | HR-orch + PJ-ci | ◐ artifact checks yes; `smoke` and `contract` subsets undefined |
| **H** production | devops, security | monitors | out of repo | n/a | ✖ out of scope until this repo deploys a service |
| **§7.2** tier→stage table | devops + qa | — | **G2** | PJ-impl | ✖ |
| **§7.3** deferral rule | the risk owner (product); architect-decision for contested cases | — | exception log | PJ-bl | ✖ no exception convention (an ordinary item with an `expires:` line, §1F) |
| **§7.4** reachability and stage owners | devops | — | **G2** | PJ-chk | ✔ `check-lane-reachability.mjs`; ✖ stage-owner rule |

### 4.5 Retention §8

| Clause | Decides | Does | Enforces | Records | Layer/System | Class | Today → required |
|---|---|---|---|---|---|---|---|
| **R1** predictive (teeth seen red) | qa | `qa` at Step 5.6 (plan scope) and on scheduled dispatch (global) | static review (5.4) for tests in the diff | retention note on the ticket | HR-spec qa | R | ◐ the audit exists but has no criteria: "merge duplicates, remove the unnecessary" (`dispatcher.md:471`) |
| **R2** unique (no cheaper test detects the same fault) | qa | `qa`; kill-set data from PJ-rep at L3 | audit record with the method stated | retention note | HR-spec qa + PJ-rep | R | ✖ no uniqueness evidence source |
| **R3** right tier (valid fidelity-gap statement) | static review judges; qa adjudicates | `review` at 5.4; `qa` at 5.6 | G9 | header; finding | HR-spec review + PJ-chk | MR | ✖ |
| **R4** specific and structure-insensitive | static review | `review` at 5.4 | refactor-forced-edit count (PJ-rep) | finding | HR-spec review | R | ✖ |
| **R5** affordable (budget and flake) | qa | PJ-rep duration and flake data | G5, G7 | report | PJ-rep + HR-spec qa | MR | ✖ no duration or flake data per test |
| **R6** alive (runs un-skipped in a stage) | qa | PJ-chk scan | G2, G4 | scan result | PJ-chk | M | ✖ 81 stub specs today |
| **§8.2** triggers and evidence | STRATEGY | PJ-rep produces; qa judges | scheduled report | report + tickets | PJ-rep + PJ-ci + HR-spec | MR | ✖ no report; trigger data does not exist yet |
| **§8.3** lowering procedure | qa decides; implementer does | implementer in one change | parity proof | change record naming old and new test | HR-spec + PJ-bl | R | ✖ new brief template; **no reviewer sees QA's edits** (F12) |
| **§8.4** removal procedure | qa | implementer or qa | reviewer ≠ remover | removal record | HR-spec + PJ-bl | R | ✖ F12: a QA removal is reviewed only by the blind review of the whole diff |
| **§8.5** escape analysis, raising | debug (root cause), qa | debug | resolve precondition | escape record on the defect ticket | HR-spec + PJ-bl | MR | ◐ `debug.md:93` demands a regression test, no stage or tier recorded |
| **§8.6** change test budget | implementer reports | implementer | static review | return block `tests-obsoleted:` | HR-orch contract | R | ✖ |

### 4.6 Flakes, skips, quarantine (§9)

| Clause | Decides | Does | Enforces | Records | Layer/System | Class | Today → required |
|---|---|---|---|---|---|---|---|
| cause removal | qa | implementer | G5 | — | HR-spec + PJ-chk | R | ◐ practices documented in `AGENTS.md` §7 rule 3 |
| quarantine with deadline | qa | PJ-run excludes from the gating run | **G1, G5** | ticket with deadline | PJ-run + PJ-bl + PJ-chk | M | ✖ no quarantine mechanism |
| no permanent retry | qa | — | scan of runner config for retry settings | — | PJ-chk | M | ✖ |
| skip / `todo` expiry | qa | — | **G4** | tracking item and date in the marker | PJ-chk | M | ✖ |
| X-tier env gating | project owner | — | documented gate with named owner | README, AGENTS.md, test header | PJ-doc | R | ✔ rule exists (`AGENTS.md` §7 "Live testing is mandatory") |

### 4.7 Gates G1–G12 (§10)

| Gate | Enforcing mechanism (PROJECT) | Reader (HARNESS) | Today |
|---|---|---|---|
| **G1** pass; an overdue quarantine fails the build | gate set at Step 5.8 and CI required check; quarantine registry | dispatcher (`dispatcher.md:95`) | ◐ pass ✔; quarantine ✖ |
| **G2** reachability, one tier | `check-lane-reachability.mjs` plus a tier map | dispatcher | ◐ two lanes only |
| **G3** tier conformance | generalize `check-agent-lane-spawn.mjs` to all tiers and projects | `qa` audit enforces "the test standard" (`:471`) | ◐ agent family; `pendingMove` baseline (`agent-lane-spawn.baseline.json`) |
| **G4** no silent skips; review debt and characterization markers carry an owner and an unexpired date | scanner for `skip`, `todo`, disabled, plus a debt-expiry check | `qa` | ✖ |
| **G5** flake budget | repeat-run reporter | `qa` | ✖ |
| **G6** regression-with-fix, red evidence on an assertion, and AC citation | backlog **obligation** requiring evidence kind `regression-test` (path anchor to the test file) and a scanner that checks `<uid> AC<n>` citations against the ticket's AC ids | dispatcher rules 15, 20 | ◐ presence only: path attestations verify a file exists at HEAD with a digest, never that it passed (`entrypoint/backlog/skill/SKILL.md:635-651`) |
| **G7** time budgets | runner timeouts plus duration report | `qa` | ◐ |
| **G8** changed-code efficacy | mutation or coverage-on-diff tool | `qa`, static review | ✖ |
| **G9** fidelity-gap statement | header lint | static review | ✖ |
| **G10** artifact check (merge for a change that ships or alters an artifact; always at release) | `verify-dist-load` | dispatcher (rule 18) | ✔ |
| **G11** strategy conformance | a check that fails a change touching test-infrastructure paths unless its record cites STRATEGY and the exception log (T63), plus `qa` review | dispatcher | ✖ |
| **G12** planning record: class, rigor, "not testing" list, test header | the routing checker (T43) and header lint (T34) | dispatcher | ✖ |
| exception log | PJ-bl items with an `expires:` line (§1F) | `qa` | ✖ no convention yet |

### 4.8 Metrics §11, data and environments §12, adoption §13, AI authorship §14

| Clause | Decides | Does | Enforces | Layer/System | Today → required |
|---|---|---|---|---|---|
| metrics: pass, flake, duration, shape | qa | runner reporters | a report exists per run | PJ-run + PJ-rep | ✖ |
| metrics: signal precision, escape, selection escape | qa | scheduled report | — | PJ-rep | ✖ |
| metrics: skip and quarantine age, growth vs obsolescence | qa | scheduled report | G4 | PJ-chk + PJ-rep | ✖ |
| metrics: change-failure rate, lead time | product | delivery tooling | — | PJ-rep | ✖ |
| dispatcher status table "test health" row | dispatcher spec | dispatcher reads a command named in the capability binding | status format (`dispatcher.md` Report format) | HR-orch + PJ-doc | ✖ measured values only (rule 21) |
| **§12** data, fixtures, isolation | implementer | implementer | G3; scratch-location rules | PJ-chk + PJ-doc | ◐ `AGENTS.md` §10 scratch under `tmp/`, tree left clean. **Conflicts** with the harness standard "e2e … one shared scaffold and teardown" (F15) |
| **§12** environments: one command per tier | devops | PJ-impl | CI uses the same command | PJ-impl + PJ-ci | ◐ `nx` targets per lane |
| **§12** automation architecture | implementer | implementer | static review | HR-spec | R |
| **§13** IMPLEMENTATION content and conformance levels | qa | qa authors; devops contributes stage mapping | review | PJ-impl | ✖ `qa.md:19-24` says one file (F2) |
| **§13** capability binding | project owner | `project` skill `setup` playbook | `## Capabilities` table | PJ-doc + HR-skill | ✖ no table in `AGENTS.md` |
| **§14** AI-authored tests | dispatcher briefs, `qa` audits | implementers | briefs, static review, `qa` | HR-orch + HR-spec | ◐ the test standard travels in every test-writing brief (`dispatcher.md:223`) with no tier or header requirement |

### 4.9 Clauses added in STRATEGY 0.2

| Clause | Decides | Does | Enforces | Records | Layer/System | Class | Today → required |
|---|---|---|---|---|---|---|---|
| **§6.6** rigor derivation | the routing command (code), from class and detected triggers | the dispatcher or working agent runs it | a checker refuses recorded rigor below derived rigor (pre-push, CI, scheduled) | rigor record in the item body or change description | PJ-run + PJ-chk + PJ-bl | M | ✖ no command, no convention (T43, T35) |
| **§6.6** escalation triggers | IMPLEMENTATION lists them with path patterns | the routing command detects them | same checker | rigor record: trigger hit or not | PJ-impl + PJ-chk | M | ✖ (T02, T43) |
| **§6.6** lowering rigor is an exception | risk owner | `backlog-operator` files the exception item | exception log | ordinary item with an `expires:` line | PJ-bl | MR | ✖ no convention (T35.AC4) |
| **§6.7** class applicability table | STRATEGY | the routing command encodes it | the same checker; the gates apply to every class | rigor record | PJ-impl + PJ-chk | M | ✖ (T43) |
| **§6.7** gates no class relaxes | STRATEGY | `test-gates` runs them for every change | G1, G2, G4, G10, release | gate report | PJ-run | M | ◐ G1 and G10 exist (`verify-dist-load`); G2 partial; G4 absent |
| **§11** escape rate by class and rigor | `qa` | scheduled report joins the escape records to the rigor records | trend alarm raises a rigor default | report | PJ-rep | MR | ✖ (T39) |
| **§13.1** roles | STRATEGY | the harness binds them (§1A.1) | the roster guard validates every bound name | `roles.md` in the testing skill | HR-skill + PJ-chk | M | ✖ (T10, T14) |
| **§13.2** delivery to roles | STRATEGY | brief templates, cards, AGENTS.md block, routing command | the conformance checker verifies each slice has a carrier | binding table | HR-orch + PJ-doc + PJ-chk | MR | ✖ (T15, T16, T44, T41) |
| **§14** separated authorship | the routing command (mode) | Test author; dispatcher verifies the join from the branch | test-ownership check; independence check in the audit | `red:` evidence; `test-authorship:` field | HR-spec + PJ-chk | MR | ✖ (T22, T23, T46) |
| **§14** dispute path | the Auditor decides once (D21) | implementer returns `test-dispute:` | the ownership check rejects an unauthorized test edit | dispute record | HR-orch contract + PJ-chk | MR | ✖ (T23, T46) |
| **§14** interface stubs and red on an assertion | the architect specifies the stubs; the dispatcher commits and verifies the stub commit before dispatching (D20) | Test author records the failing assertion | the red-evidence check in T23 and the static-review card | `red:` evidence | HR-spec + HR-orch + PJ-chk | MR | ✖ (T22, T23) |
| **§13.1** review debt expiry | the risk owner (default) | the record-keeper files the follow-up item with an expiry | G4 | follow-up item | PJ-bl + PJ-chk | M | ✖ (T45) |
| **§6.6** trigger table and rigor distribution | STRATEGY | the routing command reports the distribution over recent changes (D24) | T43 | report | PJ-run | M | ✖ (T43) |
| **§14** batch is a unit of planning | the playbook rule | planning one dispatch per bucket; authoring per unit | dispatcher telemetry rows count dispatches | measured cost comparison | HR-spec + HR-orch | R | ✖ (T22, T24) |

## 5. The swimlane: one change from ticket to retention

The plan-mode path, at Standard rigor. Steps marked **[+]** are new; **[~]** gains a duty; the rest exist today. §1C.4 gives the unmediated path and §1D the other classes.

| # | Step | Actor | Layer/System | Lifecycle | Output recorded in |
|---|---|---|---|---|---|
| 1 | Direction arrives; scan the backlog for related tickets | dispatcher; `backlog-operator scan-related` | HR-orch | intake | ticket (verbatim) |
| 2 | Group open tickets into releasable buckets; set priority and AC; **[+]** write `change-class` per ticket | product | HR-spec | plan | ticket |
| 3 | Spec each bucket into consolidated executable items; **[~]** name interfaces, contracts at boundaries, and triggers hit | architect (with `code-intel`) | HR-spec | plan | ticket spec |
| 4 | Definition-of-ready: AC with ids, class present, no blocking unknown; **[+]** rigor derived by the routing command from class and declared write-scope | dispatcher; routing command; `backlog-operator` at filing | HR-orch + PJ-run + PJ-bl | Step 2 | rigor record on the item |
| 5 | Create the plan branch off main; one `plan-branch-bucket-N` per parallelizable bucket | dispatcher | HR-orch | 5.1–5.2 | git |
| 5a | **[+]** Apply the architect's stub files on each separated-authorship bucket branch, commit them as the stub commit, and verify that it compiles and touches only stub files; refuse to dispatch the pair otherwise | dispatcher | HR-orch | new, before 5.3 | stub commit |
| 6 | **[+]** Plan each bucket's tests as a batch: risk map, tier per failure mode, "not testing" list, AC-to-test map, duplicates found across items | Test author, `plan-bucket` (one dispatch per bucket) | HR-spec | new, before 5.3 | plan blocks on the items |
| 7 | **[+]** Author the tests per unit, in parallel with step 8; record red against the stub commit, naming the failed assertion (fan out above 5 units) | Test author, `author-*` playbooks | HR-spec | new, before 5.3 | tests on the bucket branch; `red:` evidence |
| 8 | Implement in parallel with step 7, from the committed stubs: make the AC true; never edit tests; **[+]** `test-dispute:` instead of editing | implementer | HR-spec | 5.3 | return block |
| 9 | **[+]** Join: verify from the branch that each diff touches only its declared paths; merge the two; run the tests; verify every AC; ff-merge the bucket; issue → `review` | dispatcher | HR-orch | 5.3 | raw exit codes; `ac-coverage:` |
| 10 | Static-analysis review of the bucket diff; **[~]** tier and gap validity, teeth, structure coupling | `review` (guided) | HR-spec | 5.4 | findings on the ticket |
| 11 | Aggregate; one correction per bucket (never re-reviewed) | dispatcher → implementer | HR-orch | 5.5 | corrected branch |
| 12 | QA: run tests, triage, simple fixes, reopen, **audit tests** with R1–R6; **[+]** refuses to audit tests it authored; **[+]** a fresh `qa` dispatch confirms any test edit or removal (D19) | `qa` (twice, as two parties, only when tests were edited) | HR-spec | 5.6 | audit record, reopen notes, confirmation |
| 13 | Final run: **[~]** the gate set bound by `test-gates`, one JSON report | dispatcher | HR-orch + PJ-impl + PJ-run | 5.8 (stage D) | raw exit codes; report |
| 14 | The one blind review of the plan diff | `review` (blind) | HR-spec | 5.9 | findings |
| 15 | ff-only merge; CI mainline run (**[~]** the same `test-gates` command) | dispatcher; PJ-ci | HR-orch + PJ-ci | 5.10, stage E | git log; CI |
| 16 | Release, live confirmation | dispatcher | HR-orch | Step 7, stage G | evidence |
| 17 | Resolve with every AC cited by a passing test, plus artifact-class evidence | `backlog-operator` | PJ-bl + HR-spec | close | transition |
| 18 | **[+]** Signals: each run's `test-gates` report names the test groups touched, durations over budget, flakes, expired skips, and unreviewed tests (open follow-up items); a CI step (and the dispatcher at Step 5.8) raises the matching standing review item's priority by one step and records the run as a citation | PJ-ci step; `backlog-operator` or the backlog CLI | PJ-ci + PJ-bl | stage F | priority and citation on the item |
| 19 | **[+]** Review when the item reaches the top of the ready view: apply R1–R6 to the group; file lowering, rewrite, removal tickets; clear review debt; resolve the item, which re-creates it at base priority | `qa` | HR-spec | stage F | tickets via `backlog-operator` |
| 20 | **[+]** Execute those tickets: the Test author's `maintain` playbook; `qa` judges the parity proof | dispatcher, Test author, `qa` | HR-orch + HR-spec | — | change record |
| 21 | **[+]** Defect escapes: root cause with the earliest catching tier; regression test via `author-regression`; update metrics | `debug`, Test author, `qa` | HR-spec | §8.5 | escape record |

## 6. Who runs which tests, when

| Moment | Runner | What runs | Evidence |
|---|---|---|---|
| Red | Test author | its own new tests, failing | `red:` evidence: command, non-zero exit, failing test names |
| Author loop (green) | implementer | tier S for the unit; every AC verified | `RETURN` block `evidence:` and `ac-coverage:` (`contract:47-57`) |
| Executor return | dispatcher | verifies from the plan branch: `git log`, the diff, the cited tests | "You verify from the plan branch … never from the return" (`dispatcher.md:468`) |
| Commit / push | PJ-hook | static checks, staged specs, affected `test` | `.githooks/pre-commit`, `pre-push:1-12` |
| QA stage | `qa` | the unit tests; triage; audit | reopen notes with failure output (`:471`) |
| Final run | dispatcher | the project's full gates in the plan worktree | raw exit codes (`:473`) |
| Mainline | PJ-ci | `nx affected` over lint, test, e2e, verify-dist-load | `docs/PIPELINE.md` §2 |
| Signals and demand-driven review | CI step; `qa` when the item is worked | the retention report and the standing review item | priority, note, and tickets on the item |
| Release | dispatcher | release guide, live confirmation | rules 13, 18 |

## 7. What each system must add (inventory; nothing is changed by this document)

**HARNESS (sox-ecosystem)**

| System | Change | Why |
|---|---|---|
| HR-skill | New `workspace-standards` skill (§1E): registry, standard contract, verbs `run`, `apply`, `review`; the `testing` standard carries the §6.2 tree, the §8.1 questions, header formats, cards, `roles.md`, and the `apply` templates | One shared procedure for every present and future standard; agents never copy the tree into their bodies |
| HR-orch `dispatcher` | Replace the binary test standard with a reference to the project's tier mapping; require a test plan in definition-of-ready; carry tier and header requirements in test-writing briefs | F15, F17 |
| HR-orch `dispatch-contract` | Add `tier` and `tests-obsoleted:` to the return block; make the static-review brief check tier and gap statements; give the `qa` audit brief the R1–R6 questions and a record format | F12, §8.6 |
| HR-spec `qa` | Replace the single-file equivalence rule so STRATEGY plus IMPLEMENTATION satisfy it; add retention-audit and flake-triage playbooks | F2 |
| HR-spec `typescript` | Replace the coverage target with the change-scoped efficacy standard (§1A.8); default tier S; header and citation duties | F3 |
| HR-spec `architect`, `product`, `debug` | Test plan with tier and gap statements; "not testing" acceptance; escape record | §4.2, §4.5 |
| HR-spec `agent-manager` | Build the `review` and `test-author` agents, A/B-test them and the edited `typescript`, `qa`, `architect`, `product`, `debug` | F1, §1A.8 |
| HR-spec **new `test-author`** | Playbook cards `plan-bucket`, `author-new-behavior`, `author-regression`, `author-contract`, `characterize`, `select-checks`, `maintain`; write scope limited to the brief's declared test paths | F18, §1B |
| HR-orch `dispatcher`, `dispatch-contract`, `dispatch-direct`, `dispatch-plan` | `test-authorship:`, `rigor`, `playbook` brief fields; `red:` and `test-dispute:` return fields; the parallel authoring and join protocol; run the routing command per bucket; skip the review and QA dispatches for a bucket of class None | F18, F21, §1B.4 |

**PROJECT (this repository)**

| System | Change | Why |
|---|---|---|
| PJ-doc | Add `## Capabilities` including `test-gates` (commands per lifecycle step) and `test-routing` (the routing command); add a testing block of a few lines for unmediated work | F4, F8, F20 |
| PJ-impl | Draft the IMPLEMENTATION as `docs/standards/testing.md`; it is the repo's single operative file for the testing standard, `qa` adopts it and cites STRATEGY | §13 |
| PJ-run | Tier projects and strict tags; per-tier budgets | §2 |
| PJ-chk | Generalize tier conformance (G3); AC-citation scanner (G6, rule 20); skip and `todo` expiry scanner (G4); flake reporter (G5); retention-report generator | §10, §8 |
| PJ-bl | No schema change. A documented testing-record convention in the item body (AC ids, `change-class`, `rigor`, triggers, plan, "not testing"); an evidence-obligation template using the existing obligations; exception and retention items as ordinary items with an `expires:` line | F6, F7 |
| PJ-chk | Routing command and rigor checker; test-ownership check; unreviewed-tests follow-up listing | F18, F20 |
| PJ-hook, PJ-ci | Stage C smoke subset; a CI step that turns `test-gates` signals into priority bumps on standing review items (§1G) | F9, F11 |

## 8. Findings the mapping surfaces (each with its evidence)

| ID | Finding | Evidence |
|---|---|---|
| **F1** | **The dispatcher's routing rows name five agents that no sox-ecosystem extension defines** (`review`, `backend`, `refactor`, `test`, `general`). This is a defect in the dispatcher spec, not a naming difference: the roster is hand-maintained and an open item already records that nothing validates it against the registry. `qa` is correctly routed. Step 2.5 says to stop and surface a roster gap, so the lifecycle's review stages (5.4, 5.9) cannot dispatch as written. Resolution under this design: define `review` and `test-author` (§1A.8), route implementation and refactor to the closest specialist per the routing table (the roster guard checks both the names and the role resolution), and drop `general`. | `dispatcher.md:430`; `rg '"name": *"(review\|backend\|refactor\|test\|general)"' extensions/agents/*/extension.json` matched nothing; `definition-of-ready/SKILL.md:145` (item `3fe895f3`) |
| **F2** | **`qa.md` contradicts the approved STRATEGY/IMPLEMENTATION split.** Its equivalence test treats two documents as "two partial documents" and says to create `docs/TEST-STRATEGY.md`. `qa` is now dispatched at Step 5.6 and would "correct" this repo back to one file. | `qa.md:19-24`; `dispatcher.md:471` |
| **F3** | **`typescript.md` sets a coverage target.** STRATEGY P11 rejects one. | `typescript.md:45` |
| **F4** | **"The project's full gates" has no binding in this repo.** Step 5.8 and rule 5 tell the dispatcher to run them, but `AGENTS.md` lists different commands for commit (`lint,typecheck,typecheck-spec`) and for push (`lane-gate.mjs` target list), and `docs/PIPELINE.md` lists a third set. Nothing says which tiers run at Step 5.6 versus 5.8. | `dispatcher.md:95,473`; `AGENTS.md` "Gates are blocking" |
| **F5** | **AC-citation enforcement is text-pinned, not behavioral.** `tools/test-dispatcher-ac-citation.mjs` greps the dispatcher spec for its own wording; it passes on 2.0.0 (exit 0, all assertions). No run is checked. Class T. | `sox-ecosystem/tools/test-dispatcher-ac-citation.mjs` (run during this analysis) |
| **F6** | **The backlog holds acceptance criteria, risk, and test plan only as free text.** Create takes `title` and a free-text `body`; AC ids exist only by convention in the body. The decision is to keep the backlog's structure as it is and make the convention explicit (§1F), checked by the filing boundary and a scanner. | `entrypoint/backlog/src/write/create-issue.ts:80-82` |
| **F7** | **Obligations prove presence, not passing.** A `path:` attestation verifies a file exists at HEAD with a digest; `url:` anchors stay unverified. An obligation can gate "a cited regression test exists", never "tests passed". | `entrypoint/backlog/skill/SKILL.md:635-651` |
| **F8** | **adhd `AGENTS.md` has no `## Capabilities` binding**, so there is no seam to name the gate commands. | `rg "^## .*Capabilit" AGENTS.md` returned no match |
| **F9** | **Stage F has no owner and no producer.** No standing review item exists and nothing turns run results into signals, so flake detection, shape, and retention reports have nowhere to originate. The design is demand-driven (§1G). | `.github/workflows` listing |
| **F10** | **Presubmit is the dispatcher's local run, then CI is mainline.** With ff-only merges to the target, the dispatcher's Step 5.8 is the only pre-merge gate; CI runs after the push. *(Whether this repo merges through pull requests was not verified.)* | `dispatcher.md:92,473-475` |
| **F11** | **Pre-push no longer runs e2e, and no P `smoke` subset replaces it.** This is an owner decision (`AGENTS.md`: e2e is CI-only and paused locally, backlog `8963c3cb`) and `check-lane-reachability.mjs` fails a push hook that starts running `e2e`; the IMPLEMENTATION records it as a standing placement decision with a review date (STRATEGY §7.3) and runs the P `smoke` subset at presubmit instead, unless the owner lifts the decision and the reachability check is updated in the same change. | `.githooks/pre-push:6-10`; `AGENTS.md` |
| **F12** | **No reviewer sees the QA audit's removals and lowerings.** The order is static review (5.4) → QA (5.6) → one blind review (5.9) over the whole diff, and corrections and reopen cycles are never re-reviewed. The blind reviewer sees only the diff, so it cannot judge whether a removed test was redundant. STRATEGY §8.4 requires a reviewer other than the remover, with evidence. Resolved by D9 and D19: a mechanical parity record **and** confirmation by a fresh `qa` dispatch. | `dispatcher.md:94,469-472,474`; `contract:32-33` |
| **F13** | **Tier conformance covers only the agent family** and uses a baseline that "can only shrink". | `docs/decisions/0009-test-lanes-unit-vs-e2e.md` D4; `agent-lane-spawn.baseline.json` |
| **F14** | **Host hooks cannot carry portable rules.** The only hooks installed are cost caps and GitNexus enrichment; they are Claude-only and machine-local. | `~/.claude/settings.json:50-93` |
| **F15** | **The harness test standard conflicts with the strategy.** `dispatch-contract` §1a states test policy inside a harness skill (breaking L4): unit tests mock process and network libraries; e2e tests "drive every surface … in one run on one shared scaffold and teardown", with minimum duration a primary goal. STRATEGY has four tiers, and requires each test to own its mutable state and run independently (§12). A shared mutable scaffold breeds order dependence; a shared read-only scaffold (a built artifact, a running server) is compatible. | `contract:35-38`; `dispatcher.md:223`; `STRATEGY.md` §12 |
| **F16** | **The QA audit has no criteria.** "Merge duplicates, remove the unnecessary" is the whole instruction. STRATEGY §8.1–8.4 supplies the criteria, evidence, and procedure; without them QA decides by taste. | `dispatcher.md:471` |
| **F17** | **The lifecycle has no concept of P, H, or X tiers or of `smoke` subsets.** QA runs "the unit tests"; the final run is "tests, typecheck, build"; the e2e duration is the only e2e evidence the contract asks for. | `dispatcher.md:471,473`; `contract:35-38` |

| **F18** | **The harness assumes the implementer writes the tests.** Rule 15 requires a test citing the item id seen red then green; the contract says "every test the executor writes cites…" and carries the test standard in "every brief that writes or changes tests"; Step 5.3 has the implementer verify every AC. Separated authorship (STRATEGY §14) needs: who owns red, who owns green, a `test-authorship:` brief field, and a dispute path in place of an edit. | `dispatcher.md:188-190,468`; `contract:17,35`; §1B.4 |
| **F19** | **`dispatch-direct` is the dispatcher's playbook, not an unmediated session.** It runs the full delivery lifecycle (Step 10) and the release (Step 11) and forbids merging without the dispatcher's own green final run. A user talking directly to a working agent gets none of that. The strategy therefore has three modes (plan, dispatcher direction, unmediated), and only the third depends on AGENTS.md, one pulled card, and the mechanical gates. | `direct:36-37,45`; `plan:39-43`; `triage:13-14`; §1C |
| **F20** | **Unmediated mode has no carrier today.** `AGENTS.md` has no testing block and no capability binding (F8), pre-push excludes e2e (F11), and nothing records review debt. | `AGENTS.md`; `.githooks/pre-push:6-10` |
| **F21** | **The lifecycle's steps are unconditional.** Static review, QA, and the blind review run for every bucket, so a bucket of only documentation work (class None) still dispatches them. The strategy needs nothing from QA there, so skipping the dispatch is a harness change, not a strategy change. | `dispatcher.md:469-474`; §1D |
| **F22** | **The backlog's structure is kept as it is.** The testing record is a body convention (§1F). Minting a new item kind by name is existing create behavior but is not used. | `entrypoint/backlog/skill/SKILL.md:108,119`; owner direction |

## 9. Decisions

The owner approved the design on 2026-10-07 with two adaptations (routing and gates are separate targets from domain standards, D18, §1E; a role goes to the closest available agent, D17, §1E.4), answered each open decision in a questions round the same day, and then approved the rest ("if so then yes and the rest approved"). Every decision below is therefore decided; D19–D24 were taken in the review round that followed (2026-10-07). The final answers:

| ID | Final answer |
|---|---|
| D1 | Create `review`. Implementer is a role resolved to the closest available specialist per task (for example `typescript` or `ui`); `typescript` is not broadened; the `backend`, `refactor`, `general` routing rows are dropped; roster guard added |
| D2 | `qa` cites the strategy and adopts one operative file per standard, `docs/standards/<domain>.md` (for testing, `docs/standards/testing.md`); `docs/standards/` is the default home for every standard's repo-side file |
| D3 | STRATEGY lives in the harness repo as the testing standard's policy inside the `workspace-standards` skill; the IMPLEMENTATION becomes a template there; nothing is moved yet |
| D4 | Backlog structure unchanged; the testing record is a body convention |
| D5 | The routing table in `AGENTS.md` maps tasks (the testing standard's and any other standard's) to agents by name; the gate runner keeps its own Capabilities row: it knows the gates and applies them correctly for the context, and releases nothing |
| D6 | Stage F is a standing backlog review item per test group whose priority rises with signals |
| D7 | The repo owner authorizes X-tier tests, named in the IMPLEMENTATION; `security` approves intrusive tests |
| D8 | Delete the binary test standard in `dispatch-contract` and inline role cards |
| D9 | Mechanical parity evidence recorded by QA and verified by a checker, as a necessary condition; D19 adds a second party |
| D10 | Establish the system only. The migration of existing tests (stubs, skip blocks, sleeps, CI triage; STATE stream S4) is out of this plan and stays as filed backlog items; the success metric is that the finished system drives them to resolution |
| D11 | A separate `test-author` agent with a clear process. A fresh `qa` dispatch may audit it; a session may never approve what it authored |
| D12 | Separated authorship at Standard and above (required at Deep); implementer authors at Light |
| D13 | Parallel: the Test author and the implementer run concurrently against fixed interfaces with disjoint write scopes, joined by the dispatcher (§1B.4) |
| D14 | One routing command derives rigor; a checker enforces it |
| D15 | An agent with no second party returns its unreviewed tests as a filed follow-up item, cleared by a fresh `qa` dispatch (owner: "I thought they would return them to be filed for followup") |
| D16 | STRATEGY 0.2 amendments approved |
| D17 | The closest available eligible agent holds a role |
| D18 | One `workspace-standards` skill, verbs `run`, `apply`, `review`, over foundations and standards |
| D19 | QA's removals, lowerings, and other test edits need the mechanical parity record **and** confirmation by a different party (a fresh `qa` dispatch); with no second party, review debt with an owner and expiry (§2) |
| D20 | Parallel authoring starts from interface stubs specified by the architect and committed and verified by the dispatcher on the bucket branch; red evidence must be a failed assertion, not a missing symbol; interfaces open means sequential (§1B.4) |
| D21 | A test dispute goes to the Auditor, who decides once; review debt has an owner, a 14-day default expiry, and a failing check, and is allowed only at Light and Standard |
| D22 | At Deep rigor the approver receives the specification and the tests, not the implementer's reasoning |
| D23 | Each agent declares the role obligations it covers in a machine-readable list; closest-agent resolution reads that list, never free text |
| D24 | The routing checker reports the observed distribution of derived rigor over recent changes; trigger levels stay as the STRATEGY §6.6 table gives them |
| D25 | An assertion that depends on an optional diagnostic binary may self-skip with a visible warning, reported as not run (owner, STRATEGY §9); AGENTS.md §7 needs no amendment |
| D26 | Stubs return typed defaults where possible, else throw a marker error, and red means a failed assertion or the marker error from a stub the test reached; Deep work in a session with no coordinator or no available Test author is refused; Standard authorship stays with the implementer until T24 reports (§10); the success metric of D10 is a measured decrease (STATE) |

The tables below keep the options considered. Where a recommendation differs from the final answer above, the final answer governs.

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | Roster for review, backend, refactor, test, general | (a) create `review`, treat implementer as a role resolved to the closest specialist, drop the unbacked rows; (b) build agents under all five routed names; (c) keep the roster as is | (a), the owner's answer; `test-author` per D11. |
| **D2** | How `qa`'s equivalence rule changes | (a) STRATEGY + IMPLEMENTATION together satisfy it; (b) one operative file per standard that cites STRATEGY | (b), as `docs/standards/<domain>.md` (owner answer) |
| **D3** | How the strategy reaches the agents that operate the workflow | answered in §1A and §1E: one `workspace-standards` skill as the single source for every standard; role cards inlined by the brief; the `apply` and `review` verbs in the skill; a binding table plus a conformance checker proves coverage; roles, not names, in STRATEGY and IMPLEMENTATION | §1A. Remaining question: home STRATEGY and the skill in sox-ecosystem, each repo carries only IMPLEMENTATION |
| **D4** | AC, risk, and test plan in the backlog | (a) new store fields; (b) a documented body convention (§1F), checked by the filing boundary and a scanner | (b), the owner's direction: the backlog's structure stays as it is |
| **D5** | Binding for "the project's full gates" and routing | (a) a task-to-agent routing table in `AGENTS.md` plus a separate gate-runner capability row; (b) an IMPLEMENTATION table only | (a), the owner's answer |
| **D6** | How stage F runs | (a) a standing backlog review item per test group whose priority rises with signals, worked by `qa` when it reaches the top; (b) a CI cron producing a report; (c) the host `schedule` skill | (a), the owner's direction; the CI step only produces signals |
| **D7** | X-tier authorizer | product, security, or the repo owner | The repo owner, named in the IMPLEMENTATION; `security` for intrusive tests (owner answer) |
| **D8** | Reconcile the harness test standard | (a) delete it from `dispatch-contract` and point to the project's tier mapping; (b) keep a two-line summary that defers to IMPLEMENTATION | (a); keep the shared read-only scaffold as a technique, drop "one shared mutable scaffold" |
| **D9** | Reviewer for QA's removals and lowerings (F12) | (a) mechanical parity evidence recorded by QA and verified by a checker; (b) a guided review of QA's test edits, which the lifecycle currently forbids; (c) the one blind review also receives the audit records | (a), the owner's answer |
| **D10** | Rollout scope and order | (a) bind and build first, migrate last; (b) migrate first; (c) establish the system only and let it resolve the existing specs | (c), the owner's answer: "in theory the specs fix themselves through it. That will be the success metric of this plan" |
| **D11** | Where test authorship lives | (a) a new `test-author` agent with playbook cards by class; (b) playbooks on `qa`; (c) keep authorship with the implementer | (a). (b) breaks the rule that a party may not approve its own tests (STRATEGY §14); (c) is permitted below Deep but cannot meet the Deep requirement of separated authorship, so it leaves Deep unservable |
| **D12** | Default authorship mode by rigor (STRATEGY §14: required at Deep, the repository's choice below it) | (a) separated at Standard and Deep, implementer at Light; (b) separated only at Deep; (c) implementer at Light and Standard, separated only on request below Deep | (a), recorded in the IMPLEMENTATION; T24 measures the cost and can move the default |
| **D13** | Order of test author and implementer in a bucket | (a) tests first, then the implementation; (b) both in parallel against the architect's interfaces with disjoint write scopes; (c) tests after | (b), the owner's answer, with a sequential fallback when the spec leaves the interfaces open (§1B.4) |
| **D14** | How rigor reaches the actors | (a) one routing command bound as a capability, run by the dispatcher or the working agent, enforced by a checker; (b) a table the dispatcher reads; (c) agent judgment | (a): the only form that works unmediated and that a reviewer can trust |
| **D15** | Review debt when no second party exists | (a) unreviewed tests returned and filed as a follow-up item, cleared by a fresh `qa` dispatch; (b) human sign-off on every change; (c) accept the loss | (a), the owner's expectation and decision |
| **D16** | Approve the STRATEGY 0.2 amendments | read §6.1, §6.6, §6.7, §7.1, §8.2, §11, §13, §13.1, §13.2, §14 | read them; they are the portable half of this design |
| **D17** | Role availability | (a) the closest available eligible agent holds the role, recorded with its closeness evidence; unbound roles become review debt; Deep blocks without an independent holder (§1E.4); (b) fixed fallback chains; (c) fail when a routed name is missing; (d) require every role bound | (a), the owner's direction: a thin roster lowers the reported level instead of failing |
| **D18** | Skill shape | (a) one `workspace-standards` skill with verbs `run`, `apply`, `review` over foundation targets (`routing`, `gates`) and registered standards (`testing`, later others); a standard writes only its domain content unless it declares `routing: own` or `gates: own` (§1E); (b) a testing-only skill; (c) one skill per standard | (a), the owner's direction |

## 10. Suggested order of work

Scope (D10): the plan establishes the system and does not migrate existing tests; steps 7 and 8 below are the retention loop and the authorship path, and the 81 stub specs, 28 skip blocks, and fixed waits are left to that system.

1. **Unblock** (D1, D2, D11, F1–F3): roster names including `test-author`, `qa` equivalence, coverage target.
2. **Bind** (F4, F8, D5): `## Capabilities` with `test-gates`; tier set per lifecycle step.
3. **Reconcile the test standard** (F15, F17, D8).
4. **Ticket structure** (F6, D4): AC, risk, and test-plan fields; obligation templates.
5. **Author the IMPLEMENTATION**: tier mechanism, budgets, stage and gate bindings, risk map.
6. **Mechanisms**: G3 generalization, G4 scanner, AC-citation scanner (F5), flake reporter.
7. **Retention loop** (F9, F12, F16, D6, D9): standing review items and the signal step, report generator, `qa` audit criteria and parity evidence; the existing stub specs, skip blocks, and fixed waits are then resolved by the finished system (D10).
8. **Authorship and rigor** (F18–F22, D11–D15): the `test-author` agent and its cards, the parallel authoring and join protocol, the routing command, the ownership check, the unmediated block; then measure dispatch and token cost on a pilot of at least three buckets (T24). Until T24 reports, the IMPLEMENTATION sets Standard authorship to the implementer except on the pilot buckets and at Deep, so the default is not widened before it is measured.

## 11. Coverage of STRATEGY

Every clause id defined in `STRATEGY.md` v0.3 is placed in §4: P1–P14 (14), G1–G12 (12), R1–R6 (6), stages A–H (8), the eight §6.1 steps, and the sections §2.1–§2.4, §3, §4, §5, §6.2–§6.7, §7.2–§7.4, §8.1–§8.6, §9, §11, §12, §13, §13.1, §13.2, §14 . The ids were extracted from `STRATEGY.md` by script (`docs/testing/checks/cover.py`), not from a hand-kept list. The script takes an explicit allow-list of ids placed under another name and exits non-zero on any other missing id; the allow-list is `§7.1 → stage table (§4.4)`.

## 12. Provenance

- **0.9 (2026-10-07), APPROVED by the owner.** Mapped STRATEGY 0.4 after two more blind reviews: stub contract and Deep refusal in unmediated mode (§1B.4, §1C.4); the routing command checks class against write scope and reads asserted triggers (§1C.2); the report-producing run versus QA (§1A.5); pre-push placement recorded against the owner decision `8963c3cb` (F11); the G11 mechanism (§4.7); a pilot before the Standard default widens (§10); revisions read unified; D25 and D26.
- **0.8 (2026-10-07), DRAFT.** Revised after an independent review of STRATEGY 0.2, this map, and STATE 0.5 (dispositions in `REVIEW_TRIAGE.md`). Mapped STRATEGY 0.3 (G12, review debt, trigger table). Added D19–D24: second-party confirmation of QA's test edits (§2, swimlane step 12), interface stubs and assertion-level red evidence (§1B.4), disputes decided by the Auditor (§1B.4), a machine-readable capabilities declaration for closest-agent resolution (§1E.4), the rigor distribution report (§4.9), and the one engine for the checker and gate runner (§1A.6). Stage F moves on thresholds and has actions for clock-dependent work (§1G). The cost basis in §1A.7 names the document version it was measured at and is re-measured when used.
- **0.7 (2026-10-07), APPROVED.** Applied the owner's answers to the decisions round: parallel authoring and join protocol (§1B.4, D13); independence by session, so a fresh `qa` dispatch may audit (§1B.5, §1E.4, D11); implementer as a role with `typescript` not broadened (§1A.1, §1A.8, D1); a task-to-agent routing table in `AGENTS.md` and a context-aware gate runner with its own row (§1A.5, §1E.1, D5); `docs/standards/<domain>.md` as the repo-side file (D2); review debt as filed follow-up items (D15); migration out of scope (D10); STRATEGY homed in the harness repo (D3); all decisions closed (§9).
- **0.6 (2026-10-07), APPROVED.** Owner approval of the design with two adaptations. Routing and gates became foundation targets of the skill, separate from domain standards, and `apply <routing|gates|testing|...>` writes each unless a standard declares otherwise (§1E.1, §1E.2). Role holders are the closest available eligible agent, replacing fixed fallback chains (§1E.4, D17). The stage F bump uses `update` and `add-citation` because the CLI has no note verb (§1G). Counts re-measured with `git grep` on adhd `b76b4bed`: 81 stub files with 878 `it.todo`, 28 CPU-THRASH-SKIP blocks in 15 files, 103 `setTimeout` occurrences in 45 e2e files, 140 tracked e2e files. The installed-dispatcher difference is five appended host-binding lines.
- **0.5 (2026-10-07), DRAFT.** Added §1E (the `workspace-standards` skill and role-availability fallbacks), §1F (the testing record, with no backlog schema change), and §1G (stage F as demand-driven review); replaced the coverage target with a change-scoped efficacy standard (§1A.8); the roster guard now accepts declared unbound roles; findings F6, F9, F22 and decisions D3, D4, D6, D15 revised; D17 and D18 added.
- **0.4 (2026-10-07), DRAFT.** Mapped STRATEGY 0.2. Added the Test author role and its playbook cards (§1B), the three work modes and the routing command (§1C), class applicability across the lifecycle (§1D), the amended swimlane (§5), clauses added in 0.2 (§4.9), findings F18–F22, and decisions D11–D16. Corrected the claim that the strategy adds zero dispatches (§1A.3): it holds only at Light and None. Corrected the `qa` routing citation to `direct:30`. Sources newly read: `dispatch-direct`, `dispatch-plan`, and `dispatch-triage` in full.
- **0.3 (2026-10-07), DRAFT.** Added §1A, the operating model: portable roles, cost-ranked carriers, the five judgment points, the single gate runner, the conformance matrix, the architecture cost comparison, and suggested agent changes. F1 reclassified as a dispatcher roster defect.
- **0.2 (2026-10-07), DRAFT.** Remapped onto dispatcher 2.0.0 after it landed during analysis (sox-ecosystem `27be064c`, 10:57 local): the delivery lifecycle replaces merge-then-review; `qa` is routed and audits tests; ACs gate dispatch; a binary test standard is stated in `dispatch-contract` §1a. Findings F1, F4, F10, F12 were revised against the new text, and F15–F17 added.
- **0.1 (2026-10-07).** First mapping, against dispatcher 1.14.0.
- **Sources read:** `dispatcher.md` (all lines at the revision read, plus Step 5, rules 5, 15, 20, 23 at `27be064c`), `dispatch-contract`, `definition-of-ready`, `dispatch-direct`, `project` skills, `qa.md`, `backlog-operator.md`, test-related sections of `typescript`, `architect`, `debug`, `devops`, `product`, `performance`, `security`, `git-manager`, `agent-manager`, `researcher`, `architect-decision`, `doc-steward`; adhd `AGENTS.md`, `docs/PIPELINE.md`, `docs/decisions/0009-test-lanes-unit-vs-e2e.md`, `.githooks/pre-push`, `tools/gate/lane-gate.mjs`, `tools/vite-plugins/e2e-globs.mjs`, `entrypoint/backlog/skill/SKILL.md` §3–§4, `create-issue.ts`; `~/.claude/settings.json` hooks.
- **Installed copy:** `~/.claude/agents/dispatcher.md` is also v2.0.0. After the frontmatter it differs from the repo source by five appended lines, a "Resolved tool names (Claude Code)" section that binds `agent-catalog` and `memory` to their host tool names (compared 2026-10-07 with a line diff). It is host binding added at install, not drift. Line citations are to the repo source.
