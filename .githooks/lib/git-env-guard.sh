#!/usr/bin/env sh
#
# git-env-guard.sh — defense in depth for 50e8c966 (sourced by pre-commit and
# pre-push; POSIX sh, no dependencies).
#
# THE INCIDENT: git exports GIT_DIR (+ GIT_INDEX_FILE, ...) into every hook it
# runs; from a linked worktree GIT_DIR=<repo>/.git/worktrees/<name>. Those
# variables outrank `cwd`, so a test that spawns `git init|config|commit` in an
# mkdtemp dir WITHOUT scrubbing GIT_* writes into the REAL repo (core.bare=true,
# repo-local user.name/email, fixture commits on a real branch) while exiting 0.
#
# THREE LAYERS (layer 1 is each spec's own `cleanGitEnv`; this file is 2 and 3):
#   2. `no_hook_git_env <cmd...>` runs the test/nx invocation with the hook's
#      GIT_* variables unset, so a spec that forgets to scrub still cannot
#      reach the real repo.
#   3. `guard_snapshot` / `guard_verify` PROVE nothing leaked: they snapshot and
#      re-compare (a) the shared (common-dir) repo config - core.bare,
#      user.name, user.email; (b) refs (`git for-each-ref`: new refs, moved
#      tips, deleted refs); (c) the worktree path list (`git worktree list
#      --porcelain`) - and fail the hook LOUDLY, naming exactly what changed.
#      Ref scope: refs/remotes/* and branches checked out in OTHER worktrees are
#      ignored (concurrent agents legitimately move those during a long test
#      run); refs named via `guard_exclude_ref` (the ref being pushed) are
#      ignored. A worktree added/removed by a concurrent process during the run
#      is reported too - the message names the path so the cause is obvious.
#
# Contract: `guard_verify` returns non-zero (and prints a message containing
# "GIT-ENV-LEAK") on a detected leak, 0 otherwise. Callers must exit non-zero.

# Run "$@" with every hook-exported GIT_* repo-selection variable removed.
no_hook_git_env() {
  env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_PREFIX "$@"
}

# Absolute path of the SHARED repo config (the file a leaked `git config` /
# `git init` lands in), resolved from the hook's own (correct) environment.
_guard_config_file() {
  _gcd=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  printf '%s/config\n' "$_gcd"
}

_guard_read() { # <key> [--bool]
  git config --file "$GUARD_CONFIG_FILE" "$@" 2>/dev/null || true
}

# Refs the caller says may legitimately differ (the ref being pushed/committed).
GUARD_EXCLUDE_REFS=""
guard_exclude_ref() { GUARD_EXCLUDE_REFS="$GUARD_EXCLUDE_REFS $1 "; }

# "<refname> <sha>" for every ref this hook is entitled to treat as stable.
_guard_refs() {
  _gtop=$(git rev-parse --show-toplevel 2>/dev/null || true)
  _gother=$(git worktree list --porcelain 2>/dev/null | awk -v top="$_gtop" '
    /^worktree / { wt = substr($0, 10) }
    /^branch /   { if (wt != top) print substr($0, 8) }')
  git for-each-ref --format='%(refname) %(objectname)' 2>/dev/null | while read -r _rn _rs; do
    case "$_rn" in refs/remotes/*) continue ;; esac
    case "$GUARD_EXCLUDE_REFS" in *" $_rn "*) continue ;; esac
    if [ -n "$_gother" ] && printf '%s\n' "$_gother" | grep -qxF "$_rn"; then continue; fi
    printf '%s %s\n' "$_rn" "$_rs"
  done
}

# Worktree paths only (HEAD shas change on every legitimate commit).
_guard_worktrees() {
  git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p'
}

guard_snapshot() {
  GUARD_CONFIG_FILE=$(_guard_config_file) || GUARD_CONFIG_FILE=""
  [ -n "$GUARD_CONFIG_FILE" ] || return 0
  GUARD_BARE_BEFORE=$(_guard_read --bool core.bare)
  GUARD_EMAIL_BEFORE=$(_guard_read user.email)
  GUARD_NAME_BEFORE=$(_guard_read user.name)
  GUARD_REFS_BEFORE=$(_guard_refs)
  GUARD_WT_BEFORE=$(_guard_worktrees)
}

# Names every line that differs between two newline-separated snapshots.
_guard_diff() { # <before> <after>
  _gb=$(mktemp) && _ga=$(mktemp) || return 0
  printf '%s\n' "$1" | sort >"$_gb"
  printf '%s\n' "$2" | sort >"$_ga"
  diff "$_gb" "$_ga" 2>/dev/null | sed -n 's/^< /-/p;s/^> /+/p' | tr '\n' ' '
  rm -f "$_gb" "$_ga"
}

guard_verify() {
  [ -n "${GUARD_CONFIG_FILE:-}" ] || return 0
  _bare=$(_guard_read --bool core.bare)
  _email=$(_guard_read user.email)
  _name=$(_guard_read user.name)
  _leak=""
  if [ "$_bare" = "true" ] && [ "$GUARD_BARE_BEFORE" != "true" ]; then
    _leak="core.bare flipped to true"
  fi
  if [ -n "$_email" ] && [ "$_email" != "$GUARD_EMAIL_BEFORE" ]; then
    _leak="${_leak:+$_leak; }repo-local user.email set to '$_email'"
  fi
  if [ -n "$_name" ] && [ "$_name" != "$GUARD_NAME_BEFORE" ]; then
    _leak="${_leak:+$_leak; }repo-local user.name set to '$_name'"
  fi
  _refs_after=$(_guard_refs)
  if [ "$_refs_after" != "$GUARD_REFS_BEFORE" ]; then
    _leak="${_leak:+$_leak; }refs changed (-old +new): $(_guard_diff "$GUARD_REFS_BEFORE" "$_refs_after")"
  fi
  _wt_after=$(_guard_worktrees)
  if [ "$_wt_after" != "$GUARD_WT_BEFORE" ]; then
    _leak="${_leak:+$_leak; }worktree list changed (-removed +added): $(_guard_diff "$GUARD_WT_BEFORE" "$_wt_after")"
  fi
  if [ -n "$_leak" ]; then
    echo "" >&2
    echo "✖ GIT-ENV-LEAK (50e8c966): a test run by this hook modified the REAL repo: $_leak." >&2
    echo "  (A ref/worktree change can also come from a concurrent process in this shared repo; the" >&2
    echo "  names above say which. If it is not a fixture, re-run the hook.)" >&2
    echo "  Cause: a spec spawned git without scrubbing GIT_* (hook-exported GIT_DIR outranks cwd)." >&2
    echo "  Repair: git config --file '$GUARD_CONFIG_FILE' --bool core.bare false; remove the stray [user] section;" >&2
    echo "  inspect 'git log --all' and 'git worktree list' for fixture commits/worktrees." >&2
    echo "  Fix the spec: pass env: cleanGitEnv() (tools/nx-plugins/lib/git-env.js)." >&2
    return 1
  fi
  return 0
}
