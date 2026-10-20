# Dispatcher handoff — testing standard rollout, sox-ecosystem, wave 1

You are the dispatcher in `~/dev/ai/sox-ecosystem`. This is a plan to execute, not a document to review. Dispatch in the background; every dispatch states `model` and `tools` explicitly.

## Goal
Build the harness side of the approved testing standard: two new agents (`review`, `test-author`), a `workspace-standards` skill (verbs `run`, `apply`, `review` over the foundations `routing` and `gates` and the `testing` standard), a gate and check engine, and the dispatcher and `dispatch-contract` changes. Wave 1 below starts it.

## Source of truth
- Backlog ticket (sox-ecosystem project): `595965cc-d2fd-48bf-bc65-dc1767a66c0b` "Testing standard rollout 2/4: harness changes". It carries all 23 harness tasks with acceptance criteria. Look it up by title if the uid no longer resolves (a body edit mints a successor). Parent plan ticket (adhd): `a0fc7001-3421-4ac4-a313-1a12e88e00e5`.
- Policy: `/Users/nix/dev/node/adhd/docs/testing/STRATEGY.md` v0.4 (approved). Roles, decisions D1-D26, operating model: `/Users/nix/dev/node/adhd/docs/testing/STRATEGY_MAP.md` v0.9 (approved). Task list and waves: `/Users/nix/dev/node/adhd/docs/testing/STATE.md` v0.7 sections 2, 3, 6. These files are read-only inputs; edit nothing in the adhd repository.
- Do not hand the briefs below the whole strategy. Each brief gets its own task block and the STRATEGY clause ids it cites.

## Rules for this work
- Work in a worktree under `~/dev/ai/sox-ecosystem/.worktrees/<name>`; never check out a branch in the repo root. Two untracked `.opencode` artifacts in the root are not part of this work; leave them.
- Write scopes below are disjoint; declare them in each brief. Verify from the branch, not from the returns, that each diff touches only its declared paths.
- Every acceptance criterion is proven by a command whose exit code is recorded. Violation of a check is a non-zero exit. Report no count or pass you did not observe.
- The party that authors something does not approve it. A fresh `qa` dispatch audits; a blind review receives only the diff and the word "Review".
- Do not broaden `typescript`; implementers are roles resolved to the closest specialist.
- `dispatcher.md` and `dispatch-direct` are edited only by later tasks (T12, T16, T23, T47), not in wave 1.
- File every bug or deferral in the sox-ecosystem backlog at discovery, with citations.

## Wave 1 (ready now; no unmet dependency)

| Task | Agent | Write scope |
|---|---|---|
| T10 | `typescript` | `tools/test-roster-guard.mjs` |
| T11 | `agent-manager` | `extensions/agents/review/` |
| T14 | `agent-manager` | `extensions/skills/workspace-standards/` |

T14 is on the critical path (T01 done -> T14 -> T62 -> T41 -> T02 -> T43 -> T03 -> T16 -> T23 -> T24). Run it first or at least in parallel; do not let T10 or T11 delay it.

## After wave 1 merges (not yet)
T62 (engine), T10b, T13, T15, T18, T19a/b/c, T22, T48, T49 become ready once T14 lands. T12, T16, T20, T23, T24, T47, T64 follow later. Re-derive readiness from the `depends` fields in the ticket before each dispatch.

## Return format
Per task: branch and commit, files changed, each acceptance criterion id with its command and exit code, open items. Anything not run is stated as not run.

## The task blocks (verbatim)

**T10 · Name-resolution guard (item `3fe895f3`)** — role: mechanism owner · dispatch: `typescript` · depends: none · scope: `tools/test-roster-guard.mjs` · status: `todo`
- T10.AC1 Parses the dispatcher's routing rows and the task-to-agent routing table in `AGENTS.md` (once it exists) and exits non-zero for every routed agent name that matches no installed extension.
- T10.AC2 It is red on `27be064c`, naming `review`, `backend`, `refactor`, `test`, `general`.
- T10.AC3 A negative control (a fixture roster with one valid and one invalid name) passes and fails as expected.
- T10.AC4 Registered with the repository's test runner so it runs by default.

**T11 · New `review` agent (static and blind modes)** — role: static reviewer · dispatch: `agent-manager` · depends: none (D1 answered) · scope: `extensions/agents/review/` · status: `todo`
- T11.AC1 The agent has no edit or write tools.
- T11.AC2 Static mode returns findings by severity with `file:line` evidence; blind mode accepts only a diff and the instruction "Review".
- T11.AC3 A golden-set A/B against a baseline is recorded per `agent-manager` §7.
- T11.AC4 The install verification passes on every declared host.
- T11.AC5 The agent declares `roles-covered` (the role obligation ids it covers, D23); in blind mode at Deep rigor it receives the specification and the tests, not the implementer's reasoning (D22).

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
