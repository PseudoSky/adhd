# runtime-core-node

**Phase:** runtime · **Kind:** work · **Depends on:** builder-snapshot-api · **Guard:** `npx nx build environment-core-node`

---

## Goal

The `@adhd/environment` package provides a thin (~60 line) typed runtime client. `new Environment<Config>({ project, namespace, scope?, adhdRoot? })` reads a snapshot and exposes typed `env.get()` access for config values, directory paths, env vars, and provenance. Constructor uses a params object.

---

## Acceptance criteria

- [runtime-core-node.10] Runtime package builds
- [runtime-core-node.2] Environment class is exported from environment.ts
- [runtime-core-node.3] Runtime surface implemented: `env.hash`, `env.version`, `provenance.*`, bracket access (Proxy), and scope filtering all present in environment.ts
- [runtime-core-node.4] Runtime unit tests pass (must cover `env.hash`, `env.version`, `env.get("provenance.*")`, bracket access, and `scope: "system"` filtering)
- [runtime-core-node.5] `environment-core-node` package.json name is `@adhd/environment` (B3: published identity, not `@adhd/environment-core-node`)

---

## Reservations

```text
read_only:  []
mutates:    ["packages/environment/environment-core-node/src/index.ts", "packages/environment/environment-core-node/src/environment.ts"]
```

---

## Notes for executor

1. The runtime client is a JSON snapshot reader — NO builder logic, no `.env` loading, no validation.
2. Constructor takes a params object: `{ project, scope?, namespace?, adhdRoot? }`.
3. Bracket access `env["config.x"]` uses a Proxy to delegate to `env.get()`.
4. Scope filtering: when `scope: "system"`, `env.get("config.db.path")` returns `undefined` for project-scoped fields.
5. Snapshot path: `{adhdRoot}/{org}/{project}/{namespace}/adhd-environment.json`.
6. **Published identity (B3):** this package's npm name is **`@adhd/environment`** (set in `package.json` by `scaffold-workspace`). Do not leave the generator default `@adhd/environment-core-node`, or `require("@adhd/environment")` in the final audit (dod.5/dod.6) throws MODULE_NOT_FOUND. The `tsconfig.base.json` alias `@adhd/environment` → `packages/environment/environment-core-node/src/index.ts` is already declared in scaffold.
7. **Runtime surface (S9):** `env.hash` (sha256-prefixed), `env.version` (`{ configHash, structureHash, generatedAt, libraryVersion }`), `env.get("provenance.<key>")` (`{ source, scope }`), bracket access, and scope filtering are all part of the acceptance gate — see SCOPE.md §6 Runtime probes and interfaces-architect.md §4.2 / §9.4.
8. See `interfaces-architect.md` §2 and §4 for exact interface definitions.