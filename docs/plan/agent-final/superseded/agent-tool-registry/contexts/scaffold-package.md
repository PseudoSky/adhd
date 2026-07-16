# scaffold-package — CREATE @adhd/agent-tool-registry PACKAGE SKELETON

**Phase:** foundation · **Kind:** work · **Depends on:** none · **Guard:** `npx --yes nx build agent-tool-registry`

---

## Goal

`@adhd/agent-tool-registry` exists as a `platform:node` Nx library that builds
clean, is registered in `tsconfig.base.json` paths, and has a wired
better-sqlite3 + Drizzle DB client and an empty `schema.ts` ready for tables. No
tables yet — this is the package skeleton the rest of the plan fills in. See
`[inv:platform-node]`, `[inv:shared-db]`.

---

## Semantic Distillation / Delta Spec

- **Primitive:** CREATE the package at `packages/ai/agent-tool-registry/`.
- **Reference Pattern:** mirror `packages/ai/agent-mcp` exactly — `project.json`
  (`@nx/js:tsc` build with the drizzle asset glob, tags
  `["layer:ai","platform:node"]`, `release` block), `tsconfig.*`, `package.json`
  (`@adhd/agent-tool-registry`, hyphenated), `src/db/client.ts`
  (better-sqlite3 WAL), `src/db/migrate.ts`. `[ref:drizzle-schema]`,
  `[ref:store-class]`.
- **Delta Spec** (no `DATA_MODEL` tables yet — skeleton only):
  - `project.json` — name `agent-tool-registry`, `sourceRoot`
    `packages/ai/agent-tool-registry/src`, tags `["layer:ai","platform:node"]`,
    `build`/`typecheck`/`test` targets copied from agent-mcp (incl. the drizzle
    asset glob so generated migrations ship).
  - `package.json` — `"name": "@adhd/agent-tool-registry"`, deps `drizzle-orm`,
    `better-sqlite3`, `zod` (match agent-mcp versions).
  - `tsconfig.base.json` — add
    `"@adhd/agent-tool-registry": ["./packages/ai/agent-tool-registry/src/index.ts"]`.
  - `src/db/client.ts` — better-sqlite3 connection (WAL); copy agent-mcp's. The
    shared-DB-file convention from `[inv:shared-db]` is wired here, but this
    package's tables stand alone.
  - `src/db/migrate.ts` — drizzle migrator; copy agent-mcp's.
  - `src/db/schema.ts` — imports `drizzle-orm/sqlite-core`; no tables yet.
  - `src/index.ts` — barrel re-exporting `client` + (empty) schema.

---

## Acceptance criteria

- [scaffold-package.1] project.json exists for agent-tool-registry
- [scaffold-package.2] tsconfig.base.json registers the @adhd/agent-tool-registry path
- [scaffold-package.3] project.json tags it platform:node
- [scaffold-package.4] the package builds clean
- [scaffold-package.5] no browser globals imported in source

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-tool-registry/project.json", "packages/ai/agent-tool-registry/package.json", "packages/ai/agent-tool-registry/src/index.ts", "packages/ai/agent-tool-registry/src/db/client.ts", "packages/ai/agent-tool-registry/src/db/schema.ts", "packages/ai/agent-tool-registry/src/db/migrate.ts", "tsconfig.base.json"]
```

---

## Commit points

- `feat(agent-tool-registry): scaffold @adhd/agent-tool-registry package skeleton`
- Post-guard commit via `state-transition.js --complete`.

## Notes for executor

- Use the documented scaffolder if convenient (`scripts/generate-lib.sh lib
  agent-tool-registry logic node`) then RECONCILE
  `project.json`/`package.json`/tags against `agent-mcp` — verify tags per
  CLAUDE.md "verify project.json after generation."
- `tsconfig.base.json` is a shared mutable file touched by every registry plan's
  scaffold; add only the `@adhd/agent-tool-registry` line.
- Proves the structural `[dod.4]`.
