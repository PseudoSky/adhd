# Shared context — adhd-environment v0.0.5

> Single source of truth for definitions. Reference entries here from any
> context file instead of restating them.

## Glossary

- **[def:orgNamespace]** — the org-level directory segment in the data root. Defaults to `"adhd"`.
  Feeds the snapshot path `~/.<orgNamespace>/<project>/<namespace>/adhd-environment.json`
  (e.g. `~/.adhd/agent-mcp/production/…`). Overridable via `ADHD_HOME` for the root prefix.
- **[def:namespace]** — the environment segment (e.g. `production`, `staging`). Optional in the YAML;
  when `namespaces` is absent it defaults to `"default"`. When `namespaces` IS listed, only those are
  valid (no automatic `"default"`). Each namespace gets its own fully-nested directory tree.
- **[def:envPrefix]** — the env var name prefix. Inferred from the project name by convention
  (`"agent-mcp"` → `ADHD_AGENT_MCP`, uppercase, dots/dashes → `_`). Overridable with
  `envPrefixOverride` in the YAML. The namespace is NOT folded into the prefix.
  (agent-mcp sets `envPrefixOverride: ADHD_AGENT` to preserve its deployed `ADHD_AGENT_*` names.)
- **[def:inferEnvVar]** — `inferEnvVar(prefix, fieldPath)` → `prefix + "_" + fieldPath.toUpperCase().replace(/[.-]/g,"_")`.
  e.g. `inferEnvVar("ADHD_AGENT_MCP", "db.path")` → `ADHD_AGENT_MCP_DB_PATH`. A field's `env:` override
  replaces the inferred name (used when a legacy name doesn't follow the convention).
- **[def:scope-cascade]** — three-tier field resolution: `system → global → project`, with field-level
  inheritance. `project` overrides `global`, `global` overrides `system`. `mergeFieldDefinitions` applies it.
- **[def:effectiveEnv]** — the value resolution order for a config field at build time:
  `env var (inferred or override) → adhd-env set-store value → field default`, then single-level
  `${VAR}` interpolation (unresolved vars kept literal). Resolution happens once, at build; the runtime
  client only reads the resolved snapshot.
- **[def:EnvironmentSnapshot]** — builder-side instance from `build(ProjectConfig | EnvironmentSnapshot)`.
  Methods: `.set(path, value)`, `.get(path)`, `.configPath`, `.write()` (atomic).
- **[def:Environment]** — runtime client. `new Environment<T>({ project, namespace?, scope?, adhdRoot? })`.
  Reads a snapshot; exposes typed `env.get("config.*"|"path.*"|"env.*"|"provenance.*")`, bracket access,
  `env.hash`, `env.version`. No builder logic, no `.env`, no validation, no disk writes.
- **[def:contentHash]** — `sha256-` hash of sorted `key=value\n` lines. Cross-language gate:
  `contentHash({ b: "2", a: "1" })` === `"sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930"`
  in TS, Python, and Rust.
- **[def:structureHash]** — hash of logical structure (`type:name:scope`), not absolute paths.

## Cross-cutting invariants

- **[inv:thin-runtime]** — runtime clients (node/py/rs) are thin (~40-60 lines): read snapshot, expose
  typed `get()`. No builder logic in any language.
- **[inv:no-dotenv]** — no `.env` file loading anywhere. Config values are supplied via env vars or
  `adhd-env set` (set-store). Zod is fully removed.
- **[inv:cli-sole-writer]** — the CLI is the sole interface for `set` and `build`.
- **[inv:atomic-write]** — snapshots are written atomically (`.tmp` + `renameSync`).
- **[inv:package-identity]** — the TS runtime client publishes as **`@adhd/environment`** (not
  `@adhd/environment-core-node`); the `tsconfig.base.json` alias and `package.json` `name` must agree.
- **[inv:legacy-env-names]** — the agent-mcp refactor MUST preserve every deployed `ADHD_AGENT_*` env
  var name (CURRENT_CONFIG_PATTERNS.md §agent-mcp is authoritative — **26** unique vars), via
  `envPrefixOverride: ADHD_AGENT` plus per-field `env:` overrides.

## Operational notes

- **[op:nx-graph-reset]** — if any nx command (`nx show` / `nx build` / `nx test` / `nx run-many`) fails
  workspace-wide with **"Failed to process project graph"** (e.g. a stale daemon holding a phantom
  project such as `packages/environment/environment-core-builder`), run `npx nx reset` to clear the
  daemon + cached graph, then retry the command before diagnosing anything else. This applies to every
  nx-guarded state (scaffold-workspace, contract, builder, runtime-core-node/cli, refactor, audit).
