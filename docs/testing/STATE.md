# STATE — testing strategy rollout

- **Version:** 0.7 (APPROVED by the owner 2026-10-07; the 49 tasks are filed as four backlog tickets, section 6)
- **Scope:** the work to take `STRATEGY.md` from an approved document to an enforced workflow in this repository (adhd), with the harness changes it needs (sox-ecosystem) and a second adopter to prove portability.
- **Inputs:** `docs/testing/STRATEGY.md` v0.4 and `docs/testing/STRATEGY_MAP.md` v0.9, both approved by the owner (operating model in §1A–§1G; findings F1–F22; decisions D1–D26); dispositions of the review findings in `docs/testing/REVIEW_TRIAGE.md`.
- **Source of truth:** the four backlog tickets in section 6 carry every task with its acceptance criteria and supersede this file from 2026-10-07; this file is kept until T57 removes it.
- **Roles, not names:** the task text names a *role*; the **Dispatch** column names the agent that currently holds the role (binding in `STRATEGY_MAP.md` §1A.1). STRATEGY and IMPLEMENTATION never name agents.
- **Acceptance criteria** carry stable ids (`T14.AC1`) and are binary and checkable; a test or check cites them by id. A task with no criteria is not dispatchable. **Polarity:** every check named below treats a violation as a non-zero exit and a clean input as exit 0 (a check built on `rg` inverts its exit status, since `rg` exits 1 when nothing matches).

Status values: `todo` · `blocked(<decision or task>)` · `in-progress` · `done`.

## 1. Decisions (D1–D18 answered by the owner in the design round; D19–D21 and D25 by the owner in the review rounds; D22–D24 and D26 decided by the author on the owner's instruction "you decide" and approved by the owner afterwards; record in `STRATEGY_MAP.md` §9)

| ID | Final answer | Drives |
|---|---|---|
| D1 | Create `review`; implementer is a role resolved to the closest specialist (not a broadened `typescript`); drop the `backend`, `refactor`, `general` routing rows; roster guard | T11, T12, T22 |
| D2 | `qa` cites STRATEGY and adopts one file per standard, `docs/standards/<domain>.md` (testing: `docs/standards/testing.md`) | T18, T02 |
| D3 | STRATEGY homes in the harness repo as the testing standard's policy; the IMPLEMENTATION becomes the `apply testing` template there | T57 |
| D4 | Backlog structure unchanged; the testing record is a body convention | T35, T33, T17 |
| D5 | Task-to-agent routing table in `AGENTS.md` (by name, from the capability roster); the gate runner keeps its own row (it knows the gates and applies them for the context; it releases nothing) | T03, T16, T49 |
| D6 | Stage F is a standing backlog review item per test group, priority raised by signals | T39, T05, T45 |
| D7 | The repo owner authorizes X-tier tests, named in the IMPLEMENTATION; `security` approves intrusive tests | T02 |
| D8 | Remove the binary test standard from `dispatch-contract`; inline role cards | T15 |
| D9 | QA removals checked by mechanical parity evidence (necessary condition; D19 adds a second party) | T39 |
| D10 | Establish the system only; migration of existing tests is out of this plan (stream S4); success metric: the system drives the existing specs to resolution | scope |
| D11 | Separate `test-author` agent; a fresh `qa` dispatch may audit it; a session never approves what it authored | T22, T23 |
| D12 | Separated authorship at Standard and above (required at Deep); implementer at Light | T02, T43 |
| D13 | Parallel authoring: test author and implementer run concurrently against fixed interfaces, joined by the dispatcher; sequential when interfaces are open | T23, T16 |
| D14 | Rigor reaches actors through one routing command bound as the `test-routing` capability, enforced by a checker | T43, T03, T16 |
| D15 | Review debt is returned as a filed follow-up item, cleared by a fresh `qa` dispatch | T45 |
| D16 | STRATEGY 0.2 amendments approved | T01, T02 |
| D17 | The closest available eligible agent holds a role; evidence recorded; unbound roles become review debt; Deep blocks without an independent holder | T47, T10 |
| D18 | One `workspace-standards` skill, verbs `run`, `apply`, `review`, over foundations (`routing`, `gates`) and standards; a standard writes only its domain content unless it declares `routing: own` or `gates: own` | T14, T48, T49 |
| D19 | QA's test edits, removals, and lowerings need the mechanical parity record **and** confirmation by a different party (a fresh `qa` dispatch); with no second party, review debt | T39, T16, T18 |
| D20 | Parallel authoring starts from interface stubs specified by the architect and committed and verified by the dispatcher on the bucket branch; red evidence is a failed assertion, not a missing symbol; open interfaces mean sequential | T19a, T22, T23 |
| D21 | A test dispute is decided once by the Auditor; review debt has an owner, a 14-day default expiry, and a failing check, and exists only at Light and Standard | T23, T45, T47 |
| D22 | At Deep rigor the approver receives the specification and the tests, not the implementer's reasoning | T18, T11 |
| D23 | Each agent declares the role obligations it covers in a machine-readable list; closest-agent resolution reads it | T14, T47, T11, T13, T18, T19a, T22 |
| D24 | The routing checker reports the observed distribution of derived rigor over recent changes | T43, T24 |
| D25 | An assertion depending on an optional diagnostic binary may self-skip with a warning, reported as not run | T34 |
| D26 | Typed-default or marker-error stubs; red means a failed assertion or the stub's marker error; Deep refused without a coordinator or Test author; Standard authorship stays with the implementer until T24; success of D10 is a measured decrease | T22, T23, T43, T44, T24 |

## 2. Work waves (what can run in parallel)

Waves are computed from each task's `depends` field (a task's wave is one more than the latest wave of its dependencies; decisions are wave 0). Tasks in one wave depend on nothing in that wave. Scopes below are at directory granularity: where two tasks in a wave share a path, the dispatcher's brief declares the write scope at file level or serializes them.

| Wave | Tasks | Notes |
|---|---|---|
| **0** | none: every decision from the design round is answered; D19–D24 are answered | no code |
| **1** | T01, T10, T11, T21, T35 | dependencies satisfied by earlier waves; no shared scope |
| **2** | T14, T17, T33 | dependencies satisfied by earlier waves; no shared scope |
| **3** | T10b, T15, T18, T19a, T19b, T19c, T22, T48, T62 | dependencies satisfied by earlier waves; shared scope to declare at file level or serialize: T48/T62 share `extensions/skills/workspace-standards/` |
| **4** | T30, T41, T47, T49 | dependencies satisfied by earlier waves; shared scope to declare at file level or serialize: T30/T41 share `tools/nx-plugins/test/` |
| **5** | T02, T13, T32, T36, T37, T38, T60 | dependencies satisfied by earlier waves; shared scope to declare at file level or serialize: T02/T60 share `docs/standards/testing.md`, T32/T36 share `tools/nx-plugins/test/executors/wiring/` |
| **6** | T12, T20, T31, T39, T43, T57, T61 | dependencies satisfied by earlier waves; shared scope to declare at file level or serialize: T31/T39 share `tools/nx-plugins/test/executors/wiring/`, T31/T43 share `tools/nx-plugins/test/executors/wiring/`, T39/T43 share `tools/nx-plugins/test/` |
| **7** | T03, T34, T40, T63 | dependencies satisfied by earlier waves; shared scope to declare at file level or serialize: T34/T63 share `tools/nx-plugins/test/` |
| **8** | T04, T05, T16, T44, T45, T46 | dependencies satisfied by earlier waves; shared scope to declare at file level or serialize: T04/T44 share `AGENTS.md`, T45/T46 share `tools/nx-plugins/test/` |
| **9** | T23, T42 | dependencies satisfied by earlier waves; no shared scope |
| **10** | T24, T64 | dependencies satisfied by earlier waves; no shared scope |

**Critical path** (longest dependency chain, computed from the `depends` fields): T01 → T14 → T62 → T41 → T02 → T43 → T03 → T16 → T23 → T24 (10 steps). Every other task is off the critical path.

## 3. Tasks

### Stream S1 — Strategy documents (adhd, `docs/testing/`)

**T01 · Ratify STRATEGY v0.4** — role: strategy owner · dispatch: `qa` · depends: D16, D19–D24 · scope: `docs/testing/STRATEGY.md` · status: `done` (owner approval 2026-10-07; no fourth blind review was run)
- T01.AC1 STRATEGY §13.1 defines the thirteen roles, each with its obligation expressed as existing clause ids and a role-to-clause index, and §6.1, §6.6, §6.7, §10, §11, §13.2, §14 carry the amended rules.
- T01.AC2 A name-independence script prints every backticked agent name found in `STRATEGY.md` (names read from the harness agent list, excluding the purpose-tag names defined in STRATEGY §2.3, read from that table) and exits non-zero if it prints any; it exits 0 on `STRATEGY.md` and non-zero on a copy seeded with `` `qa` ``. The command and both exit statuses are recorded on this task.
- T01.AC3 The clause-id coverage script, given the explicit allow-list `7.1 -> stage table (STRATEGY_MAP §4.4)`, exits 0 and prints no missing id; without the allow-list it exits non-zero naming §7.1. The command and exit statuses are recorded on this task.
- T01.AC4 `## Provenance` records the change and why; a blind review of v0.3 by a party other than its author is recorded, and the owner's approval is recorded.
- T01 evidence so far (the author's run on v0.3, not an approval; scripts in `docs/testing/checks/`, run from `docs/testing`): `python3 -I checks/names.py --also test-author --also review STRATEGY.md` prints `0 violations`, exit 0, and exits 1 on a copy with a line seeded with `` `qa` ``; `python3 -I checks/cover.py` prints `missing: ['§7.1']`, exit 1, and `python3 -I checks/cover.py 7.1` prints `missing: []`, exit 0.

**T02 · Draft the IMPLEMENTATION for this repository (`docs/standards/testing.md`)** — role: strategy owner · dispatch: `qa` (`adopt` playbook) · depends: T01, T41, T48 · scope: `docs/standards/testing.md` · status: `blocked(T01, T41, T48)`
- T02.AC1 Contains an element for each of the ten items STRATEGY §13 requires (tier mapping, stage mapping, gate mapping, decision-tree bindings, retention bindings, metrics bindings, risk map, migration plan or the deferral statement §13.8 allows, class and rigor bindings, delivery to roles), and for the qa-required sections not covered by them (case design, data and fixtures, environments, automation architecture, provenance).
- T02.AC2 A binding table has exactly one row per STRATEGY clause id, each with mechanism class (C0–C4), command or path, owning role, and status; the T41 completeness check exits 0 on it.
- T02.AC3 Names no agent: the T41.AC6 name-independence check exits 0 on it.
- T02.AC4 The risk map ranks this repository's failure modes with the covering tier, and the migration section states that existing tests are left to the finished system (D10) and cites the filed backlog items.
- T02.AC5 States a conformance level (L1, L2, or L3) equal to the level the T41 checker prints for it.
- T02.AC6 Contains the class and rigor bindings required by STRATEGY §13 item 9: the escalation triggers with the path patterns that detect them, the default change class for each of this repository's backlog item types, the rigor record's location, the rigor distribution report (D24), and authorship mode per class and rigor (D12).
- T02.AC7 States the slice-delivery table required by §13 item 10: for each role, the carrier (check, field, brief slice, or pulled card) and where it lives.
- T02.AC8 Names the X-tier authorizer (the repo owner, D7), the stage that sets each X enabling flag (G2), the H-tier provisioning command, and the gate-runner and routing-table bindings.
- T02.AC10 The binding table sits in a region marked hand-maintained, which `apply` never overwrites (T48.AC8).
- T02.AC9 Gives each undefined quantity of STRATEGY a value: the review-debt expiry, the retention window, the escape budget per rigor level, and the stage F signal thresholds and period.

**T03 · `## Capabilities` section with `test-gates` and `test-routing` in `AGENTS.md`** — role: record-keeper · dispatch: `doc-steward` reviews what `apply routing`, `apply gates`, and `apply testing` write · depends: T02, T30, T43, T48, T49 · scope: `AGENTS.md` · status: `blocked(T02, T30, T43, T48, T49)`
- T03.AC1 `AGENTS.md` has a `## Capabilities` table in the `project` skill's format: the role-resolution row written between the `workspace-standards:routing` markers, the gate-runner row between the `workspace-standards:gates` markers, and the `test-routing` row between the `workspace-standards:testing:capabilities` markers (written by `apply testing`, since classification is domain-specific).
- T03.AC2 The `test-gates` row names the command per lifecycle step (author loop, QA run, final run, mainline, release) and cites the IMPLEMENTATION table.
- T03.AC3 Each named command exits 0 when run on a clean tree.
- T03.AC4 A `test-routing` row binds the routing command (T43); the command exits 0 for a valid class and write-scope and non-zero for an unknown class.

**T04 · Retire the single-file strategy; ADR-0010** — role: strategy owner · dispatch: `qa` + `architect-decision` · depends: T02, T03 · scope: `docs/TEST-STRATEGY.md`, `docs/decisions/0010-*.md`, `docs/decisions/README.md`, `AGENTS.md` §7 pointers · status: `blocked(T02, T03)`
- T04.AC1 No two documents claim to be the repository's strategy; `docs/TEST-STRATEGY.md` is removed or reduced to a pointer, with its live-e2e and real-provider content carried into `docs/standards/testing.md`.
- T04.AC2 ADR-0010 records the tier model and states what it supersedes in ADR-0009 D1.
- T04.AC3 `check-lane-reachability.mjs` exits 0 afterward.

**T05 · Stage definitions in `docs/PIPELINE.md`** — role: mechanism owner · dispatch: `devops` · depends: T02, T39, T40, T41 · scope: `docs/PIPELINE.md` · status: `blocked(T02, T39, T40, T41)`
- T05.AC1 Stages A–H are defined with budgets and owners; stage F is defined as the signal step, the priority ladder, the standing review items, and their owner and failure route.
- T05.AC2 Every stage names the command it runs, and the T41 reachability check passes.

### Stream S2 — Harness (sox-ecosystem; file in that repository's backlog)

**T10 · Name-resolution guard (item `3fe895f3`)** — role: mechanism owner · dispatch: `typescript` · depends: none · scope: `tools/test-roster-guard.mjs` · status: `todo`
- T10.AC1 Parses the dispatcher's routing rows and the task-to-agent routing table in `AGENTS.md` (once it exists) and exits non-zero for every routed agent name that matches no installed extension.
- T10.AC2 It is red on `27be064c`, naming `review`, `backend`, `refactor`, `test`, `general`.
- T10.AC3 A negative control (a fixture roster with one valid and one invalid name) passes and fails as expected.
- T10.AC4 Registered with the repository's test runner so it runs by default.

**T10b · Role-resolution guard** — role: mechanism owner · dispatch: `typescript` · depends: T14 · scope: `tools/test-roster-guard.mjs` · status: `blocked(T14)`
- T10b.AC1 For each role in `roles.md`, exits 0 when the role resolves to a closest eligible agent by the `roles-covered` declarations (D23) or is declared unbound, and non-zero when it does neither; a fixture roster missing one agent proves all three outcomes.
- T10b.AC2 Run on the real roster after the agent edits it exits 0 (this is checked by T12.AC4).

**T11 · New `review` agent (static and blind modes)** — role: static reviewer · dispatch: `agent-manager` · depends: none (D1 answered) · scope: `extensions/agents/review/` · status: `todo`
- T11.AC1 The agent has no edit or write tools.
- T11.AC2 Static mode returns findings by severity with `file:line` evidence; blind mode accepts only a diff and the instruction "Review".
- T11.AC3 A golden-set A/B against a baseline is recorded per `agent-manager` §7.
- T11.AC4 The install verification passes on every declared host.
- T11.AC5 The agent declares `roles-covered` (the role obligation ids it covers, D23); in blind mode at Deep rigor it receives the specification and the tests, not the implementer's reasoning (D22).

**T12 · Dispatcher routing fix** — role: verifier · dispatch: `agent-manager` · depends: T10, T10b, T11, T13, T22, T49 · scope: `extensions/agents/dispatcher/dispatcher.md`, `extensions/skills/dispatch-direct/SKILL.md` · status: `blocked(T10, T10b, T11, T13, T22, T49)`
- T12.AC1 No routing row names an agent without an extension (the T10 check exits 0).
- T12.AC2 Test running and audit route to the auditor role's agent; static and blind review route to the new reviewer; test planning and authoring route to the Test author's agent; implement and refactor route to the closest specialist per the routing table (for example `typescript` or `ui`); no row names `general`.
- T12.AC3 `tools/test-dispatcher-ac-citation.mjs` still exits 0.
- T12.AC4 No routing row in `dispatcher.md` names the undefined `test` agent, and the T10b check exits 0 with the test-authoring route resolving to the Test author's agent. Precedence: the task-to-agent table in `AGENTS.md` (T49) wins; the dispatcher's rows are defaults used only when no table exists.

**T13 · Replace `typescript`'s coverage target with a change-scoped efficacy standard** — role: author · dispatch: `agent-manager` · depends: T14, T49 · scope: `extensions/agents/typescript/typescript.md` · status: `blocked(T14, T49)`
- T13.AC1 `! rg -q "coverage exceeding" typescript.md` exits 0 (no such text remains).
- T13.AC2 Its testing section states the change-scoped standard: every behavior a change adds or alters has a test that fails when that behavior is deliberately broken (seeded fault or diff-based mutation run), and changed lines left uncovered or surviving are reported per change. It contains no repository-wide percentage target.
- T13.AC3 The body states default tier S and the header and citation duties, by reference to the Light-rigor implementer card, and states that it never edits, skips, or deletes a test it did not author.
- T13.AC4 The description keeps its current scope: implementation and refactor tasks reach specialists through the routing table (T49), not through a broadened description. A golden-set A/B shows no regression on the existing type-system tasks.
- T13.AC5 The agent declares `roles-covered` (D23).

**T14 · `workspace-standards` skill (registry, verbs, `testing` standard)** — role: strategy owner · dispatch: `agent-manager` · depends: T01, D18 · scope: `extensions/skills/workspace-standards/` · status: `blocked(T01)`
- T14.AC1 A registry lists the foundations `routing` and `gates` and each standard with its status; `testing` is present and `deployment`, `implementation`, `documentation`, `organization`, `styling` may be listed as planned.
- T14.AC2 A standard contract states what a standard must provide to register: a portable policy naming no agent; a machine-readable declaration of its roles (obligations, tools needed, independence constraints), work classes, and gates (id, threshold, mechanism, stage); a carrier per clause; a conformance specification a script can run; an `apply` template; and optional `routing: own` or `gates: own`.
- T14.AC3 `/workspace-standards <review|run|apply> <target>` loads that target's playbook for that verb for a foundation or a standard; an unknown target or a verb the target lacks is a named error, not a silent default.
- T14.AC4 The `testing` standard has role cards (classifier, implementer-at-Light, static reviewer, auditor, triager) and the seven Test-author playbook cards (`plan-bucket`, `author-new-behavior`, `author-regression`, `author-contract`, `characterize`, `select-checks`, `maintain`); each is ≤4096 bytes (`wc -c`) and cites STRATEGY clause ids only.
- T14.AC5 The `testing` standard has playbooks for `run`, `apply`, `review`, `retention-audit`, and `flake-triage`; each ends in a recorded artifact.
- T14.AC6 Formats for the test header, audit record, escape record, removal record, and the testing record (MAP §1F).
- T14.AC7 `roles.md` lists, per role, its obligations (with ids), the tools it needs, its independence constraints, optional tie-break hints, and the no-holder outcome (MAP §1E.4); the T10 guard validates every name in it.
- T14.AC8 `review all` iterates the registry and reports each registered standard that lacks a playbook, a conformance specification, or an `apply` template; a seeded planned standard produces a finding.
- T14.AC9 Installs on claude and opencode.
- T14.AC11 A recorded reuse decision, with a memory and search check first, compares the existing `tools/gate/lane-gate.mjs`, `check-lane-reachability.mjs`, and Nx target orchestration, and one third-party option for managed blocks, before T62 and T48 build anything.
- T14.AC10 A `roles-covered` declaration schema (obligation ids drawn from `roles.md`) is defined, and `review routing` reports an agent with no declaration (D23).

**T15 · `dispatch-contract`: inline role cards, return fields, review and audit briefs** — role: verifier · dispatch: `agent-manager` · depends: T14, D8 · scope: `extensions/skills/dispatch-contract/` · status: `blocked(T14)`
- T15.AC1 The binary test standard is replaced by an instruction to inline the role's card and the project's tier-mapping excerpt.
- T15.AC2 The return block gains `tier:` and `tests-obsoleted:`; a pin test covers both.
- T15.AC3 The static-review brief tells the reviewer to check tier and gap validity; the audit brief carries R1–R6 and the audit record format.
- T15.AC4 `! rg -q "one shared scaffold" SKILL.md` exits 0 (no such text remains).
- T15.AC5 The brief gains `test-authorship:`, `rigor`, and `playbook`; the return block gains `red:` and `test-dispute:`; a pin test covers each.
- T15.AC6 `contract:17` and `contract:35` no longer assume the executor writes the tests: the citation duty attaches to whoever writes a test, and the test standard rides the briefs of test-writing roles only.

**T16 · Dispatcher and `dispatch-direct`: bind the gate set, require a test plan** — role: verifier · dispatch: `agent-manager` · depends: T15, T03 · scope: `dispatcher.md`, `dispatch-direct/SKILL.md` · status: `blocked(T15, T03)`
- T16.AC1 Step 5.6 and 5.8 read their commands from the `test-gates` capability.
- T16.AC2 Definition-of-ready includes "test plan present" for any item that changes behavior.
- T16.AC3 Test-writing, review, and audit briefs inline the role card.
- T16.AC4 For each bucket the dispatcher runs the `test-routing` command and fills `rigor`, `test-authorship`, and `playbook` in every brief of the bucket.
- T16.AC5 For a separated-authorship bucket the dispatcher first commits and verifies the stub commit (T23.AC7), then dispatches the Test author and the implementer together with disjoint declared write scopes; at the join it verifies from the branch that each diff touches only its declared paths, merges, and runs the tests (rule 15's red is the Test author's evidence against the base commit); a bucket whose spec leaves interfaces open runs the Test author first.
- T16.AC6 A bucket whose items are all class None dispatches no static review and no QA, and the telemetry row says so; the final run and release still run.
- T16.AC7 When `qa` edited, removed, or lowered any test, the dispatcher dispatches a fresh `qa` confirmation (given the audit record, the parity evidence, and the test-file diff only) before the final run, and the telemetry row names both dispatches; with no second party eligible it records review debt with an owner and an expiry (D19).

**T17 · Filing boundary: the testing record** — role: record-keeper · dispatch: `agent-manager` · depends: T35 · scope: `extensions/skills/definition-of-ready/SKILL.md`, `extensions/agents/backlog-operator/backlog-operator.md` · status: `blocked(T35)`
- T17.AC1 The filing-boundary subset checks the item body for a `## Testing record` section with a valid `change-class`, `ac:` ids, `not-testing:`, and `plan:` (MAP §1F).
- T17.AC2 `backlog-operator` returns ESCALATE when a behavior-changing item lacks them.
- T17.AC3 `backlog-operator` refuses to file an item whose record has no valid `change-class` (one of the eight values in STRATEGY §6.1.1).
- T17.AC4 No file under `entrypoint/backlog/src/` changes (the backlog's structure is used as it is).

**T18 · Auditor persona: adopt IMPLEMENTATION, not a single file** — role: strategy owner · dispatch: `agent-manager` · depends: T14, D2 · scope: `extensions/agents/qa/qa.md` · status: `blocked(T14)`
- T18.AC1 The equivalence rule no longer requires `docs/TEST-STRATEGY.md`; it adopts the repository's IMPLEMENTATION and cites STRATEGY.
- T18.AC2 The body points at the `adopt`, `conformance`, `retention-audit`, and `flake-triage` playbooks.
- T18.AC3 A golden-set A/B shows it still refuses unmeasured claims.
- T18.AC4 Its audit brief tells it to refuse to audit tests whose authorship record names its own dispatch, and to record the independence check in the audit record.
- T18.AC5 A confirm mode accepts only the audit record, the parity evidence, and the test-file diff, and declines to confirm edits made by its own session (D19); it declares `roles-covered` (D23).
- T18.AC6 It adjudicates a `test-dispute:` once and records the outcome for the risk owner (D21).

**T19a · Planner edit** — role: planner · dispatch: `agent-manager` · depends: T14, T35 · scope: `architect.md` · status: `blocked(T14, T35)`
- T19a.AC1 The spec names interfaces and contracts at every boundary and any escalation trigger it sees, and no longer lists tests.
- T19a.AC2 For a bucket with separated authorship its spec includes the stub files (compiling, interfaces only, every body throws "not implemented"); it does not commit them, because the bucket branch does not exist when it specs and it has no commit permission (D20).
- T19a.AC3 It declares `roles-covered` (D23).

**T19b · Risk owner edit** — role: risk owner · dispatch: `agent-manager` · depends: T14, T35 · scope: `product.md` · status: `blocked(T14, T35)`
- T19b.AC1 `product` writes `change-class` on each ticket while grouping, accepts or rejects the "not testing" list at Deep, and its verification reference names a role, not a missing agent.
- T19b.AC2 It declares `roles-covered` (D23).

**T19c · Triager edit** — role: triager · dispatch: `agent-manager` · depends: T14, T35 · scope: `debug.md` · status: `blocked(T14, T35)`
- T19c.AC1 The defect report records the earliest tier and stage that could have caught the defect.
- T19c.AC2 It declares `roles-covered` (D23).

**T20 · A/B validation of every edited agent** — role: strategy owner · dispatch: `agent-manager` · depends: T11, T13, T18, T19a, T19b, T19c, T22 · scope: `agent-manager` golden-set artifacts · status: `blocked(T11, T13, T18, T19a, T19b, T19c, T22)`
- T20.AC1 A recorded golden-set result for each edited agent.
- T20.AC2 No agent shows a regression against its baseline.

**T21 · File the `performance` / `performance-engineer` duplicate** — role: record-keeper · dispatch: `backlog-operator` · depends: none · status: `done` (the item already exists: `9a866182`, found by a dedupe search on 2026-10-07)
- T21.AC1 One deduped item exists in the sox-ecosystem backlog with both extensions cited (`9a866182`).

**T22 · New `test-author` agent: the Test author** — role: test author · dispatch: `agent-manager` · depends: T14, D1, D11 · scope: `extensions/agents/test-author/` · status: `blocked(T14)`
- T22.AC1 The agent's body forbids editing production code and states the write scope it received; a golden-set case shows it refusing a seeded brief that asks it to edit a production path. (Mechanical enforcement of the same rule is T16.AC5 and T46.)
- T22.AC2 Each of the seven playbook cards is ≤4096 bytes and is the only strategy text the brief inlines for it.
- T22.AC3 The `plan-bucket` card limits a dispatch to five items and says larger buckets are split by cohesion; the authoring cards say one bounded dispatch per unit, fan out above five units, and stop and return the remaining list after about 100 sequential tool calls.
- T22.AC4 The agent's output for an authoring unit includes `red:` evidence taken against the stub commit: the command, the non-zero exit, and for each test either the failing assertion or the marker error raised by a stub it reached; a record whose failure is a missing symbol or a compile error is rejected by the T23.AC8 check.
- T22.AC5 A golden-set A/B against a baseline of the implementer writing the same tests is recorded per `agent-manager` §7: on a fixed set of at least five seeded faults, the count of faults each set of tests catches is recorded, and the separated tests catch at least as many as the baseline.
- T22.AC6 The agent declares `roles-covered` (D23) and owns test support code (fakes, fixtures, builders) by declared file, even where it lives beside production code.

**T23 · Parallel authoring and join protocol in the dispatcher and contract** — role: verifier · dispatch: `agent-manager` · depends: T15, T16, T22, T19a, D13, D20, D21 · scope: `dispatcher.md` rule 15 and Step 5.3, `dispatch-contract`, `dispatch-direct` · status: `blocked(T15, T16, T22, T19a)`
- T23.AC1 Rule 15 states that red evidence is the Test author's (recorded against the bucket's stub commit) and green evidence is the join run's, and both are recorded on the item.
- T23.AC2 The implementer brief for a separated bucket carries "do not edit, skip, or delete a test you did not author"; its write scope is production paths and the stub files, and the Test author's is test paths and test support files, each declared by file.
- T23.AC3 A `test-dispute:` return makes the dispatcher route the text to a fresh `qa` dispatch that decides once; the dispute does not consume the retry ladder, and a second dispute on the same test is refused and escalated to the risk owner.
- T23.AC4 `tools/test-dispatcher-ac-citation.mjs` still exits 0.
- T23.AC5 A walkthrough of one real bucket records the stub commit, the concurrent dispatch, the red run, the join run, and one dispute round trip, with the commands and exit codes.
- T23.AC6 A bucket whose spec leaves the interfaces open runs sequentially (Test author first), and the brief says why.
- T23.AC7 Before dispatching a separated pair the dispatcher applies the spec's stub files to the bucket branch, commits them as the stub commit, and verifies that the commit compiles and touches only stub files; it refuses to dispatch the pair otherwise, and seeded buckets with no stubs, with a non-compiling stub, and with a stub that edits a non-stub file prove the refusals.
- T23.AC8 A check rejects a `red:` record whose failing output is a missing-symbol or compile error, or that names neither a failed assertion nor the marker error of a stub the test reached; seeded records of each kind fail, and a valid record of each accepted kind passes.
- T23.AC9 The stub contract is stated in the architect's brief and the Test author's card: typed defaults where the language allows, else a marker error that the check can recognise.

**T24 · Measure the cost of separated authorship** — role: auditor · dispatch: `qa` · depends: T23, T43 · scope: one measurement record under `docs/testing/` · status: `blocked(T23, T43)`
- T24.AC1 On a pilot of at least three real buckets (at least one with four or more items), the record gives dispatch counts and token totals from the dispatcher's telemetry rows for implementer-authored and separated-authored runs.
- T24.AC2 The record states which numbers are measured and which are not; nothing is estimated.
- T24.AC3 The record gives a decision on D12: keep, tighten, or relax the default.
- T24.AC4 The record includes the observed distribution of derived rigor from the T43.AC6 report, and says what share of changes carry separated authorship.

**T47 · Role availability: closest available agent in the dispatcher** — role: verifier · dispatch: `agent-manager` · depends: T10b, T14, D17, D23 · scope: `dispatcher.md`, `dispatch-direct/SKILL.md`, `dispatch-plan/SKILL.md` · status: `blocked(T10b, T14)`
- T47.AC1 The dispatcher resolves each role by the rule in MAP §1E.4 (eligibility by tools and independence constraints, then closeness by the `roles-covered` declarations, then fewest other roles held); the hints in `roles.md` only break ties and free-text descriptions are never scored (D23).
- T47.AC2 The chosen agent and its closeness evidence, or the unbound role, are named in the dispatch's telemetry row.
- T47.AC3 An unbound role records review debt (owner, expiry) on the affected tests at Light and Standard; at Deep rigor with no independent holder the change is blocked and the block is reported.
- T47.AC4 A seeded roster with `review` removed completes a Light change with review debt recorded, picks the closest eligible read-only agent for a Standard change (a fresh `qa` dispatch is eligible; a `qa` session that authored the tests is not), and blocks a Deep change when none is eligible.
- T47.AC5 `tools/test-dispatcher-ac-citation.mjs` still exits 0.

**T48 · `apply testing`: generate the testing-specific repo side** — role: strategy owner · dispatch: `typescript` · depends: T14, D14, D18 · scope: `extensions/skills/workspace-standards/` testing templates and scripts · status: `blocked(T14)`
- T48.AC1 Run on a repository, it writes between `workspace-standards:testing` markers in `AGENTS.md` only the testing-specific parts: the testing block of at most 12 lines, the `test-routing` capability row, and the class table behind it; and it writes the IMPLEMENTATION skeleton with the binding table to `docs/standards/testing.md`.
- T48.AC2 It does not write routing rows, `roles.md`, or gate bindings unless the testing declaration says `routing: own` or `gates: own`; a fixture declaration proves both outcomes.
- T48.AC3 A second run produces no change (`git diff --exit-code` exits 0).
- T48.AC4 A hand edit inside the managed block is reported as drift by `review testing` and not overwritten without a flag.
- T48.AC5 For each mechanism it cannot write (a checker, a hook), it files one backlog item through the backlog CLI instead of editing code.
- T48.AC6 A dry-run flag prints the diff and writes nothing.
- T48.AC8 The binding table is written inside a hand-maintained region that `apply` creates once and never overwrites; a second run leaves a filled-in table untouched.
- T48.AC7 It runs unchanged on a second repository (sox-ecosystem) and on a fixture repository with no `AGENTS.md`.

**T49 · `apply routing` and `apply gates`: the foundation targets** — role: strategy owner · dispatch: `typescript` · depends: T14, T62, D17, D18 · scope: `extensions/skills/workspace-standards/` foundation templates and scripts · status: `blocked(T14, T62)`
- T49.AC1 `apply routing` writes between `workspace-standards:routing` markers: a task-to-agent routing table in `AGENTS.md` mapping every task a registered standard defines to agents in the capability roster by name, `roles.md`, and the capability rows that expose role resolution, composed from the roles and tasks that every registered standard declares.
- T49.AC2 `apply gates` writes between `workspace-standards:gates` markers: the gate registry, the stage bindings, and the capability row for one domain-neutral gate runner, composed from the gates that every registered standard declares. The runner is the T62 engine; a standard's gate set (testing's is `test-gates`) is run through it and appears in its single report; no standard adds a runner of its own.
- T49.AC3 Adding a second fixture standard with its own roles and gates changes the generated routing and gates blocks and no testing-specific text (a diff proves it).
- T49.AC4 A standard declaring `routing: own` or `gates: own` is skipped by the matching foundation target and reported as such.
- T49.AC5 A second run produces no change; a hand edit inside a block is reported as drift by `review routing` or `review gates`.
- T49.AC7 The routing table written by `apply routing` states the precedence over the dispatcher's own rows (the table wins) and is validated by the T10 guard.
- T49.AC6 For each gate whose mechanism does not exist, it files one backlog item through the backlog CLI instead of writing code.

**T62 · Gate and check engine (harness-owned)** — role: mechanism owner · dispatch: `typescript` · depends: T14, D18 · scope: `extensions/skills/workspace-standards/engine/` · status: `todo`
- T62.AC1 One command reads a repository command table (gate id, command, stage, mechanism class) and runs a named gate set for a lifecycle step, a change class and rigor, and changed paths; it selects the gates that have something to check and relaxes none by class (STRATEGY §6.7).
- T62.AC2 It writes one JSON report and exits with the worst gate's status; it releases nothing.
- T62.AC3 It contains no build-tool knowledge: the same command runs against a fixture table in a directory with no `nx.json`, and a seeded failing command makes the exit non-zero and the report name it.
- T62.AC5 It is built from the reuse decision of T14.AC11 and says in its README which existing tool it reuses and which it replaces.
- T62.AC4 It exposes the generic check entry points that T41 fills (completeness, liveness, reachability, teeth).

**T63 · Metrics, exception-log, and G11 producers** — role: mechanism owner · dispatch: `typescript` · depends: T30, T35, T39 · scope: `tools/nx-plugins/test/` · status: `blocked(T30, T35, T39)`
- T63.AC1 The `test-gates` report or a scheduled report produces signal precision, escape rate by tier, escape rate by class and rigor level, and change-failure rate and lead time, each from named recorded fields (the escape record, the rigor record) and each labelled "not measured" when its field is absent.
- T63.AC2 A check reads the exception items (`expires:` lines) and fails the signal job for an exception past its date or a deferral (STRATEGY §7.3) with no expiry or review date.
- T63.AC3 A check fails a change that touches test-infrastructure paths unless its record cites STRATEGY and the exception log (G11); a seeded change without the citation fails and one with it passes.
- T63.AC4 STRATEGY §12 (data, fixtures, automation architecture) is carried by the IMPLEMENTATION sections of T02.AC1 and checked by static review; the task records that it adds no mechanical check for it.

**T64 · Release the harness changes** — role: verifier · dispatch: `devops` · depends: T11, T12, T13, T14, T15, T16, T18, T19a, T19b, T19c, T22, T23, T47 · scope: sox-ecosystem release files · status: `blocked(T11, T12, T13, T14, T15, T16, T18, T19a, T19b, T19c, T22, T23, T47)`
- T64.AC1 The new `review` and `test-author` agents, the `workspace-standards` skill, and the edited agents and skills are versioned, listed in the changelog, and installed to every declared host.
- T64.AC2 The installed `dispatcher` carries the new routing and lifecycle text (a line diff of the installed and repository copies shows only the host-binding lines).

### Stream S3 — Project mechanisms (adhd)

**T30 · This repository's command table and Nx target for the engine** — role: mechanism owner · dispatch: `typescript` + `devops` · depends: T62 · scope: `tools/nx-plugins/test/` and one nx target · status: `blocked(T62)`
- T30.AC1 A repository command table binds each gate id to this repository's command, stage, and mechanism class, and the T62 engine runs the named gate set from it (the testing standard's is `test-gates`), writing one JSON report (per-tier pass and fail, per-test duration, skip and `todo` counts, quarantine, header-lint results).
- T30.AC2 The exit code is the worst gate's.
- T30.AC3 A seeded failing test makes the exit non-zero and the report names it.
- T30.AC4 The nx cache is honored (a second run is a hit; evidence is the cache line, never `--skip-nx-cache`).

**T31 · Tier map; generalize G2 and G3** — role: mechanism owner · dispatch: `typescript` · depends: T02, T30 · scope: `tools/vite-plugins/`, `tools/nx-plugins/test/executors/wiring/` · status: `blocked(T02, T30)`
- T31.AC1 Every test file maps to exactly one of S, P, H, X by a single source of truth.
- T31.AC2 A seeded S-tier test that spawns a process fails the check in any project, not only the agent family.
- T31.AC3 The `pendingMove` baseline can only shrink (a negative control proves it).

**T32 · G4 skip and `todo` expiry scanner** — role: mechanism owner · dispatch: `typescript` · depends: T30 · scope: `tools/nx-plugins/test/executors/wiring/` · status: `blocked(T30)`
- T32.AC1 A `skip`, `todo`, or disabled marker without a tracking item and a date fails.
- T32.AC2 A marker past its date fails; a marker within its date passes.
- T32.AC3 The scanner reports the current counts of stub specs and `it.todo` as it measures them at run time, with the commit it ran on, and records them as its baseline; the counts in section 4 are the ones observed when the items were filed.

**T33 · G6 AC-citation scanner** — role: mechanism owner · dispatch: `typescript` · depends: T35 · scope: `tools/nx-plugins/test/` · status: `blocked(T35)`
- T33.AC1 For a fixture ticket with AC1–AC3 and tests citing only AC1 and AC2, the scanner reports AC3 uncovered and exits non-zero.
- T33.AC2 One test citing several ACs and tickets counts for each.
- T33.AC3 The scanner reads the `ac:` ids from the item body through the existing `get` verb with `fields:["body"]` (documented at `SKILL.md:390-391`); a fixture proves the round trip through the real store.

**T34 · G9 header lint** — role: mechanism owner · dispatch: `typescript` · depends: T31 · scope: `tools/nx-plugins/test/` · status: `blocked(T31)`
- T34.AC1 A P, H, or X test without a tier and a one-sentence fidelity-gap statement fails.
- T34.AC2 An S test needs no gap statement and passes.
- T34.AC3 The header accepts `authorship: separated` or `authorship: implementer` and rejects any other value; a header with no `authorship` field is treated as implementer-authored legacy.
- T34.AC4 A tier S test whose header lacks a failure mode or a tier fails (G12); the gap statement is still not required for tier S.

**T35 · Backlog: document the testing-record convention and evidence obligation (no schema change)** — role: record-keeper · dispatch: `typescript` · depends: none (D4 answered) · scope: `entrypoint/backlog/skill/SKILL.md`, one test file · status: `todo`
- T35.AC1 `SKILL.md` documents the `## Testing record` grammar (MAP §1F): the eight `change-class` values, `rigor`, `triggers`, `ac:` ids, `not-testing:`, `plan:`, `expires:`.
- T35.AC2 A test creates an item with the record through the CLI, reopens the store, and reads the record back through `get` and `query`.
- T35.AC3 An evidence obligation template for `regression-test` using the existing obligation kind is documented (presence only, per F7).
- T35.AC4 Exception and retention items are documented as ordinary items: an exception carries an `expires:` line and a relation to the item it excuses.
- T35.AC5 `git diff --name-only` over `entrypoint/backlog/src/` excluding test files is empty: no schema or verb change.

**T36 · G5 flake reporter, quarantine, no permanent retry** — role: mechanism owner · dispatch: `typescript` · depends: T30 · scope: runner config, `tools/nx-plugins/test/` · status: `blocked(T30)`
- T36.AC1 A repeat-run mode reports any test with both outcomes on the same code.
- T36.AC2 A quarantine registry excludes a test from the gating run, still runs and reports it, and fails past its deadline.
- T36.AC3 A scan fails any runner config that sets a retry without a tracking item.

**T37 · G7 per-tier budgets and duration report** — role: mechanism owner · dispatch: `devops` · depends: T30 · scope: runner config · status: `blocked(T30)`
- T37.AC1 Each tier has an enforced per-test timeout.
- T37.AC2 The report lists tests over budget; a seeded over-budget test is listed and fails the gate at the configured severity.

**T38 · G8 changed-code efficacy** — role: mechanism owner · dispatch: `researcher` then `typescript` · depends: T30 · scope: decision record, then runner config · status: `blocked(T30)`
- T38.AC1 A decision record compares candidate mutation or coverage-on-diff tools from live sources, with the memory check first per the DRY rule.
- T38.AC2 The chosen tool runs diff-based on changed S-tier code and reports survivors.
- T38.AC3 No repository-wide percentage threshold is added.

**T39 · Test-group signals and demand-driven stage F** — role: mechanism owner · dispatch: `devops` · depends: T30, T36, T37, D6, D9, D19 · scope: `.github/workflows/`, `tools/nx-plugins/test/` · status: `blocked(T30, T36, T37)`
- T39.AC1 The `test-gates` report lists, per test group, the signals with their counts for the IMPLEMENTATION's period: changes that touched it, tests over budget, flakes, skips or `todo` past their date, and open unreviewed-tests items.
- T39.AC2 A CI step on mainline push sets the group's standing review item priority from the period's signal counts (computed from the counts, not incremented, so a repeat run or a second writer yields the same priority; a touch alone does not raise it), using the existing backlog `update` (priority only; the item's uid is unchanged, proven by a test) and `add-citation` (context names the run id and signal) verbs; re-running the same run id changes nothing; the priority never exceeds the top step.
- T39.AC3 One open standing review item exists per group at base priority; resolving it re-creates it at base priority.
- T39.AC4 An item at the top for longer than the IMPLEMENTATION's limit makes the signal job exit non-zero and files an escalation item assigned to the risk owner; the job is a scheduled or mainline-push job and is not a merge gate.
- T39.AC9 The dispatcher's status table lists the standing items at or near the top, so the work is surfaced where `qa` is dispatched.
- T39.AC5 The retention report contains per-test duration, flake count, skip age, tier, shape by count and by time, and (when available) per-test uniqueness.
- T39.AC6 QA removals require a recorded parity proof, checked mechanically (D9), and a confirmation record from a different party (D19); a removal with either missing fails.
- T39.AC7 The period is a rolling window of N days set in the IMPLEMENTATION and evaluated by the signal job; a period with no threshold crossing lowers the item one step, and working the item resets it to base priority; a test fixture shows the priority rising and falling.
- T39.AC8 A scheduled CI job runs the T36 repeat-run mode at the IMPLEMENTATION's period; sampled mutation analysis (T38) and capped X smoke each have a scheduled job or a named action on the standing item, or an exception item with an expiry exists for each.

**T40 · Stage subsets: pre-push smoke, full mainline, release** — role: mechanism owner · dispatch: `devops` · depends: T31 · scope: `.githooks/`, `.github/workflows/`, runner config · status: `blocked(T31)`
- T40.AC1 `smoke` and `contract` tags are defined with strict tags enabled.
- T40.AC2 Pre-push runs affected S only, as `AGENTS.md` and backlog `8963c3cb` require; the P `smoke` subset runs at presubmit (stage D), and the IMPLEMENTATION records the pre-push placement as a standing decision with a review date (STRATEGY §7.3). If the owner lifts `8963c3cb`, `check-lane-reachability.mjs` is updated in the same change.
- T40.AC3 Once item `59ae45f9` is resolved or has a named root cause, mainline runs the whole repository (not only affected) for S, P, and H, and reports selection escapes.
- T40.AC4 The release stage runs S, P, and H and the `smoke` and `contract` subsets against the built artifact.
- T40.AC5 Mainline runs H over the whole integrated state, and the H lane's provisioning command is defined and exercised by that lane.
- T40.AC6 Each X-tier enabling flag is set by at least one named stage, and a test with the flag unset is reported as not run; with the flag set and a credential missing the run fails.

**T41 · `strategy-conformance` checks (generic checks in the T62 engine, testing checks in this repository)** — role: mechanism owner · dispatch: `typescript` · depends: T14, T62 · scope: the engine's `checks/` directory and `tools/nx-plugins/test/` · status: `blocked(T14, T62)`
- T41.AC1 Completeness: every clause id in `STRATEGY.md` has exactly one binding row; a seeded missing row fails.
- T41.AC2 Liveness: every referenced path and command exists; a seeded dead path fails.
- T41.AC3 Reachability: the stage a gate is bound to invokes it; a seeded unbound gate fails.
- T41.AC4 Teeth: each mechanical gate has a seeded-violation fixture it must fail on; a gate without one fails.
- T41.AC5 Reports L1, L2, or L3 from the passing rows (an obligation without a mechanism counts toward no level); runs at stage E and whenever `/workspace-standards review testing` is invoked.
- T41.AC6 Name independence: `STRATEGY.md` and the IMPLEMENTATION contain no backticked name drawn from the harness's agent list (read from that list), excluding the purpose-tag names read from STRATEGY §2.3; the check exits non-zero on a violation, and a seeded `` `qa` `` fails. Run against fixtures here; T02.AC3 runs it on the real IMPLEMENTATION.
- T41.AC7 Lists every unbound role and the clauses left to review debt, and lowers the reported level accordingly (seeded roster missing `review` shows it).
- T41.AC8 The generic checks (completeness, liveness, reachability, teeth) live in the engine and run for every registered standard through `review gates`; the testing-specific checks (AC6, level reporting) are the only code in the `review testing` path.

**T42 · Status-table "test health" row** — role: verifier · dispatch: `agent-manager` · depends: T30, T16 · scope: dispatcher status format · status: `blocked(T30, T16)`
- T42.AC1 The row is read from the `test-gates` report and shows measured values only.

**T43 · Routing command and rigor checker (`test-routing`)** — role: mechanism owner · dispatch: `typescript` · depends: T02, T30 · scope: `tools/nx-plugins/test/` · status: `blocked(T02, T30)`
- T43.AC1 Given a class, a write scope, and the triggers the item's testing record asserts, the command prints one JSON object with `rigor`, `triggers`, `authorship`, `playbook`, and `gates`.
- T43.AC2 It encodes STRATEGY §6.6 and §6.7: a boundary-or-contract class yields Deep; a refactor whose write scope hits a persistence trigger yields Deep (the STRATEGY §6.6 trigger table); an unknown class exits non-zero.
- T43.AC3 The checker fails when a change's recorded rigor is below the derived rigor (a seeded Light record on a Deep trigger fails), when the rigor record is absent, and when a Standard or Deep change has no "not testing" list (G12).
- T43.AC4 It never relaxes a gate: for every class, including class None, the output's `gates` contains G1, G2, G4, and G12, and G10 where the change ships or alters an artifact; skipping the static-review and QA dispatches for class None is a dispatch choice that the output states separately.
- T43.AC5 It runs in pre-push, in CI, and in the stage F signal step.
- T43.AC7 It exits non-zero for an inconsistent class: `no-code` with a write scope that touches source or test paths, `refactor` with an added behavior-bearing file; an asserted trigger can raise the derived rigor and never lower it.
- T43.AC8 For Deep with no coordinator or no available Test author it exits non-zero with the reason (the change is refused or escalated).
- T43.AC6 It prints the distribution of derived rigor over the last N merged changes (N and the trigger path patterns come from the IMPLEMENTATION), computed from git history (D24).

**T44 · AGENTS.md testing block for unmediated work (written by `apply testing`)** — role: record-keeper · dispatch: `doc-steward` reviews it · depends: T02, T03, T41, T48 · scope: `AGENTS.md` · status: `blocked(T02, T03, T41, T48)`
- T44.AC1 The block is written by `/workspace-standards apply testing` between its own markers (`workspace-standards:testing:block`, distinct from the capability-row markers of T03), is at most 12 lines, and names the class list, "run `test-routing` before writing a test", "record the rigor line in the commit message", "never edit or skip a test you did not author", "return unreviewed tests as a filed follow-up item" at Standard, and "stop and escalate at Deep when no separate Test author can be invoked"; its size in bytes is reported from `wc -c`.
- T44.AC2 The block names no agent (the T41.AC6 check exits 0 on it); the routing table is a separate block.
- T44.AC3 `CLAUDE.md` still resolves to the same file as `AGENTS.md`.
- T44.AC4 Two sessions by an agent with no dispatcher (one Light change, one Standard change) are recorded as transcripts; a script confirms that each transcript runs the routing command before its first test-file edit and that each ends by listing its unreviewed tests; both checks exit 0.

**T45 · Follow-up items for unreviewed tests** — role: mechanism owner · dispatch: `typescript` · depends: T32, T34, T39, D15 · scope: header lint, `tools/nx-plugins/test/` · status: `blocked(T32, T34, T39)`
- T45.AC1 A working agent with no second party ends with a final message that lists the unreviewed tests and files one backlog item naming them (a seeded session proves it).
- T45.AC2 The group's standing review item lists the open unreviewed-tests items with their age.
- T45.AC3 Each follow-up item carries an owner and an expiry (default 14 days); G4 fails the build past the expiry; an item older than the limit in the IMPLEMENTATION raises the group's standing review item by one step each run (T39.AC2).
- T45.AC4 A fresh `qa` dispatch clears an item by recording a review; a session never clears an item for tests it authored.

**T46 · Test-ownership check** — role: mechanism owner · dispatch: `typescript` · depends: T31, T34 · scope: `.githooks/`, `.github/workflows/`, `tools/nx-plugins/test/` · status: `blocked(T31, T34)`
- T46.AC1 The check reads the header from the base commit of the change, never from its head, so that deleting the header in the same edit does not exempt a file; it applies only to a test file whose base-commit header records separated authorship (`authorship: separated`); a file with no such header (legacy, or implementer-authored) is exempt, and the exemption is reported as a count so it shrinks as existing tests are migrated.
- T46.AC2 A change to a covered file after the commit that introduced it fails unless it comes from the test author's or the auditor's recorded dispatch (its run line in the commit trailer, verified against the run record in the location the IMPLEMENTATION names (a file committed with the change, readable by CI); where none is named the check is reported as not enforced in CI, not as passing).
- T46.AC3 A seeded edit by an implementer's dispatch to a covered file fails; the same edit under the test author's run line passes; the same edit to an exempt legacy file passes.
- T46.AC4 The check is stated as a guard against accident, not against forgery: forgery is caught by the audit's independence check (T18.AC4) and by review of the commit's run line.
- T46.AC5 The same check runs as a CI job on every pushed change, so skipping the local hook does not skip the check.

### Stream S4 — Migration of existing tests (out of this plan, D10)

The owner scoped this plan to establishing the system: "in theory the specs fix themselves through it. That will be the success metric of this plan". The existing work stays as filed backlog items and is not a task here: 81 stub specs with 878 `it.todo` when filed (`f4bdf20e`), 28 `CPU-THRASH-SKIP` blocks (`701ca5ab`), 103 `setTimeout` occurrences in e2e files (`c8245cbc`), the failing `ci.yml` runs (`59ae45f9`). The classification of the 140 e2e files into tiers and the reconcile of `agent-lane-spawn.baseline.json` are left to the system as well. The plan is judged by a measured decrease: after the rollout tasks in streams S1, S2, S3, and S5 are in place and the retention loop has run for one retention cycle (length set by the owner), the T32 scanner and the retention report show each of the four counts (stub specs, skip blocks, `setTimeout` occurrences in e2e files, failing mainline CI runs) lower than at their first measurement. Reaching zero is not required; the owner sets the deadline.

### Stream S5 — Homing and portability proof

**T57 · Home STRATEGY in the harness repo and break up `docs/testing/`** — role: strategy owner · dispatch: `qa` · depends: T14, T02, T48 · scope: sox-ecosystem `extensions/skills/workspace-standards/standards/testing/`, adhd `docs/testing/` · status: `blocked(T14, T02, T48)`
- T57.AC1 A table gives every file in `docs/testing/` a destination: `STRATEGY.md` becomes the testing standard's policy in the skill; the operating-model parts of `STRATEGY_MAP.md` become the skill's references; `STATE.md` tasks are filed in the backlog and the file removed; `HANDOFF.md`, `REVIEW.md`, `REVIEW-MAP.md`, `REVIEW_REQUEST.md`, and `REVIEW_TRIAGE.md` are removed, and `checks/names.py` and `checks/cover.py` become the T41 engine's first two checks once their findings are filed or carried into the destination documents; the IMPLEMENTATION's skeleton becomes the `apply testing` template, and this repository's filled-in file stays at `docs/standards/testing.md`.
- T57.AC2 The policy copy in the skill is byte-identical to the approved `STRATEGY.md` (equal `shasum -a 256`), and the name-independence check passes on it at its new path.
- T57.AC3 adhd's repo-side file is `docs/standards/testing.md`, generated by `apply testing`, and `! rg -q "docs/testing/" docs AGENTS.md` exits 0.
- T57.AC4 `review testing` runs in adhd after the move and reports a conformance level.

**T60 · Adopt the strategy in sox-ecosystem** — role: strategy owner · dispatch: `qa` (`adopt` playbook) · depends: T14, T41, T62 · scope: sox-ecosystem `docs/standards/testing.md` · status: `blocked(T14, T41, T62)`
- T60.AC1 An IMPLEMENTATION exists there with the binding table and names no agent.
- T60.AC2 The conformance checker (the T62 engine and T41 checks) runs there, bound to that repository's own command table, and reports a level.
- T60.AC3 Any STRATEGY change the adoption needs is raised as an issue against STRATEGY, not patched locally.

**T61 · Cross-repository conformance dry run** — role: strategy owner · dispatch: `qa` · depends: T60 · status: `blocked(T60)`
- T61.AC1 The checker reports both repositories' levels side by side.
- T61.AC2 Differences are explained by repository facts, not by strategy edits.

## 4. Observed issues and where they are filed (not part of the rollout)

| Observation | Backlog item (2026-10-07) | Rollout task |
|---|---|---|
| 81 stub specs held 878 `it.todo` when filed (the T32 scanner re-measures) | `9d2c58c3-568d-4e36-8f55-8dfb3ea5246f` (adhd, new) | T32 |
| 28 `CPU-THRASH-SKIP` skip blocks in 15 files | `701ca5ab` (adhd, existing, enriched) | out of plan (D10) |
| 103 `setTimeout` occurrences in 45 e2e files | `ad5d69f0-8bde-47d2-aee7-d2e6233518ff` (adhd, new) | out of plan (D10) |
| 6 of the last 8 `ci.yml` runs on `main` failed | `59ae45f9-d0cc-497b-a83e-1758fe012c40` (adhd, new; related to `f1ddfb0c`, `940260f1`, `a4d346ae`) | out of plan (D10) |
| Dispatcher routes to agents that no extension defines (F1) | `3fe895f3` (sox-ecosystem, existing, enriched) | T10, T12 |
| `qa.md` single-file strategy rule (F2) | `4e57efce-0d70-4f16-a494-8194d8d173cb` (sox-ecosystem, new) | T18 |
| `typescript.md` coverage target (F3) | `e7785ef3-c371-41b8-8f6f-9df9a765e9e5` (sox-ecosystem, new) | T13 |
| Binary test standard in `dispatch-contract` (F15) | `ee4d2df9-0880-4330-a679-511b45bd521c` (sox-ecosystem, new) | T15 |
| Harness assumes the implementer writes the tests (F18) | `4d8136a0-d585-4d37-97c2-3676fdc687ed` (sox-ecosystem, new) | T15, T22, T23 |
| `dispatch-direct` is the dispatcher's playbook, not an unmediated session (F19) | design note in `STRATEGY_MAP.md` §1C; no defect | T44 |
| Unmediated work has no carrier for the testing rules (F20) | `1061522b` (adhd, existing, enriched) | T44, T48 |
| Lifecycle steps are unconditional (F21) | `235e4944-b0ef-4e66-8480-3775c97927d4` (sox-ecosystem, new) | T16.AC6 |
| `performance` and `performance-engineer` look like duplicates | `9a866182` (existing) | T21 |
| Modified files in the working tree that this work did not author (release metadata, a tsconfig, the lockfile) | not part of this work; `git status --porcelain` lists them | none |
| The installed `~/.claude/agents/dispatcher.md` differs from the repo source | not a defect: five appended host-binding lines (`Resolved tool names (Claude Code)`) | none |
| The memory MCP server timed out throughout planning; no research was persisted; the `backlog`, `agent-mcp`, and `search` servers failed to connect at session start | `15d98692-1433-4a29-b2c5-40f5af1325a1` (adhd, existing, enriched) and `2d89e154-bad2-47fd-a8ec-be782d2c6f7e` (memory, existing) | none |

## 5. Log

- **2026-10-07** — Revised to v0.7 after two more blind reviews of STRATEGY 0.3 and the three documents. T10 split into a name guard and a role guard (T10b); new tasks T63 (metrics, exception-log, and G11 producers) and T64 (release the harness changes); the success metric of D10 is a measured decrease; stub contract, Deep refusal, a pilot before widening Standard authorship, reuse analysis (T14.AC11, T62.AC5), pre-push placement recorded against `8963c3cb` (T40.AC2), signal job failure route and idempotent priority (T39), base-commit header reading and run-record location (T46), class consistency check (T43.AC7), dependency fixes (T02, T12, T13, T45, T62), and block statuses regenerated from `depends`. Waves recomputed.
- **2026-10-07** — Revised to v0.6 after an independent review (`REVIEW.md`, `REVIEW-MAP.md`; dispositions in `REVIEW_TRIAGE.md`) against STRATEGY 0.3 and STRATEGY_MAP 0.8. Added decisions D19–D24 and task T62 (the harness engine for the checks and the gate runner). T41 no longer depends on T02 (T02 now depends on T41). T01 reopened for v0.3. T10 split into a name-resolution check and a role-resolution check; the dispatcher route assertions moved to T12; T19 split into three tasks with their own criterion ids. Acceptance criteria rewritten to one exit polarity (violation is non-zero). Waves and the critical path recomputed.
- **2026-10-07** — Applied the owner's answers to the decisions round (STRATEGY_MAP v0.7): all decisions answered; parallel authoring and join (T16, T23); independence by session; implementer is a role and `typescript` is not broadened (T13); routing table in `AGENTS.md` (T49); `docs/standards/testing.md` (T02, T48); unreviewed-tests follow-up items (T45); homing task T57; the migration stream removed from the plan (D10).
- **2026-10-07** — Owner approved the design ("I approve with adaptation") with two adaptations: `apply <routing|gates|testing|...>` with routing and gates as foundation targets separate from domain standards (T14, T48, T49), and the closest available agent as role holder (D17, T47, T10). Backlog items filed or enriched for the observed issues (section 4).
- **2026-10-07** — Revised against `STRATEGY_MAP.md` v0.5: the skill is `workspace-standards` with verbs `run`, `apply`, `review` (T14, T48); roles may be unbound (T47, T10); the backlog is used as it is (T35, T17, T33); stage F is demand-driven review items (T39, T05, T45); the coverage target is replaced by a change-scoped efficacy standard (T13).
- **2026-10-07** — Added decisions D11–D16, tasks T22–T24 and T43–T46, and acceptance criteria on T01–T03, T12–T19, T35 against `STRATEGY.md` v0.2 and `STRATEGY_MAP.md` v0.4.
- **2026-10-07** — Created from `STRATEGY_MAP.md` v0.3. No task filed or started.

## 6. Filed tickets (2026-10-07)

| Ticket | Project | Uid | Tasks |
|---|---|---|---|
| 1/4 plan: decisions, waves, strategy documents, scope, observed issues | adhd | `a0fc7001-3421-4ac4-a313-1a12e88e00e5` | T01-T05 |
| 2/4 harness changes | sox-ecosystem | `595965cc-d2fd-48bf-bc65-dc1767a66c0b` | T10, T10b, T11-T18, T19a-c, T20-T24, T47-T49, T62, T64 |
| 3/4 project mechanisms | adhd | `19a5efd5-7da3-42b8-8d28-78570e04d060` | T30-T46, T63 |
| 4/4 homing and adoption | adhd | `945c464c-bfba-4df6-a9b9-b912cd26dab9` | T57, T60, T61 |

Tickets 2, 3, and 4 are `part_of` ticket 1. A body edit mints a successor uid, so look the tickets up by title if a uid no longer resolves.
