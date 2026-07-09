#!/usr/bin/env sh
# nx target driver for environment-core-py (PyPI: adhd-environment).
# Resolves `uv` from PATH, then the Homebrew keg fallback, and fails loudly
# if neither exists. Invoked by project.json build/test/nx-release-publish.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

UV=$(command -v uv 2>/dev/null || true)
if [ -z "$UV" ] && [ -x /opt/homebrew/bin/uv ]; then
  UV=/opt/homebrew/bin/uv
fi
if [ -z "$UV" ]; then
  echo "FATAL: uv not found on PATH or at /opt/homebrew/bin/uv" >&2
  exit 127
fi

case "${1:-}" in
  build)   exec "$UV" run --python 3.10 -m build ;;
  test)    exec "$UV" run --python 3.10 -m pytest tests/ ;;
  # publish is intentionally NOT wired to real credentials here; TWINE/UV
  # tokens are supplied by the release environment, never committed.
  publish) exec "$UV" publish dist/* ;;
  *) echo "usage: nx-run.sh {build|test|publish}" >&2; exit 2 ;;
esac
