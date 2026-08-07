# @adhd/environment — Implementation Spec v0.0.5

> **Status: Current.** Supersedes [SPEC_0.0.4.md](./SPEC_0.0.4.md) on 2026-07-08. This revision introduces fully-nested namespace directory trees, removes the "default" namespace, replaces `.env` file workflow with CLI `adhd-env set`, renames `envPrefix` to `envPrefixOverride` (inferred from project name when absent), adds `orgNamespace` to project config, switches `Environment` constructor to params object, adds TypeScript generics for typed access, and specifies the builder `EnvironmentSnapshot` API with `.set()`/`.get()`/`.configPath()`/`.write()`.

## Revision History

| Revision | Date | Key Changes |
|---|---|---|
| 0.0.0–0.0.4 | 2026-07-06 | See SPEC_0.0.4.md for full history |
| **0.0.5** | **2026-07-08** | **See below** |

---

## Design Changes from v0.0.4

### Change 1: Directory structure — org namespace + fully-nested namespaces

The snapshot directory structure is now `~/.<orgNamespace>/<projectName>/[namespace]/adhd-environment.json`.

- `orgNamespace` is a new field in the YAML `project` section, defaulting to `"adhd"`
- Namespaces create **fully-nested directory trees**: `~/.adhd/agent-mcp/production/data/primary/` (org=`adhd`)
- **Namespace defaults to `"default"`** — when `namespaces` is not listed in the YAML, the namespace defaults to `"default"`. The path always includes a namespace level: `~/.adhd/agent-mcp/default/adhd-environment.json`. When `namespaces` IS listed (e.g. `[production, staging]`), only those namespaces are valid — no automatic `"default"` is added.

This provides strong multi-tenant isolation: two orgs with the same project name never collide on disk.

### Change 2: envPrefixOverride (optional) replaces envPrefix

The YAML field `envPrefix` is renamed to `envPrefixOverride`. When absent, the env prefix is **inferred from the project name**:

- Project name `agent-mcp` → inferred prefix `ADHD_AGENT_MCP`
- Project name `decompile-cli` → inferred prefix `ADHD_DECOMPILE_CLI`
- Explicit `envPrefixOverride: CUSTOM_PREFIX` → `CUSTOM_PREFIX` (replaces inference entirely)

The inference algorithm (`projectEnvPrefix()`) uppercases the project name and replaces `-` with `_`. No manual `envPrefix` declaration is needed for the common case.

### Change 3: No `.env` file — CLI `adhd-env set`

The `.env` file-based workflow is **removed**. Environment variables and secrets are set via the CLI:

```bash
adhd-env set providers.openai.secret sk-test-openai-key --namespace production
adhd-env set providers.anthropic.secret sk-test-anthropic-key --namespace production
```

Values are stored in the builder's internal store (language-agnostic, implementation detail). At build time, the builder resolves field values from:
1. `process.env[effectiveEnvVar]` (for actually-set env vars at build time)
2. Stored values from `adhd-env set`
3. Field `default`
4. Interpolation + type coercion

The `.env` parser (C2 from TOOLS.md) is deprecated but may remain in the codebase for backward compatibility — it is **not** part of the v0.0.5 workflow.

### Change 4: Environment constructor takes params object

The runtime client constructor switches from positional parameters to a named params object:

```typescript
// v0.0.4 (positional)
new Environment("agent-mcp", undefined, "production", ADHD_HOME)

// v0.0.5 (params object)
new Environment({ project: "agent-mcp", namespace: "production", adhdRoot: ADHD_HOME })
```

Params object:
```
{
  project: string;           // Required. Project name (kebab-case).
  scope?: ConfigScope;       // Optional. "system" | "global" | "project".
  namespace?: string;        // Optional. When absent, reads snapshot from <org>/<project>/ (no namespace level).
  adhdRoot?: string;         // Optional. Default: os.homedir()/.adhd
}
```

### Change 5: Typed Environment via generics

The `Environment` class accepts a generic type parameter for type-safe `get()` access:

```typescript
// Field names below are agent-mcp's REAL config fields (CURRENT_CONFIG_PATTERNS.md,
// authoritative). Note: the numeric port field is `transport.port` — there is no `server.port`.
interface AgentMcpConfig {
  config: {
    transport: { port: number };
    db: { path: string };
    logging: { level: string };
  };
}

const env = new Environment<AgentMcpConfig>({
  project: "agent-mcp",
  namespace: "production"
});

const port: number = env.get("config.transport.port");  // typed as number
const path: string = env.get("config.db.path");         // typed as string
```

The generic type parameter maps field paths to their TypeScript types. When no generic is provided, `env.get()` returns `unknown` (caller must cast).

### Change 6: Builder `EnvironmentSnapshot` class

The builder exports a factory function and an instance class:

```typescript
// Factory: build(spec, options?) → EnvironmentSnapshot<T>
import { build, parseYamlSpec } from '@adhd/environment-builder';

const spec = parseYamlSpec("./adhd.environment.yaml");
const snap = build(spec, { namespace: "production" });

// Instance methods:
snap.get("transport.port");         // → any (typed via generic)
snap.set("transport.port", "4000"); // mutate in memory
snap.configPath;                  // → resolved output path
snap.write();                     // validate + atomic write
snap.write({ skipValidation: true }); // force write

// Rebuild from existing snapshot (preserves set values):
const snap2 = build(snap, { namespace: "production" });
```

The `build()` function accepts either a `ParsedYamlSpec` (from YAML) or an existing `EnvironmentSnapshot` (to rebuild with YAML changes while preserving overrides from `set()`).

---

## Summary of v0.0.5 Changes

| Area | v0.0.4 | v0.0.5 |
|---|---|---|
| Directory structure | `~/.adhd/<project>/[namespace]/` | `~/.<orgNamespace>/<project>/<namespace>/` — always includes namespace (defaults to `"default"`) |
| Org namespace | Not present | Defaults to `"adhd"`, configurable in YAML |
| Default namespace | "default" when namespace absent | When `namespaces` absent → defaults to `"default"`. When listed, only those namespaces are valid. |
| Namespace directories | Flat per namespace | Fully-nested directory tree per namespace |
| Env prefix config | `envPrefix` (required) | `envPrefixOverride` (optional, inferred from project name) |
| `.env` file | Required for secrets | **Removed** — use `adhd-env set` |
| CLI set command | Not present (`.env` only) | `adhd-env set <field> <value> [--namespace]` |
| Environment constructor | Positional args | Params object `{ project, scope?, namespace?, adhdRoot? }` |
| Environment type safety | `get()` returns `unknown` | Generic `Environment<T>` — `get()` returns typed values |
| Builder class | `buildSnapshot()` returns raw snapshot object | `build()` returns `EnvironmentSnapshot` instance with `.set()`, `.get()`, `.configPath`, `.write()` |
| Rebuild from snapshot | Not supported | `build(EnvironmentSnapshot)` rebuilds preserving set values |
