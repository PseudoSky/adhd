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
