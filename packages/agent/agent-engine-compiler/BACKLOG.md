# @adhd/agent-compiler — Backlog

## BUG-CLI-001: Pre-existing TS2352 in compile.ts (FIXED in compile-cli state)

**File:** `src/compile.ts` line 251 (prior state's output)
**Root cause:** `emitToolsForProvider(...)` returns `EmittedTool[]`; `EmittedServerSideTool` lacks an index signature, making the direct `as StructuredTool[]` cast fail tsc.
**Fix applied:** Double-cast via `unknown` — `as unknown as StructuredTool[]`. Runtime safe: all `EmittedTool` shapes are plain objects.
**Status:** Fixed in commit `75125d2`.

## DEBT-CLI-001: @adhd symlinks in dist/ created by test beforeAll

**Context:** When the test spawns `node dist/.../compile.js`, the bin imports `@adhd/*` packages using ESM specifiers. There are no `node_modules/@adhd` symlinks in dist/ (no npm workspace linking in this repo), so Node can't find them.
**Workaround:** `compile-cli.test.ts` creates `dist/packages/ai/agent-compiler/node_modules/@adhd/<pkg>` symlinks in `beforeAll` and removes them in `afterAll`.
**Permanent fix:** Add npm/yarn workspace `workspaces` field to root `package.json` so `@adhd/*` packages are properly symlinked, OR have the nx build step emit a `package.json` `imports` map / `exports` subpath that resolves relative to dist. Either fix removes the test-side symlink dance.

## DEBT-CLI-002: --db default path not auto-migrated for first-run UX

**Context:** `--db` defaults to `~/.agent-registry/registry.db`. The CLI runs migrations on open but only covers the compiler's own drizzle folder — it skips the four upstream package migration sets because those paths are resolved relative to the dist layout (which may not exist on a fresh install).
**Impact:** First-run `agent-compiler compile <slug>` against a fresh DB will error on missing tables from the upstream packages.
**Permanent fix:** Bundle or reference upstream drizzle migration folders in the dist output (add to `project.json` `assets`), or use a combined migrations folder.

---

## Revalidation (2026-07-04) — verified against current source

| Item | Status | Notes |
|------|--------|-------|
| DEBT-CLI-001 — symlink workaround | **STILL OPEN** | `packages/agent/agent-engine-compiler/src/__tests__/compile-cli.test.ts` still creates/removes `node_modules/@adhd` symlinks in `beforeAll`/`afterAll` (lines 186-225, 332-337). No permanent fix (npm/yarn workspaces, `imports`/`exports` subpaths) implemented. |
| DEBT-CLI-002 — migration failure | **CHANGED (worse than described)** | **All 5** migration paths (not 4 of 5) resolve to nonexistent dist directories. Path constants in `packages/agent/agent-engine-compiler/src/cli/compile.ts:64-74` use stale pre-rename package names (e.g., `agent-provider` instead of `agent-core-provider`). `fs.existsSync` guard silently swallows all failures — **zero migrations run**. Additionally, `openDb()` refuses to create the DB file on first run — exits with error if file is absent. Three compounded failures make this a complete migration blackout, not a partial one. |
