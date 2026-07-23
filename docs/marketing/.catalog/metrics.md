# Metrics: Documentation Cartography Runs

## run 28888998c0a68e2712d06b89ed1602e0c6aab3c4 — 2026-07-22T16:08:33-05:00

**Cartographer**: claude-haiku-4-5-20251001
**Status**: Initial baseline catalog
**Scope**: adhd monorepo (root)

### Metric 1: Eliminated Reader Searches
**Count**: 7 fallbacks

A fresh user reading README.md would need to search for:
1. @adhd/query (wrong path, no such package)
2. @adhd/transforms (wrong path, no such package)
3. @adhd/react-hooks (wrong path, no such package)
4. @adhd/data (wrong path, no bare barrel exists)
5. packages/ai/agent-mcp/ (path moved to entrypoint/agent-mcp/)
6. packages/ai/agent-mcp-budget/ (path moved)
7. packages/ai/agent-policy/ / packages/ai/agent-mcp-sanitize/ (paths moved)

**Breakdown by File**:
- README.md: 7 fallbacks (lines 21-43 completely wrong)
- AGENTS.md: 0 fallbacks (accurate paths)
- docs/agent-mcp/: 0 fallbacks (not discovered from README)

**Root Cause**: README.md is default Nx template with outdated package list; was never updated when packages were restructured (packages/ai/ → packages/agent/, packages/apigen/, entrypoint/), and old package names (@adhd/data, @adhd/query) were never harmonized with actual code structure.

**Recommendation**: README.md should be deleted or completely rewritten.

### Metric 2: Feature Delta
**Discovered**: 50 packages (49 libraries + 5 CLIs)
**Added (new v0.0.1 since prior run)**: @adhd/agent-core-env (2026-07-22)
**Deprecated**: None identified
**Roadmap**: @adhd/environment-cli (planned, not built)

**Recent changes** (from git status at run time):
- Modified: 11 package.json files (version edits, deps)
- Modified: 7 README.md files (docs updates)
- Added: 4 new doc directories

**Net feature delta**: 
- `discovered`: 50 
- `added`: 1 (agent-core-env)
- `deprecated`: 0
- `roadmap`: 1 (environment-cli)

### Metric 3: Doc Junk Ratio
**Junk** (wrong/obsolete/noise): ~50%
- README.md: 100% junk (default template + completely stale package list)
- docs/agent-mcp/: ~20% junk (some outdated paths, no mcp-env section in old docs)
- docs/apigen/: ~10% junk (examples outdated)
- docs/environment/: 0% junk (newly written, comprehensive)
- docs/contributing/: 0% junk (assumed accurate; not audited)

**Redundant** (duplicated elsewhere): ~15%
- AGENTS.md §1-4 vs docs/architecture/ (if it exists)
- Multiple references to agent registry packages scattered across docs
- Package-level README.md files (11 modified) vs docs/agent-mcp/

**Undocumented** (real capability with no user-facing doc): ~55%
- @adhd/agent-core-env: Not in README, AGENTS.md §4, or docs/
- Apigen plugin system: Mentioned in README but no architectural overview
- Dispatch CLI: No user-facing examples
- Environment cascade: Documented in docs/environment/ but not linked from README

**Recommendation**: Highest ROI is rewriting README.md (+4 hours to get from 50% junk to <10%).

### Current State Snapshot

| Metric | Value | Status |
|--------|-------|--------|
| Total Packages | 50 | ✓ Enumerated |
| Capabilities Shipped | 50 | ⚠️ Assumed (nx build broken) |
| Capabilities Roadmap | 1 (environment-cli) | ✓ Documented |
| Capabilities Deprecated | 0 | ✓ None found |
| User-Facing Docs | ~40% complete | 🔴 Needs work |
| Agent-Facing Docs (AGENTS.md) | ~95% complete | ✓ Comprehensive |
| Test Coverage | 169 test files | ⚠️ Cannot run (nx broken) |
| GitNexus Index Freshness | up-to-date | ✓ Fresh |
| Nx Project Graph | BROKEN | 🔴 Blocker |

### Known Issues Documented

1. **NX_LIST_BROKEN**: Project graph error blocks all verification (critical blocker)
2. **README_STALE**: Completely outdated, negative value (delete/rewrite)
3. **SCATTERED_DOCS**: Architecture info split across AGENTS.md, docs/, and package README.md
4. **NO_USER_QUICKSTART**: No working examples for consumers (agent-mcp spawn, apigen run, dispatch execute)
5. **AGENT_CORE_ENV_UNDOCUMENTED**: New package not in README or AGENTS.md §4

### Files Written

| File | Lines | Purpose |
|------|-------|---------|
| docs/marketing/.catalog/capabilities.json | 120 | Machine-readable capability list |
| docs/marketing/.catalog/doc-conformance.md | 380 | Doc assessment + recommendations |
| docs/marketing/.catalog/distribution.md | 200 | Publishing pipeline + freshness |
| docs/marketing/.catalog/required-tooling.md | 250 | Tools needed but unavailable |
| docs/marketing/.catalog/metrics.md | THIS FILE | Run metrics + recommendations |

**Next Run Should**:
1. Fix nx project graph error (debug cause)
2. Re-run all verify commands in capabilities.json
3. Run actual test suites to confirm shipped status
4. Rewrite README.md
5. Create docs/QUICK-START.md
6. Update AGENTS.md §4 with new packages

