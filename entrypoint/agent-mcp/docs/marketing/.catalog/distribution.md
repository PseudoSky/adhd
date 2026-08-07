# @adhd/agent-mcp — Distribution & Publishing

**Package:** @adhd/agent-mcp  
**Current version (repo):** 2.0.0 (unpublished in this branch)  
**Published version:** 2.0.1 (npm)  
**Scope path:** /Users/nix/dev/node/adhd/entrypoint/agent-mcp

---

## Distribution Channels

### NPM Registry

**Package name:** @adhd/agent-mcp  
**Published:** Yes (v2.0.1 as of latest release)  
**Publish path:** https://registry.npmjs.org/@adhd/agent-mcp

**Access:**
```bash
npm install @adhd/agent-mcp
# or yarn/pnpm equivalent
```

**Standalone entrypoint commands installed:**
- `agent-mcp` → runs the MCP server (Node entry, bin: "./src/index.js")
- `agent-mcp-tail` → streams agent-mcp logs (bin: "./src/scripts/agent-mcp-tail.js")

**Package.json publish config:**
```json
{
  "name": "@adhd/agent-mcp",
  "version": "2.0.0",
  "type": "module",
  "bin": {
    "agent-mcp": "./src/index.js",
    "agent-mcp-tail": "./src/scripts/agent-mcp-tail.js"
  },
  "main": "./src/index.ts"
}
```

**Built artifact location:** dist/entrypoint/agent-mcp (Nx build output)

---

## Publishing Pipeline

### Build

**Build command:** `npx nx build agent-mcp`  
**Build executor:** @nx/js:tsc  
**Build output:**
- Compiled TypeScript → dist/entrypoint/agent-mcp/
- Copies: `entrypoint/agent-mcp/*.json` (package.json), `entrypoint/agent-mcp/drizzle/` (migrations)
- Entry point: dist/entrypoint/agent-mcp/index.js (compiled from src/index.ts)

**Build dependencies:** 18 upstream dependencies (agent-store-runtime, agent-engine-orchestrator, agent-store-prompts, etc.)

### Test

**Test command:** `npx nx test agent-mcp --run`  
**Test framework:** Vitest  
**Test files:**
- src/__tests__/wiring.test.ts (5 unit tests)
- src/__tests__/tool-advertisement.test.ts (14 unit tests)
- src/__tests__/integration/live-dag.e2e.test.ts (skipped: AGENT_MCP_LIVE=1 only)
- src/__tests__/integration/live-oauth.e2e.test.ts (skipped: AGENT_MCP_LIVE=1 only)
- src/__tests__/integration/live-budget.e2e.test.ts (skipped: AGENT_MCP_LIVE=1 only)

**Current test status:** 19 passed, 4 skipped

### Publish

**Publish command:** `nx release publish` (standard Nx monorepo workflow)

**Publish process:**
1. Git tag created (v2.0.0 or next version)
2. npm registry upload (authentication required)
3. GitHub Releases entry created (if configured)

**Version management:** Conventional Commits (feat/fix/refactor) drive semantic versioning (major.minor.patch)

---

## Public Surface (Discoverable Artifacts)

### Files Included in Distribution

**Package root artifacts:**
- `package.json` — name, version, bin, main, dependencies
- `dist/entrypoint/agent-mcp/` — compiled JavaScript, migrations, assets

**Documentation (currently missing from distribution):**
- ❌ `README.md` — NOT IN PACKAGE
- ❌ `CHANGELOG.md` — NOT IN PACKAGE
- ❌ `docs/` — technical audit only (docs/provider-call-audit.md)
- ❌ `CONTRIBUTING.md` — NOT IN PACKAGE
- ❌ `LICENSE.md` — NOT IN PACKAGE
- ❌ `SECURITY.md` — NOT IN PACKAGE

**Migration files (Drizzle):**
- `dist/entrypoint/agent-mcp/drizzle/` — schema migrations (0000-initial.sql through 0007-*.sql)

### Community Health Files (Missing)

| File | Present | Required | Status |
|------|---------|----------|--------|
| README.md | ❌ | ✅ | CRITICAL GAP |
| CHANGELOG.md | ❌ | ✅ | CRITICAL GAP |
| CONTRIBUTING.md | ❌ | ✅ | GAP |
| CODE_OF_CONDUCT.md | ❌ | ✅ | GAP |
| SECURITY.md | ❌ | ⚠ | GAP (some repos require) |
| LICENSE | ❌ | ✅ | Assumed MIT at repo level |

---

## Freshness & Staleness Tracking

### Current Commit State

**Latest catalog build:** Not yet run (this is the first cartographer run)  
**Repo HEAD SHA:** 7c400a73a5e7d747856f522271cd189b688675f9  
**Repo HEAD timestamp:** (git log -1 --format=%cI) → TBD on first catalog write

**Published version (npm) info:**
```
npm view @adhd/agent-mcp versions
# → ["2.0.0", "2.0.1", ...]
npm view @adhd/agent-mcp@2.0.1 dist.tarball
# → https://registry.npmjs.org/@adhd/agent-mcp/-/agent-mcp-2.0.1.tgz
```

### Staleness Calculation

**For next catalog run:**
```
commits_since = git rev-list --count <last_catalog_sha>..HEAD
```

If commits_since > 5, the published version (2.0.1) is stale vs. repo HEAD. A new publish is warranted.

---

## Dependency Graph (for distribution impact)

**Exports from agent-mcp (public API):**
- `{ HookRegistry }` — re-exported from @adhd/agent-engine-orchestrator (line 36)
- `{ ComposedPromptStore }` — re-exported from @adhd/agent-store-prompts (line 37)
- `{ buildPromptResolver }` — custom export (function, lines 39-84)
- (MCP server creation happens via index.ts entry point, not exported as library)

**Consumers of agent-mcp (if any):**
- Consumers expect to run `agent-mcp` CLI command (from bin)
- Consumers expect to import buildPromptResolver for registry integration
- No documented library consumers yet (this is a server, not a library)

---

## Artifact Locations

| Artifact | Location | Built from | Status |
|----------|----------|-----------|--------|
| NPM tarball | registry.npmjs.org/@adhd/agent-mcp | src/ + package.json | published (v2.0.1) |
| Docker image | (not published) | Dockerfile? (none found) | N/A |
| GitHub Release | (if configured) | git tag v2.0.x | TBD |
| Docs site | (not published) | docs/provider-call-audit.md | N/A (no docs site) |
| CLI binary | installed via npm | bin: "./src/index.js" (built to dist/) | available after npm install |

---

## Checklist for 2.0.2 Publishing

### Pre-publish:
- [ ] Bump version: 2.0.0 → 2.0.2 (patch for bug fixes)
- [ ] Run all tests: `npx nx test agent-mcp --run`
- [ ] Build: `npx nx build agent-mcp`
- [ ] Add CHANGELOG.md entry for v2.0.2
- [ ] **ADD README.md** (blocking for new consumers)
- [ ] **ADD docs/API_REFERENCE.md** (blocking for tool discovery)
- [ ] **ADD docs/CONFIG.md** (blocking for env setup)
- [ ] **ADD docs/PROVIDERS.md** (blocking for provider selection)

### Publish:
- [ ] `nx release publish`
- [ ] Verify tarball on npm: `npm view @adhd/agent-mcp@2.0.2`
- [ ] Test install in isolation: `npm install @adhd/agent-mcp@2.0.2` in a fresh dir
- [ ] Smoke test: `agent-mcp --help` (or first startup)

### Post-publish:
- [ ] Update CHANGELOG.md with publish timestamp + tarball SHA
- [ ] Tag commit: `git tag @adhd/agent-mcp@2.0.2`
- [ ] Announce in release notes/Discord
- [ ] Update downstream consumers (if any repos depend on @adhd/agent-mcp)

---

## Known Distribution Issues

**Issue 1: Data directory hardcoded to repo root**  
- Default ADHD_AGENT_DATABASE_PATH: /Users/nix/dev/node/adhd/data/agents.db (assumed git-ignored)
- Consumers should override to ~/.adhd/agent-mcp/ or /var/lib/agent-mcp/
- Tracked in BACKLOG as "move default DB out of repo root"

**Issue 2: No Docker image**  
- agent-mcp is node/sqlite only, easily containerizable
- No Dockerfile or registry entry yet (TBD)

**Issue 3: No docs published to a docs site**  
- docs/ folder exists (only provider-call-audit.md)
- No docs build, no hosting (docs.adhd.ai or similar)
- Consumers must read docs from GitHub raw/ or npm tarball

---

## Summary

**Published:** ✅ v2.0.1 on npm  
**Installable:** ✅ `npm install @adhd/agent-mcp`  
**CLI available:** ✅ `agent-mcp` + `agent-mcp-tail` commands  
**Documentation:** ❌ Critical gaps (README, API ref, provider guide missing)  
**Next release:** v2.0.2 (patch) — ready for publish after docs added

→ Steward should add 4 critical docs (README, API_REFERENCE, PROVIDERS, CONFIG) before publishing 2.0.2 to npm.
