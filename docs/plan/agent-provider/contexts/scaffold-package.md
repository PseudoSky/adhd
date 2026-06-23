# scaffold-package — CREATE @adhd/agent-provider PACKAGE SKELETON

**Phase:** foundation · **Kind:** work · **Depends on:** none · **Guard:** `npx --yes nx build agent-provider`

---

## Goal

`@adhd/agent-provider` exists as a `platform:node` Nx library that builds clean,
is registered in `tsconfig.base.json` paths, and has a wired better-sqlite3 +
Drizzle DB client and an empty `schema.ts` ready for the `provider_*` tables. No
tables yet — this is the package skeleton the rest of the plan fills in.

---

## Semantic Distillation

- **Primitive:** CREATE the package at `packages/ai/agent-provider/`.
- **Reference Pattern:** mirror `packages/ai/agent-mcp` exactly — `project.json`
  (`@nx/js:tsc` build, `tags: ["layer:ai","platform:node"]`, `release` block,
  drizzle asset glob), `tsconfig.*`, `package.json` (`@adhd/agent-provider`,
  hyphenated), `src/db/client.ts` (better-sqlite3 WAL + `foreign_keys = ON`),
  `src/db/migrate.ts`. `[ref:drizzle-schema]`, `[ref:store-class]`,
  `[inv:platform-node]`.
- **Delta Spec:**
  - `project.json` — name `agent-provider`, `sourceRoot`
    `packages/ai/agent-provider/src`, tags `["layer:ai","platform:node"]`,
    `build`/`typecheck`/`test`/`serve`/`clean`/`nx-release-publish` targets copied
    from agent-mcp (incl. the drizzle asset glob).
  - `package.json` — `"name": "@adhd/agent-provider"`, deps `@adhd/agent-mcp-types`
    (`*`), `drizzle-orm`, `better-sqlite3`, `zod` (match agent-mcp versions); dev
    deps `drizzle-kit`, `vitest`, `@types/better-sqlite3`, `typescript`, `tslib`.
  - `tsconfig.base.json` — add ONLY
    `"@adhd/agent-provider": ["./packages/ai/agent-provider/src/index.ts"]`.
  - `src/db/client.ts` — better-sqlite3 connection (WAL, `foreign_keys = ON`);
    copy agent-mcp's. Honor `DATABASE_PATH` so it can point at the SAME shared
    SQLite file the other registry packages use (`[inv:shared-db-prefix]`).
  - `src/db/schema.ts` — imports `drizzle-orm/sqlite-core`; no tables yet.
  - `src/index.ts` — barrel re-exporting `client` + schema (empty for now).

---

## Acceptance criteria

- [scaffold-package.1] project.json exists for agent-provider
- [scaffold-package.2] tsconfig.base.json registers the @adhd/agent-provider path
- [scaffold-package.3] project.json tags it platform:node
- [scaffold-package.4] the package builds clean
- [scaffold-package.5] no browser globals imported in source

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-provider/project.json", "packages/ai/agent-provider/package.json", "packages/ai/agent-provider/src/index.ts", "packages/ai/agent-provider/src/db/client.ts", "packages/ai/agent-provider/src/db/schema.ts", "tsconfig.base.json"]
```

---

## Commit points

- `feat(agent-provider): scaffold @adhd/agent-provider package skeleton`
- Post-guard commit via `state-transition.js --complete`.

## Notes for executor

- Use the documented scaffolder if convenient (`scripts/generate-lib.sh lib
  agent-provider logic node`) then RECONCILE `project.json`/`package.json`/tags
  against `agent-mcp` — verify tags per CLAUDE.md "verify project.json after
  generation."
- `tsconfig.base.json` is a shared mutable file touched by every registry plan's
  scaffold; add only the `@adhd/agent-provider` line. Proves `[dod.4]`.
- Do NOT depend on `@adhd/agent-mcp` — that would invert the dependency direction
  (`[inv:adapter-in-types]`). Only `@adhd/agent-mcp-types` is an allowed dep.
