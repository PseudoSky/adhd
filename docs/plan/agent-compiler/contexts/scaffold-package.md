# scaffold-package — NEW @adhd/agent-compiler NODE PACKAGE

**Phase:** foundation · **Kind:** work · **Depends on:** compiler-design · **Guard:** `npx --yes nx build agent-compiler`

---

## Goal

`@adhd/agent-compiler` exists as a clean `platform:node` Nx library that builds
green, is registered in `tsconfig.base.json`, imports no browser code, and
declares npm dependencies on the four upstream registry packages it joins. The
shared-DB client helper (`db/client.ts`) opens ONE better-sqlite3 handle over the
shared registry file. This is the foundation every engine state builds on. Proves
`[dod.6]`.

---

## Semantic Distillation

- **Primitive:** SCAFFOLD the package. Mirror `packages/ai/agent-mcp`'s
  `project.json` (tags `["layer:ai","platform:node"]`, `@nx/js:tsc` build) and
  `package.json` (`type:"module"`, `bin` entry for the CLI, `exports`).
- **Reference Pattern:** `[inv:platform-node]`, `[inv:one-db-handle]`,
  `[ref:cli-bin]`.
- **Delta Spec:**
  - `project.json`: `name: agent-compiler`, `sourceRoot`, tags
    `["layer:ai","platform:node"]`, build target writing `dist/packages/ai/agent-compiler`.
  - `package.json`: `@adhd/agent-compiler`, deps on `@adhd/agent-registry`,
    `@adhd/agent-tool-registry`, `@adhd/agent-provider`, `@adhd/agent-policy`
    (all `"*"`), plus `better-sqlite3`, `drizzle-orm`, `zod`; a `bin` mapping
    `agent-registry` (or `agent-compiler`) → `./src/cli/compile.js`.
  - `tsconfig.base.json`: add `"@adhd/agent-compiler": ["./packages/ai/agent-compiler/src/index.ts"]`.
  - `src/db/client.ts`: open the shared SQLite file, return a
    `BetterSQLite3Database` typed over the union of the four packages' schemas
    (re-export their tables under their prefixes); ONE handle (`[inv:one-db-handle]`).
  - `src/index.ts`: empty public barrel to be filled by later states.

---

## Acceptance criteria

- [scaffold-package.1] project.json exists
- [scaffold-package.2] tsconfig path registered
- [scaffold-package.3] tagged platform:node
- [scaffold-package.4] package builds clean
- [scaffold-package.5] no browser globals
- [scaffold-package.6] depends on the four registry packages

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [scaffold-package.1] project.json exists

- [scaffold-package.2] tsconfig path registered
- [scaffold-package.3] tagged platform:node
- [scaffold-package.4] package builds clean
- [scaffold-package.5] no browser globals
- [scaffold-package.6] depends on the four registry packages
---

## Reservations

```text
read_only:  ["docs/plan/agent-compiler/decisions.md"]
mutates:    ["packages/ai/agent-compiler/project.json", "packages/ai/agent-compiler/package.json", "packages/ai/agent-compiler/src/index.ts", "packages/ai/agent-compiler/src/db/client.ts", "tsconfig.base.json"]
```

---

## Commit points

- `feat(agent-compiler): scaffold platform:node package + shared-DB client`

## Notes for executor

- Build the four upstream packages first so their barrels resolve at typecheck.
- `db/client.ts` opens ONE handle (`[inv:one-db-handle]`); do NOT `ATTACH` a
  second file or open four handles.
- No store/emit logic here — only scaffold + the client. Keep `index.ts` minimal.
