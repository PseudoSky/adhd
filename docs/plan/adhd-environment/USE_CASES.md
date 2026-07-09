# USE_CASES — adhd-environment v0.0.5

> Derived from `SCOPE.md` (2026-07-08). Each use case is a concrete scenario with real inputs and observable expected outcomes.

---

## Happy Paths — Configuration Authoring

### UC-01: Generate starter YAML config

**Scenario:** Samira starts a new agent-mcp project. She runs `adhd-env init --generate-config` to get a starter file.

**Input:**
```bash
adhd-env init --generate-config
```

**Expected output:**
- `adhd.environment.yaml` written to CWD
- Contains `project.orgNamespace: adhd`, `project.name` (from CWD), no `envPrefixOverride`
- Contains placeholder `namespaces`, `dirs`, and `config` sections
- Exits 0

---

### UC-02: Build snapshot from YAML (first time, no namespace)

**Scenario:** Samira edits the YAML with her project's fields and directories, then runs `adhd-env build` without a namespace.

**Input:**
```bash
adhd-env build
```

**Expected output:**
- Reads `adhd.environment.yaml` from CWD
- Resolves `orgNamespace: adhd`, project name `agent-mcp`
- Infers `envPrefix` from project name: `ADHD_AGENT_MCP`
- Merges system → global → project field definitions
- Resolves config values from `adhd-env set` store (no `.env` file)
- Generates `fieldSchema`
- Validates resolved config
- Computes `contentHash` and `structureHash`
- Creates all declared directories
- Writes `~/.adhd/agent-mcp/default/adhd-environment.json` atomically (namespace defaults to `"default"`)
- Exits 0

---

### UC-03: Build for a specific namespace

**Scenario:** Samira builds separate snapshots for production and staging.

**Input:**
```bash
adhd-env build --namespace production
adhd-env build --namespace staging
```

**Expected output:**
- `~/.adhd/agent-mcp/production/adhd-environment.json` exists (fully nested)
- `~/.adhd/agent-mcp/staging/adhd-environment.json` exists
- Each namespace has its own complete directory tree under `<org>/<project>/<namespace>/`
- Each has independent `configHash`

---

### UC-04: Build for a specific scope only

**Scenario:** Samira only wants to resolve project-scoped values, ignoring system/global fallbacks.

**Input:**
```bash
adhd-env build --scope project
```

**Expected output:**
- Snapshot contains only project-scoped fields
- `fieldSchema` contains only project-scoped properties
- `provenance` entries all have `scope: "project"`
- System and global fields are absent from `config` section

---

## Happy Paths — CLI Set & Build

### UC-04b: Set a config value via CLI (replaces .env)

**Scenario:** Samira sets the OpenAI API key using the CLI, no `.env` file needed.

**Input:**
```bash
adhd-env set providers.openai.secret sk-test-openai-key --namespace production
adhd-env set providers.anthropic.secret sk-test-anthropic-key --namespace production
```

**Expected output:**
- Secret stored in builder's internal store
- No `.env` file created
- Next `adhd-env build --namespace production` resolves `providers.openai.secret` from stored value

---

## Happy Paths — Runtime Client

### UC-05: Read resolved config values at runtime

**Scenario:** Samira imports `Environment` in her agent-mcp code and accesses resolved config.

**Input:**
```ts
import { Environment } from "@adhd/environment";

type AgentMcpConfig = {
  config: {
    db: { path: string };
    server: { port: number };
    log: { level: string };
    providers: {
      openai: { model: string; secret: string };
      anthropic: { model: string; secret: string };
    };
  };
};

const env = new Environment<AgentMcpConfig>({
  project: "agent-mcp",
  namespace: "production"
});

const dbPath: string = env.get("config.db.path");
const port: number = env.get("config.server.port");
const logLevel: string = env.get("config.log.level");
```

**Expected output:**
- `dbPath` resolves to path from snapshot with `${HOME}` expanded
- `port` === `3000` (integer-typed)
- `logLevel` === `"info"`

---

### UC-06: Look up directory paths

**Scenario:** Samira accesses registered directories by type and name.

**Input:**
```ts
const env = new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" });
const primaryDir = env.get("path.state.data");           // by type (first match)
const registryDir = env.get("path.state.data.registry"); // by type + name
const logDir = env.get("path.runtime.log");              // by type only
```

**Expected output:**
- `primaryDir` → `~/.adhd/agent-mcp/production/data/primary/`
- `registryDir` → `~/.adhd/agent-mcp/production/data/registry/`
- `logDir` → `~/.adhd/agent-mcp/production/log/`
- All paths include `adhd/` (orgNamespace) in the directory hierarchy

---

### UC-07: Read env vars from snapshot

**Scenario:** Samira reads the env var values recorded in the snapshot.

**Input:**
```ts
const env = new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" });
const openaiKey = env.get("env.OPENAI_API_KEY");
```

**Expected output:**
- `openaiKey` returns the value stored via `adhd-env set` at build time
- Returns `undefined` if the env var was not set

---

### UC-08: Access provenance

**Scenario:** Samira traces where each config value came from.

**Input:**
```ts
const env = new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" });
const prov = env.get("provenance.db.path");
```

**Expected output:**
- `prov` → `{ source: "project.default", scope: "project" }`
- For values set via `adhd-env set`: `{ source: "project.env", scope: "project", env: "OPENAI_API_KEY" }`

---

### UC-09: Access metadata

**Scenario:** Samira reads hash, version, project info from the runtime client.

**Input:**
```ts
const env = new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" });
console.log(env.hash);
console.log(env.prefix);
console.log(env.namespace);
```

**Expected output:**
- `env.hash` → `"sha256-<64 hex chars>"`
- `env.prefix` → `"ADHD_AGENT_MCP_PRODUCTION_"` (includes namespace suffix)
- `env.namespace` → `"production"`

---

### UC-10: Bracket access shorthand

**Scenario:** Samira uses bracket notation as a shortcut.

**Input:**
```ts
const env = new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" });
const port = env["config.server.port"];
const same = env["config.server.port"] === env.get("config.server.port");
```

**Expected output:**
- `port` === `3000`
- `same` === `true`

---

## Happy Paths — Env Var Inference

### UC-11: Infer env var name from field path

**Scenario:** The builder infers env var names from the field definition when `env` is not explicitly set.

**Input:**
```ts
inferEnvVar("ADHD_AGENT_MCP", "db.path")
```

**Expected output:**
- `"ADHD_AGENT_MCP_DB_PATH"`

---

### UC-12: Env var override in field definition

**Scenario:** A field has an explicit `env` override that replaces the inferred name.

**Input:**
```yaml
providers.openai.secret:
  default: ""
  type: string
  env: OPENAI_API_KEY   # override: never check ADHD_AGENT_MCP_PROVIDERS_OPENAI_SECRET
```

**Expected output:**
- Effective env var name is `OPENAI_API_KEY`
- Inferred name `ADHD_AGENT_MCP_PROVIDERS_OPENAI_SECRET` is never checked

---

### UC-13: Custom orgNamespace

**Scenario:** A project sets a custom `orgNamespace` and the directory structure and env prefix reflect it.

**Input:**
```yaml
project:
  name: my-tool
  orgNamespace: acmecorp
```
```bash
adhd-env build --namespace production
```

**Expected output:**
- Snapshot at `~/.acmecorp/my-tool/production/adhd-environment.json`
- Default env prefix: `ADHD_MY_TOOL`
- Env prefix for namespace: `ADHD_MY_TOOL_PRODUCTION_`

---

## Happy Paths — Builder EnvironmentSnapshot

### UC-14: Build returns an EnvironmentSnapshot instance

**Scenario:** The builder's `build()` function returns an `EnvironmentSnapshot` instance with instance methods.

**Input:**
```ts
import { build, EnvironmentSnapshot } from '@adhd/environment-builder';
import { parseYamlSpec } from '@adhd/environment-builder';

const spec = parseYamlSpec("./adhd.environment.yaml");
const snap: EnvironmentSnapshot<{ data: { db: { path: string } } }> = build(spec);
console.log(snap.get("db.path"));
```

**Expected output:**
- `snap` is an `EnvironmentSnapshot` instance
- `snap.get("db.path")` returns the resolved db path
- `snap.configPath` returns the full path to where the snapshot will be written

---

### UC-15: Set value on EnvironmentSnapshot and write

**Scenario:** Samira sets a value on the snapshot instance and persists it.

**Input:**
```ts
const snap = build(spec);
snap.set("providers.openai.secret", "sk-new-key");
snap.write();
```

**Expected output:**
- `snap.get("providers.openai.secret")` returns `"sk-new-key"`
- `snap.write()` atomically writes the snapshot to `snap.configPath`
- After write, reading the snapshot file shows the updated value

---

### UC-16: Rebuild from existing EnvironmentSnapshot

**Scenario:** Samira rebuilds from an existing snapshot to incorporate YAML changes while preserving set values.

**Input:**
```ts
const existing = build(spec, { namespace: "production" });
existing.set("server.port", "4000");
existing.write();

// Later: YAML changes, rebuild from snapshot
const updated = build(existing);  // reads snapshot, merges YAML changes, preserves overrides
```

**Expected output:**
- `build(existing)` reads both the YAML and the existing snapshot
- YAML changes (new fields, updated defaults) are applied
- Previously-set values (like `server.port: 4000`) are preserved
- Returns a new `EnvironmentSnapshot` instance with merged state

---

## Happy Paths — Scope Cascade

### UC-17: Three-tier scope merge

**Scenario:** The builder merges system → global → project field definitions correctly.

**Input:**
```ts
const system = { "log.level": { default: "info", type: "string", scope: "system" } };
const global = { "server.port": { default: "8080", type: "integer", scope: "global", minimum: 1024 } };
const project = { "server.port": { default: "3000", type: "integer", scope: "project" } };
const merged = mergeFieldDefinitions(system, global, project);
```

**Expected output:**
- `merged["server.port"]` has `default: "3000"` (project wins)
- Inherits `minimum: 1024` from global scope
- `merged["log.level"]` has `default: "info"` (system, no override)

---

## Edge Cases — Error Handling

### UC-18: Snapshot not found

**Scenario:** A runtime client tries to read a snapshot that doesn't exist.

**Input:**
```ts
const env = new Environment({ project: "nonexistent", namespace: "production" });
```

**Expected output:**
- Throws `"Snapshot not found: ~/.adhd/nonexistent/production/adhd-environment.json. Run 'adhd-env build' first."`
- Error message includes the file path and the guidance message

---

### UC-19: Rejected config validation

**Scenario:** The builder rejects a config that fails fieldSchema validation.

**Input:**
```yaml
config:
  project:
    server.port:
      default: "50"
      type: integer
      minimum: 1024
```

**Expected output:**
- `adhd-env build` exits non-zero
- Error message: `"server.port: must be >= 1024 (got 50)"`
- No snapshot is written

---

### UC-20: Malformed YAML

**Scenario:** The YAML file has a syntax error.

**Input:**
```bash
echo "project: { bad yaml" > bad.yaml
adhd-env build --config bad.yaml
```

**Expected output:**
- Error message includes file path and line number
- Exits non-zero

---

### UC-21: Scope filtering hides out-of-scope values

**Scenario:** A runtime client constructed with `scope: "system"` cannot access project-scoped values.

**Input:**
```ts
const env = new Environment<AgentMcpConfig>({
  project: "agent-mcp",
  scope: "system",
  namespace: "production"
});
const logLevel = env.get("config.log.level");    // system-scoped
const dbPath = env.get("config.db.path");         // project-scoped
```

**Expected output:**
- `logLevel` → `"info"`
- `dbPath` → `undefined` (filtered out by scope)

---

### UC-22: Two namespaces, independent snapshots

**Scenario:** Production and staging namespaces produce independent snapshots with different env prefixes.

**Input:**
```ts
const prod = new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" });
const staging = new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "staging" });
```

**Expected output:**
- `prod.prefix` → `"ADHD_AGENT_MCP_PRODUCTION_"`
- `staging.prefix` → `"ADHD_AGENT_MCP_STAGING_"`
- Each reads from `~/.adhd/agent-mcp/<namespace>/adhd-environment.json`

---

### UC-23: No namespace in YAML → defaults to "default"

**Scenario:** When `namespaces` is not listed in `adhd.environment.yaml`, the namespace defaults to `"default"`.

**Input:**
```yaml
# adhd.environment.yaml (no namespaces section)
project:
  name: agent-mcp
  orgNamespace: adhd
```
```bash
adhd-env build
```

**Expected output:**
- Snapshot at `~/.adhd/agent-mcp/default/adhd-environment.json`
- Path structure: `<org>/<project>/<namespace>/` always (namespace defaults to `"default"`)

---

## Happy Paths — Agent-MCP Refactor

### UC-24: Replace config.ts with typed Environment

**Scenario:** Samira replaces the 299-line `config.ts` with a typed `Environment` constructor.

**Input:**
```ts
// Replaces entrypoint/agent-mcp/src/config.ts
import { Environment } from "@adhd/environment";

const env = new Environment<AgentMcpConfig>({
  project: "agent-mcp",
  namespace: "production"
});

// Previously: config.db.path from rawFromEnv()
const dbPath = env.get("config.db.path");
const serverPort = env.get("config.server.port");
const logLevel = env.get("config.log.level");
```

**Expected output:**
- 30 lines instead of 299
- No Zod import, no dotenv, no deepFreeze
- `env.get("config.server.port")` returns `number` (TypeScript type)

---

### UC-25: Provider credential resolution preserved

**Scenario:** `getProviderConfig()` still works after refactor.

**Input:**
```ts
function getProviderConfig(provider: string) {
  const model = env.get("config.providers." + provider + ".model");
  const secret = env.get("env.OPENAI_API_KEY");  // for openai
  return { model, secret };
}
```

**Expected output:**
- Returns same shape as the old frozen `Config` object
- Model from `env.get("config.providers.*.model")`
- Secret from `env.get("env.*")`

---

### UC-26: env.prefix replaces hardcoded prefix

**Scenario:** The security guard `isEnvNameAllowed()` uses the namespace-aware prefix.

**Input:**
```ts
function isEnvNameAllowed(name: string): boolean {
  return name.startsWith(env.prefix);
}
```

**Expected output:**
- For `production` namespace: checks against `"ADHD_AGENT_MCP_PRODUCTION_"`
- For `staging` namespace: checks against `"ADHD_AGENT_MCP_STAGING_"`
- No hardcoded `"ADHD_AGENT_"` prefix

---

### UC-27: All 26 env vars mappable to env.get()

**Scenario:** Every env var from the old `rawFromEnv()` is accessible via `env.get("env.*")`.

**Input:**
```ts
const openaiKey = env.get("env.OPENAI_API_KEY");
const anthropicKey = env.get("env.ANTHROPIC_API_KEY");
// ... all 26 old env vars
```

**Expected output:**
- Every env var used by agent-mcp is recorded in the snapshot's `envVars` section
- Accessible via `env.get("env.<NAME>")` at runtime

---

## Edge Cases — Namespace Directory Isolation

### UC-28: Namespace directories are fully independent

**Scenario:** Production and staging namespaces each get their own complete directory tree.

**Input:**
```bash
adhd-env build --namespace production
adhd-env build --namespace staging
ls ~/.adhd/agent-mcp/production/
ls ~/.adhd/agent-mcp/staging/
```

**Expected output:**
- `~/.adhd/agent-mcp/production/` contains `data/`, `log/`, `adhd-environment.json`
- `~/.adhd/agent-mcp/staging/` contains the same structure independently
- Directories under each namespace are fully isolated

---

### UC-29: orgNamespace in directory path

**Scenario:** The orgNamespace is reflected in the directory hierarchy.

**Input:**
```bash
adhd-env build --namespace production
```

**Expected output:**
- Snapshot path: `~/.adhd/agent-mcp/production/adhd-environment.json`
- Data directories: `~/.adhd/agent-mcp/production/data/primary/`
- The `adhd/` in the path is the `orgNamespace` from the YAML config

---

## Edge Cases — Builder Instance API

### UC-30: set() validates against fieldSchema

**Scenario:** Setting an invalid value via `EnvironmentSnapshot.set()` fails validation.

**Input:**
```ts
const snap = build(spec);
snap.set("server.port", "50");  // Must be >= 1024 per field definition
snap.write();
```

**Expected output:**
- `snap.set("server.port", "50")` succeeds in memory
- `snap.write()` validates and throws: `"server.port: must be >= 1024 (got 50)"`
- Snapshot file is not written (partial write prevented)

---

### UC-31: configPath reflects org namespace and namespace

**Scenario:** `configPath` returns the correct path based on org, project, and namespace.

**Input:**
```ts
const snap = build(spec, { namespace: "production" });
console.log(snap.configPath);
```

**Expected output:**
- Without namespace override: `~/.adhd/agent-mcp/production/adhd-environment.json`
- `configPath` always includes `orgNamespace`, `project`, and `namespace` segments
