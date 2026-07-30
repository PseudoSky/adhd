# Release: @adhd Monorepo — Summer 2026

> **Status:** Pre-release draft — the changes below are committed to `main` but not yet published
> as a tagged release. See [CHANGELOG.md](./CHANGELOG.md) for the full line-by-line record.

**54 packages published to npm** across 7 domains (agent, apigen, backlog, data, dispatch, environment, workspace). **42 shipped capabilities** verified, 1 roadmap, 1 deprecated. **All 54 published packages** now have capability documentation.

---

## Executive Summary

This release represents a **fundamental retooling of the @adhd ecosystem** across every layer:

- **Brand-new product**: [`@adhd/backlog`](#backlog-graph-based-backlog-management) — graph-based backlog management with 34 CLI/HTTP/MCP operations, replacing hand-edited markdown with an authoritative graph store
- **Build pipeline overhaul**: The monorepo's own build tooling is now a first-class @adhd subsystem — 5 custom Nx plugins, 10+ executors, published-state cache, centralized metrics with CPU guard
- **Apigen maturation**: serve-core OpPlan/TransportAdapter refactor, canonical route/tool-name projection across all 8 transport plugins, CLI passthrough, configurable namespace, Python extract/serve split (Flask + gRPC)
- **Agent ecosystem hardening**: Import-time DB side effects eliminated (12 packages), SSE port contention fixed, fresh-machine registry DB setup, environment cascade now powers all agent config
- **Workspace hygiene**: pnpm migration closed, dead package paths cleaned up, pre-commit hook slimmed, secret-scan as nx task

---

## What's New

### @adhd/backlog — Graph-Based Backlog Management

A brand-new package: **graph-backed multi-agent backlog manager** with three live transports (CLI, HTTP, MCP stdio), all mounted via apigen's live `run()` path — no code generation.

- **34 operations**: CRUD, query/report, lifecycle (transition, archive, resolve), multi-agent coordination (claim, renew, release, assign), structure (dependencies, supersede, split, merge), markdown interop (import/render with parity-check gate)
- **Concurrency-safe SQLite graph store**: TOCTOU-free ID allocation via CAS inside `.immediate()` transaction, bounded jittered exponential backoff for `SQLITE_BUSY`, 20-worker race-free proven at the test level
- **Audit-log event system**: Every transition, claim, and release is independently recoverable via `DERIVED_FROM` audit nodes — immune to metadata-replace semantics
- **UPSERT markdown import**: Re-importing a BACKLOG.md diff-and-updates against the live graph, with ownership-gated cross-file edits and malformed-header diagnostics
- **Phase-3 migration active**: Graph is authoritative, CLI/MCP is the write path, `BACKLOG.md` is a generated projection verified by a parity-check gate
- **Installable agent skill**: `backlog install-skill --host opencode` installs the skill file for MCP-based backlog access

- **`backlog install-skill`**: One-command skill installation to any supported host (claude, codex, opencode). Zero external dependencies — copies the packaged `skill/SKILL.md` to the correct per-host skill directory. Verified on opencode.

Verified: `backlog --help` lists 34 commands, 249 items tracked (211 open).

### Build Tooling: Custom Nx Plugin Ecosystem

The monorepo's release pipeline is now built on 5 custom Nx plugins with 10+ executors:

| Plugin | Executors | Purpose |
|--------|-----------|---------|
| `@adhd/nx-build` | `version`, `publish`, `reconcile`, `manifest`, `verify-dist-load`, `hygiene`, `link` | Full release lifecycle |
| `@adhd/nx-deps` | `sync-deps`, `sync-deps-check` | Dependency range reconciliation |
| `@adhd/nx-assets` | `copy` | README/CHANGELOG to dist |
| `@adhd/nx-secret-scan` | `scan` | Credential detection (whole-repo task) |
| `@adhd/nx-test` | `wiring` | Test configuration verification |

Key capabilities:

- **Published-state cache** — `published-state.json` with 54 packages. Version bump decisions are **zero-network on the happy path** (1166× faster than tarball fetch, proven by benchmarks). Atomic lockfile for concurrency-safe `nx run-many` parallel writes.
- **CPU-usage guard** in `withMetrics` — fails a task when it exceeds `ADHD_NX_METRICS_MAX_CPU_PCT` (default 300%). Every metrics.json record includes a `cpuPercent` field.
- **Vitest thread-pool bounding** — 45 previously-unbounded `vite.config.ts` now clamp to `clamp(ceil(cores/3), 2, 4)`, preventing multiplicative CPU oversubscription when Nx runs test targets concurrently.
- **Release commit automation** — `pnpm release:commit` stages and commits only the bumped files with explicit pathspecs (never `git add -A`).

### Apigen Ecosystem

The code-first API generation framework reaches a new level of maturity:

- **serve-core refactor**: New `TransportAdapter`/`OpPlan` primitives in `@adhd/apigen-engine-runtime`. All 4 run-capable transport plugins (Fastify, Express, MCP, CLI-output) now share the same dispatch-and-invoke path.
- **Canonical route/tool-name projection** — consistent kebab-case HTTP routes, qualified MCP tool names, nested kebab CLI paths. Configurable `dropFileSegment` per source. Fixes `BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001`.
- **CLI passthrough**: `apigen run --type cli -- <command> <args>` — native argument forwarding without `--opt argv=` workaround.
- **Configurable namespace**: `ExtractOptions.dropFileSegment` lets packages like `@adhd/backlog` strip the file segment from command/tool names (e.g. `backlog create-item` instead of `backlog client-d create-item`).
- **Python extract/serve split**: Flask and gRPC Python targets now use TS-computed plans for extract/serve. Ephemeral ports for py-flask/py-grpc test servers.
- **EnvelopeCapability wiring**: `--use` schema composition works end-to-end.
- **Cross-bundle `instanceof ApiError` fix**: New `isApiError()` duck-type guard eliminates 500→400 misclassification when the same `ApiError` class is loaded from different Vite bundles — affected all 4 run-capable plugins.
- **Server killability**: SIGTERM/SIGINT/SIGHUP handling with orphan-guard for child process cleanup.
- **Verified**: `apigen --help` shows 6 commands, `apigen list-types` shows 8 plugins (4 run-capable).

### Agent Ecosystem

- **`@adhd/agent-core-env`** (v0.0.4) — shared environment-backed resolver for the agent-registry family's SQLite database. Eliminates the long-standing import-time DB side effect across 5 registry-family packages.
- **SSE port contention fixed**: Multi-instance agent-mcp (global + project, or concurrent process managers) no longer contend on port 3001. Per-instance port derivation via `@adhd/environment` + `EADDRINUSE` fallback to OS ephemeral.
- **Registry DB fresh-machine fix**: `buildPromptResolver()` now creates parent dir + runs all 5 migration sets on first open — no more `SQLITE_CANTOPEN` on clean installs.
- **Usage accounting**: Per-task, per-session, and per-agent usage tracking capturing input/output tokens, model calls, wall-clock time, model processing time, cost, tool calls, and response size. Persisted to SQLite and queryable via MCP tool.
- **Budget enforcement** (`@adhd/agent-plugin-budget@0.0.6`): Caps token spend, cost, wall-clock time, model calls, tool calls, and response size per task/session/agent/global scope with ISO 8601 duration windows and warning vs block enforcement modes.
- **Claude CLI provider**: New `claudecli` provider type uses the local `claude` CLI (Claude Code) as a subprocess provider. Supports `allowedBuiltinTools` whitelist and `systemPromptIsAgentSpec` mode for complete agent markdown file support.

  **Measured performance (8-file edit+verify task, same model across all conditions):**

  | Condition | Turns | Cost | Wall Time |
  |-----------|-------|------|-----------|
  | Agent-tool harness (wildcard tools) | 28 | $0.71 | 90.6s |
  | Agent-tool harness (scoped tools) | 27 | $0.69 | 71.8s |
  | **claudecli provider (scoped tools)** | **5** | **$0.21** | **26.2s** |

  The claudecli provider completes identical work in **~3.4x fewer turns and at ~3.4x lower cost** than the interactive Agent-tool harness. Root cause: the claudecli provider batches multiple tool calls into single dense turns (833-1335 output tokens/turn) while the Agent-tool harness issues one tool call per round-trip (70-300 tokens/turn). Savings come from turn-count reduction, not per-turn efficiency — the interactive harness's dispatch loop adds overhead between every tool call that headless `claude -p` doesn't incur.
- **Rate cards**: Provider pricing configuration in `@adhd/agent-core-provider` — maps provider type and model to per-unit costs, used by usage accounting for monetary cost computation.
- **12 packages published** to npm: base-types (2.1.5), core-policy (2.1.6), core-provider (2.1.6), core-env (0.0.4), store-prompts (2.1.4), store-tools (2.1.6), store-runtime (2.1.5), engine-compiler (2.1.5), engine-orchestrator (2.1.5), plugin-budget (0.0.6), plugin-sanitize (0.0.4), generator-plugin (0.0.4).

### Environment Cascade

- **Zero-config configuration**: Code defaults → system (`/etc/adhd`) → global (`~/.adhd`) → project (`.adhd/`) → local overrides → env vars. Fully optional, no files required.
- **Consumers**: agent-mcp (config, logging, plugins, queue, server, SSE, DB paths), apigen-plugin-mcp (multi-instance port binding), backlog (DB path resolution).
- **3 packages**: `@adhd/environment` (v0.0.3), `@adhd/environment-base-spec` (v0.0.5), `@adhd/environment-builder` (v0.0.4).

### Workspace Hygiene & Fixes

- **Deprecated package paths removed**: `packages/ai/` (7 directories) and `packages/shared/` entirely removed — all packages live under their actual domain directories.
- **`CLAUDE.md` is now a symlink** to `AGENTS.md` — structural impossibility of the two diverging again.
- **Pre-commit hook slimmed**: 187→98 lines. Secret-scan is now a whole-repo nx task. No more `--fix` re-staging.
- **Test wiring fixed**: 15 projects that shipped specs that could never run now have proper `test` targets — `nx run-many -t test` no longer silently skips them.
- **Build-tool stale `package.json` fix**: 3 packages (`data-base-transforms`, `data-query-engine`, `ui-react-base-hooks`) had dist versions permanently stuck ahead of source — fixed by adding `generatePackageJson: true`.
- **Apigen bundle size**: 10 packages went from ~25MB unpacked to ~67KB unpacked (external deps properly externalized).
- **Dispatch serializer fixed**: `dispatch-serializer-json`'s Vite config now correctly externalizes `fs`/`path` — fixed `(void 0) is not a function` crash.
- **Decimal.js regression fixed**: Pnpm migration made `decimal.js` resolvable, exposing a schema-extraction regression — fixed at the text-normalization layer.
- **Packaging hygiene gate added**: `check-publish-hygiene.mjs` asserts every published tarball excludes `__tests__/`, `*.test.*`, `vite.config.*`, etc. 5 packages with bloated/wrong packaging fixed.

---

## Upgrade Notes

### For npm consumers

- **@adhd/agent-mcp**: If running multiple instances, ensure `ADHD_AGENT_SSE_ENABLED` is set correctly. The default port is no longer a fixed 3001 — concurrent instances spread across ports. Set `sse.enabled: false` to skip the SSE bind entirely.
- **@adhd/backlog**: If migrating from hand-edited `BACKLOG.md`, run `backlog import-from-markdown --path BACKLOG.md --plan <plan-name>` to seed the graph. Phase-3 means the graph is authoritative — edit via CLI/MCP, not by editing markdown.
- **@adhd/agent-core-env**: Registry DB default moved to `~/.adhd/agent-registry/`. If you had custom `ADHD_AGENT_REGISTRY_DB_PATH` set, behavior is unchanged. Otherwise, agent-mcp now creates a fresh registry DB at the canonical path — existing `.adhd/agent-mcp/registry.db` is no longer read automatically.
- **@adhd/apigen-cli**: `apigen serve`'s front proxy now requires canonical kebab-case routes. If you were accessing `/namespace/opName` directly (not through the generated OpenAPI spec), update your paths to `/namespace/file-segment/op-name`. The `--namespace` flag on `apigen run` now affects the wire route.

### For contributors

- **Package scaffolding**: Must use `npx nx g @adhd/workspace-codegen-nx:<tier>` — the old `scripts/generate-lib.sh` exits 1 with a deprecation message. Pass the **bare name** (the generator composes the full `<domain>-<tier>-<name>`).
- **Build**: Run `pnpm run build` — never `tsc` directly. The build pipeline is `build → dist-manifest → verify-dist-load → publish-hygiene → publish`, all via Nx targets.
- **Release**: `pnpm release` (= `build` + `version` + `publish`). Use `pnpm release:dry` for preview. The `version` task uses `published-state.json` for cache — run `npx nx run-many -t reconcile` to refetch if the cache diverges from reality.
- **Pre-commit hook**: Runs `nx affected -t lint` with `CI=true`. If lint auto-fixes a dependency range (via `sync-deps`), the commit is FAILED — review the diff, `git add` the fixed `package.json`, and retry.
- **Nx cache**: Never use `--skip-nx-cache` — it creates a stale cached entry that can overwrite your fresh dist. Use `npx nx reset` instead of a clean rebuild.

---

## Deprecated

- **Legacy `tools/util/backlog.mjs`** — standalone BACKLOG.md markdown parser. Superseded by `@adhd/backlog` (Phase-3 graph-authoritative). Retained for backward compatibility but no longer the recommended tool.

---

## Roadmap

- **Environment CLI** (`entrypoint/environment-cli/`) — planned: `init`, `build`, `set`, `status`, `export` commands. Stub directory exists.

---

## Statistics

| Metric | Value |
|--------|-------|
| Published packages | 54 |
| Shipped capabilities | 42 |
| Packages with capability docs | 54/54 |
| Projects (nx targets) | 62 |
| Test files | 169+ |
| Git commits since last catalog | 269 |
| Monorepo domains | 7 (agent, apigen, data, dispatch, environment, ui-react, workspace) |
| Entrypoints | 5 (backlog, agent-mcp, apigen-cli, dispatch-cli, decompile-cli) |

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for the full per-entry changelog with commit SHAs, file lists, and negative-control proofs.

---

*Prepared by the doc-steward from verified catalog data. Every shipped-capability claim resolves to a `status: shipped` entry in [capabilities.json](./docs/marketing/.catalog/capabilities.json). 42 shipped, 1 roadmap, 1 deprecated — see [CHANGELOG.md](./CHANGELOG.md) for the full per-entry changelog.*
