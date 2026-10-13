#!/usr/bin/env bash
# worktree-setup.sh <name> [base-ref]
# worktree-setup.sh --bl <backlog-id> [base-ref]
#
# Create a git worktree at <main-checkout>/.worktrees/<name> on a NEW branch
# `${WORKTREE_BRANCH_PREFIX:-feat}/<name>` (from <base-ref>, default HEAD) and
# give it its OWN installed node_modules (backlog 7b7d5e38 / 66fd78ee / 7cd6fc6f).
#
# With --bl the backlog item is looked up (WORKTREE_BACKLOG_CMD, default `adhd-backlog`)
# and the worktree AND branch are both named `plan-<8hex>` (kind PLAN) or `task-<8hex>`
# (any other kind), with no prefix. The item's uid and title are recorded in branch
# config (adhd-backlog-uid / adhd-backlog-title) for scripts/worktree-merge.sh and
# scripts/worktree-cleanup.sh. Merge and clean up with those scripts, never by hand.
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

usage() {
  echo "usage: scripts/worktree-setup.sh <name> [base-ref]" >&2
  echo "       scripts/worktree-setup.sh --bl <backlog-id> [base-ref]" >&2
  exit 2
}

# --bl <id> may appear anywhere; everything else is positional.
bl=""
positional=()
while [ $# -gt 0 ]; do
  case "$1" in
    --bl) [ $# -ge 2 ] || usage; bl="$2"; shift 2 ;;
    -*) usage ;;
    *) positional+=("$1"); shift ;;
  esac
done

bl_uid="" bl_title=""
if [ -n "$bl" ]; then
  [ ${#positional[@]} -le 1 ] || usage
  base="${positional[0]:-HEAD}"
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # prints: <name>\t<uid>\t<title>   (stdout only; the backlog CLI logs to stderr)
  resolved="$(node "$script_dir/lib/worktree-resolve-bl.mjs" "$bl")" || { echo "worktree-setup: could not resolve backlog id '$bl'" >&2; exit 1; }
  IFS=$'\t' read -r name bl_uid bl_title <<<"$resolved"
  branch="$name"
else
  [ ${#positional[@]} -ge 1 ] && [ ${#positional[@]} -le 2 ] || usage
  name="${positional[0]}"
  base="${positional[1]:-HEAD}"
  branch="${WORKTREE_BRANCH_PREFIX:-feat}/$name"
fi
case "$name" in
  ''|*/*|.*|*[[:space:]]*) echo "worktree-setup: <name> must be a plain directory name (no slash, dot-prefix or whitespace): '$name'" >&2; exit 2 ;;
esac

# The MAIN checkout owns .worktrees/, even when this script is run from inside
# another worktree.
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
main_root="$(dirname "$common_dir")"
target="$main_root/.worktrees/$name"
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
if [ -n "$bl_uid" ]; then
  git -C "$main_root" config "branch.$branch.adhd-backlog-uid" "$bl_uid"
  git -C "$main_root" config "branch.$branch.adhd-backlog-title" "$bl_title"
fi

(
  cd "$target"
  # shellcheck disable=SC2086
  $pnpm_cmd install --frozen-lockfile
)

if [ -L "$target/node_modules" ] || [ ! -d "$target/node_modules" ]; then
  echo "worktree-setup: $target/node_modules is not a real installed directory after install" >&2
  exit 1
fi

# Seed the gitnexus index so `gx` works here without a cold analyze (757f40d7).
# gitnexus 1.6.5 keeps the index in <checkout>/.gitnexus and only collapses worktree
# *names* to the repo's (GITNEXUS_HOME just moves the registry), so a new worktree
# has no index. Clone main's (APFS clonefile / reflink: ~free) and run an incremental
# analyze detached, which registers this worktree (~80s vs a cold full index).
# Nx needs no seeding: with nx.json's cacheDirectory unpinned, Nx 23 shares one cache
# + index DB per user across every checkout of the workspace.
# Best-effort: never fails setup. WORKTREE_SEED_GITNEXUS=0 turns it off.
if [ "${WORKTREE_SEED_GITNEXUS:-1}" != "0" ] && [ -d "$main_root/.gitnexus" ] && command -v gitnexus >/dev/null 2>&1; then
  if [ -e "$main_root/.gitnexus/.reindex.lock" ]; then
    echo "worktree-setup: gitnexus is indexing right now — skipped the index seed (run: cd $target && gitnexus analyze --index-only)"
  elif { cp -cR "$main_root/.gitnexus" "$target/.gitnexus" 2>/dev/null || cp -R "$main_root/.gitnexus" "$target/.gitnexus" 2>/dev/null; }; then
    mkdir -p "$target/tmp"
    ( cd "$target" && nohup gitnexus analyze --index-only . >"$target/tmp/gitnexus-analyze.log" 2>&1 & ) 
    echo "worktree-setup: gitnexus index cloned; registering in the background (log: $target/tmp/gitnexus-analyze.log, ~80s until gx answers)"
  else
    echo "worktree-setup: gitnexus index clone failed — run: cd $target && gitnexus analyze --index-only"
  fi
fi

echo "worktree-setup: ready — $target (branch $branch, own node_modules)"
