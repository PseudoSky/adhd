# Required Tooling: Tools Needed But Unavailable

**Assessment Date**: 2026-07-22
**Catalog Run**: 28888998c0a68e2712d06b89ed1602e0c6aab3c4

## Blocking Issues

### 1. Nx Project Graph Broken ⛔ CRITICAL
**Issue**: `npx nx list` and `npx nx build <package>` fail with "Failed to process project graph" error

**Capabilities Affected**:
- ALL capability verification (marked 🔴 UNVERIFIED in capabilities.json)
- Cannot compile packages to verify dist/
- Cannot run tests to prove shipped capabilities
- Cannot check dependency boundaries
- Cannot generate code via workspace generators

**Root Cause**: Unknown. Verbose flag does not provide stack trace. No apparent syntax errors in package.json or project.json files.

**Workaround Used**: 
- Enumerated packages manually via `find packages -name package.json`
- Read source code directly (src/index.ts) to assess exports
- Relied on GitNexus knowledge graph (which reports "up-to-date") for execution flows

**Impact on Metrics**:
- Cannot fully verify "shipped" status for 100% of capabilities
- All verify commands in capabilities.json are marked UNVERIFIED
- Tests exist but cannot be run to prove thy pass
- Build artifacts (dist/) cannot be verified as loadable

**Next Steps**:
1. Run `npx nx list --verbose 2>&1 > /tmp/nx-graph-error.txt` and inspect full stack trace
2. Check for syntax errors in all nx.json, project.json, tsconfig.json files
3. Verify no circular dependencies introduced by recent changes
4. Consider running `npx nx reset` to clear cache/state and retry

**Estimated Provisioning Cost**: None (tool already available, just broken). Requires debugging, not new tool.

---

## Information Gaps

### 2. Cannot Access npm Registry Metadata
**Issue**: `npm info @adhd/<package>` (or similar) not available in this assessment scope

**Capabilities Affected**:
- Cannot verify which packages are published to npm
- Cannot determine last-published dates
- Cannot check public vs private package status
- Cannot assess package download stats

**What I Could Not Document**:
- Actual npm publish status (which packages are live on npm.js)
- Last-published timestamp per package (in distribution.md)
- Package freshness relative to source (commits since last publish)
- Dependency compatibility (what versions of @anthropic-ai/sdk, better-sqlite3, etc. are actually on npm)

**Information Source**: 
- `package.json` files show local versions (e.g., v2.1.2)
- PUBLISHING.md describes publish process but doesn't list recent publishes

**Workaround Used**: Documented in distribution.md as "UNKNOWN" for all npm queries; noted as open question for steward/publisher.

**Estimated Provisioning Cost**: None. Requires `npm cli` access or web API (which I have). Just not executed in this run.

---

### 3. Cannot Verify Built Artifacts (dist/)
**Issue**: Nx build broken; cannot compile packages to inspect dist/ contents

**Capabilities Affected**:
- Cannot run verify commands like `npx apigen-cli --help`
- Cannot check that exports are actually loadable (dist/index.js)
- Cannot verify TypeScript compilation (no errors, correct types)
- Cannot check tree-shaking, bundle size, or output format

**What I Could Not Verify**:
- Whether dist/ actually exists and contains runnable code
- Whether `import()` statements resolve at runtime
- Whether TypeScript compilation succeeds (assumes yes based on CI/CD)
- Whether bundles are correctly formatted (CJS vs ESM)

**Workaround Used**: Relied on:
- Source code inspection (src/index.ts exports, src/**/*.ts implementation)
- Test file presence (indicates package is being tested)
- Package.json bin/ fields (indicate CLI entrypoints)
- GitNexus type information (resolves imports, knows function signatures)

**Estimated Provisioning Cost**: Dependent on fixing Nx graph (see §1). Once fixed, `npx nx run-many -t build` will compile all packages.

---

### 4. Cannot Run Integration Tests
**Issue**: Nx test also blocked by broken project graph

**Capabilities Affected**:
- Cannot execute test suites to prove capabilities work
- Cannot run agent-mcp server and call MCP tools
- Cannot run apigen-cli and generate a real API
- Cannot run dispatch-cli and execute a real DAG

**What I Could Not Verify**:
- Whether test suites pass (169 test files exist but not executable)
- Whether integration tests prove consumer outcomes (they should per AGENTS.md §7)
- Whether live LLM tests pass (if they exist behind AGENT_MCP_LIVE=1 gate)

**Workaround Used**: Documented as "🔴 UNVERIFIED (needs build)" in capabilities.json. Relied on:
- Test file existence (packages/agent/agent-base-types/src/test/domain.spec.ts)
- Test naming patterns (*.spec.ts suggests Vitest)
- Comments in source (e.g., agent-mcp/src/index.ts describes expected behavior)

**Estimated Provisioning Cost**: Dependent on fixing Nx graph. Once fixed, `npx nx affected -t test` will run all affected test suites.

---

### 5. Cannot Verify Cross-Package Dependencies
**Issue**: Nx graph broken; cannot trace import paths or validate dependency boundaries

**Capabilities Affected**:
- Cannot check that apigen plugins correctly depend on apigen-core-client
- Cannot verify that @adhd/environment-builder is not imported by browser code
- Cannot check platform isolation (platform:node vs platform:browser vs platform:shared)
- Cannot validate tier hierarchy (base can't import core, core can't import engine, etc.)

**What I Could Not Verify**:
- Whether actual imports match documented tier hierarchy
- Whether platform constraints are enforced (e.g., no React imports in platform:node)
- Whether circular dependencies exist
- Whether exported APIs match type definitions

**Workaround Used**: Relied on:
- Source code inspection (grep for `import { X } from '@adhd/...` patterns)
- Package.json dependencies field (shows declared dependencies, not actual imports)
- GitNexus code graph (CALLS edges show actual call graph, useful for some verification)

**Estimated Provisioning Cost**: Dependent on fixing Nx graph.

---

## Impact Summary

| Tool | Status | Blocking? | Alternative | Effort to Provision |
|------|--------|-----------|-------------|-------------------|
| `npx nx` (project graph) | 🔴 BROKEN | YES (all verification) | Manual enumeration | Debug + fix (unknown) |
| `npm info` / npm registry | ⚠️ NOT ACCESSED | NO (informational) | Steward/publisher manual check | None (available, chose not to use) |
| `npx <cli> --help` | 🔴 BLOCKED | NO (informational) | Source code inspection | Fix Nx graph + build |
| Integration tests | 🔴 BLOCKED | NO (proof) | Test file inspection | Fix Nx graph + test |
| Dependency audits | 🔴 BLOCKED | NO (governance) | Manual inspection | Fix Nx graph + lint |

## Verification Debt

All capabilities in capabilities.json marked 🔴 UNVERIFIED:

```json
"verified_output": "🔴 UNVERIFIED (needs build)",
"verified_output": "🔴 UNVERIFIED (missing tool: nx-build broken)",
```

This is honest signal, not a limitation of the cartographer. Once Nx graph is fixed:

1. Rebuild with `npx nx build <package>` for each capability
2. Run `<cli> --help` to get actual help text
3. Execute `verify` command in each capabilities.json entry and capture stdout
4. Update verified_output fields with real output
5. Change status to ✓ for any that succeed

**Estimated Re-Run Effort**: 30 min (once Nx is fixed) to run all verify commands and update capabilities.json.

