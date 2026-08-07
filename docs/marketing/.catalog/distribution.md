# Distribution: @adhd Monorepo Scope

**Scope**: adhd monorepo (root)
**Public Packages**: 54 published to npm (@adhd scope)
**Package Registry**: npm (@adhd scope)
**GitHub Repository**: https://github.com/PseudoSky/adhd

## Publishing Pipeline

### Source Repository
- **URL**: https://github.com/PseudoSky/adhd
- **Branch**: main (default)
- **Sync Status**:
  - Last Local Commit: `9eb4f22c335091074e97f0075ef594649cba38b0` (2026-07-24T20:58:13-05:00)
  - GitNexus Index: Up-to-date
  - Remote Status: Unknown (not checked from this scope)

### Build + Publish Commands
```bash
pnpm run build                                    # compile all packages to dist/
CI=true npx nx run-many -t version                # bump versions (changed-only)
CI=true npx nx run-many -t publish                # publish to npm
```

**Gated by**:
- `pnpm run build` success
- `npx nx run-many -t test` success
- `npx nx run-many -t lint` success
- Human code review
- Per-project: `publish` dependsOn `test`, `^test`, `version`, `dist-manifest`, `verify-dist-load`, `publish-hygiene`

### Distribution Channels

| Channel | Type | Status | Freshness |
|---------|------|--------|-----------|
| npm registry | Package Registry | ACTIVE | All 54 packages published (latest ~2026-07-23 via `published-state.json`) |
| GitHub Releases | Release artifacts | UNKNOWN | Not assessed |
| GitHub Packages | Package Registry | UNKNOWN | Not assessed |

### Individual Package Status (from published-state.json)

All 54 packages are published to npm under @adhd scope. Versions per published-state.json:

#### Agent Family (12 packages)
| Package | Version | 
|---------|---------|
| @adhd/agent-base-types | 2.1.5 |
| @adhd/agent-core-env | 0.0.4 |
| @adhd/agent-core-policy | 2.1.6 |
| @adhd/agent-core-provider | 2.1.6 |
| @adhd/agent-engine-compiler | 2.1.5 |
| @adhd/agent-engine-orchestrator | 2.1.5 |
| @adhd/agent-generator-plugin | 0.0.4 |
| @adhd/agent-mcp | 2.1.4 |
| @adhd/agent-plugin-budget | 0.0.6 |
| @adhd/agent-plugin-sanitize | 0.0.4 |
| @adhd/agent-store-prompts | 2.1.4 |
| @adhd/agent-store-runtime | 2.1.5 |
| @adhd/agent-store-tools | 2.1.6 |

#### Apigen Ecosystem (20 packages)
| Package | Version |
|---------|---------|
| @adhd/apigen-base-errors | 0.1.5 |
| @adhd/apigen-base-logical | 0.0.5 |
| @adhd/apigen-base-schema | 0.1.4 |
| @adhd/apigen-base-types | 0.0.4 |
| @adhd/apigen-cli | 0.1.4 |
| @adhd/apigen-codegen-openapi | 0.1.6 |
| @adhd/apigen-core-client | 0.1.4 |
| @adhd/apigen-engine-conformance | 0.1.4 |
| @adhd/apigen-engine-gateway | 0.1.5 |
| @adhd/apigen-engine-naming | 0.1.4 |
| @adhd/apigen-engine-runtime | 0.1.4 |
| @adhd/apigen-generator-nx | 0.0.4 |
| @adhd/apigen-plugin-api-express | 0.1.4 |
| @adhd/apigen-plugin-api-fastify | 0.1.5 |
| @adhd/apigen-plugin-cli-output | 0.1.5 |
| @adhd/apigen-plugin-health | 0.1.6 |
| @adhd/apigen-plugin-jsonschema | 0.1.5 |
| @adhd/apigen-plugin-logger | 0.1.6 |
| @adhd/apigen-plugin-mcp | 0.1.5 |
| @adhd/apigen-plugin-openapi | 0.1.6 |
| @adhd/apigen-plugin-py-flask | 0.1.5 |
| @adhd/apigen-plugin-py-grpc | 0.1.5 |
| @adhd/apigen-python-env | 0.1.4 |

#### Backlog (1 package)
| Package | Version |
|---------|---------|
| @adhd/backlog | 0.0.2 |

#### Dispatch Family (6 packages)
| Package | Version |
|---------|---------|
| @adhd/dispatch-base-spec | 0.0.5 |
| @adhd/dispatch-base-types | 0.0.4 |
| @adhd/dispatch-cli | 0.0.4 |
| @adhd/dispatch-core-client | 0.0.5 |
| @adhd/dispatch-core-optimizer | 0.0.5 |
| @adhd/dispatch-orchestrator | 0.0.4 |
| @adhd/dispatch-serializer-json | 0.0.5 |

#### Environment Family (3 packages)
| Package | Version |
|---------|---------|
| @adhd/environment | 0.0.3 |
| @adhd/environment-base-spec | 0.0.5 |
| @adhd/environment-builder | 0.0.4 |

#### Data Family (3 packages)
| Package | Version |
|---------|---------|
| @adhd/data-base-transforms | 2.2.5 |
| @adhd/data-core-structures | 2.2.4 |
| @adhd/data-query-engine | 2.2.4 |

#### Workspace Family (2 packages)
| Package | Version |
|---------|---------|
| @adhd/workspace-base-tools | 0.0.4 |
| @adhd/workspace-codegen-nx | 0.0.4 |

#### Other
| Package | Version |
|---------|---------|
| @adhd/decompile-cli | 0.1.11 |
| @adhd/ui-react-base-hooks | 2.2.4 |

### CI/CD Integration
**Status**: Not fully assessed in this catalog

Known:
- `.github/workflows/ci.yml` — CI pipeline, node-version 22
- `.github/workflows/pull-request.yml` — PR checks, node-version 22 for test job
- Pre-commit hook at `.githooks/pre-commit` — lint gating + secret-scan
- Secret-scan is a whole-repo nx task (`@adhd/nx-secret-scan`)

Unknown:
- Automated publish triggers (on tag push? manual?)
- Post-publish smoke test automation
- Nx Cloud remote cache status

## Freshness & Staleness Tracking

### Last Catalog Run
- **SHA**: 9eb4f22c335091074e97f0075ef594649cba38b0
- **Timestamp**: 2026-07-24T20:58:13-05:00
- **Git Log**: `docs(changelog): record backlog render/archive verify fix`
- **Changes Since Prior Catalog** (28888998c0a68e2712d06b89ed1602e0c6aab3c4):
  - **Commits**: 269
  - **New package**: @adhd/backlog (entrypoint/backlog) — 0.0.2
  - **New package**: apigen-python-env (packages/apigen/python-env) — 0.1.4
  - **New tools**: tools/nx-plugins/{build,deps,assets,test,secret-scan,lib} — 6 plugin directories
  - **Published-state cache**: published-state.json (54 packages)

### Publish Hygiene

The workspace has a comprehensive publish hygiene system:
1. `version` task: cache-driven bump decision (published-state.json)
2. `reconcile` task: integrity-gated cache backfill from npm
3. `publish-hygiene` task: npm-pack allowlist + declared-entry gate
4. `verify-dist-load` task: proves dist/ loads as a consumer would
5. `publish` task: cache-check before publish, write-through on success

### Known Issues (from codebase)
1. **BUG-DISPATCH-PUBLISH-001**: Import specifier divergence (tsconfig paths != package.json name) — FIXED for apigen-family (BUG-APIGEN-NAMING-IMPORT-SPECIFIER-DIVERGENCE-001, 37 files)
2. **BUG-AgentMCP-001**: Same issue in agent-mcp — RESOLVED (tsconfig.base.json cleaned)
3. **NX cache caveat**: `--skip-nx-cache` creates stale dist — documented in AGENTS.md §5
4. **Release commit**: Opt-in `pnpm release:commit` — not automatic (deliberate)

### Deployment Considerations

- **Requires**: Node.js 22+ (CI pinned)
- **Package manager**: pnpm (default, per AGENTS.md)
- **Entrypoints** (need dist/ in PATH or bin/ symlink):
  - @adhd/backlog (`backlog` command, 34 ops)
  - @adhd/agent-mcp (MCP server)
  - @adhd/apigen-cli (`apigen` command, 6 subcommands)
  - @adhd/dispatch-cli (`dispatch` command, 7 subcommands)
  - @adhd/decompile-cli (`decompile` command)
  - @adhd/environment-cli (planned, not built)

- **Configuration**: @adhd/environment cascade (code defaults → system → global → project → env vars)
- **Database**: Per-package SQLite stores under `~/.adhd/`:
  - agent-mcp: `~/.adhd/agent-mcp/`
  - agent-registry: `~/.adhd/agent-registry/` (via agent-core-env)
  - backlog: `~/.adhd/backlog/` (configurable via env)
