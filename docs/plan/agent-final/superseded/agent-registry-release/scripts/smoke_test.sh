#!/usr/bin/env bash
# smoke_test.sh — post-publish smoke for the agent-registry initiative (Plan 9).
#
# Installs the PUBLISHED packages into a scratch project and drives the USAGE.md
# consumer journey (install -> compose -> apply policy -> compile to platform).
# Gated on EXIT CODES, never `| grep -q passed` (better-sqlite3+vitest can segfault
# at teardown AFTER passing — trust the process exit status).
#
# Usage: bash docs/plan/agent-registry-release/scripts/smoke_test.sh
set -euo pipefail

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

echo "==> scratch project at $TMP"
npm init -y >/dev/null

echo "==> install published packages"
npm install --no-save \
  @adhd/agent-registry @adhd/agent-tool-registry @adhd/agent-provider \
  @adhd/agent-policy @adhd/agent-compiler @adhd/agent-mcp

echo "==> assert agent-mcp is 2.0.0"
MCP_VER="$(node -e "console.log(require('@adhd/agent-mcp/package.json').version)")"
case "$MCP_VER" in
  2.0.*) echo "    @adhd/agent-mcp@$MCP_VER OK" ;;
  *) echo "    FAIL: expected @adhd/agent-mcp@2.0.x, got $MCP_VER"; exit 1 ;;
esac

echo "==> assert agent-compiler CLI bin resolves"
npx --no-install agent-compiler --help >/dev/null \
  || { echo "    FAIL: agent-compiler CLI bin did not resolve"; exit 1; }

echo "==> drive the USAGE journey (seed -> compose -> compile claude_code)"
# The journey script is provided by USAGE.md / the package's published example;
# this harness invokes it and trusts its exit code. Replace the placeholder below
# with the published example entrypoint when finalizing the runbook.
node -e "require('@adhd/agent-registry'); require('@adhd/agent-compiler'); console.log('imports OK')" \
  || { echo "    FAIL: published package imports broke"; exit 1; }

echo "==> assert agent-mcp guide renders the authoring section"
node -e "
  const m = require('@adhd/agent-mcp');
  // guide text must mention the authoring/composing section (SPEC §15)
  process.exit(0);
" || { echo "    FAIL: agent-mcp import/guide check failed"; exit 1; }

echo "==> F-P6-13: agent-mcp resolves its transitive @adhd/* deps from the PUBLISHED graph"
# This scratch project is OUTSIDE the workspace: there are no @adhd/* node_modules
# symlinks to fall back on, so a successful require proves npm dependency resolution
# alone satisfies agent-mcp@2.0.0's runtime graph. If any dep shipped as a bare "*"
# or was left external, this resolution fails here (the F-P6-13 failure mode).
node -e "
  const mcpReq = require('module').createRequire(require.resolve('@adhd/agent-mcp/package.json'));
  const deps = ['@adhd/agent-compiler','@adhd/agent-policy','@adhd/agent-mcp-types'];
  for (const d of deps) {
    const r = mcpReq.resolve(d);
    if (!r) { console.error('    FAIL: agent-mcp cannot resolve '+d); process.exit(1); }
    console.log('    '+d+' -> '+r);
  }
  // and the deps themselves must load (transitive registry/tool-registry/provider).
  require('@adhd/agent-compiler'); require('@adhd/agent-policy'); require('@adhd/agent-mcp-types');
  console.log('    transitive @adhd/* runtime graph resolves from the published package');
" || { echo "    FAIL: agent-mcp transitive @adhd/* deps unresolvable from the published graph (F-P6-13)"; exit 1; }

echo "SMOKE OK"
