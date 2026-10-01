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
  library/package name (AGENTS.md §12 Commit Convention).
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
