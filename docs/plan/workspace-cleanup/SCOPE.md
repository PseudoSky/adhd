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

## Phase 2 (separate plan)

- Enforce strict import rules per layer definition
- Refactor apigen: split `apigen-core-client` into `apigen-extractor-ts` + move types to `apigen-base-types`
- Refactor agent: remove engine→store and engine→engine violations
- Lock `pkg-class` ESLint rules, remove wildcard
