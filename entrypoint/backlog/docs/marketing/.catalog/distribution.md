# Distribution — `@adhd/backlog`

## Public locations
| Channel | Identifier | Evidence |
|---------|-----------|----------|
| npm | `@adhd/backlog` (access: public) | `package.json` `name` + `publishConfig` |
| GitHub | `PseudoSky/adhd`, dir `entrypoint/backlog` | `package.json` `repository.directory` |
| CLI binary | `adhd-backlog` → `./dist/index.js` | `package.json` `bin` |
| MCP | tools `backlog_*` (server via `serve`, or host config written by `install`) | `src/server.ts`, `src/install.ts` |
| Skill | host skill installed by `install-skill` (claude/codex/opencode) | `src/install-skill.ts` |
| Packaged assets | `dist`, `CHANGELOG.md`, `skill` | `package.json` `files` + `assets` |
| License | MIT (copyright 2026 pseudosky) | `LICENSE` (added since the prior capture); `package.json` `"license":"MIT"` — npm auto-includes it with `files` |

## Publish pipeline
- Command: `nx release publish` (clean build + test, normal cache) per repo `PUBLISHING.md` / `AGENTS.md` §11.
- No `.github/workflows` publish job found in this package's surface; publishing is operator-driven from the monorepo.

## Installed-build divergence (recorded)
| Build | Path | `gitContext` on create/transition |
|-------|------|-----------------------------------|
| Main tree @ `9df2a5c7` | `entrypoint/backlog/dist/index.js` (rebuilt 2026-09-23T20:20) | **accepted** (5 refs in dist) |
| Globally installed `adhd-backlog` | `/Users/nix/.nvm/.../lib/node_modules/@adhd/backlog` → symlink → `.worktrees/restore-min/entrypoint/backlog/dist/index.js` | **not in schema** (0 refs) — rejects `gitContext` with `invalid_argument` |

## Freshness
| Field | Value |
|-------|-------|
| `last_catalog_sha` | `9df2a5c76584fe16e38e10b53d8a33ef39545e05` (prior catalog's `last_verified_sha`) |
| `last_catalog_at` | 2026-09-24T00:29:06Z (this refresh) |
| `HEAD` | `9df2a5c76584fe16e38e10b53d8a33ef39545e05` |
| `HEAD` commit time | `2026-09-23T19:52:30-04:00` |
| `commits_since` | **0** (`git rev-list --count 9df2a5c7..HEAD` = 0 — HEAD has not moved; the surface changes are in the working tree, and `dist/` was rebuilt 20:20 from it) |
| verified binary | `entrypoint/backlog/dist/index.js` rebuilt 2026-09-23T20:20 (uncommitted) |
