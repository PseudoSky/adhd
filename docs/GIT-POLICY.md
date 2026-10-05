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
