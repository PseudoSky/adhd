# runtime-core-node

**Phase:** runtime · **Kind:** work · **Depends on:** builder-snapshot-api · **Guard:** `true`

---

## Goal

The `@adhd/environment` package provides a thin (~60 line) typed runtime client. `new Environment<Config>({ project, namespace, scope?, adhdRoot? })` reads a snapshot and exposes typed `env.get()` access for config values, directory paths, env vars, and provenance. Constructor uses a params object.

---

## Acceptance criteria

- [runtime-core-node.1] `new Environment({ project: "agent-mcp", namespace: "production" })` constructs without error when snapshot exists
- [runtime-core-node.3] `env.get("path.state.data")` returns directory path string
- [runtime-core-node.5] `env.get("provenance.db.path")` returns `{ source: string, scope: string }`
- [runtime-core-node.7] `env["config.server.port"]` delegates to `env.get()`
- [runtime-core-node.9] `env.prefix` returns `"ADHD_AGENT_MCP_PRODUCTION_"` (namespace-aware)



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
6. See `interfaces-architect.md` §2 and §4 for exact interface definitions.