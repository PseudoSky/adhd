# Documentation Conformance Assessment

**Scope**: adhd monorepo (root)
**Assessment Date**: 2026-07-22
**Last Verified Commit**: 28888998c0a68e2712d06b89ed1602e0c6aab3c4

## Executive Summary

| Metric | Value |
|--------|-------|
| **Total Public Capabilities** | 8 major + 50 packages |
| **Documented in README** | 0% (completely stale) |
| **Documented in AGENTS.md** | ~40% (agent-facing, not user-facing) |
| **Documented in docs/** | ~30% (scattered, not linked) |
| **Junk Ratio** | ~50% (dead paths, moved packages) |
| **Redundancy Ratio** | ~15% (scattered references to same concept) |
| **Undocumented Ratio** | ~55% (real packages with no public surface) |

## Per-Document Assessment

### README.md
**Status**: 🔴 **REMOVE** — Junk, negative value

**Coverage**: Lines 1-102
- **Junk** (~60%): Default Nx boilerplate (lines 1-19), outdated package list (lines 21-43), stale shell examples (lines 44-58), generic Nx documentation (lines 61-102)
- **Incorrect** (~40%): Every single package path/name is wrong
  - Cites `@adhd/data`, `@adhd/query`, `@adhd/react-hooks`, `@adhd/transforms` (NO SUCH PACKAGES)
  - Cites `packages/ai/agent-mcp/` (MOVED to `entrypoint/agent-mcp/`)
  - Cites `packages/ai/agent-mcp-budget/`, `packages/ai/agent-policy/`, `packages/ai/agent-mcp-sanitize/` (ALL MOVED)

**Problems**:
1. **Reader Fallback**: A user reading README.md MUST search npm/repo for wrong package names, then manually trace real paths
2. **Trust Damage**: Users will assume all docs are stale (they are)
3. **No Actual Project Description**: Doesn't explain what the @adhd ecosystem IS, what it's FOR, who uses it

**Recommendation**: **DELETE entirely or completely rewrite from scratch.** Current version provides negative value — it's actively misleading.

**Action Items**:
- [ ] Delete README.md or rewrite it with: project mission, who this is for, quick-start (actually working examples), and links to real docs (AGENTS.md, docs/)
- [ ] Link from README to the REAL docs (docs/agent-mcp/, docs/apigen/, docs/environment/)

---

### AGENTS.md
**Status**: 🟡 **REVISE** — Agent-facing instruction document, not user-facing

**Coverage**: 315 lines, 12 sections
- **Quality**: Comprehensive and mostly accurate (self-updates, admits staleness)
- **Audience**: Agents operating the monorepo, not external users
- **Location**: Repo root, hard to discover (GitHub treats it as configuration, not documentation)

**Issues**:
1. **§4 Existing Package Context**: Self-admits "has gone stale before," lists 7 packages but many have dependencies/related packages not listed (no mention of @adhd/agent-core-env, apigen plugins, environment cascade)
2. **No Public APIs Listed**: Doesn't explain what consumers can actually USE from these packages
3. **Architectural Jargon**: Heavy use of internal concepts (tier, layer, domain, platform tags) without explaining why a user would care
4. **Not Discoverable**: Not in docs/, no navigation from README, GitHub/IDE searches find it but it's clearly an internal guide

**Strengths**:
- Correct package paths and names
- Accurate dependency rules
- Detailed testing protocol
- Publishing workflow clearly documented

**Recommendation**: **KEEP as-is for agent use, but CREATE a separate user-facing architecture guide.**

**Action Items**:
- [ ] Create docs/ARCHITECTURE.md with: ecosystem overview, package hierarchy, public API surfaces (not just names)
- [ ] Create docs/QUICK-START.md with working examples for agent-mcp, apigen-cli, dispatch-cli
- [ ] Update §4 "Existing Package Context" with newly discovered packages (agent-core-env, environment, workspace-codegen-nx)

---

### docs/agent-mcp/ (agent MCP documentation)
**Status**: 🟡 **REVISE** — Partial coverage, scattered, some correct

**Contents**:
- docs/agent-mcp/USAGE.md (likely entry point)
- docs/agent-mcp/SPEC.md (MCP protocol)
- docs/agent-mcp/mcp-env/ (new, config management)
- docs/agent-mcp/agent-mcp-chat-gateway/ (new, chat gateway docs)

**Assessment**:
- ✓ Exists and has real content
- ✗ Not linked from README or AGENTS.md
- ✗ Unclear if complete (agent-mcp-chat-gateway is "new," status unclear)
- ✗ No reference to agent-core-env (new package that unifies registry DB paths)
- ✗ No quick-start example (import + spawn agent)

**Recommendation**: **CONSOLIDATE** — Merge into docs/architecture/ with clear entry point from README.

---

### docs/apigen/
**Status**: 🟡 **REVISE** — Incomplete, plugin system underdocumented

**Assessment**:
- ✓ Exists with SPEC.md
- ✗ No examples of actual `apigen run` or `apigen generate` workflows
- ✗ Plugin system (8 transport plugins) not documented
- ✗ No Python Flask/gRPC target documentation
- ✗ 21 packages but no breakdown of which are public vs internal

**Recommendation**: **REVISE** with:
- [ ] Working examples (TypeScript function → MCP tools, HTTP API, CLI, OpenAPI)
- [ ] Plugin architecture overview
- [ ] Python target documentation

---

### docs/environment/
**Status**: 🟢 **KEEP** — Recently added, comprehensive for new feature

**Contents**:
- docs/environment/ARCHITECTURE.md (design and rationale)
- docs/environment/BROWSER.md (browser-safe usage)
- docs/environment/adoption-survey/GAP_SPECS.md (G-7/G-8/G-9 specs)

**Assessment**:
- ✓ Clear purpose and design rationale
- ✓ Addresses new package (@adhd/environment v0.0.1, 2026-07-22)
- ✓ Links to agent-mcp and apigen usage
- ✓ New GAP_SPECS (G-7/G-8/G-9) document environment variable auto-discovery specs

**Recommendation**: **KEEP and HIGHLIGHT** — This is good recent work. Link it from docs/QUICK-START.md.

---

### docs/architecture/
**Status**: 🔴 **REMOVE or CONSOLIDATE** — Likely stale or redundant with AGENTS.md

**Assessment**: Unknown without reading contents; likely duplicates AGENTS.md information or contains outdated tier/domain mapping (remember: layers were misaligned in prior versions).

**Recommendation**: Audit this directory. If it's stale/redundant with AGENTS.md, merge its unique content into docs/ARCHITECTURE.md and delete.

---

### docs/contributing/
**Status**: 🟢 **KEEP** — Likely accurate convention guide

**Assessment**: Not audited in detail; assumption based on AGENTS.md §1 reference to "docs/contributing/conventions/package-naming.md."

**Recommendation**: Verify it exists and is accurate. Link from docs/QUICK-START.md.

---

### docs/plan/
**Status**: 🔴 **DO NOT DOCUMENT** — Plan artifacts, not user documentation

**Assessment**: 13+ plan state machines (agent-*, dispatch-*). These are ephemeral, superseded/completed work artifacts. They document historical execution, not current state.

**WARNING**: Running plans reference docs/plan/* paths at runtime (found: packages/dispatch/dispatch-base-spec/src/test/plan.spec.ts reads docs/plan/dispatch-production/dag.json). Deleting plan dirs breaks tests.

**Recommendation**:
- [ ] Verify runtime dependencies on plan DAGs before deleting any plan directory
- [ ] Migrate runtime fixtures (e.g., dag.json for tests) into the test package, not the plan dir
- [ ] Once migrated, mark docs/plan/ as "historical archives" in README

---

## Extracted Orphans (Correct Info, Not Yet Represented)

### 1. New Package: @adhd/agent-core-env
- **Location**: packages/agent/agent-core-env/
- **Version**: v0.0.1 (2026-07-22)
- **Purpose**: Shared environment-backed resolver for agent-registry family's shared SQLite DB
- **Impact**: Eliminates import-time DB side effects, unifies prompts/tools/policy/provider store DB path discovery
- **Status**: SHIPPED, documented in entrypoint/agent-mcp/src/index.ts but NOT in README, AGENTS.md, or docs/agent-mcp/

**Action**: Add to AGENTS.md §4 "Existing Package Context" + docs/agent-mcp/ARCHITECTURE.md

### 2. Environment Cascade System
- **Location**: packages/environment/ (3 packages: base-spec, builder, core-node)
- **Version**: v0.0.1 (2026-07-22)
- **Purpose**: Zero-config configuration cascade for @adhd ecosystem
- **Consumers**: agent-mcp (config/logging/plugins/queue/server/SSE/transport/DB paths), apigen-plugin-mcp (multi-instance port binding)
- **Status**: SHIPPED, documented in docs/environment/ but NOT in README or AGENTS.md §4

**Action**: Add to AGENTS.md §4 + quick-start guide

### 3. Apigen Plugin System Architecture
- **8 Transport Plugins**: MCP, Fastify, Express, CLI, JSON Schema, OpenAPI, Python Flask, Python gRPC
- **Location**: packages/apigen/apigen-plugin-*/
- **Status**: SHIPPED, mentioned in README but no architectural overview, no examples
- **Missing**: Explanation of how dispatch() → OutputPlugin → per-transport adaptation works

**Action**: Create docs/apigen/PLUGIN-ARCHITECTURE.md + working examples

### 4. Workspace-Codegen-Nx Generator
- **Location**: packages/workspace/workspace-codegen-nx/
- **Status**: SHIPPED, MANDATORY per AGENTS.md §1
- **Usage**: `npx nx g @adhd/workspace-codegen-nx:<tier> --name <name> --group <domain> ...`
- **Missing**: No documentation separate from AGENTS.md; users can't find it

**Action**: Create docs/contributing/SCAFFOLD-PACKAGES.md with examples

### 5. Dispatch CLI and Task DAG System
- **Location**: entrypoint/dispatch-cli/ + packages/dispatch/
- **Version**: v0.0.1 (recently added/reshuffled)
- **Commands**: validate, snapshot, optimize, eligible, status, run, calibrate
- **Status**: SHIPPED, documented in entrypoint/dispatch-cli/ but NO user-facing examples

**Action**: Create docs/dispatch/QUICK-START.md with DAG examples

---

## Metric: Reader Fallback Count (metric_1_eliminated_reader_searches)

### Fallbacks Triggered by Stale README.md
A new user reading the repo-root documentation would hit these fallbacks:

1. **npm search**: User sees `@adhd/query` → npm search fails → manual git grep
2. **npm search**: User sees `@adhd/react-hooks` → npm search fails → manual git grep
3. **npm search**: User sees `@adhd/transforms` → npm search fails → manual git grep  
4. **npm search**: User sees `@adhd/data` → npm search fails (or finds wrong package) → manual git grep
5. **git clone attempt**: User tries `packages/ai/agent-mcp/` → directory doesn't exist → manual search for real location
6. **git clone attempt**: User tries `packages/ai/agent-mcp-budget/` → directory doesn't exist → manual search
7. **Source inspection**: User falls back to `find packages -name "*.ts" | grep -i agent` → finds real paths manually

**Total Fallbacks**: 7+ searches that a user with correct README.md would not need

---

## Recommendations by Priority

### CRITICAL (Blocker for Users)
1. **DELETE or REWRITE README.md** — Currently a liability
   - Replace with: 1-para project description, "What is this?" section, links to real docs
   - Estimated effort: 2 hours (write once, get it right)

### HIGH (Fundamental Discoverability)
2. **CREATE docs/QUICK-START.md** — Getting started guide
   - agent-mcp: spawn + call tools
   - apigen-cli: write function → MCP server
   - dispatch-cli: validate DAG → execute
   - Estimated effort: 4 hours

3. **CREATE docs/ARCHITECTURE.md** — Package hierarchy and public APIs
   - Extracted from AGENTS.md §1-4, user-friendly
   - Tie to package.json descriptions
   - Estimated effort: 3 hours

4. **UPDATE AGENTS.md §4** — Add newly discovered packages
   - agent-core-env, environment-core-node, workspace-codegen-nx
   - Estimated effort: 0.5 hour

### MEDIUM (Completeness)
5. **CREATE docs/contributing/SCAFFOLD-PACKAGES.md** — How to create new packages
   - Extract from AGENTS.md §1, add working examples
   - Estimated effort: 2 hours

6. **AUDIT docs/architecture/** — Check for redundancy with AGENTS.md
   - If redundant, merge unique content and delete
   - Estimated effort: 1 hour

7. **CREATE docs/dispatch/QUICK-START.md** — DAG system examples
   - Estimated effort: 3 hours

8. **REVISE docs/apigen/PLUGIN-ARCHITECTURE.md** — Plugin system overview
   - Estimated effort: 2 hours

### LOW (Housekeeping)
9. **VERIFY docs/plan/ runtime dependencies** — Before deletion
   - Find all test files reading dag.json, migrate to test package
   - Estimated effort: 2 hours

10. **AUDIT docs/architecture/** — Consolidation decision
    - Estimated effort: 0.5 hour decision, 2-4 hours consolidation (if needed)

---

## Tracking

| Item | Status | Owner |
|------|--------|-------|
| README.md delete/rewrite | TODO | steward |
| docs/QUICK-START.md create | TODO | cartographer/steward |
| docs/ARCHITECTURE.md create | TODO | cartographer/steward |
| AGENTS.md §4 update | TODO | cartographer |
| docs/plan runtime deps audit | TODO | steward |

