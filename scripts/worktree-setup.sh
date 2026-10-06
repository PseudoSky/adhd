#!/usr/bin/env bash
# worktree-setup.sh <name> [base-ref]
#
# Create a git worktree at <main-checkout>/.worktrees/<name> on a NEW branch
# `${WORKTREE_BRANCH_PREFIX:-feat}/<name>` (from <base-ref>, default HEAD) and
# give it its OWN installed node_modules (backlog 7b7d5e38 / 66fd78ee / 7cd6fc6f).
#
# Why a real install and not a symlink or a copy of another tree's node_modules:
#   - a symlinked node_modules is one inode shared by every worktree, so an
#     install or a dependency-checks `--fix` in one worktree rewrites all of
#     them (the 2026-07 incident in docs/contributing/conventions/worktree-workflow.md §1.1);
#   - a worktree with NO node_modules makes `nx lint` / dependency-checks report
#     every used dependency as unused and strip it (BUG-REPO-PRECOMMIT-DEPCHECK-
#     STRIPS-USED-DEPS-001), and blocks the nx-graph pre-commit guard.
# `pnpm install --frozen-lockfile` is cheap on a warm machine-wide store
# (~/Library/pnpm/store is shared by every project) and never rewrites the
# lockfile.
#
# Exit codes: 0 ok; 2 usage; 1 any failure (existing path/branch, install
# failure, or node_modules not a real directory afterwards). Never uses
# --force, never deletes anything.
#
# Environment:
#   WORKTREE_BRANCH_PREFIX  branch prefix (default: feat)
#   WORKTREE_SETUP_PNPM     pnpm command (default: "corepack pnpm")
set -euo pipefail

usage() { echo "usage: scripts/worktree-setup.sh <name> [base-ref]" >&2; exit 2; }

[ $# -ge 1 ] && [ $# -le 2 ] || usage
name="$1"
base="${2:-HEAD}"
case "$name" in
  ''|*/*|.*|*[[:space:]]*) echo "worktree-setup: <name> must be a plain directory name (no slash, dot-prefix or whitespace): '$name'" >&2; exit 2 ;;
esac

# The MAIN checkout owns .worktrees/, even when this script is run from inside
# another worktree.
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
main_root="$(dirname "$common_dir")"
target="$main_root/.worktrees/$name"
branch="${WORKTREE_BRANCH_PREFIX:-feat}/$name"
pnpm_cmd="${WORKTREE_SETUP_PNPM:-corepack pnpm}"

if [ -e "$target" ]; then
  echo "worktree-setup: $target already exists — refusing to touch it" >&2
  exit 1
fi
if git -C "$main_root" show-ref --verify --quiet "refs/heads/$branch"; then
  echo "worktree-setup: branch $branch already exists — pick another <name>" >&2
  exit 1
fi

git -C "$main_root" worktree add "$target" -b "$branch" "$base"

(
  cd "$target"
  # shellcheck disable=SC2086
  $pnpm_cmd install --frozen-lockfile
)

if [ -L "$target/node_modules" ] || [ ! -d "$target/node_modules" ]; then
  echo "worktree-setup: $target/node_modules is not a real installed directory after install" >&2
  exit 1
fi

echo "worktree-setup: ready — $target (branch $branch, own node_modules)"
