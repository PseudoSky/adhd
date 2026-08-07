# workspace-cleanup — Rename + restructure monorepo to `<group>-<layer>-<name>` convention

**Status:** planned · **Phase:** 1 (rename only) · **Depends on:** none

## Summary

Rename every package in the monorepo to the uniform `<group>-<layer>-<name>` naming convention.
Phase 1 is surface-level only: `nx mv` + `git mv`, no dependency refactoring. Phase 2 (separate plan)
enforces the strict import rules and fixes violations.

## Naming Convention

```
packages/<group>/<group>-<layer>-<name>/    → @adhd/<group>-<layer>-<name>
entrypoint/<name>/                          → @adhd/<name>
```

| Term | Meaning | Examples |
|---|---|---|
| `group` | Domain / bounded context | `apigen`, `agent`, `data`, `dispatch`, `ui-react` |
| `layer` | Package classification within group | `base`, `core`, `engine`, `store`, `plugin`, `generator`, `query` |
| `name` | Specific package identity | `client`, `naming`, `mcp`, `budget`, `structures` |

### Layer semantics

| Layer | Definition | Internal deps rule | ESLint class |
|---|---|---|---|
| `base` | Zero internal deps (roots) | nothing within domain | foundation |
| `core` | Depends only on `base` | `base` only | foundation |
| `engine` | Depends on `base` + `core` | `base` + `core` | foundation |
| `store` | Persistence/storage | `base` + `core` | foundation |
| `query` | Query/engine layer | `base` + `core` | foundation |
| `plugin` | Optional extension | `base` + `core` + `store` | optional |
| `generator` | Code generator | `base` + `core` | optional |

### Entrypoints

Entrypoints live in `entrypoint/` (flat, no type subdirs) with `<name>/` directory and `@adhd/<name>` npm name.

**Entrypoints created:**
- `entrypoint/decompile-cli/` → `@adhd/decompile-cli` (mv from `packages/decompile`)
- `entrypoint/agent-mcp/` → `@adhd/agent-mcp` (entrypoint wrapping `agent-core-runtime`)
- `entrypoint/apigen-cli/` → `@adhd/apigen-cli` (mv from `packages/apigen/cli`)

**Deleted (via `nx g @nx/workspace:remove`):**
- `adhd` — Nx boilerplate Next.js app
- `adhd-e2e` — Nx boilerplate Cypress e2e

## Prerequisite: fix tsconfig paths for `nx mv`

All 41 entries in `tsconfig.base.json` compilerOptions.paths use `./` prefix (e.g. `"./packages/..."`)
which breaks Nx's source-root matching in `@nx/workspace:move`. Strip the prefix before any rename:

```jsonc
// Before: "@adhd/foo": ["./packages/group/foo/src/index.ts"]
// After:  "@adhd/foo": ["packages/group/foo/src/index.ts"]
```

## Rename tool: `@nx/workspace:move`

```bash
nx g @nx/workspace:move \
  --destination packages/<group>/<new-name> \
  --projectName <old-name> \
  --newProjectName <new-name> \
  --importPath @adhd/<new-name> \
  --projectNameAndRootFormat as-provided
```

This does: `git mv` directory → update `project.json` (name, sourceRoot, path refs) → update `package.json` (name, internal deps) → rewrite all TypeScript import/export/references across the workspace → update `tsconfig.base.json` paths.

**Verified** with `dispatch-spec` → `dispatch-base-spec`: 15 source files across `dispatch-client` and `dispatch-optimizer` updated correctly. See BACKLOG.md `FOLLOW-UP: nx mv workspace rename prerequisite (workspace-cleanup)`.

## Rename catalog

### apigen

| Current | New npm name | New path |
|---|---|---|
| `packages/apigen/core/` | `@adhd/apigen-core-client` | `packages/apigen/apigen-core-client/` |
| `packages/apigen/cli/` | `@adhd/apigen-cli` | `entrypoint/apigen-cli/` |
| `packages/apigen/logical/` | `@adhd/apigen-base-logical` | `packages/apigen/apigen-base-logical/` |
| `packages/apigen/errors/` | `@adhd/apigen-base-errors` | `packages/apigen/apigen-base-errors/` |
| `packages/apigen/schema/` | `@adhd/apigen-base-schema` | `packages/apigen/apigen-base-schema/` |
| `packages/apigen/naming/` | `@adhd/apigen-engine-naming` | `packages/apigen/apigen-engine-naming/` |
| `packages/apigen/runtime/` | `@adhd/apigen-engine-runtime` | `packages/apigen/apigen-engine-runtime/` |
| `packages/apigen/gateway/` | `@adhd/apigen-engine-gateway` | `packages/apigen/apigen-engine-gateway/` |
| `packages/apigen/conformance/` | `@adhd/apigen-engine-conformance` | `packages/apigen/apigen-engine-conformance/` |
| `packages/apigen/nx/` | `@adhd/apigen-generator-nx` | `packages/apigen/apigen-generator-nx/` |
| `packages/apigen/codegen/openapi/` | `@adhd/apigen-plugin-openapi` | `packages/apigen/apigen-plugin-openapi/` |
| _new_ | `@adhd/apigen-base-types` | `packages/apigen/apigen-base-types/` |
| all `packages/apigen/plugins/*/` | keep `@adhd/apigen-plugin-*` | keep same |

### agent

| Current | New npm name | New path |
|---|---|---|
| `packages/ai/agent-mcp-types/` | `@adhd/agent-base-types` | `packages/agent/agent-base-types/` |
| `packages/ai/agent-policy/` | `@adhd/agent-core-policy` | `packages/agent/agent-core-policy/` |
| `packages/ai/agent-provider/` | `@adhd/agent-core-provider` | `packages/agent/agent-core-provider/` |
| `packages/ai/agent-mcp/` → split | `@adhd/agent-core-runtime` | `packages/agent/agent-core-runtime/` |
| | `@adhd/agent-mcp` | `entrypoint/agent-mcp/` |
| `packages/ai/agent-registry/` | `@adhd/agent-store-prompts` | `packages/agent/agent-store-prompts/` |
| `packages/ai/agent-tool-registry/` | `@adhd/agent-store-tools` | `packages/agent/agent-store-tools/` |
| `packages/ai/agent-compiler/` | `@adhd/agent-engine-compiler` | `packages/agent/agent-engine-compiler/` |
| `packages/ai/agent-nx/` | `@adhd/agent-generator-plugin` | `packages/agent/agent-generator-plugin/` |
| `packages/ai/agent-mcp-budget/` | `@adhd/agent-plugin-budget` | `packages/agent/agent-plugin-budget/` |
| `packages/ai/agent-mcp-sanitize/` | `@adhd/agent-plugin-sanitize` | `packages/agent/agent-plugin-sanitize/` |

### data (was standalone packages/data, transform, query)

| Current | New npm name | New path |
|---|---|---|
| `packages/transform/` | `@adhd/data-base-transforms` | `packages/data/data-base-transforms/` |
| `packages/data/` | `@adhd/data-core-structures` | `packages/data/data-core-structures/` |
| `packages/query/` | `@adhd/data-query-engine` | `packages/data/data-query-engine/` |

### dispatch

| Current | New npm name | New path |
|---|---|---|
| `packages/dispatch/dispatch-spec/` | `@adhd/dispatch-base-spec` | `packages/dispatch/dispatch-base-spec/` |
| `packages/dispatch/dispatch-client/` | `@adhd/dispatch-core-client` | `packages/dispatch/dispatch-core-client/` |
| `packages/dispatch/dispatch-optimizer/` | `@adhd/dispatch-core-optimizer` | `packages/dispatch/dispatch-core-optimizer/` |
| _new_ | `@adhd/dispatch-base-types` | `packages/dispatch/dispatch-base-types/` |

### ui-react (was standalone packages/react-hooks, storybook)

| Current | New npm name | New path |
|---|---|---|
| `packages/react-hooks/` | `@adhd/ui-react-base-hooks` | `packages/ui-react/ui-react-base-hooks/` |
| `packages/storybook/` | `@adhd/ui-react-base-storybook` | `packages/ui-react/ui-react-base-storybook/` |

## Verification gates

After all moves, the following must pass:

1. `nx run-many -t lint` — zero errors
2. `nx run-many -t build` — zero failures
3. `nx run-many -t test` — results match pre-rename baseline
4. Grep for old package names (`@adhd/apigen-core`, `@adhd/agent-mcp-budget`, etc.) in `src/` — zero matches

## Agent migration order (no `git mv`)

Do NOT `git mv packages/ai/ packages/agent/`. Instead, `nx mv` each agent package directly to its final destination under `packages/agent/`. The old `packages/ai/` empties naturally as packages move out:

```bash
nx mv agent-mcp-types    agent-base-types      --destination packages/agent/agent-base-types
nx mv agent-policy       agent-core-policy     --destination packages/agent/agent-core-policy
nx mv agent-provider     agent-core-provider   --destination packages/agent/agent-core-provider
# ... etc for all agent packages
```

After all moves, `packages/ai/` will be empty and can be deleted with `rm -rf packages/ai`.

## Agent-mcp split — extract `agent-store-runtime` + `agent-engine-orchestrator`

Split `packages/ai/agent-mcp/` into three packages following the layer hierarchy. Only `entrypoint/agent-mcp/` keeps the `@adhd/agent-mcp` npm name for backward compatibility.

### Target structure

```
packages/agent/
  agent-base-types/                      ← exists, hosts shared domain types
  agent-core-policy/                     ← exists
  agent-core-provider/                   ← exists
  agent-store-prompts/                   ← exists, has ComposedPromptStore for cache
  agent-store-runtime/                   ← NEW — session + task stores
  agent-engine-orchestrator/             ← NEW — engine, providers, tool handlers, clients
  agent-plugin-budget/                   ← exists
  agent-plugin-sanitize/                 ← exists

entrypoint/
  agent-mcp/                             ← NEW — thin MCP server shell
```

### Package: `agent-store-runtime` (store layer)

**NPM:** `@adhd/agent-store-runtime` at `packages/agent/agent-store-runtime/`
**Tags:** `domain:agent, pkg-kind:store, pkg-class:foundation, layer:data, platform:shared`
**Deps:** `agent-base-types`, `drizzle-orm`, `better-sqlite3`

**Contents (extracted from agent-mcp):**
- `store/session-store.ts` — session lifecycle, message history, context window
- `store/task-store.ts` — task lifecycle, cancellation token registry
- `db/schema.ts` — tables: `sessions`, `messages`, `tasks`, `task_events`, `task_usage`, `experiment_assignments`
- `runtime/usage-client.ts` — `UsageClient` class for token accumulation
- `utils/ids.ts` — `generateId`
- `utils/timestamps.ts` — `nowIso`

**Not included (stays in entrypoint/agent-mcp):**
- `agents` table — thin cache, kept with the entrypoint
- `store/agent-store.ts` — CRUD for agents, kept with the entrypoint

### Package: `agent-engine-orchestrator` (engine layer)

**NPM:** `@adhd/agent-engine-orchestrator` at `packages/agent/agent-engine-orchestrator/`
**Tags:** `domain:agent, pkg-kind:engine, pkg-class:foundation, layer:logic, platform:node`
**Deps:** `agent-base-types`, `agent-core-policy`, `agent-core-provider`, `agent-store-prompts`, `agent-store-runtime`, `drizzle-orm`, `pino`

**Contents (extracted from agent-mcp):**
- `engine/orchestrator.ts` — tool-use loop, HITL, event emission
- `engine/policy.ts` — `PolicyEngine` (recursion depth, tool loops, allowed agents)
- `engine/hooks.ts` — `HookRegistry`
- `engine/prompt-resolver.ts` — `resolveComposedPrompt`, `computeContextHash`
- `engine/queue.ts` — `BackgroundQueue`
- `engine/dag-engine.ts` — `DagEngine` (task dependency DAG)
- `providers/` — `types.ts`, `factory.ts`, `anthropic.ts`, `openai.ts`, `claudecli.ts`
- `clients/` — MCP client registry + transports (in-process, stdio, http, sse)
- `tools/agent-crud.ts` — agent create/read/update/delete/list
- `tools/session.ts` — agent/session tool
- `tools/task.ts` — task/create/result/list/cancel
- `tools/usage.ts` — usage_query tool
- `plugins/loader.ts` — external plugin loading
- `plugins/usage-plugin.ts` — `UsagePlugin` (writes to task_usage via store-runtime)
- `validation/` — Zod schemas for agent, session, task, message, mcp, execution, usage, errors
- `runtime/usage-client.ts` — `UsageClient` (shared with store-runtime)

**Uses `@adhd/agent-store-prompts`** for `ComposedPromptStore` (composed prompt cache).  
**Uses `@adhd/agent-store-runtime`** for `SessionStore` + `TaskStore` (session/task lifecycle).

### Entrypoint: `entrypoint/agent-mcp`

**NPM:** `@adhd/agent-mcp` at `entrypoint/agent-mcp/`
**Tags:** `entrypoint:mcp, pkg-class:entrypoint, platform:node`
**Deps:** `agent-engine-orchestrator`, `agent-store-runtime`, `agent-store-prompts`, `@modelcontextprotocol/sdk`

**Contents:**
- `index.ts` — composition root, process lifecycle, `main()`
- `server.ts` — MCP server creation via `@modelcontextprotocol/sdk`
- `config.ts` — env loading, config singleton
- `logger.ts` — pino to stderr
- `store/agent-store.ts` — agents table (thin cache)
- `db/client.ts` — DB singleton connection
- `db/schema.ts` — agents table + migrations
- `db/migrate.ts` / `migrate-runner.ts` — migration boot
- `streaming/sse-server.ts` — SSE task event server
- `streaming/chat-gateway.ts` — OpenAI-compatible gateway
- `streaming/event-bus.ts` — in-process event bus
- `utils/load-env.ts` — env file loading
- `scripts/agent-mcp-tail.ts` — CLI dev tool

### Migration steps

1. **Create `agent-store-runtime`** — extract session-store, task-store, usage-client, schema, ids, timestamps
2. **Create `agent-engine-orchestrator`** — extract engine, providers, clients, tools, plugins, validation
3. **Remove duplicate `ComposedPromptStore`** from agent-mcp; import from `@adhd/agent-store-prompts` instead
4. **Wire entrypoint** — `entrypoint/agent-mcp/` imports from the two new packages, registers tools, starts server
5. **Update tsconfig.base.json** — add paths for the new packages
6. **Update package.json deps** — all consumers of agent-mcp now depend on the specific package they need
7. **Tests** — all existing tests must pass; verify with `nx run-many -t test`
8. **Remove old `packages/ai/agent-mcp/`** once verified

## Phase 2 (separate plan)

- Enforce strict import rules per layer definition
- Refactor apigen: split `apigen-core-client` into `apigen-extractor-ts` + move types to `apigen-base-types`
- Remove engine→store and engine→engine violations
- Lock `pkg-class` ESLint rules, remove wildcard
