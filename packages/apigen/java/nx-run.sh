#!/usr/bin/env sh
# nx target driver for apigen-java (packages/apigen/java, FEAT-APIGEN-001).
#
# Mirrors the pattern prototyped for Rust in an unmerged sibling worktree
# (.worktrees/apigen-reexport-fix/.../environment-core-rs/nx-run.sh — not a
# path present on this branch or main): there is no registered Nx plugin for
# Java in nx.json (only @monodon/rust and @nxlv/python are registered), so
# this module is driven by nx:run-commands + this script rather than a new
# Nx plugin (installing one requires human approval).
#
# Resolves `mvn` from PATH and fails loudly if it is absent — never silently
# skips. Invoked by project.json's build/test/package targets.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

MVN=$(command -v mvn 2>/dev/null || true)
if [ -z "$MVN" ] && [ -x /opt/homebrew/bin/mvn ]; then
  MVN=/opt/homebrew/bin/mvn
fi
if [ -z "$MVN" ]; then
  echo "FATAL: mvn not found on PATH or at /opt/homebrew/bin/mvn" >&2
  exit 127
fi

case "${1:-}" in
  build)   exec "$MVN" -q -pl . compile ;;
  test)    exec "$MVN" -q -pl . test ;;
  package) exec "$MVN" -q -pl . package -DskipTests ;;
  *) echo "usage: nx-run.sh {build|test|package}" >&2; exit 2 ;;
esac
