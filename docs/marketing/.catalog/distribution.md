# Distribution: @adhd Monorepo Scope

**Scope**: adhd monorepo (root)
**Public Packages**: 50 total (49 publishable libraries + 5 CLI/server entrypoints)
**Package Registry**: npm (@adhd scope)
**GitHub Repository**: https://github.com/PseudoSky/adhd

## Publishing Pipeline

### Source Repository
- **URL**: https://github.com/PseudoSky/adhd
- **Branch**: main (default)
- **Sync Status**: 
  - Last Local Commit: `28888998c0a68e2712d06b89ed1602e0c6aab3c4` (2026-07-22T16:08:33-05:00)
  - GitNexus Index: Up-to-date
  - Remote Status: Unknown (not checked from this scope)

### Build + Publish Command
```bash
pnpm run build                    # compile all packages to dist/
npx nx run-many -t version        # bump versions (changed-only, tags)
npx nx run-many -t publish        # publish to npm
```

**Gated by**:
- `pnpm run build` success (all packages compile)
- `npx nx affected -t test` success (changed packages pass tests)
- Manual code review approval (AGENTS.md: "must not push without human approval")
- CI/CD pipeline (if configured — not verified in this scope assessment)

**Per PUBLISHING.md**:
- Version bumping via `nx release` (not manual `package.json` edits)
- Changed-only versioning (only packages with dist/ changes get bumped)
- Test+Lint gates before publish
- Post-publish smoke tests per package (documented in PUBLISHING.md §post-publish checklist)

### Distribution Channels

| Channel | Type | Status | Freshness | Notes |
|---------|------|--------|-----------|-------|
| npm registry | Package Registry | ACTIVE | Last public release unknown | `@adhd/<package-name>` scoped packages |
| GitHub Releases | Release artifacts | UNKNOWN | Not assessed | May contain built bundles, changelogs |
| GitHub Packages | Package Registry | UNKNOWN | Not assessed | May mirror npm registry |
| npm tarball (local) | Snapshot | CURRENT | v0.4.0 (per package.json) | Workspace version 0.4.0 |

**Problem**: Cannot determine actual npm publish status (last-published dates, current SemVer versions on npm) without network access or npm cli inspection. These would normally be obtained via `npm info @adhd/agent-mcp` for each package.

### Individual Package Status (Known from package.json)

#### Recent/High-Profile Packages (v0.0.1 or v2.1.x)
| Package | Version | Tier | Last Updated | npm? |
|---------|---------|------|--------------|------|
| @adhd/agent-mcp | 2.1.2 | entrypoint | 2026-07-22 | UNKNOWN |
| @adhd/agent-core-env | 0.0.1 | core | 2026-07-22 (NEW) | UNKNOWN |
| @adhd/environment | 0.0.1 | core | 2026-07-22 | UNKNOWN |
| @adhd/apigen-cli | 0.1.1 | entrypoint | recent | UNKNOWN |
| @adhd/dispatch-cli | 0.0.1 | entrypoint | recent | UNKNOWN |
| @adhd/workspace-codegen-nx | ? | core | recent | UNKNOWN |

**Notes**:
- Version scheme: `major.minor.patch` for stable (2.x), `0.x.y` for early (0.1.x, 0.0.x)
- All packages exist locally; publish status not verifiable from this assessment

### CI/CD Integration
**Status**: Not assessed in this catalog

Unknown:
- GitHub Actions workflows (exists? triggers? gates?)
- Remote cache (Nx Cloud connected? status?)
- Automated publish (on tag push? manual trigger?)
- Smoke test automation (post-publish verification)

**Action Item**: Review .github/workflows/ for actual CI/CD pipeline documentation.

### Pre-Publish Verification

**Gating** (per AGENTS.md, PUBLISHING.md):
1. `pnpm run build` — All packages compile to dist/
2. `npx nx affected -t test` — Changed packages pass tests
3. `npx nx affected -t lint` — No lint errors
4. Human code review (required per AGENTS.md)
5. Smoke test (e.g., `npx apigen-cli --help` returns exit 0)

**Status**: These gates exist in code/docs but execution status unknown (nx project graph currently broken).

## Freshness & Staleness Tracking

### Last Catalog Run
- **SHA**: 28888998c0a68e2712d06b89ed1602e0c6aab3c4
- **Timestamp**: 2026-07-22T16:08:33-05:00
- **Git Log**: `feat(agent-core-env): shared registry-DB resolver + DI kills import-time DB-open side effect`
- **Changes Since**: TBD (run `git rev-list --count 28888998c0a68e2712d06b89ed1602e0c6aab3c4..HEAD` to track commits since)

### Packages Changed Recently
From git status at start of this catalog run:
- Modified: 11 package.json files (version bumps, dependency edits)
- Modified: 7 README.md files (docs updates)
- Added: 4 new doc directories (docs/agent-mcp/agent-mcp-chat-gateway/, docs/agent-mcp/mcp-env/, docs/agent/, docs/plan/*)
- Deleted: ~200 files (old plan artifacts from docs/plan/agent-final/superseded/*)

**Implication**: Recent churn suggests active development; not appropriate for stable release until changes are tested and merged.

## Publish Hygiene Checks

### Known Checks (from codebase)
`pnpm run check:publish-hygiene` → `nx run @adhd/source:check-publish-hygiene`

**Details**: Unknown without reading the implementation. Likely includes:
- No `devDependencies` in published packages
- No relative paths in imports (use @adhd/ scoped paths)
- No sensitive files in dist/
- Version consistency across package family (e.g., agent-* all v2.1.2)

### Issues Documented (from AGENTS.md, memory)
1. **BUG-DISPATCH-PUBLISH-001**: Import specifier divergence (tsconfig paths != package.json name) breaks publish
2. **BUG-AGENTMCP-001**: Same issue in agent-mcp
3. **NX cache issue**: `--skip-nx-cache` creates stale dist/ artifacts published as current (AGENTS.md §5)

**Status**: These are documented to watch for; unknown if all are resolved.

## Deployment Considerations

### Node Target
- **Requires**: Node.js 18+ (assumed, not verified)
- **Package managers**: pnpm (per AGENTS.md "default every JS/TS project to pnpm")
- **Entrypoints** (need dist/ in PATH or bin/ symlink):
  - @adhd/agent-mcp (server, requires --ADHD_AGENT_MCP_STARTUP flags)
  - @adhd/apigen-cli (CLI, `apigen` command)
  - @adhd/dispatch-cli (CLI, `dispatch` command)
  - @adhd/decompile-cli (CLI, `decompile` command)
  - @adhd/environment-cli (CLI, planned, not yet built)

### Environment/Configuration
- Controlled via @adhd/environment cascade (code defaults → system → global ~/.adhd → project .adhd/ → local *.local → env vars)
- No setup.sh or post-install scripts (assumed; not verified)
- Database persistence: per-package (agent-mcp → ~/.adhd/agent-mcp/, apigen per config, etc.)

### Multi-Instance Collision Handling
- **agent-mcp**: Derives SSE port per instance (instanceId), prevents port collisions
- **apigen-plugin-mcp**: Also uses environment for per-instance port binding
- **dispatch-cli**: No documented multi-instance handling

## Open Questions (for steward/publisher)

1. Is the monorepo currently published to npm? If yes, what are the last-published dates per package?
2. What is the post-publish smoke test procedure per PUBLISHING.md?
3. Is GitHub Actions CI/CD configured? What gates publish?
4. Why does `nx list` fail with "project graph" error? Blocks verify of all capabilities.
5. Are there unpublished/local-only packages (private:true except ui-react-base-storybook)?

