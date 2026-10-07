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
# TWO LAYERS here (the first layer is each spec's own `cleanGitEnv`):
#   1. `no_hook_git_env <cmd...>` runs the test/nx invocation with the hook's
#      GIT_* variables unset, so a spec that forgets to scrub still cannot
#      reach the real repo.
#   2. `guard_snapshot` / `guard_verify` PROVE nothing leaked: they compare the
#      shared (common-dir) repo config before and after the tests and fail the
#      hook LOUDLY, naming the leak, if core.bare flipped to true or a
#      repo-local user.name/user.email appeared that was not there before.
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

guard_snapshot() {
  GUARD_CONFIG_FILE=$(_guard_config_file) || GUARD_CONFIG_FILE=""
  [ -n "$GUARD_CONFIG_FILE" ] || return 0
  GUARD_BARE_BEFORE=$(_guard_read --bool core.bare)
  GUARD_EMAIL_BEFORE=$(_guard_read user.email)
  GUARD_NAME_BEFORE=$(_guard_read user.name)
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
  if [ -n "$_leak" ]; then
    echo "" >&2
    echo "✖ GIT-ENV-LEAK (50e8c966): a test run by this hook modified the REAL repo config: $_leak." >&2
    echo "  Cause: a spec spawned git without scrubbing GIT_* (hook-exported GIT_DIR outranks cwd)." >&2
    echo "  Repair: git config --file '$GUARD_CONFIG_FILE' --bool core.bare false; remove the stray [user] section;" >&2
    echo "  inspect 'git log --all' and 'git worktree list' for fixture commits/worktrees." >&2
    echo "  Fix the spec: pass env: cleanGitEnv() (tools/nx-plugins/lib/git-env.js)." >&2
    return 1
  fi
  return 0
}
