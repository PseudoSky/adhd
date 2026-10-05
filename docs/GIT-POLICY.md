# Git Policy

**Schema version:** 1 · **Governs:** the `adhd` monorepo, integration branch `main`.

This is the single authoritative description of how this repository uses git. Rules that
already exist elsewhere are cited by `path §section` rather than restated. Enforcement is
attributed to the external trust roots that actually hold it — the hooks in `.githooks/`, the
workflows in `.github/workflows/`, and human review — never to this file. It contains no
credentials and no machine-local paths.

## Branching & merge

- **Integration branch:** `main` — the only long-lived branch. CI runs on every push to it and
  on pull requests (`.github/workflows/ci.yml`).
- **Where a change forks from:** `main` (CONTRIBUTING.md §Development Workflow).
- **Branch naming:** no machine-enforced pattern. Convention is a `<type>/<slug>` prefix using
  the commit-convention types (e.g. `fix/nx-build-cpu-guard`); agent worktrees use the
  `worktree-agent-<id>` form. Reviewers check this; no ref hook does.
- **Merge strategy:** changes land on `main` through a pull request (CONTRIBUTING.md
  §Development Workflow), not a direct push. History carries true merge commits (e.g.
  `merge(backlog): …`); ff-only is **not** enforced.
- **Rebase-in-flight:** permitted only on a branch that is solely your own and is nobody else's
  base. `main` is never rebased or rewritten.

## Push & review

- **Who may merge:** the author of a change is not its approver — approval comes from a
  reviewer, CI, or the human. This is a review gate, not a machine gate.
- **Push authorization:** no push without human approval, except an explicit blanket grant made
  at the start of the session (AGENTS.md §Rules).
- **Required checks:** a change is not mergeable until CI is green — `nx format:check`, the
  lane-reachability check, `nx affected -t lint test build verify-dist-load`, and
  `nx affected -t e2e --parallel=1` (`.github/workflows/ci.yml`). The PR secret-scan job is the
  credentials enforcement boundary (`.github/workflows/pull-request.yml`); the local pre-commit
  hook is fast feedback only.
- **Force-push scope:** forbidden on `main` and any shared branch; `--force-with-lease` is
  permitted only on a branch solely your own.
- **Merge queue:** none — PRs merge one at a time against `main`, and CI re-runs on each
  `synchronize`.

## Commit convention

- **Rule set:** Conventional Commits, `<type>(<scope>): <subject>`, with the scope being the
  library/package name (AGENTS.md §12 Commit Convention). Documentation-only commits use a
  `docs(<area>):` scope instead — e.g. `docs(adr):`, `docs(plan):`, `docs(git-policy):` — as this
  repository's own history does.
- **Enforcement:** there is no commit-msg hook and no commitlint config in this repository, so
  the message rule is review-enforced, not machine-enforced. The commit-time machine gates
  (`.githooks/pre-commit`) validate staged content — a mass-deletion guard, the secret scan,
  affected lint, and the staged-spec test — never the message.

## Worktree layout

- **Root:** all worktrees live under `.worktrees/` (AGENTS.md §Rules; `.gitignore`). Never check
  out a different branch in the repo root — create a worktree instead (AGENTS.md §Rules).
- **One worktree per branch:** each worktree holds exactly one branch; branches are not shared
  across worktrees.
- **Provisioning:** git does not copy `node_modules`, so a fresh worktree needs its dependencies
  installed before lint/test can be trusted — `.githooks/pre-commit` Gate 2 fails with an
  explicit message if `node_modules/.modules.yaml` or `node_modules/nx` is missing. Scratch
  output belongs under `tmp/` or `.adhd/tmp/` (AGENTS.md §10).
- **Reap TTL:** a worktree that is clean, unlocked, and merged to `main` is reaped as part of the
  operation that merged it — it is not left to age. An unmerged worktree is never reaped on a
  timer; it is reported with a named blocker (see Cleanup).

## Cleanup

Safe to remove a worktree — **all three, never any one**:

1. `git status --porcelain` inside it is empty (untracked files count as NOT clean);
2. it is not `locked` in `git worktree list --porcelain`;
3. its branch is an ancestor of `main` (`git merge-base --is-ancestor <head> main` exits 0) — or
   the worktree is explicitly recorded as returned-with-a-named-blocker.

If all three hold: `git worktree remove` — never `--force` on a tree you did not author. If any
fails: leave it and report why. Reap one at a time, each with its own three-part check.

Recovery runbook:

- Moved worktree → `git worktree repair <path>`.
- Deleted worktree, branch intact → `git worktree prune`.
- Lost commits → `git reflog`, then `git fsck --unreachable`. The reflog is local and
  time-bounded (GC expires it): git history is durable, the reflog is best-effort only.
- Before abandoning any worktree, require the work to be committed **and** pushed — recovery
  must not depend on a local, expiring reflog.

## Release

- **Versioning & tag scheme:** there are **no git tags** — the npm registry is the source of
  truth for what is released. A package version is released iff `name@version` resolves on the
  registry. Versions are computed per-project and written to each package's `package.json` by the
  `@adhd/nx-build:version` executor (cited: `PUBLISHING.md` §Workflow; `tools/nx-plugins/build/`).
- **Changelog / release notes:** the root `CHANGELOG.md` is maintained by hand and committed by
  the opt-in `pnpm release:commit` step, which stages only bumped `package.json`, `CHANGELOG.md`,
  and `published-state.json` (cited: `PUBLISHING.md` §Workflow;
  `DEBT-BUILD-VERSION-NO-AUTOCOMMIT-001`).
- **Monorepo release coordination:** the workspace is released as one unit by `pnpm release`
  (`build` → `nx run-many -t version` → `nx run-many -t publish`); the `publish` target runs
  per-project only when `name@version` is absent from the registry. `published-state.json` at the
  workspace root records `{version, normalizedHash, publishedIntegrity}` per package and is
  committed alongside version bumps (cited: root `package.json` `release` script;
  `PUBLISHING.md` §Workflow).
- **Rollback:** a bad publish is superseded by publishing a corrected version; the registry is
  append-only and no git tag or ref is moved by a release (cited: `PUBLISHING.md` §Troubleshooting).
- **Deploy triggers:** automated publish is driven by the workflows in `.github/workflows/` (cited:
  `PUBLISHING.md` §CI publish). Pushing and publishing require human approval — silence is not
  consent (cited: `PUBLISHING.md` §Approval & Authorization; `AGENTS.md` §Rules).

## Provenance

Schema version 1.

- **v1 — 2026-09-30 — created.** No committed document contained all required sections before
  this file: `CONTRIBUTING.md` covers only the fork/branch/PR flow; the
  `docs/contributing/conventions/*` docs are single-topic; and
  `docs/contributing/conventions/worktree-workflow.md` self-describes as a "proposed convention
  … nothing … implemented". Established this file as the single authoritative policy, citing
  AGENTS.md, CONTRIBUTING.md, `.githooks/`, and `.github/workflows/` by path rather than
  restating them, and added a one-line pointer to it from `CONTRIBUTING.md`.

- **2026-10-01 — operation record: fast-forward merge of `feat/apigen-plugin-tracing`.** Ran
  `git merge --ff-only feat/apigen-plugin-tracing` on `main`, moving `main` `bb832e7b` →
  `0f85bc1c` (7 commits, 42 files) with no merge commit. A fast-forward is within this policy's
  stated norm rather than a deviation: §Branching & merge says ff-only is **not** enforced, and
  `main`'s history already contains both ff-able landings that took a merge commit and landings
  that did not — so `--no-ff` is a chosen shape here, not the only lawful one. The staged index
  entry for `tools/nx-plugins/build/executors/smoke-test/task-report.mjs` (an orphan owned by
  another worker) was left byte-identical and staged: it appears in neither `main`'s nor the
  branch's tree, so the merge could not reach it. No source file, `registry/index.json`, or
  worktree was modified. This record is the only change to this file.

- **2026-10-01 — operation record: reap of `.worktrees/impl-apigen-tracing`.** Applied the
  §Cleanup safe-to-remove test to the worktree for `feat/apigen-plugin-tracing` (HEAD
  `0f85bc1c`, its branch fast-forwarded onto `main` at `b19990a4`): `git status --porcelain` was
  empty, the entry carried no `locked` line, and the branch was an ancestor of `main`
  (`git rev-list --count main..feat/apigen-plugin-tracing` = 0), so it is attributable to a
  merged branch. Ran `git worktree remove .worktrees/impl-apigen-tracing` — no `--force` — and
  `git branch -d feat/apigen-plugin-tracing` (was `0f85bc1c`). Worktrees went 53 → 52; no source
  file, hook, or `registry/index.json` was modified. The staged orphan
  `tools/nx-plugins/build/executors/smoke-test/task-report.mjs` (blob `70fd7b71`) remains
  byte-identical and staged. This record is the only change to this file.

- **2026-10-02 — operation record: land of `fix/apigen-tracing-debts`.** Committed the rewire as
  `580399a7` (8 paths: `@adhd/sox-telemetry` `^0.3.2` → `^0.4.1` in six `package.json`,
  `pnpm-lock.yaml`, and the new `entrypoint/backlog/src/server.tracing-six-tags.spec.ts`). Gates
  all green: `nx test apigen-plugin-tracing` (23 passed, exit 0); `server.tracing-six-tags`
  (1 passed, exit 0); `server.tracing-required` (66 passed, exit 0); plus the pre-commit hook's
  affected-lint pass. Absorbed `main` (`ce645937`, root `AGENTS.md`) into the branch, then
  fast-forwarded `main` `ce645937` → `06a0d3f9` (a merge commit on the branch whose first parent
  is `580399a7`; ff-only, within §Branching & merge's "ff-only is not enforced"). No push, no
  publish, and no worktree or branch removed — cleanup is deferred. The staged orphan
  `tools/nx-plugins/build/executors/smoke-test/task-report.mjs` was left byte-identical and
   staged. This record is the only change to this file.

- **2026-10-04 — operation record: policy sync, landing adhd ADR-0006.** The equivalence test
  failed: this file carried Branching & merge, Push & review, Commit convention, Worktree layout,
  Cleanup, and Provenance, but no Release section. Corrected inside the ADR-0006 landing operation
  by adding §Release above (versioning/tag scheme, changelog, rollback, deploy triggers, monorepo
  coordination), each rule cited to `PUBLISHING.md`, root `package.json`, and `.github/workflows/`
  by path rather than restated. §Release and this record are the changes to this file in this
  operation.

- **2026-10-04 — operation record: relocate the target `@adhd/backlog` interface spec out of the
  ADR catalog.** `docs/decisions/0007-target-backlog-public-interface.md` (untracked, 158 lines)
  was physically moved — not `git mv`, which cannot move an untracked path — to
  `docs/plan/backlog-consolidation/backlog-interface-target.md`. Only the H1 changed, from
  `# ADR-0007 — …` to `# Target @adhd/backlog public interface (end-state; not shipped)`; lines
  2–158 are byte-identical (sha256 of lines 2–158 unchanged at `fae4e1c3…`). The owner ruled the
  document is not an ADR but non-binding plan material, so it was withdrawn from `docs/decisions/`
  and was never in the ADR Index; `docs/decisions/README.md` has no withdrawn/reserved list, so it
  required no edit and was left untouched. Also corrected §Commit convention above: this
  repository's own history uses a `docs(<area>):` scope for documentation-only commits (HEAD
  `docs(adr):`), a convention the stated "scope = library/package name" rule omitted. Committed
  with explicit paths (never `git add -A`/`.`/`-a`); not pushed. This §Commit convention correction
  and this record are the changes to this file in this operation.

- **2026-10-04 — operation record: land of `feat/bucket-d-multisurface-reconcile` (dispatch-2026-10-04-9c4e).**
  Landed bucket D onto `main` as a **merge commit** `a98429d9` (parents `9b8b580a` = pre-merge
  `main`, `fd19fe16` = D head), moving `main` `9b8b580a` → `a98429d9`; 9 files, +1616 lines.
  §Branching & merge was the deciding rule: this history "carries true merge commits" and ff-only is
  not enforced, while rebase-in-flight is permitted only on a branch "solely your own" — D is an
  in-flight executor branch, not the operator's, so rewriting its 5 commits (`1bcc147d`..`fd19fe16`)
  was out; a merge commit is the stated shape here. Dry-run `git merge-tree --write-tree --name-only
  main fd19fe16` exited 0 with no conflict hunks; the actual merge was conflict-free (the only
  shared directory with merged bucket A is `entrypoint/agent-mcp/src/__tests__/`, and A and D added
  distinct filenames there; A did not touch `entrypoint/agent-mcp/package.json`, so D's
  `agent-mcp-follow` bin insertion applied cleanly). Post-merge `git rev-list --count main..fd19fe16`
  = 0 and `git merge-base --is-ancestor fd19fe16 main` exits 0, so all 5 D commits are contained.
  A concurrent agent's uncommitted work was present in the working tree throughout
  (`entrypoint/agent-mcp/src/store/agent-store.ts`, `packages/agent/agent-core-env/src/{index.ts,
  sqlite-locking.ts}` modified; two untracked test fixtures) and was neither staged, swept, nor
  modified — the merge touched none of those paths. No push, no branch or worktree removed, no gates
  run (the post-merge review runs the suite). This record is the only change to this file in this
  operation. Recorded under §Commit convention's `docs(<area>):` scope.

- **2026-10-04 — operation record: land of `feat/bucket-c-publish-contract-docs` (dispatch-2026-10-04-9c4e).**
  Landed bucket C onto `main` as a **merge commit** `67b2762f` (parents `cd1e4333` = pre-merge
  `main`, `5c377d7c` = C head), moving `main` `cd1e4333` → `67b2762f`; 22 files, +749/-38.
  §Branching & merge was the deciding rule: this history "carries true merge commits" and ff-only is
  not enforced, while rebase-in-flight is permitted only on a branch "solely your own" — C is an
  in-flight executor branch, not the operator's, so rewriting its 7 commits (`1bcc147d`..`5c377d7c`)
  was out; a merge commit is the stated shape here. Dry-run `git merge-tree --write-tree main
  5c377d7c` exited 0, producing tree `3efa0232` with no conflict hunks; the actual `git merge
  --no-ff` was conflict-free (ort strategy, exit 0). Post-merge `git rev-list --count
  main..feat/bucket-c-publish-contract-docs` = 0 and `git merge-base --is-ancestor 5c377d7c main`
  exits 0, so all 7 C commits are contained. The working tree was clean before and after
  (`git status --porcelain` empty). No push, no branch or worktree removed, no gates run (the
  post-merge review runs the suite). This record is the only change to this file in this operation.
  Recorded under §Commit convention's `docs(<area>):` scope.

- **2026-10-04 — operation record: land of the `feat/bucket-d-multisurface-reconcile` follow-up
  (dispatch-2026-10-04-9c4e).** Landed 3 follow-up commits on top of the already-merged
  `fd19fe16` (`6e21be6f`, `5c1aabd3`, `7eb0c728`; head `7eb0c728`) onto `main` as a **merge
  commit** `132f4072` (parents `d045cfc0` = pre-merge `main`, `7eb0c728` = branch head), moving
  `main` `d045cfc0` → `132f4072`; 5 files, +374/-9 (new
  `entrypoint/agent-mcp/src/__tests__/agent-mcp-follow-bin.test.ts`; modified
  `bucket-d-acceptance.test.ts`, `follow-renderer.test.ts`,
  `entrypoint/agent-mcp/src/scripts/agent-mcp-follow.ts`, and
  `entrypoint/agent-mcp/src/streaming/follow-renderer.ts`). §Branching & merge was the deciding
  rule: this history "carries true merge commits" and ff-only is not enforced, while rebase-in-
  flight is permitted only on a branch "solely your own" — D is an in-flight executor branch, not
  the operator's, so rewriting its commits was out; a merge commit is the stated shape here.
  Dry-run `git merge-tree --write-tree main 7eb0c728` exited 0 producing tree `c8c7c613` with no
  conflict hunks; the actual `git merge --no-ff` was conflict-free (ort strategy, exit 0).
  Post-merge `git rev-list --count main..feat/bucket-d-multisurface-reconcile` = 0 and
  `git merge-base --is-ancestor 7eb0c728 main` exits 0, so all 3 follow-up commits are contained.
  The working tree was clean before and after (`git status --porcelain` empty). No push, no branch
  or worktree removed, no gates run (the post-merge review runs the suite). This record is the only
  change to this file in this operation. Recorded under §Commit convention's `docs(<area>):` scope.

- **2026-10-04 — operation record: land of `feat/bucket-b-provider-runtime` (dispatch-2026-10-04-9c4e).**
  Landed bucket B onto `main` as a **merge commit** `9feacfd2` (parents `ded98335` = pre-merge
  `main`, `e175c2dd` = B head), moving `main` `ded98335` → `9feacfd2`; 18 files, +1147/-34.
  §Branching & merge was the deciding rule: this history "carries true merge commits" and ff-only is
  not enforced, while rebase-in-flight is permitted only on a branch "solely your own" — B is an
  in-flight executor branch, not the operator's, so rewriting its 11 commits (`1bcc147d`..`e175c2dd`)
  was out; a merge commit is the stated shape here. Dry-run `git merge-tree --write-tree --name-only
  main e175c2dd` exited 0, producing tree `3f837092` with no conflict hunks; the actual `git merge
  --no-ff` was conflict-free (ort strategy, exit 0), with one automatic content merge in
  `packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts` and no conflict. B did not touch
  this file (empty `git diff 1bcc147d..e175c2dd -- docs/GIT-POLICY.md`), so `main`'s policy revision
  survived the merge byte-identical (blob `b3131bc9`). Post-merge
  `git rev-list --count main..feat/bucket-b-provider-runtime` = 0 and
  `git merge-base --is-ancestor e175c2dd main` exits 0, so all 11 B commits are contained. The working
  tree was clean before and after (`git status --porcelain` empty); `main`'s pre-merge tip
  `ded98335` (a concurrent agent's `docs(plan):` commit) was left byte-identical. No push, no branch
  or worktree removed, no gates run (the post-merge review runs the suite). This record is the only
  change to this file in this operation. Recorded under §Commit convention's `docs(<area>):` scope.

- **2026-10-04 — operation record: land of the `feat/bucket-c-publish-contract-docs` findings-sweep
  follow-up (dispatch-2026-10-04-9c4e).** Landed 4 follow-up commits on top of the already-merged
  `5c377d7c` (`2a6dc470`, `7060faa4`, `3fcf997e`, `20f541cc`; head `20f541cc`) onto `main` as a
  **merge commit** `210d52d1` (parents `1839d1a3` = pre-merge `main`, `20f541cc` = C head), moving
  `main` `1839d1a3` → `210d52d1`; 11 files, +458/-104. §Branching & merge was the deciding rule:
  this history "carries true merge commits" and ff-only is not enforced, while rebase-in-flight is
  permitted only on a branch "solely your own" — C is an in-flight executor branch, not the
  operator's, so rewriting its commits was out; a merge commit is the stated shape here. Dry-run
  `git merge-tree --write-tree --name-only main 20f541cc` exited 0, producing tree `6203c0c1` with no
  conflict hunks; the actual `git merge --no-ff` was conflict-free (ort strategy, exit 0). The branch
  never touched this file (empty `git diff 54ee90a2..20f541cc -- docs/GIT-POLICY.md`), so the merge
  carried `main`'s policy blob `d772b9fc` into tree `6203c0c1` byte-identical. Post-merge
  `git rev-list --count main..feat/bucket-c-publish-contract-docs` = 0 and
  `git merge-base --is-ancestor 20f541cc main` exits 0, so all 4 follow-up commits are contained. The
  working tree was clean before and after (`git status --porcelain` empty). No push, no branch or
  worktree removed, no gates run (the post-merge review runs the suite). This record is the only
  change to this file in this operation. Recorded under §Commit convention's `docs(<area>):` scope.

- **2026-10-04 — operation record: land of the `feat/bucket-a-store-registry` remainder
  (dispatch-2026-10-04-9c4e).** Landed the bucket-A remainder onto `main` as a **merge commit**
  `8ddd6836` (parents `b3648471` = pre-merge `main`, `6f889317` = branch head), moving `main`
  `b3648471` → `8ddd6836`; 36 files, +2144/-119. The dispatch named 8 commits (`1b970168`,
  `492092a2`, `88171d7c`, `a0e29d8f`, `2c3fa5b7`, `1647488d`, `e84a71e7`, `6f889317`), but the
  branch carried **9** since the merge-base `9b8b580a`: the base of the series is `d9fddae5`
  (`fix(agent-core-env,agent-mcp): BEGIN IMMEDIATE + bounded BUSY retry on AgentStore
  read-modify-write`), which the dispatch list omitted. Contents: the ADR-0001 store substrate
  (`packages/agent/agent-core-env/src/{open-registry-store.ts,store-transaction.ts,index.ts,
  sqlite-locking.ts}`), the `agent-engine-compiler/src/db/migrate-registry.ts` migration, the
  agent-mcp registry/session/`agent_verify_mcp` tests, the dispatch-cli `import-agents` work, and
  the revert of the rejected better-sqlite3-only AC4/AC5 path (`e84a71e7`). §Branching & merge was
  the deciding rule: this history "carries true merge commits" and ff-only is not enforced, while
  rebase-in-flight is permitted only on a branch "solely your own" — the branch is an in-flight
  executor branch, not the operator's, so rewriting its 9 commits was out; a merge commit is the
  stated shape here. Dry-run `git merge-tree --write-tree main 6f889317` exited 0, producing tree
  `d9a210e1` with no conflict hunks; the actual `git merge --no-ff` was conflict-free (ort
  strategy, exit 0), with automatic content merges in `entrypoint/agent-mcp/{AGENTS.md,package.json,
  src/index.ts,src/server.ts}` and `packages/dispatch/dispatch-orchestrator/src/{lib/agent-runner.ts,
  test/agent-runner.spec.ts}` and no conflict. The branch did not touch this file
  (`git diff 9b8b580a..6f889317 -- docs/GIT-POLICY.md` empty), so `main`'s policy blob `ef6fa31d`
  survived the merge byte-identical (merged tree `d9a210e1` resolves this path to `ef6fa31d`).
  Post-merge `git rev-list --count main..feat/bucket-a-store-registry` = 0 and
  `git merge-base --is-ancestor 6f889317 main` exits 0, so all 9 branch commits are contained. The
  working tree was clean before and after (`git status --porcelain` empty). No push, no branch or
  worktree removed, no gates run (the post-merge review runs the suite). This record is the only
  change to this file in this operation. Recorded under §Commit convention's `docs(<area>):` scope.

- **2026-10-04 — operation record: land of the `feat/bucket-c-publish-contract-docs` delta-scope
  follow-up (dispatch-2026-10-04-9c4e).** Landed 1 follow-up commit on top of the already-merged
  `20f541cc` (`ea3923db` = `fix(agent-mcp): delta-scope legacy catch-up so canonical post-seed
  writes survive (80b61a7d)`) onto `main` as a **merge commit** `05f4b0e0` (parents `f5bd3938` =
  pre-merge `main`, `ea3923db` = C head), moving `main` `f5bd3938` → `05f4b0e0`; 2 files,
  +371/-96 (`entrypoint/agent-mcp/src/db/migrate-legacy.ts`,
  `entrypoint/agent-mcp/src/__tests__/db.legacy-migration.test.ts`). §Branching & merge was the
  deciding rule: this history "carries true merge commits" and ff-only is not enforced, while
  rebase-in-flight is permitted only on a branch "solely your own" — C is an in-flight executor
  branch, not the operator's, so rewriting its commit was out; a merge commit is the stated shape
  here. Dry-run `git merge-tree --write-tree main ea3923db` exited 0, producing tree `9976c1b6`
  with no conflict hunks; the actual `git merge --no-ff` was conflict-free (ort strategy, exit 0).
  The branch never touched this file (empty `git diff 20f541cc..ea3923db -- docs/GIT-POLICY.md`), so
  the merge carried `main`'s policy blob `7a0b9b7f` byte-identical. Post-merge
  `git rev-list --count main..feat/bucket-c-publish-contract-docs` = 0 and
  `git merge-base --is-ancestor ea3923db main` exits 0, so the commit is contained. The working
  tree was clean before and after (`git status --porcelain` empty). No push, no branch or worktree
  removed, no gates run (the post-merge review runs the suite). This record is the only change to
  this file in this operation. Recorded under §Commit convention's `docs(<area>):` scope.

- **2026-10-04 — operation record: land of the `feat/bucket-b-provider-runtime` continuation
  (dispatch-2026-10-04-9c4e).** Landed the bucket-B continuation onto `main` as a **merge commit**
  `a7e526f3` (parents `7fe7ce10` = pre-merge `main`, `6f739de0` = B head), moving `main`
  `7fe7ce10` → `a7e526f3`; 29 files, +1954/-79. The 8 commits since the merge-base `e175c2dd` are
  `182d741c`, `b6884f67`, `ecd0f138`, `e95bc2df`, `f6213b58`, `6f30eb40`, `e8271d77`, `6f739de0` —
  matching the dispatch list exactly. §Branching & merge was the deciding rule: this history
  "carries true merge commits" and ff-only is not enforced, while rebase-in-flight is permitted only
  on a branch "solely your own" — B is an in-flight executor branch, not the operator's, so
  rewriting its commits was out; a merge commit is the stated shape here. The dry-run
  `git merge-tree --write-tree --name-only main 6f739de0` exited **1** with exactly one conflict,
  `packages/agent/agent-engine-orchestrator/src/index.ts`. That conflict was a trivial additive
  export union: base blob `03fbe6d2`; `main` (`63b6c9cb`) added the `AgentUpdateResult` type to the
  `./tools/agent-crud.js` line and the `./tools/mcp-verify.js` export block; B (`f8b26a54`) added
  the `./providers/server-side-tools.js` exports and `ServerSideTool` to the provider-types line
  (these auto-merged, producing no hunk), plus `tasksBatch` and `DEFAULT_BATCH_CONCURRENCY` to the
  `./tools/task.js` line. No symbol was defined divergently on the two sides, so the resolution is
  the union rather than a choice: kept `main`'s mcp-verify block **and** B's
  `tasksBatch`/`DEFAULT_BATCH_CONCURRENCY` on the task line, with the auto-merged provider-side
  additions and `AgentUpdateResult` intact. Resolved content is blob `d93a2ff9`; verified
  `git diff main -- <file>` shows only B's additions and `git diff
  feat/bucket-b-provider-runtime -- <file>` shows only `main`'s additions, i.e. the union with
  nothing dropped. The dry-run's exit 1 was the only non-zero step; the resolved
  `git commit --no-edit` exited 0 after the git-invoked pre-commit hook (mass-deletion guard, secret
  scan, affected lint, staged-spec) passed. Post-merge `git rev-list --count
  main..feat/bucket-b-provider-runtime` = 0 and `git merge-base --is-ancestor 6f739de0 main` exits 0,
  and each of the 8 named commits was individually confirmed an ancestor of `main`. The branch never
  touched this file (empty `git diff 7fe7ce10..a7e526f3 -- docs/GIT-POLICY.md`), so `main`'s policy
  blob `c650d6b7` survived the merge byte-identical. The working tree was clean before and after
  (`git status --porcelain` empty). No push, no branch or worktree removed, and no gates were run by
  this operation (the post-merge review runs the suite). This record is the only change to this file
  in this operation. Recorded under §Commit convention's `docs(<area>):` scope.

- **2026-10-05 — operation record: land of `feat/bucket-a-store-registry` (dispatch-2026-10-04-9c4e).**
  Landed bucket A onto `main` as a **merge commit** `28de68d7` (parents `2bd9d012` = pre-merge
  `main`, `133a338d` = A head), moving `main` `2bd9d012` → `28de68d7`; 14 files, +711/-42. The 7
  commits since the merge-base `6f889317` are `f2c736ea`, `fabf0b50`, `570412e4`, `1c4c6604`,
  `30b04c74`, `9faee66f`, `133a338d` — matching the dispatch list exactly. §Branching & merge was the
  deciding rule: this history "carries true merge commits" and ff-only is not enforced, while
  rebase-in-flight is permitted only on a branch "solely your own" — A is an in-flight executor
  branch, not the operator's, so rewriting its 7 commits was out; a merge commit is the stated shape
  here. The dry-run `git merge-tree --write-tree --name-only main 133a338d` exited 0, producing tree
  `b7444205` with no conflict hunks; the actual `git merge --no-ff` was conflict-free (ort strategy,
  exit 0), auto-merging `entrypoint/agent-mcp/AGENTS.md` and
  `packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts` with no hunk left unresolved. The
  post-merge tree at `28de68d7` is `b7444205`, byte-identical to the dry-run tree. Post-merge
  `git rev-list --count main..feat/bucket-a-store-registry` = 0, the merge is two-parent (not
  fast-forward), and `git merge-base --is-ancestor` exits 0 for each of the 7 named commits
  individually. The branch never touched this file (empty `git diff 6f889317..133a338d --
  docs/GIT-POLICY.md`), so `main`'s policy blob `1492528e` survived the merge byte-identical
  (pre-merge `2bd9d012` and post-merge `28de68d7` resolve the same blob). The working tree was clean
  before and after (`git status --porcelain` empty), and no concurrent agent had this file dirty when
  the append began (its on-disk sha256 equalled the committed blob). The branch remains checked out
  in worktree `.worktrees/bucket-a`; no push, no branch or worktree removed, and no gates were run by
  this operation (the post-merge review runs the suite). This record is the only change to this file
  in this operation. Recorded under §Commit convention's `docs(<area>):` scope.

- **2026-10-05 — operation record: fast-forward land of the `feat/bucket-a-store-registry` remainder
  `d78aaf2f` (dispatch-2026-10-04-9c4e).** Ran `git merge --ff-only feat/bucket-a-store-registry` on
  `main`, moving `main` `ff979cc2` → `d78aaf2f` (1 commit; 3 files, +342/-83) with no merge commit.
  A fast-forward is within §Branching & merge's stated norm rather than a deviation: it "carries true
  merge commits" and ff-only is not enforced, and — unlike a rebase — a fast-forward rewrites no
  commit; it advances `main`'s ref to the branch head, which is what this operation was directed to
  do, so the "branch solely your own" rebase restriction is not implicated. Preconditions verified
  before the merge: `git rev-parse feat/bucket-a-store-registry` = `d78aaf2f`; the merge-base of
  `main` and the branch was `main` itself (`ff979cc2`); `git merge-base --is-ancestor main
  feat/bucket-a-store-registry` exited 0; `git rev-list --count main..<branch>` = 1 and
  `<branch>..main` = 0; and `git show -s --format=%P d78aaf2f` is the single parent `ff979cc2`.
  The merge ran clean (`Fast-forward`, exit 0) and `d78aaf2f` is contained: post-merge `git
  merge-base --is-ancestor d78aaf2f main` exits 0 and `git rev-list --count
  main..feat/bucket-a-store-registry` = 0. Contents (numstat `ff979cc2..d78aaf2f`):
  `entrypoint/agent-mcp/src/db/migrate.ts` (+9), `entrypoint/agent-mcp/src/db/migrate-legacy.ts`
  (+157/-83), and `entrypoint/agent-mcp/src/__tests__/db.legacy-migration.test.ts` (+176) — the
  in-place `task_usage` reconciliation and the refusal of a false-success legacy seed. A concurrent
  agent's uncommitted work was present in the working tree throughout
  (`entrypoint/backlog/src/query/card.ts` and `query.ts` modified; `sort-priority-direction.spec.ts`
  untracked) and was neither staged, swept, nor touched — the merge's path set is disjoint from
  those paths (empty `git diff --name-only main d78aaf2f -- entrypoint/backlog/src/query/...`), and
  their sha256 hashes and `git status --porcelain` lines were byte-identical before and after.
  The branch never touched this file (empty `git diff --name-only ff979cc2 d78aaf2f --
  docs/GIT-POLICY.md`), so `main`'s policy blob `2c74035b76a352ff8a732ba81df1e6bcd248e22c` survived
  the merge byte-identical. No push, no branch or worktree removed, and no gates were run by this
  operation (the post-merge review runs the suite). This record is the only change to this file in
  this operation. Recorded under §Commit convention's `docs(<area>):` scope.

- **2026-10-05 — operation record: land of `feat/bucket-c-publish-contract-docs` (dispatch-2026-10-04-9c4e).**
  Landed bucket C onto `main` as a **merge commit** `c3058b3f` (parents `127ba06c` = pre-merge
  `main`, `d0b9b095` = C head), moving `main` `127ba06c` → `c3058b3f`; 6 files, +176/-43:
  `entrypoint/agent-mcp/src/__tests__/docs-and-config-contract.test.ts` (M),
  `entrypoint/agent-mcp/src/__tests__/fixtures/catalog-shell-config.seed.json` (A),
  `package.json` (M),
  `packages/agent/agent-engine-orchestrator/src/__tests__/task-list-contract.test.ts` (M),
  `packages/agent/agent-engine-orchestrator/src/tools/task.ts` (M), and `pnpm-lock.yaml` (M). The 3
  commits since the merge-base `3fa5609d` are `ff58c8e5` (`fix(deps): regenerate pnpm-lock.yaml for
  the pinned specifiers` — the HIGH CI fix), `6ee04cea`
  (`fix(agent-engine-orchestrator): type projected taskList/resultTool as ProjectedTask`), and
  `d0b9b095` (`test(agent-mcp): seed repo-owned fixture so f141baad AC2 asserts unconditionally`) —
  matching the dispatch list exactly. §Branching & merge was the deciding rule: this history "carries
  true merge commits" and ff-only is not enforced, while rebase-in-flight is permitted only on a
  branch "solely your own" — C is an in-flight executor branch, not the operator's, so rewriting its
  3 commits was out; a merge commit is the stated shape here. Dry-run
  `git merge-tree --write-tree --name-only main d0b9b095` exited 0, producing tree `ff46b5d4` with no
  conflict hunks; the actual `git merge --no-ff` was conflict-free (ort strategy, exit 0). The branch
  never touched this file since its merge-base (empty `git diff 3fa5609d..d0b9b095 --
  docs/GIT-POLICY.md`), so `main`'s policy blob `d92bac78` survived the merge byte-identical
  (pre-merge `127ba06c` and post-merge `c3058b3f` resolve the same blob). Post-merge
  `git rev-list --count main..feat/bucket-c-publish-contract-docs` = 0 and
  `git merge-base --is-ancestor` exits 0 for each of the 3 named commits individually. A concurrent
  agent's uncommitted work was present in the working tree throughout
  (`entrypoint/backlog/src/query/card.ts` and `query.ts` modified; `sort-priority-direction.spec.ts`
  untracked) and was neither staged, swept, nor touched — the merge's path set is disjoint from those
  paths, and their sha256 hashes and `git status --porcelain` lines were byte-identical before and
  after. No push, no branch or worktree removed, and no gates were run by this operation (the
  post-merge review runs the suite). This record is the only change to this file in this operation.
  Recorded under §Commit convention's `docs(<area>):` scope.

- **2026-10-05 — operation record: land of `feat/bucket-g-dispatch-cli-taskstore` (dispatch-2026-10-04-9c4e).**
  Landed bucket G onto `main` as a **merge commit** `d71f7f02` (parents `52a8f3f0` = pre-merge
  `main`, `a6854d78` = G head), moving `main` `52a8f3f0` → `d71f7f02`; 7 files, +123/-7:
  `entrypoint/dispatch-cli/eslint.config.mjs` (M), `entrypoint/dispatch-cli/package.json` (M),
  `entrypoint/dispatch-cli/project.json` (M),
  `entrypoint/dispatch-cli/src/test/default-mcp-servers.spec.ts` (M),
  `packages/agent/agent-store-runtime/src/__tests__/task-store.test.ts` (M),
  `packages/agent/agent-store-runtime/src/store/task-store.ts` (M), and `pnpm-lock.yaml` (M). The 2
  commits since the merge-base `ff979cc2` are `892da21c` (`fix(dispatch-cli): declare @adhd/backlog
  dependency and assert the default MCP entry exists (1505199b)`) and `a6854d78`
  (`docs(agent-store-runtime): document and pin the task-store list() ordering contract (7ab73187)`) —
  matching the dispatch list exactly. §Branching & merge was the deciding rule: this history "carries
  true merge commits" and ff-only is not enforced, while rebase-in-flight is permitted only on a
  branch "solely your own" — G is an in-flight executor branch, not the operator's, so rewriting its
  2 commits was out; a merge commit is the stated shape here. This merge was performed **after** the
  bucket-C merge above and `main` was re-read first (`52a8f3f0`), so the dry-run was re-run against
  the advanced `main`: `git merge-tree --write-tree --name-only main a6854d78` exited 0, producing
  tree `92e5e628` with no conflict hunks — differing from the bucket-C-era dry-run tree `6a1033c6`
  only because `main` had moved, and still clean. The actual `git merge --no-ff` was conflict-free
  (ort strategy, exit 0), auto-merging `pnpm-lock.yaml` (G's lockfile delta vs. `main`'s
  bucket-C lockfile delta) with no hunk left unresolved. The branch never touched this file since
  its merge-base (empty `git diff ff979cc2..a6854d78 -- docs/GIT-POLICY.md`), so the policy revision
  landed by the bucket-C provenance commit (`5d1d8474`) survived the merge byte-identical (pre-merge
  `52a8f3f0` and post-merge `d71f7f02` resolve the same blob). Post-merge
  `git rev-list --count main..feat/bucket-g-dispatch-cli-taskstore` = 0 and
  `git merge-base --is-ancestor` exits 0 for each of the 2 named commits individually. A concurrent
  agent's uncommitted work was present in the working tree throughout
  (`entrypoint/backlog/src/query/card.ts` and `query.ts` modified; `sort-priority-direction.spec.ts`
  untracked) and was neither staged, swept, nor touched — the merge's path set is disjoint from those
  paths, and their sha256 hashes and `git status --porcelain` lines were byte-identical before and
  after. No push, no branch or worktree removed, and no gates were run by this operation (the
  post-merge review runs the suite). This record is the only change to this file in this operation.
  Recorded under §Commit convention's `docs(<area>):` scope.

- **2026-10-05 — operation record: land of `feat/bucket-b-provider-runtime-eng` (dispatch-2026-10-04-9c4e).**
  Landed the bucket-B engine onto `main` as a **merge commit** `0451d09b` (parents `6bdbf3e5` =
  pre-merge `main`, `2f5a556a` = branch head), moving `main` `6bdbf3e5` → `0451d09b`; 6 files,
  +590/-7: `packages/agent/agent-engine-orchestrator/eslint.config.mjs` (M),
  `packages/agent/agent-engine-orchestrator/package.json` (M),
  `packages/agent/agent-engine-orchestrator/src/__tests__/plugins-loader-budget.test.ts` (A),
  `packages/agent/agent-engine-orchestrator/src/__tests__/task-dependency-gating.test.ts` (A),
  `packages/agent/agent-engine-orchestrator/src/tools/task.ts` (M), and `pnpm-lock.yaml` (M). The 2
  commits since the merge-base `ff979cc2` are `976e4a2a` (`fix(agent-engine-orchestrator): resolve the
  default budget plugin from the engine (dfb03557)`) and `2f5a556a` (`fix(agent-engine-orchestrator):
  enforce task depends_on gating before dispatch (ac115447)`) — matching the dispatch list exactly.
  §Branching & merge was the deciding rule: this history "carries true merge commits" and ff-only is
  not enforced, while rebase-in-flight is permitted only on a branch "solely your own" — the branch is
  an in-flight executor branch, not the operator's, so rewriting its 2 commits was out; a merge commit
  is the stated shape here. Dry-run `git merge-tree --write-tree --name-only main 2f5a556a` exited 0,
  producing tree `7f547f9c` with no conflict hunks; the actual `git merge --no-ff` was conflict-free
  (ort strategy, exit 0), auto-merging `packages/agent/agent-engine-orchestrator/src/tools/task.ts`
  and `pnpm-lock.yaml` with no hunk left unresolved, and the post-merge tree at `0451d09b` is
  `7f547f9c`, byte-identical to the dry-run tree. The branch never touched this file (empty
  `git diff ff979cc2..2f5a556a -- docs/GIT-POLICY.md`), so `main`'s policy blob `da70249d` survived
  the merge byte-identical (pre-merge `6bdbf3e5` and post-merge `0451d09b` resolve the same blob).
  Post-merge `git rev-list --count main..feat/bucket-b-provider-runtime-eng` = 0 and
  `git merge-base --is-ancestor` exits 0 for each of the 2 named commits individually. A concurrent
  agent's uncommitted work was present in the working tree throughout
  (`entrypoint/backlog/src/query/card.ts` and `query.ts` modified; `sort-priority-direction.spec.ts`
  untracked) and was neither staged, swept, nor touched — the merge's path set is disjoint from those
  paths, and their sha256 hashes and `git status --porcelain` lines were byte-identical before and
  after. No push, no branch or worktree removed, and no gates were run by this operation (the
  post-merge review runs the suite). This record is the only change to this file in this operation.
  Recorded under §Commit convention's `docs(<area>):` scope.

- **2026-10-05 — operation record: land of `feat/bucket-b-provider-runtime` (dispatch-2026-10-04-9c4e).**
  Landed the bucket-B agent systemPrompt projection onto `main` as a **merge commit** `4c2ad052`
  (parents `8a8361ad` = pre-merge `main`, `4dad74bc` = B head), moving `main` `8a8361ad` →
  `4c2ad052`; 7 files, +686/-26: `entrypoint/agent-mcp/AGENTS.md` (M),
  `entrypoint/agent-mcp/src/__tests__/integration/agent-prompt-projection.e2e.test.ts` (A),
  `entrypoint/agent-mcp/src/server.ts` (M),
  `packages/agent/agent-engine-orchestrator/src/__tests__/agent-crud-projection.test.ts` (A),
  `packages/agent/agent-engine-orchestrator/src/index.ts` (M),
  `packages/agent/agent-engine-orchestrator/src/tools/agent-crud.ts` (M), and
  `packages/agent/agent-engine-orchestrator/src/validation/agent.ts` (M). The 3 commits since the
  merge-base `3fa5609d` are `4a6ae079` (`feat(agent-engine-orchestrator,agent-mcp): gate agent
  systemPrompt behind explicit opt-in`), `d0d26495`
  (`fix(agent-engine-orchestrator,agent-mcp): wire full/fields opt-in into agent_update response`),
  and `4dad74bc` (`refactor(agent-engine-orchestrator,agent-mcp): rename bare full opt-in to
  self-describing fullDefinition`) — matching the dispatch list exactly. §Branching & merge was the
  deciding rule: this history "carries true merge commits" and ff-only is not enforced, while
  rebase-in-flight is permitted only on a branch "solely your own" — B is an in-flight executor
  branch, not the operator's, so rewriting its 3 commits was out; a merge commit is the stated shape
  here. Dry-run `git merge-tree --write-tree --name-only main 4dad74bc` exited **1** with exactly one
  conflict, `entrypoint/agent-mcp/AGENTS.md` — the **only** conflict, both this branch and the
  already-merged A-fix having edited the tool table, and the conflict region was exactly two adjacent
  rows of that table (`agent_list`, `agent_verify_mcp`) with no other hunk. As the dispatch directed,
  the conflict was resolved as a **union of the table rows, dropping nothing**: kept B's `agent_list`
  row (`(fullDefinition?: bool, fields?: string[]) -> {agents: [...]}` with the summary-omits-
  `systemPrompt` wording) **and** `main`'s (A-fix's) `agent_verify_mcp` row (`status`/`ok` tri-state
  wording, which itself carries the self-referential `agent-mcp` skip explanation), with both sides'
  unchanged `agent_create`/`agent_read`/`agent_update` rows intact (B's `fullDefinition` wording) and
  every other row untouched. Resolved content is blob `589fd913`; verified `git diff main -- <file>`
  shows only B's additions and `git diff feat/bucket-b-provider-runtime -- <file>` shows only
  `main`'s `agent_verify_mcp` addition, i.e. the union with nothing dropped, and
  `rg '^(<<<<<<<|=======|>>>>>>>)' <file>` matches nothing (no markers remain). The dry-run's exit 1
  was the only non-zero step; the resolved `git commit --no-edit` exited 0 after the git-invoked
  pre-commit hook (mass-deletion guard, secret-scan, affected lint, staged-spec) passed. Post-merge
  `git rev-list --count main..feat/bucket-b-provider-runtime` = 0, the merge is two-parent (not
  fast-forward), and `git merge-base --is-ancestor` exits 0 for each of the 3 named commits
  individually. The branch never touched this file (empty `git diff 3fa5609d..4dad74bc --
  docs/GIT-POLICY.md`), so `main`'s policy blob `32f9a3b5` survived the merge byte-identical
  (pre-merge `8a8361ad` and post-merge `4c2ad052` resolve the same blob). A concurrent agent's
  uncommitted work was present in the working tree throughout (`entrypoint/backlog/src/query/card.ts`
  and `query.ts` modified; `sort-priority-direction.spec.ts` untracked) and was neither staged,
  swept, nor touched — the merge's path set is disjoint from those paths, and their sha256 hashes and
  `git status --porcelain` lines were byte-identical before and after. No push, no branch or worktree
  removed, and no gates were run by this operation (the post-merge review runs the suite). This
  record is the only change to this file in this operation. Recorded under §Commit convention's
  `docs(<area>):` scope.

- **2026-10-05 — operation record: fast-forward land of `feat/bucket-g-dispatch-cli-taskstore`
  (dispatch-2026-10-04-9c4e).** Ran `git merge --ff-only feat/bucket-g-dispatch-cli-taskstore` on
  `main`, moving `main` `1ff78e39` → `e0458224` (1 commit; 1 file, +4) with no merge commit. The
  single commit is `e0458224` (`test(dispatch-cli): opt agent_read into fullDefinition in
  agents-import e2e`); the change is 4 added lines in
  `entrypoint/dispatch-cli/src/test/agents-import.e2e.test.ts` — a 3-line comment plus
  `fullDefinition: true` on the `agent_read` call — so the assertion at
  `expect(def.systemPrompt).toBe(BODY)` again requests the full record, which the `eaa420a0`
  systemPrompt projection had made a **default** `agent_read` omit. Per the commit message, that
  omission made the test red on merged `main` (`f5a76002`); the production callers
  (`import-agents.ts` `ensureAgent`, `dispatch-orchestrator` `agent-runner.ts`) use `agent_read`
  only as an existence probe and are unaffected, and the other dispatch-cli/agent-mcp `agent_read`
  sites were audited to be existence probes or to read `mcpServers`/index fields, none asserting the
  omitted `systemPrompt`. A fast-forward is within §Branching & merge's stated norm rather than a
  deviation: it "carries true merge commits" and ff-only is not enforced, and — unlike a rebase — a
  fast-forward rewrites no commit; it advances `main`'s ref to the branch head, which is what this
  operation was directed to do, so the "branch solely your own" rebase restriction is not
  implicated. Preconditions verified before the merge: `git rev-parse main` = `1ff78e39` and
  `git rev-parse feat/bucket-g-dispatch-cli-taskstore` = `e0458224`; the merge-base of `main` and the
  branch was `main` itself; `git merge-base --is-ancestor main
  feat/bucket-g-dispatch-cli-taskstore` exited 0; `git rev-list --count main..<branch>` = 1 and
  `<branch>..main` = 0; and `git show -s --format=%P e0458224` is the single parent `1ff78e39`. The
  merge ran clean (`Updating 1ff78e39..e0458224` / `Fast-forward`, exit 0), and `e0458224` is
  contained: post-merge `git merge-base --is-ancestor e0458224 main` exits 0 and
  `git rev-list --count main..feat/bucket-g-dispatch-cli-taskstore` = 0. The branch never touched
  this file — `main` and `e0458224` resolve the identical policy blob `67f47270` — so the policy
  revision this operation read (commit `db9c95d2`) and records under survived the merge
  byte-identical. The working tree was clean before and after (`git status --porcelain` empty); no
  concurrent agent had an uncommitted path in it at either point, and none was staged, swept, or
  touched. No push, no branch or worktree removed, and no gates were run by this operation (the
  dispatcher verifies `dispatch-cli:test` against the post-merge `main`). This record is the only
  change to this file in this operation. Recorded under §Commit convention's `docs(<area>):` scope.

- **2026-10-05 — operation record: land of `feat/bucket-b-provider-runtime-eng`
  (dispatch-2026-10-04-9c4e).** Landed bucket B's provider-runtime engine branch onto `main` as a
  **merge commit** `c47cdf9e` (parents `28c40d30` = pre-merge `main`, `b1bb718b` = branch head),
  moving `main` `28c40d30` → `c47cdf9e`; 4 files, +53: `entrypoint/agent-mcp/project.json` (M),
  `packages/agent/agent-engine-orchestrator/project.json` (M),
  `packages/agent/agent-engine-orchestrator/tsconfig.spec.json` (A), and
  `tools/nx-plugins/build/executors/typecheck-spec/agent-engine-orchestrator.baseline.json` (A). The
  2 commits since the merge-base `db9c95d2` are `4c254146` (`fix(agent-engine-orchestrator):
  compile the spec corpus with a typecheck-spec ratchet`) and `b1bb718b`
  (`fix(agent-mcp,dispatch-cli): materialize registry-family drizzle for the spawned host`) —
  matching the dispatch list exactly. §Branching & merge was the deciding rule: this history
  "carries true merge commits" and ff-only is not enforced, while rebase-in-flight is permitted only
  on a branch "solely your own" — the branch is an in-flight executor branch, not the operator's, so
  rewriting its 2 commits was out; a merge commit is the stated shape here. The dry-run `git
  merge-tree --write-tree --name-only main b1bb718b` exited **1** with exactly one conflict,
  `entrypoint/dispatch-cli/src/test/agents-import.e2e.test.ts` — the **only** conflict, both this
  branch and the already-merged `e0458224` having made the same intended change: add the explicit
  `fullDefinition: true` opt-in to the `agent_read` call so `def.systemPrompt` is returned, keeping
  `expect(def.systemPrompt).toBe(BODY)`. Git auto-merged the shared `fullDefinition: true` and
  `main`'s explanatory comment; the conflict block was **only** the branch's extra explanatory
  comment inserted before that argument, so the resolution keeps the already-integrated comment and
  drops the duplicate — a single, coherent version. Both sides are equivalent in substance; the
  resolved file is byte-identical to `main`'s (`git show main:<file> | diff - <file>` empty), so the
  merge's net change to that path is nil and the post-merge diff (`git diff --name-status 28c40d30
  c47cdf9e`) lists the other 4 files only. Verified in the resolved file: `rg
  '^(<<<<<<<|=======|>>>>>>>)'` matches nothing (no markers), the `agent_read` call passes
  `fullDefinition: true` exactly once (line 89; the other textual hit is prose in the retained
  comment on line 84), and `expect(def.systemPrompt).toBe(BODY)` remains. The dry-run's exit 1 was
  the only non-zero step; the resolved `git commit --no-edit` exited 0 after the git-invoked
  pre-commit hook (mass-deletion guard, secret scan, affected lint, staged-spec) passed. Post-merge
  `git rev-list --count main..feat/bucket-b-provider-runtime-eng` = 0, the merge is two-parent (not
  fast-forward), and `git merge-base --is-ancestor` exits 0 for each of the 2 named commits
  individually. The branch never touched this file (`git diff --name-status db9c95d2..b1bb718b`
  lists no `docs/GIT-POLICY.md`), so `main`'s policy blob `ed3a021d` survived the merge
  byte-identical (pre-merge `28c40d30` and post-merge `c47cdf9e` resolve the same blob). The working
  tree was clean before and after (`git status --porcelain` empty); the concurrent backlog work
  already committed on `main` by another agent (`1ff78e39`, `entrypoint/backlog/src/query/*`) was
  carried through untouched and never staged. The branch remains checked out in worktree
  `.worktrees/bucket-b-eng`; no push, no branch or worktree removed, and no gates were run by this
  operation (the dispatcher verifies `dispatch-cli:test` against the post-merge `main`). This record
  is the only change to this file in this operation. Recorded under §Commit convention's
  `docs(<area>):` scope.

- **2026-10-05 — operation record: land of `test/live-e2e-five-acs` (dispatch-2026-10-04-9c4e).**
  Landed the live five-AC e2e branch onto `main` as a **merge commit** `207bd509` (parents
  `86036ce5` = pre-merge `main`, `18b2e7d5` = branch head), moving `main` `86036ce5` → `207bd509`;
  5 files, +1333, no deletions (new `docs/TEST-STRATEGY.md`, `entrypoint/dispatch-cli/AGENTS.md`,
  `entrypoint/dispatch-cli/README.md`,
  `entrypoint/dispatch-cli/src/test/fixtures/memory-stub-server.mjs`,
  `entrypoint/dispatch-cli/src/test/integration/live-dispatch-five-acs.e2e.test.ts`). The branch was
  two commits: `f833ed9f` (the gated live five-AC e2e across real agent-mcp + real provider, the
  memory stub, and `docs/TEST-STRATEGY.md`) and `18b2e7d5` (correct the run command — no
  `--testFile` on the nx target). It forked from `1ff78e39` and diverged from `main`'s tip by 6
  commits, so the landing is a genuine non-fast-forward. §Branching & merge was the deciding rule:
  this history "carries true merge commits" and ff-only is not enforced, while rebase-in-flight is
  permitted only on a branch "solely your own" — the branch is an in-flight executor branch, not the
  operator's, so rewriting its 2 commits was out; a merge commit is the stated shape here. Dry-run
  `git merge-tree --write-tree --name-only main 18b2e7d5` exited 0 with no conflict hunks, producing
  tree `1f0ac287`; the actual `git merge --no-ff` was conflict-free (ort strategy, exit 0), and the
  post-merge tree is byte-identical to the dry-run tree (`git rev-parse HEAD^{tree}` = `1f0ac287`).
  The branch never touched this file (`git diff --stat 1ff78e39 test/live-e2e-five-acs --
  docs/GIT-POLICY.md` empty), so `main`'s policy blob `ca0f1953` survived the merge byte-identical
  (pre-merge `86036ce5` and post-merge `207bd509` resolve the same blob). Post-merge
  `git rev-list --count main..test/live-e2e-five-acs` = 0 and `git merge-base --is-ancestor 18b2e7d5
  main` exits 0; `f833ed9f` and `18b2e7d5` are each individually contained. The working tree was
  clean before and after (`git status --porcelain` empty) — the dispatched "concurrent dirt under
  `entrypoint/backlog/**`" was not present at execution time, so nothing was avoided or staged. No
  push, no branch or worktree removed, no gates run (the post-merge review runs the suite). This
  record is the only change to this file in this operation. Recorded under §Commit convention's
  `docs(<area>):` scope.

- **2026-10-05 — operation record: land of `test/complexity-determinism` (dispatch-2026-10-04-9c4e).**
  Landed the deterministic-complexity-gate fix onto `main` as a **merge commit** `63fc204e`
  (parents `7e28b45d` = pre-merge `main`, `2801dc23` = branch head), moving `main` `7e28b45d` →
  `63fc204e`; 1 file, +165/-127: `packages/data/data-query-engine/src/lib/complexity.spec.ts`. The
  branch was a single commit, `2801dc23` (`test(data-query-engine): make complexity gate
  deterministic via element-touch counts`), whose only parent is the merge-base `7adea399`, so the
  landing is a genuine non-fast-forward (`git merge-base --is-ancestor 2801dc23 main` was false
  before the merge). §Branching & merge was the deciding rule: this history "carries true merge
  commits" and ff-only is not enforced, while rebase-in-flight is permitted only on a branch "solely
  your own" — the branch is an in-flight executor branch, not the operator's, so rewriting its
  commit was out; a merge commit is the stated shape here. Dry-run `git merge-tree --write-tree
  --name-only main test/complexity-determinism` exited 0, producing tree `cbd4edea` with no conflict
  hunks; the actual `git merge --no-ff` was conflict-free (ort strategy, exit 0), and the post-merge
  tree (`git rev-parse HEAD^{tree}` = `cbd4edea`) is byte-identical to the dry-run tree. The branch
  never touched this file (empty `git diff --name-only 7adea399..2801dc23 -- docs/GIT-POLICY.md`), so
  `main`'s policy blob `4f7218e0` survived the merge byte-identical (pre-merge `7e28b45d` and
  post-merge `63fc204e` resolve the same blob). Post-merge `git rev-list --count
  main..test/complexity-determinism` = 0 and `git merge-base --is-ancestor 2801dc23 main` exits 0, so
  the commit is contained. A concurrent agent's uncommitted work was present in the working tree
  throughout — five untracked files (`docs/plan/backlog-consolidation/ac-traceability.json`,
  `entrypoint/backlog/scripts/gen-ac-traceability.mjs`,
  `entrypoint/backlog/src/contract-matrix.e2e.ts`, `entrypoint/backlog/src/mcp-host.e2e.ts`,
  `entrypoint/backlog/src/test/helpers/spawn-mcp-host.ts`) — and was neither staged, swept, nor
  touched: the merge's path set is disjoint from those paths, nothing was staged before or after
  (`git diff --cached --name-only` empty), and the `git status --porcelain` line set was identical
  before and after. No push, no branch or worktree removed, and no gates were run by this operation
  (the post-merge review runs the suite). This record is the only change to this file in this
  operation. Recorded under §Commit convention's `docs(<area>):` scope.

- **2026-10-05 — operation record: land of `fix/budget-global-cap` (dispatch-2026-10-04-9c4e).**
  Landed the global-scope budget-cap fix onto `main` as a **merge commit** `43fadbba` (parents
  `f3d9502f` = pre-merge `main`, `6a2da60d` = branch head), moving `main` `f3d9502f` → `43fadbba`;
  6 files, +550/-203: `entrypoint/dispatch-cli/src/test/integration/live-dispatch-five-acs.e2e.test.ts`
  (M), `packages/agent/agent-plugin-budget/package.json` (M),
  `packages/agent/agent-plugin-budget/src/__tests__/budget-plugin.test.ts` (M),
  `packages/agent/agent-plugin-budget/src/index.ts` (M),
  `packages/agent/agent-plugin-budget/vite.config.ts` (M), and `pnpm-lock.yaml` (M). The single
  commit since the merge-base `7adea399` is `6a2da60d` (`fix(agent-plugin-budget): enforce
  global-scope caps via the drizzle handle + scoped cost`, fixing `5339c2e5`) — matching the
  dispatch list exactly. §Branching & merge was the deciding rule: this history "carries true merge
  commits" and ff-only is not enforced (and the dispatch directed `--no-ff`), while rebase-in-flight
  is permitted only on a branch "solely your own" — the branch is an in-flight executor branch, not
  the operator's, so rewriting its commit was out; a merge commit is the stated shape here. Dry-run
  `git merge-tree --write-tree --name-only main fix/budget-global-cap` exited 0, producing tree
  `f312145e` with no conflict hunks; the actual `git merge --no-ff` was conflict-free (ort strategy,
  exit 0), auto-merging `pnpm-lock.yaml` (the branch's +10 lockfile delta against `main`'s) with no
  hunk left unresolved, and the post-merge tree at `43fadbba` is `f312145e`, byte-identical to the
  dry-run tree. The lockfile was left byte-identical to the merge result — no post-merge edit, no
  conflict marker (`rg '^(<<<<<<<|=======|>>>>>>>)' pnpm-lock.yaml` matches nothing). The branch
  never touched this file (empty `git diff --name-only 7adea399..6a2da60d -- docs/GIT-POLICY.md`), so
  `main`'s policy blob `dce4da3f` survived the merge byte-identical (pre-merge `f3d9502f` and
  post-merge `43fadbba` resolve the same blob). Post-merge `git rev-list --count
  main..fix/budget-global-cap` = 0 and `git merge-base --is-ancestor 6a2da60d main` exits 0, so the
  commit is contained; the merge is two-parent, not fast-forward. A concurrent agent's uncommitted
  work was present in the working tree throughout (`docs/plan/backlog-consolidation/QA-STRATEGY.md`
  and `entrypoint/backlog/project.json` modified; five untracked files under
  `docs/plan/backlog-consolidation/` and `entrypoint/backlog/`) and was neither staged, swept, nor
  touched — the merge's path set is disjoint from those paths, nothing was staged before or after
  (`git diff --cached --name-only` empty), and the `git status --porcelain` line set was identical
  before and after. This operation did not push, did not delete a branch or remove a worktree, and
  did not run gates (the post-merge review runs the suite). This record is the only change to this
  file in this operation. Recorded under §Commit convention's `docs(<area>):` scope.

- **2026-10-05 — operation record: land of `feat/bucket-h-residual-hardening` (dispatch-2026-10-04-9c4e).**
  Landed bucket H's residual hardening onto `main` as a **merge commit** `444fe491` (parents
  `9f1276f7` = pre-merge `main`, `0812e1ba` = branch head), moving `main` `9f1276f7` → `444fe491`;
  26 files, +947/-41. The 7 commits since the merge-base `96e10020` are `6b6458d2`
  (`fix(agent-engine-orchestrator): collapse duplicate vite plugins key`, fixing `50b77657`),
  `157cbdff` (`fix(agent-mcp): correct stale e2e filename in dist-manifest comment`, fixing
  `d965f490`), `62e148f2` (`docs(agent-mcp): document agent_update openSessionsNotUpdated return
  field`, fixing `6f3cd348`), `dd0ed875` (`fix(agent-mcp): resolve default budget plugin from
  agent-mcp's own module base`, fixing `cc636860`), `34a9b766` (`fix(dispatch-orchestrator):
  no-auto-create mode for DAG-named agents`, fixing `f1dbd0f2`), `53418eb7` (`fix(agent-mcp):
  ADHD_AGENT_SKIP_LEGACY_MIGRATION flag for hermetic boots`, fixing `af567fb8`), and `0812e1ba`
  (`fix(dispatch-cli): correct same stale e2e filename in test-target comment`, fixing `d965f490`) —
  matching the dispatch list exactly (7 commits; `d965f490` is fixed by two of them). §Branching &
  merge was the deciding rule: this history "carries true merge commits" and ff-only is not enforced
  (and the dispatch directed `--no-ff`), while rebase-in-flight is permitted only on a branch "solely
  your own" — the branch is an in-flight executor branch, not the operator's, so rewriting its 7
  commits was out; a merge commit is the stated shape here. Dry-run `git merge-tree --write-tree
  --name-only main feat/bucket-h-residual-hardening` exited 0, producing tree `ffd3c6c6` with no
  conflict hunks; the actual `git merge --no-ff` was conflict-free (ort strategy, exit 0), and the
  post-merge tree at `444fe491` is `ffd3c6c6`, byte-identical to the dry-run tree. The branch never
  touched this file (empty `git diff --name-only main feat/bucket-h-residual-hardening --
  docs/GIT-POLICY.md`; both revisions resolve policy blob `fbe507c6`), so `main`'s policy revision
  survived the merge byte-identical (pre-merge `9f1276f7` and post-merge `444fe491` resolve the same
  blob). Post-merge `git rev-list --count main..feat/bucket-h-residual-hardening` = 0, the merge is
  two-parent (not fast-forward), and `git merge-base --is-ancestor` exits 0 for each of the 7 named
  commits individually. The working tree was clean before and after (`git status --porcelain` empty),
  nothing was staged (`git diff --cached --name-only` empty), and the dispatch's anticipated
  "concurrent dirt unrelated" was not present, so nothing had to be avoided or protected. The branch
  remains checked out in worktree `.worktrees/bucket-h-residual` at `0812e1ba`; no push, no branch or
  worktree removed, and no gates were run by this operation (the post-merge review runs the suite).
  This record is the only change to this file in this operation. Recorded under §Commit convention's
  `docs(<area>):` scope.

- **2026-10-05 — operation record: land of `test/live-five-acs-fn-provider` (dispatch-2026-10-04-9c4e).**
  Landed the anthropic-provider live five-AC e2e branch onto `main` as a **merge commit** `3869d37d`
  (parents `27a21407` = pre-merge `main`, `5be96af9` = branch head), moving `main` `27a21407` →
  `3869d37d`; 3 files, +150/-28: `entrypoint/dispatch-cli/AGENTS.md` (M, +14/-2),
  `entrypoint/dispatch-cli/README.md` (M, +20/-4), and
  `entrypoint/dispatch-cli/src/test/integration/live-dispatch-five-acs.e2e.test.ts` (M, +116/-22) —
  the `DISPATCH_E2E_PROVIDER=anthropic` wiring in the live five-AC e2e, isolation of AC2's HITL tool
  surface, the AC2 diagnostic, and corrections to a false reachability claim in the test header,
  README, and AGENTS. The branch was a single commit, `5be96af9`, whose only parent is the merge-base
  `27a21407` (`git show -s --format=%P 5be96af9` = `27a21407`), so it was strictly ahead of `main` by
  one commit (`main..branch` = 1, `branch..main` = 0) and a fast-forward was possible; the dispatch
  directed `--no-ff`, and a merge commit is within §Branching & merge, which states history "carries
  true merge commits" and ff-only is not enforced. §Branching & merge was the deciding rule:
  rebase-in-flight is permitted only on a branch "solely your own" — this is an in-flight executor
  branch, not the operator's, so rewriting its commit was out; a merge commit is the stated shape here.
  Dry-run `git merge-tree --write-tree --name-only main 5be96af9` exited 0, producing tree `d400ba81`
  with no conflict hunks; the actual `git merge --no-ff` was conflict-free (ort strategy, exit 0), and
  the post-merge tree at `3869d37d` is `d400ba81`, byte-identical to the dry-run tree. No conflict
  marker remains in any merged file (`rg '^(<<<<<<<|=======|>>>>>>>)'` matches nothing). The branch
  never touched this file (empty `git diff --name-only 27a21407..5be96af9 -- docs/GIT-POLICY.md`; both
  revisions resolve policy blob `ea62a23e`), so `main`'s policy revision survived the merge
  byte-identical (pre-merge `27a21407`, merge commit `3869d37d`, and branch head all resolve the same
  blob). The merge is two-parent (not fast-forward); post-merge
  `git merge-base --is-ancestor 5be96af9 main` exits 0 and
  `git rev-list --count main..test/live-five-acs-fn-provider` = 0, so `5be96af9` is contained. The
  working tree was clean before and after (`git status --porcelain` empty) and nothing was staged
  before or after (`git diff --cached --name-only` empty); the dispatch's anticipated "unrelated
  concurrent dirt" was not present, so nothing had to be avoided or protected. The branch remains
  checked out in worktree `.worktrees/live-five-acs-fn-provider` at `5be96af9`; no push, no branch or
  worktree removed, and no gates were run by this operation (the post-merge review runs the suite).
  This record is the only change to this file in this operation. Recorded under §Commit convention's
  `docs(<area>):` scope.
