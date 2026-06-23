# scaffold-package — CREATE @adhd/agent-registry-migration PACKAGE SKELETON

**Phase:** foundation · **Kind:** work · **Depends on:** migration-design · **Guard:** `npx --yes nx build agent-registry-migration`

---

## Goal

`@adhd/agent-registry-migration` exists as a `platform:node` Nx library that
builds clean, is registered in `tsconfig.base.json` paths, and declares
dependencies on `@adhd/agent-registry` (plan 1) and `@adhd/agent-compiler`
(plan 5). No migration logic yet — this is the skeleton the rest of the plan
fills in. Proves `[dod.5]`.

---

## Semantic Distillation

- **Primitive:** CREATE the package at `packages/ai/agent-registry-migration/`.
- **Reference Pattern:** mirror `packages/ai/agent-mcp` exactly — `project.json`
  (`@nx/js:tsc` build, `tags: ["layer:ai","platform:node"]`, `release` block),
  `tsconfig.*`, `package.json`. `[inv:platform-node]`.
- **Delta Spec:**
  - `project.json` — name `agent-registry-migration`, `sourceRoot`
    `packages/ai/agent-registry-migration/src`, tags `["layer:ai","platform:node"]`,
    `build`/`typecheck`/`test` targets copied from agent-mcp.
  - `package.json` — `"name": "@adhd/agent-registry-migration"`, deps include
    `@adhd/agent-registry`, `@adhd/agent-compiler`, plus `better-sqlite3`,
    `drizzle-orm`, a YAML parser (`yaml`), a markdown AST parser
    (`remark`/`unified` or equivalent), `zod` (match agent-mcp versions).
  - `tsconfig.base.json` — add ONLY
    `"@adhd/agent-registry-migration": ["./packages/ai/agent-registry-migration/src/index.ts"]`.
    (The `@adhd/agent-registry` + `@adhd/agent-compiler` path lines already exist
    from plans 1 and 5 — do not re-add them.)
  - `src/index.ts` — empty public barrel for now.

---

## Acceptance criteria

- [scaffold-package.1] project.json exists
- [scaffold-package.2] tagged platform:node
- [scaffold-package.3] tsconfig path registered
- [scaffold-package.4] depends on registry + compiler
- [scaffold-package.5] package builds clean

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-registry-migration/project.json", "packages/ai/agent-registry-migration/package.json", "packages/ai/agent-registry-migration/src/index.ts", "tsconfig.base.json"]
```

---

## Commit points

- `feat(agent-registry-migration): scaffold @adhd/agent-registry-migration package skeleton`
- Post-guard commit via `state-transition.js --complete`.

## Notes for executor

- Use the documented scaffolder if convenient (`./generate-lib.sh lib
  agent-registry-migration logic node`) then RECONCILE
  `project.json`/`package.json`/tags against `agent-mcp` — verify tags per
  CLAUDE.md "verify project.json after generation."
- `tsconfig.base.json` is a shared mutable file touched by every registry plan's
  scaffold; add only this package's line.
