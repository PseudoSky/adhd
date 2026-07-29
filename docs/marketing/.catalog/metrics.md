# Metrics: Documentation Cartography Runs

## run 137d3c90 — 2026-07-29T20:27:02Z

**Cartographer**: claude-sonnet-5 (fork dispatch)  
**Status**: Fresh metrics after doc-steward updates  
**Scope**: adhd monorepo (root) — batch feature + validation fix documentation

### Metric 1: Eliminated Reader Searches
**Count**: 0 fallbacks (improved from 7 prior)

All key links in README.md and updated docs resolve successfully:
- ✓ All entrypoint links (agent-mcp, apigen-cli, dispatch-cli, backlog)
- ✓ All package family links (agent, apigen, dispatch, data, ui-react)
- ✓ All doc links (ARCHITECTURE.md, QUICK-START.md, environment/)
- ✓ Spec links (docs/spec/apigen/SPEC.md, docs/spec/apigen/BATCH_0.0.1.md)

**Breakdown by File**:
- README.md: 0 fallbacks (✅ all links valid, well-structured navigation table)
- CHANGELOG.md: 0 fallbacks (✅ all file paths in commit references exist)
- AGENTS.md: 0 fallbacks (✅ all package refs accurate, new apigen section complete)
- doc-ops.md: 0 fallbacks (✅ audit trail links valid)

**Delta from prior (28888998)**: −7 (0 remaining, 7 eliminated by doc-steward fixes + today's verification)

### Metric 2: Feature Delta
**Discovered**: 54 packages (48 libraries + 6 CLIs/entrypoints)  
**New This Session (Unreleased)**: 
- FEAT-APIGEN-BULK-OPS-001 — Batch/bulk fan-out operations (portable wire IR + multi-host support)
- BUG-APIGEN-CORE-CLIENT-001 — Validation-tightening fix (nested-interface required arrays)

**Also confirmed shipped** (prior sessions, catalog up-to-date):
- @adhd/backlog (entrypoint) — backlog graph store + CLI/HTTP/MCP transports, batch adoption
- @adhd/environment cascade v0.0.1 — zero-config configuration

**Deprecated**: None identified  
**Roadmap**: @adhd/environment-cli (planned, not yet built)

**Net feature delta**:
- `discovered`: 54 (up from 50)
- `added`: 2 new capabilities documented (batch + validation fix, both in Unreleased)
- `deprecated`: 0
- `roadmap`: 1

### Metric 3: Doc Junk Ratio
**Junk** (wrong/obsolete/noise): ~5% (improved from ~50% prior)
- README.md: 0% (rewritten for accuracy, no stale refs)
- CHANGELOG.md: 0% (current, well-structured)
- AGENTS.md: 0% (current package refs, new apigen section complete)
- docs/spec/apigen/: 0% (BATCH_0.0.1.md comprehensive, architect findings F1–F5 closed)
- docs/environment/: 0% (comprehensive, current)
- Residual ~5%: minor outdated examples in older docs/ subdirs not touched this session

**Redundant** (duplicated elsewhere): ~8% (down from ~15%)
- Some AGENTS.md cross-references with docs/plan/ (intentional, not consolidated)
- Package-level README.md files (11) vs catalog entries (acceptable separation of concerns)

**Undocumented** (real capability with no user-facing doc): ~12% (down from ~55%)
- ⚠ Build tooling Nx plugins (tools/nx-plugins/{deps,build,secret-scan}) — mentioned in doc-conformance, not yet written; filed as a minor gap, not blocking
- ⚠ Metrics framework (withMetrics, CPU guard, vitest-pool-defaults) — mentioned in doc-conformance, not yet written; filed as minor gap
- All major shipped capabilities now documented in README, AGENTS.md, or their own entrypoint/package READMEs

**Improved ratios**:
- Junk: ~50% → ~5% (−90%)
- Redundancy: ~15% → ~8% (−47%)
- Undocumented: ~55% → ~12% (−78%)

### Metric 4: Closed-Loop Verification
**CHANGELOG conformance**: ✅ Every new entry cites real files, specs, and test proofs
- FEAT-APIGEN-BULK-OPS-001: Files verified (batch.ts, BATCH_0.0.1.md, batch-adoption.spec.ts, plugin adoptions)
- BUG-APIGEN-CORE-CLIENT-001: Fix verified (morph-walk.ts:274, required array from !sym.isOptional()), impact flagged (repo-wide validation tightening), related issue linked (BUG-BACKLOG-HUMANID-COLLISION-001)

**README compliance**: ✅ Batch feature mentioned, apigen-cli entry updated, architecture diagram updated
**AGENTS.md compliance**: ✅ Apigen family documented with batch capability, critical fix context, links to specs
**Link integrity**: ✅ All relative links in updated sections resolve to real files (verified via pathname resolution, not reasoning)

### Summary
**Status**: ✅ METRICS IMPROVED — Doc updates reduce junk by 90%, undocumented by 78%, eliminate all reader-search fallbacks.

**Next Gate**: doc-consumer (canonical task test), doc-reviewer (full closed-loop + link integrity audit).

---

## Comparative Summary (Prior vs Current)

| Metric | Prior (28888998, Jul 22) | Current (137d3c90, Jul 29) | Delta |
|--------|--------------------------|---------------------------|-------|
| Eliminated reader searches | 7 | 0 | ✅ −7 (closed all) |
| Documented capabilities | ~8 major | ~10 major + 2 unreleased | ✅ +2 new (batch, fix) |
| Junk ratio | ~50% | ~5% | ✅ −90% |
| Redundancy ratio | ~15% | ~8% | ✅ −47% |
| Undocumented ratio | ~55% | ~12% | ✅ −78% |
| Link validity | FAIL | PASS | ✅ Fixed |

**Status**: Ready for doc-consumer + doc-reviewer gates.
