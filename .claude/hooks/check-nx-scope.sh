#!/usr/bin/env sh
#
# check-nx-scope.sh — PreToolUse hook (Bash matcher) enforcing this repo's
# "agents only ever run affected nx commands" rule (see
# DEBT-PROCESS-AFFECTED-TEST-001, tmp/release-pipeline-audit.md).
#
# Two disallowed shapes, both real footguns confirmed this session:
#
#   1. `nx test|build|lint <project>` (bare, not run-many/affected) —
#      silently misses every downstream consumer of <project>. Confirmed
#      real: commit a82ec947 changed apigen-engine-naming, the author only
#      ran targeted `nx test` on two packages, three downstream test suites
#      landed broken and stayed broken until a later triage pass.
#
#   2. `nx run-many -t test|build|lint|publish` with no `--projects=`/
#      `--affected` scoping — runs the full workspace task graph regardless
#      of what changed. Confirmed real: today's unscoped `nx run-many -t
#      publish` pulled in 486-541 tasks for a ~15-package changeset, causing
#      3 distinct resource-contention failures (all reproduced clean in
#      isolation). Fixed for the release pipeline itself in
#      tools/nx-plugins/build/executors/smoke-test/run-release.mjs +
#      tools/nx-plugins/build/lib/changed-set.js — this hook is the same
#      rule enforced for ad-hoc agent Bash commands, which can't be fixed by
#      changing one script.
#
# Reads the PreToolUse JSON payload on stdin, checks .tool_input.command.
# Emits {} (allow, no comment) for anything that doesn't match, or a deny
# decision with a pointer to the correct affected-scoped alternative.
#
# BUG-REPO-HOOK-HEREDOC-001: the matching below used to run against the
# ENTIRE command string verbatim, including heredoc bodies. A `git commit -F
# -` whose commit MESSAGE merely quoted the forbidden pattern (e.g. prose in
# an incident write-up describing `nx run-many -t publish` as the bug being
# fixed) got denied as if it were executing that command. Two fixes below,
# both required to preserve real blocking while unblocking prose:
#   (a) short-circuit ALLOW when the command's leading token is `git commit`
#       — a commit invocation's own argv never contains an nx invocation to
#       execute, only (optionally) a message that may quote/describe one.
#   (b) for every other command, strip heredoc BODIES (the lines between a
#       `<<EOF`/`<<'EOF'`/`<<-EOF` opener and its terminator line) before
#       pattern-matching, so a heredoc payload used for something other than
#       `git commit -F -` (e.g. `cat <<'EOF' > notes.md`) can't trigger a
#       false block either.
# This must NOT weaken real enforcement: an actual unscoped `nx run-many -t
# build` (or the bare-target shape) is still blocked, heredoc or not.

cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$cmd" ]; then
  echo '{}'
  exit 0
fi

# NOTE: there is deliberately NO `git commit` leading-token short-circuit.
# An earlier version of this fix allowed any command whose first token was
# `git commit`, reasoning that a commit message is data. That opened a real
# bypass in the opposite direction from the one it guarded against: the
# short-circuit fired on the LEADING token, so `git commit -m x && npx nx
# run-many -t build` (and the `;` variant) sailed through with the unscoped
# nx invocation chained AFTER the commit. Verified ALLOW before removal,
# DENY after. Heredoc-body stripping below is sufficient on its own for the
# real case this fix exists for (a `git commit -F -` whose MESSAGE quotes a
# forbidden command), so the short-circuit bought nothing and cost enforcement.

# Strip heredoc BODIES before matching anything else. A heredoc opener
# looks like `<<EOF`, `<<'EOF'`, `<<"EOF"`, or `<<-EOF` (the `-` variant
# additionally strips leading tabs from the terminator line); the body runs
# from the line after the opener through the first line that is exactly the
# delimiter (tab-stripped for `<<-`). Only the opener LINE's portion up to
# the `<<...` token is kept for matching (so e.g. `cat <<'EOF' | nx build x`
# is impossible to construct meaningfully anyway, but we don't lose real
# content preceding the redirect on that line).
stripped=$(printf '%s\n' "$cmd" | awk '
  BEGIN { skip = 0; delim = ""; striptabs = 0 }
  {
    line = $0
    if (skip) {
      check = line
      if (striptabs) sub(/^\t+/, "", check)
      if (check == delim) { skip = 0; delim = "" }
      next
    }
    if (match(line, /<<-?[ \t]*("[^"]*"|'"'"'[^'"'"']*'"'"'|[A-Za-z_][A-Za-z0-9_]*)/)) {
      pre = substr(line, 1, RSTART - 1)
      tok = substr(line, RSTART, RLENGTH)
      print pre
      striptabs = (tok ~ /^<<-/) ? 1 : 0
      d = tok
      sub(/^<<-?[ \t]*/, "", d)
      gsub(/^"/, "", d); gsub(/"$/, "", d)
      gsub(/^'"'"'/, "", d); gsub(/'"'"'$/, "", d)
      delim = d
      skip = 1
      next
    }
    print line
  }
')

cmd="$stripped"

if [ -z "$cmd" ]; then
  echo '{}'
  exit 0
fi

# Only look at commands that actually invoke nx (bare `nx`, `npx nx`, `pnpm nx`).
case "$cmd" in
  *nx\ *) ;;
  *) echo '{}'; exit 0 ;;
esac

# Already affected/run-many-scoped or graph/show/list/reset/format (read-only
# or already-correct) — never block these.
case "$cmd" in
  *--affected*|*affected*|*--projects=*) echo '{}'; exit 0 ;;
  *"nx graph"*|*"nx show"*|*"nx list"*|*"nx reset"*|*"nx format"*) echo '{}'; exit 0 ;;
esac

# Shape 1: bare `nx test|build|lint <project>` (single targeted project, no
# run-many, no affected — already excluded above).
if echo "$cmd" | grep -qE '(^|[^a-zA-Z0-9_-])nx[[:space:]]+(test|build|lint)[[:space:]]+[a-zA-Z0-9@/_-]+' \
   && ! echo "$cmd" | grep -qE 'run-many'; then
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Targeted `nx test/build/lint <project>` silently misses downstream consumers when the project has dependents (DEBT-PROCESS-AFFECTED-TEST-001 — a real incident, commit a82ec947, landed 3 broken downstream suites this way). Use `npx nx affected -t <target> --uncommitted` (or --base=<ref>/--files=<path>), which naturally scopes to the real changed set including all dependents. Only a leaf package with zero dependents is safe to target directly, and this hook can't verify that for you — prefer affected regardless."}}
EOF
  exit 0
fi

# Shape 2: `nx run-many -t test|build|lint|publish` with no scoping flag
# (already excluded --affected/--projects= above).
if echo "$cmd" | grep -qE 'run-many[[:space:]].*-t[[:space:]]+(test|build|lint|publish)'; then
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Unscoped `nx run-many -t <target>` runs the full workspace task graph regardless of what changed (confirmed 486-541 tasks for a ~15-package real changeset, causing 3 resource-contention failures this session). Use `npx nx affected -t <target> --uncommitted` (or --base=<ref>) for a dev sweep, or for release, `pnpm release` (tools/nx-plugins/build/executors/smoke-test/run-release.mjs) already computes and passes --projects= via tools/nx-plugins/build/lib/changed-set.js — do not call run-many -t publish/test/build/lint directly."}}
EOF
  exit 0
fi

echo '{}'
