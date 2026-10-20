# Working understanding — testing strategy for adhd (and portable to sox-ecosystem)

Written 2026-10-07 at the end of the session's current turn. Everything here was observed in this session unless marked *(unverified)*. Nothing is committed or filed in any backlog.

## 1. What the owner wants

1. A **portable STRATEGY** (principles, tiers, workflows, decision trees, when to remove or lower a test) that applies to every repo, including `~/dev/ai/sox-ecosystem`. It must not depend on agent names.
2. A per-repo **IMPLEMENTATION** that maps the strategy into one repo. Also name-free. Not yet drafted.
3. A **STRATEGY_MAP** that says which layer (HARNESS or PROJECT) and which system handles each clause. Names agents; it is the only document that may.
4. A **STATE.md** task list next to the implementation. The most performant operating mapping: fastest while still covering every task.
5. Owner's standing rules (from `~/.claude/CLAUDE.md` and `AGENTS.md`): use `rg` or `gx`, never grep/find/ls to search code; no `git stash`/`reset --hard`; file bugs and deferrals in the backlog via `adhd-backlog` (never hand-edit BACKLOG.md); commit only with an explicit pathspec; no completion claim on a red gate; end every message with the list of unacknowledged bugs/deferrals.

## 2. Artifacts produced (all untracked, in `/Users/nix/dev/node/adhd/docs/testing/`)

| File | Version | State |
|---|---|---|
| `STRATEGY.md` | 0.4, **approved** | 535 lines; the portable testing policy (to be homed in the harness repo, D3) |
| `STRATEGY_MAP.md` | 0.9, **approved** | 797 lines; operating model §1A–§1G, 22 findings (F1–F22), 24 decisions (D1–D18 answered in the design round, D19–D24 in the review round) |
| `STATE.md` | 0.7, **approved** (tasks not filed) | 426 lines; 49 tasks in streams S1–S3 and S5, waves computed from dependencies; stream S4 (migration) is out of the plan |
| `REVIEW.md`, `REVIEW-MAP.md` | independent review of 0.2 / 0.7 / 0.5 | kept as the record |
| `REVIEW_TRIAGE.md` | disposition of every review finding | applied, rejected, or reduced, each with the reason |
| `REVIEW_REQUEST.md` | dispatch guide for the next blind review | not for the reviewer |

Not yet written: `IMPLEMENTATION.md`. Not yet done: any change to agents, skills, hooks, or checkers. The backlog schema is not to change (the testing record is a body convention). Backlog items for the observed issues are filed (STATE.md §4); the 49 rollout tasks are not.

## 3. How the strategy is meant to reach the workflow (the operating model)

- **Roles, not names** in STRATEGY and IMPLEMENTATION. The MAP binds roles to the sox-ecosystem agents.
- **Carriers, cheapest first:** C0 mechanical checks (0 agent tokens) → C1 template fields → C2 role cards (≤4 KB, inlined into the dispatcher's brief) → C3 judgment dispatch → C4 human.
- **Single source:** one `workspace-standards` skill (`/workspace-standards <review|run|apply> <routing|gates|testing|...|all>`; `routing` and `gates` are foundation targets separate from domain standards, each `apply` writes its own part unless a standard declares otherwise; testing is the first standard, future ones are deployment, implementation, documentation, organization, styling). Its `testing` standard has role cards (classifier, implementer-at-Light, static reviewer, auditor, triager), four playbooks (`adopt`, `conformance`, `retention-audit`, `flake-triage`), and seven Test-author playbook cards. Delivery is by inlining into the brief; the contract already says never reference a file that can be inlined (`dispatch-contract/SKILL.md:126`).
- **Judgment points:** classification, static review, QA audit, triage, and adoption fold into dispatches that already happen. Test planning and authoring by a separate **Test author** (a new agent, `test-author`) adds about one planning dispatch per bucket plus one authoring dispatch per unit at Standard and Deep rigor (estimate; task T24 measures it); at Light and None it adds none.
- **Roles may be unavailable:** a role goes to the closest available eligible agent (obligations covered, tools matched, independence rules respected), recorded with its evidence; with none eligible the role is unbound, becomes review debt, and Deep rigor blocks.
- **Backlog used as it is:** class, rigor, AC ids, plan live in a `## Testing record` section of the item body; no schema change.
- **Stage F is demand-driven:** one standing backlog review item per test group; each signal (change touching the group, slowness, flake, expired skip) raises its priority one step; `qa` works it when it reaches the top.
- **Coverage target replaced** by a change-scoped efficacy standard measured on the diff, never as a repository-wide percentage.
- **Rigor by class:** a change's class (eight values, independent of the backlog's item types) and its escalation triggers derive its rigor (None, Light, Standard, Deep) through one routing command bound as the `test-routing` capability; no class relaxes any gate (STRATEGY §6.6, §6.7).
- **Three work modes:** plan, dispatcher direction (`dispatch-direct`, which runs the full lifecycle), and unmediated (user to a working agent, carried only by AGENTS.md, one pulled card, and the mechanical gates) (MAP §1C).
- **Parallel authoring and join:** the Test author and the implementer run concurrently against the architect's fixed interfaces with disjoint write scopes; red is recorded against the base commit; the dispatcher joins, merges, and runs the tests; a `test-dispute:` return replaces an edit; sequential (tests first) when interfaces are open (MAP §1B.4). A party is one session, so a fresh `qa` dispatch may audit tests another dispatch authored.
- **One gate runner** (own Capabilities row, written by `apply gates`) knows the registered gates and applies them correctly for the lifecycle step, change class, rigor, and changed paths; it writes one JSON report that the dispatcher's final run, QA, CI, the stage F signal step, and the conformance checker read. It releases nothing: release stays the dispatcher's Step 7. The testing standard's gate set is `test-gates`.
- **Routing table:** `apply routing` writes a task-to-agent routing table in `AGENTS.md`, mapping each task a registered standard defines to agents in the capability roster by name.
- **Conformance check:** the IMPLEMENTATION carries a binding table with one row per STRATEGY clause id; a `strategy-conformance` checker verifies completeness, liveness, reachability, teeth (seeded violations), and name independence, and reports L1/L2/L3.
- **Agent changes:** add `review` (static and blind modes) and `test-author`; keep `typescript` as it is except replacing its coverage target (implementer is a role resolved to the closest specialist through the routing table, for example `typescript` or `ui`); keep `qa` as one agent that cites STRATEGY and adopts `docs/standards/testing.md`; add a roster guard.
- **Cost basis:** `STRATEGY.md` v0.3 is 61,338 bytes (`wc -c`; ≈15,300 tokens at 4 bytes/token, an estimate). The 1,000-token card figure is a design budget, not measured.

## 4. Facts about the environment that drive the plan

### sox-ecosystem dispatcher 2.0.0 (commit `27be064c`, landed 2026-10-07 10:57 while I worked)
- Lifecycle: plan worktree → bucket worktrees → implementer verifies every AC, ff-merges into the plan branch, issue → `review` → static review per bucket (guided, does not run the suite) → aggregate and correct → QA stage (run unit tests, triage, simple fixes, reopen complex ones, test audit) → dispatcher's own final run of "the project's full gates" → **one blind review per plan** → ff-only merge → release run by the dispatcher → live confirmation → resolve. (`dispatcher.md:90-97, 462-475`.)
- Every item needs acceptance criteria; `none applicable` is gone; tests cite `<uid> AC<n>`; one test may cite several (`dispatcher.md:221-223`).
- `dispatch-contract` §1a states a binary test standard: unit tests mock process/network libraries; e2e tests "drive every surface in one run on one shared scaffold and teardown" (`contract:35-38`). I found this conflicts with STRATEGY §12 (isolation) and states test policy in a harness skill.
- Installed copy `~/.claude/agents/dispatcher.md` is also v2.0.0 and differs from the repo source only by five appended lines, a `Resolved tool names (Claude Code)` host-binding section (line diff, 2026-10-07). Not a defect.

### Roster
- 21 agent extensions in `sox-ecosystem/extensions/agents`: agent-manager, architect, architect-decision, backlog-operator, debug, devops, dispatcher, doc-cartographer, doc-consumer, doc-evangelist, doc-reviewer, doc-steward, git-manager, performance, performance-engineer, product, qa, researcher, security, typescript, ui.
- The dispatcher routes to `review`, `backend`, `refactor`, `test`, `general`; no extension defines them. This is a **dispatcher spec defect** (hand-maintained roster; open item `3fe895f3`, `definition-of-ready/SKILL.md:145`), not a naming difference.
- `qa.md:19-24` says a repo has exactly one strategy file and tells `qa` to create `docs/TEST-STRATEGY.md`; this contradicts the approved STRATEGY/IMPLEMENTATION split. `qa` is now dispatched at lifecycle Step 5.6, so the conflict is live.
- `typescript.md:45` demands "Test coverage exceeding 90%", contradicting STRATEGY P11.

### adhd repo (HEAD `14b06b4`)
- Two test lanes only (`test`, `e2e`); lane membership comes from `tools/vite-plugins/e2e-globs.mjs`; `check-lane-reachability.mjs` and `check-agent-lane-spawn.mjs` enforce lanes (spawn check covers only the agent family; baseline `agent-lane-spawn.baseline.json` can only shrink).
- 140 tracked e2e files (`git ls-files '*.e2e.ts' '*.e2e.test.ts'`). 81 tracked spec files are stubs (`STUB (mocked placeholder)`) holding 878 `it.todo` (`entrypoint/backlog` 35, `entrypoint/apigen-cli` 23, `packages/apigen` 23). 28 `describe.skip`/`it.skip` blocks tagged `CPU-THRASH-SKIP` in 15 files (backlog item 701ca5ab). 103 `setTimeout` occurrences in 45 e2e files, not yet classified as fixed waits or deadlines. All counted with `git grep` on adhd `b76b4bed`, 2026-10-07.
- `AGENTS.md` has no `## Capabilities` section.
- Pre-push excludes e2e since commit `14b06b44`; CI (`ci.yml`, `pull-request.yml`) still runs `nx affected -t e2e --parallel=1`. No scheduled workflow exists.
- Backlog store: create takes `title` + free-text `body`; no structured AC, risk, or test-plan field (`create-issue.ts:80-82`), and the design keeps it that way (a `## Testing record` convention in the body; `get` with `fields:["body"]` returns it, `SKILL.md:390-391`). The CLI has no note verb: stage F signals use `update` and `add-citation`. It has obligations and attestations: a `path:` attestation proves a file exists at HEAD with a digest, not that tests passed (`entrypoint/backlog/skill/SKILL.md:635-651`).
- Installed Vitest is 4.1.9 and contains `tagsFilter` and `strictTags`.
- 6 of the last 8 `ci.yml` runs on `main` failed: `nx format:check` x3, `Install dependencies` x1, `nx affected -t lint test build verify-dist-load` x1, one cancelled; cause of the last three not established (item 59ae45f9).
- During the session ~28 `package.json`/`CHANGELOG.md` files became modified that I did not touch (likely a release in progress).

## 5. Findings F1–F22 (full text in `STRATEGY_MAP.md` §8)
F1 roster defect · F2 `qa` single-file rule · F3 coverage target · F4 "project's full gates" unbound · F5 AC citation is text-pinned only (pin test passes on 2.0.0) · F6 no structured AC field · F7 obligations prove presence, not passing · F8 no Capabilities section · F9 stage F has no owner · F10 presubmit is the dispatcher's local run, CI is mainline *(whether adhd merges through PRs unverified)* · F11 pre-push has no smoke subset · F12 no reviewer sees QA's removals · F13 tier conformance covers only the agent family · F14 host hooks cannot carry portable rules · F15 binary test standard conflicts with the strategy · F16 QA audit has no criteria · F17 lifecycle lacks P/H/X tiers · F18 harness assumes the implementer writes tests · F19 `dispatch-direct` is the dispatcher's playbook, not an unmediated session · F20 unmediated mode has no carrier · F21 lifecycle steps are unconditional · F22 whether the backlog holds a custom `change-class` field is unverified.

## 6. Decisions
All 18 are answered; the final answer for each is the table in `STRATEGY_MAP.md` §9 (mirrored in `STATE.md` §1).

## 7. Mistakes I made and how they were corrected (so they are not repeated)
- Earlier counts were wrong: "six" skip blocks (28 in 15 files), "about 20" fixed sleeps (103 `setTimeout` occurrences in 45 files, not all sleeps), "801" `it.todo` (878 by `git grep`), "135" e2e files (140 tracked), and "15 lines" of installed-dispatcher difference (five appended host-binding lines). All re-measured and the documents corrected.
- I read dispatcher 1.14 and mapped against it; 2.0.0 landed mid-session and changed F1, F4, F10, F12. I re-read, re-ran the AC pin test, and rewrote the MAP.
- My first T01.AC2 name-check pattern matched ordinary words and failed a clean document. Replaced with a backticked-name pattern excluding the tag names `security` and `performance`; verified with a seeded negative control.
- Early in the session I claimed `catalog-verbs` logic could move to unit with no duplicate to delete; the graph overlap (70%) was misleading because `catalog-verbs.spec.ts` is an `it.todo` stub. Corrected in the later analysis.
- The STATE wave table claimed tasks in a wave had no dependency on each other; seven pairs did. Waves are now computed from the `depends` fields.
- The MAP cited `direct:35` for the QA routing row; line 35 is the retry ladder and the routing is `direct:30` (verified: those skill files are identical at sox-ecosystem `27be064c` and `fbba2f88`, so this was a mis-citation, not file drift).
- I treated `dispatch-direct` as the user's "talking directly to an agent" scenario; it is the dispatcher's own playbook and runs the full lifecycle. The unmediated case is a separate mode.
- The advisor tool was unavailable twice, then answered once; the memory MCP server timed out throughout, so no research was persisted.

## 8. Next steps
1. The documents are approved and the 49 rollout tasks are filed as four tickets (STATE section 6). Start wave 1 of STATE section 2 (T01 done; T10, T11, T35, T62 ready). The 15 unverified sources remain open.
2. Build the `workspace-standards` skill (T14) and the generators (T48, T49); then `apply testing` writes `docs/standards/testing.md` from the template (T02 is the hand draft).
3. Home STRATEGY in the harness repo and break up `docs/testing/` (T57).
4. Before any commit: `git commit -- <explicit paths>` only; run `npx nx affected -t lint,typecheck,typecheck-spec` as the repo gate requires.

## 9. Open items not acknowledged elsewhere
- Release-process changes in the adhd working tree not authored by me (about 28 `package.json` and `CHANGELOG.md` files).
- `performance` vs `performance-engineer` duplicate (unfiled, task T21).
- `backlog`, `memory`, `agent-mcp`, `search` MCP servers failed to connect this session; the `adhd-backlog` CLI works.
- The backlog store logged `store.integrity.damaged` for `idx_fts_node` (an FTS index written by an older Turso version) and rebuilt it in 743 ms on the first query of this session (`BL-347`); no action taken.

## 10. Decisions round, 2026-10-07 (applied)
A review round followed (`REVIEW.md`, `REVIEW-MAP.md`, dispositions in `REVIEW_TRIAGE.md`) and the owner decided D19–D24 (second-party confirmation of QA's test edits, interface stubs and assertion-level red evidence, disputes decided by the auditor with expiring review debt, an approver information barrier at Deep, a machine-readable capabilities declaration per agent, a rigor distribution report); the owner then approved the three documents without a fourth blind review. The design round: The owner answered every open decision and then approved the rest ("if so then yes and the rest approved"). The answers are applied in STRATEGY.md (party definition, concurrent authoring), STRATEGY_MAP.md v0.7, and STATE.md v0.5. Notable: D10 limits the plan to establishing the system (migration of existing tests is out; success metric: the system resolves them); D3 homes STRATEGY in the harness repo, so `docs/testing/` is to be broken up into the skill (T57) and nothing is moved before then.
