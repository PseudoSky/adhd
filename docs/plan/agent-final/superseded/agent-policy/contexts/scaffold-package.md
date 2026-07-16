# scaffold-package — CREATE @adhd/agent-policy PACKAGE SKELETON

**Phase:** foundation · **Kind:** work · **Depends on:** policy-design · **Guard:** `npx --yes nx build agent-policy`

---

## Goal

`@adhd/agent-policy` exists as a `platform:node` Nx library that builds clean, is
registered in `tsconfig.base.json` paths, and has a wired better-sqlite3 + Drizzle
DB client and an empty `schema.ts` ready for `policy_*` tables. No tables yet —
this is the package skeleton the rest of the plan fills in.

---

## Semantic Distillation

- **Primitive:** CREATE the package at `packages/ai/agent-policy/`.
- **Reference Pattern:** mirror `packages/ai/agent-mcp` exactly — `project.json`
  (`@nx/js:tsc` build, `tags: ["layer:ai","platform:node"]`, `release` block,
  drizzle asset glob), `tsconfig.*`, `package.json` (`@adhd/agent-policy`,
  hyphenated), `src/db/client.ts` (better-sqlite3 WAL), `src/db/migrate.ts`.
  `[ref:drizzle-schema]`, `[ref:store-class]`, `[inv:platform-node]`.
- **Delta Spec:**
  - `project.json` — name `agent-policy`, `sourceRoot`
    `packages/ai/agent-policy/src`, tags `["layer:ai","platform:node"]`,
    `build`/`typecheck`/`test` targets copied from agent-mcp (incl. drizzle asset
    glob).
  - `package.json` — `"name": "@adhd/agent-policy"`, deps `drizzle-orm`,
    `better-sqlite3`, `zod`, and `@adhd/agent-mcp-types` (for the plugin contract
    + `HookRegistry`) — match agent-mcp / agent-mcp-budget versions.
  - `tsconfig.base.json` — `"@adhd/agent-policy":
    ["./packages/ai/agent-policy/src/index.ts"]` was added at plan-authoring time;
    verify it is present, do not duplicate.
  - `src/db/client.ts` — better-sqlite3 connection (WAL); copy agent-mcp's.
  - `src/db/schema.ts` — imports `drizzle-orm/sqlite-core`; no tables yet.
  - `src/index.ts` — barrel re-exporting `client` + schema (empty for now).

---

## Acceptance criteria

- [scaffold-package.1] project.json exists for agent-policy
- [scaffold-package.2] tsconfig.base.json registers the @adhd/agent-policy path
- [scaffold-package.3] project.json tags it platform:node
- [scaffold-package.4] the package builds clean
- [scaffold-package.5] no browser globals imported in source

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-policy/project.json", "packages/ai/agent-policy/package.json", "packages/ai/agent-policy/src/index.ts", "packages/ai/agent-policy/src/db/client.ts", "packages/ai/agent-policy/src/db/schema.ts", "tsconfig.base.json"]
```

---

## Commit points

- `feat(agent-policy): scaffold @adhd/agent-policy package skeleton`
- Post-guard commit via `state-transition.js --complete`.

## Notes for executor

- Use the documented scaffolder if convenient (`scripts/generate-lib.sh lib
  agent-policy logic node`) then RECONCILE `project.json`/`package.json`/tags
  against `agent-mcp` — verify tags per CLAUDE.md "verify project.json after
  generation."
- Depend on `@adhd/agent-mcp-types` now so the enforcement-plugin state can import
  `IHookRegistry` / `HookRegistry` / `PluginFactory` without a later package.json edit.
