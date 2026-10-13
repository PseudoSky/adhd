#!/usr/bin/env bash
# Thin launcher: all logic lives in worktree-merge.mjs.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/worktree-merge.mjs" "$@"
