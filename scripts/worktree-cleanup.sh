#!/usr/bin/env bash
# Thin launcher: all logic lives in worktree-cleanup.mjs (JSON/hash handling needs node; macOS bash may be 3.2).
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/worktree-cleanup.mjs" "$@"
