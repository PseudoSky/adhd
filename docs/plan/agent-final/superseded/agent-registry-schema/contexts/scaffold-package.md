# scaffold-package — CREATE @adhd/agent-registry PACKAGE SKELETON

**Phase:** foundation · **Kind:** work · **Depends on:** design-and-architecture · **Guard:** `npx --yes nx build agent-registry`

---

## Goal

`@adhd/agent-registry` exists as a `platform:node` Nx library that builds clean,
is registered in `tsconfig.base.json` paths, and has a wired better-sqlite3 +
Drizzle DB client and an empty `schema.ts` ready for tables. No tables yet —
this is the package skeleton the rest of the plan fills in.

---

## Semantic Distillation

- **Primitive:** CREATE the package at `packages/ai/agent-registry/`.
- **Reference Pattern:** mirror `packages/ai/agent-mcp` exactly — `project.json`
  (`@nx/js:tsc` build, `tags: ["layer:ai","platform:node"]`, `release` block),
  `tsconfig.*`, `package.json` (`@adhd/agent-registry`, hyphenated),
  `src/db/client.ts` (better-sqlite3 WAL), `src/db/migrate.ts`.
  `[ref:drizzle-schema]`, `[ref:store-class]`, `[inv:platform-node]`.
- **Delta Spec:**
  - `project.json` — name `agent-registry`, `sourceRoot`
    `packages/ai/agent-registry/src`, tags `["layer:ai","platform:node"]`,
    `build`/`typecheck`/`test` targets copied from agent-mcp (incl. drizzle asset glob).
  - `package.json` — `"name": "@adhd/agent-registry"`, deps `drizzle-orm`,
    `better-sqlite3`, `zod` (match agent-mcp versions).
  - `tsconfig.base.json` — add `"@adhd/agent-registry": ["./packages/ai/agent-registry/src/index.ts"]`.
  - `src/db/client.ts` — better-sqlite3 connection (WAL); copy agent-mcp's.
  - `src/db/schema.ts` — imports `drizzle-orm/sqlite-core`; no tables yet.
  - `src/index.ts` — barrel re-exporting `client` + schema (empty for now).

---

## Acceptance criteria

- [scaffold-package.1] project.json exists for agent-registry
- [scaffold-package.2] tsconfig.base.json registers the @adhd/agent-registry path
- [scaffold-package.3] project.json tags it platform:node
- [scaffold-package.4] the package builds clean
- [scaffold-package.5] no browser globals imported in source

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-registry/project.json", "packages/ai/agent-registry/package.json", "packages/ai/agent-registry/src/index.ts", "packages/ai/agent-registry/src/db/client.ts", "packages/ai/agent-registry/src/db/schema.ts", "tsconfig.base.json"]
```

---

## Commit points

- `feat(agent-registry): scaffold @adhd/agent-registry package skeleton`
- Post-guard commit via `state-transition.js --complete`.

## Notes for executor

- Use the documented scaffolder if convenient (`scripts/generate-lib.sh lib
  agent-registry logic node`) then RECONCILE `project.json`/`package.json`/tags
  against `agent-mcp` — verify tags per CLAUDE.md "verify project.json after generation."
- `tsconfig.base.json` is a shared mutable file touched by every registry plan's
  scaffold; add only the `@adhd/agent-registry` line.
