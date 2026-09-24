# Capabilities — `@adhd/backlog` v1.0.0

Scope: `entrypoint/backlog`. Verified at `9df2a5c76584fe16e38e10b53d8a33ef39545e05` (2026-09-24T00:29:06Z) against `dist/index.js` **rebuilt 2026-09-23T20:20** from the working tree.
Machine contract: `capabilities.json`. Every entry is **shipped** (25 capabilities).

**Mounted operations: 17 verbs + `batch action` = 18** (plus 5 CLI-only special commands: `install-skill`/`install`, `serve`, `search`, `sandbox-path`, `store-check`). The three §5 stats/rollup reads are no longer library-only — they are first-class CLI/MCP/HTTP operations as well as library exports.

| # | id | surface | substance | receipt | notes |
|---|----|---------|-----------|---------|-------|
| 1 | `get` | CLI/MCP/HTTP | moderate | `src/api.ts:391` | issue by uid, or registry entry by name |
| 2 | `query` | CLI/MCP/HTTP | substantial | `src/api.ts:425` | filters + pagination + grep/semantic + views |
| 3 | `lookup` | CLI/MCP/HTTP | moderate | `src/api.ts:452` | free-text → owning project/component |
| 4 | `create` | CLI/MCP/HTTP | substantial | `src/api.ts:460` | dedupe scan, uid mint, gitContext, embed |
| 5 | `update` | CLI/MCP/HTTP | substantial | `src/api.ts:474` | body edit supersedes → successor uid |
| 6 | `transition` | CLI/MCP/HTTP | substantial | `src/api.ts:482` | note gate (default true), citation gate |
| 7 | `claim` | CLI/MCP/HTTP | substantial | `src/api.ts:490` | lease with staleness, CAS |
| 8 | `relate` | CLI/MCP/HTTP | moderate | `src/api.ts:498` | 5 relation types, add/remove |
| 9 | `move` | CLI/MCP/HTTP | moderate | `src/api.ts:506` | re-file under project/component |
| 10 | `delete` | CLI/MCP/HTTP | moderate | `src/api.ts:519`, `:585` | bi-temporal soft delete |
| 11 | `upsert-project` | CLI/MCP/HTTP | moderate | `src/api.ts:536` | mints reserved `(root)` component |
| 12 | `upsert-component` | CLI/MCP/HTTP | moderate | `src/api.ts:544` | by (project, name) |
| 13 | `upsert-location` | CLI/MCP/HTTP | moderate | `src/api.ts:557` | by (component, locType, value) |
| 14 | `rm-location` | CLI/MCP/HTTP | trivial | `src/api.ts:565` | soft-remove location |
| 15 | `batch-action` | CLI/MCP/HTTP | substantial | `@adhd/apigen-plugin-batch` | N-way fan-out over any one op |
| 16 | `serve` | CLI | substantial | `src/serve.ts`, `src/server.ts` | HTTP/MCP long-lived server |
| 17 | `install-skill` | CLI | moderate | `src/install-skill.ts`, `src/install.ts` | alias `install`; host config |
| 18 | `search` | CLI | moderate | `src/search-shortcut.ts` | argv-flag form of `query --input` |
| 19 | `sandbox-path` | CLI | trivial | `src/cli.ts:498` | resolved store path, store-free |
| 20 | `store-check` | CLI | moderate | `src/cli.ts:530`, `src/store/vocabulary-guard.ts` | vocabulary mismatch diagnostic |
| 21 | `query-views` | CLI/MCP/HTTP | substantial | `src/query/types.ts:255-265` | enum: list/ready/graph/order/stale/similar/overlap/projects/components/locations |
| 22 | `markdown-format` | CLI/MCP/HTTP | moderate | `src/query/markdown.ts` | `format:'markdown'` for item-list views |
| 23 | `priority-matrix` | **CLI/MCP/HTTP + library** | moderate | `src/api.ts:479`, `src/index.ts:29` | `backlog_priority_matrix`; status-aware counts |
| 24 | `part-of-rollup` | **CLI/MCP/HTTP + library** | substantial | `src/api.ts:501`, `src/index.ts:30` | `backlog_part_of_rollup`; transitive `part_of` descendants |
| 25 | `open-curve` | **CLI/MCP/HTTP + library** | substantial | `src/api.ts:524`, `src/index.ts:31` | `backlog_open_curve`; audit-reconstructed open counts |

## Counts by status
- shipped: **25**
- roadmap: 0
- deprecated: 0
- library-only (subset of shipped): **0** — the former three (`priority-matrix`, `part-of-rollup`, `open-curve`) now mount on CLI/MCP/HTTP.

## Executed this run
Only store-free commands were run (no writes to `~/.adhd/backlog/**`):
- `--help` → exit 0; proves the 17 verbs + `batch action` + the 5 special commands are mounted. The three stats verbs appear with their exact input schemas:
  - `backlog priority-matrix  { input: { filter?: object } }`
  - `backlog part-of-rollup  { input: { uid: string } }`
  - `backlog open-curve  { input: { filter?: object, at: string[] } }`

All other `verified_output` values are `null` with the source/spec/test receipt named; no runtime output was fabricated. `serve`/`install`/`search`/`store-check`/`query`/`priority-matrix`/`part-of-rollup`/`open-curve` were **not** invoked (long-lived, filesystem-mutating, or store-opening), so their runtime proof is the mounted-surface listing plus source receipts.
