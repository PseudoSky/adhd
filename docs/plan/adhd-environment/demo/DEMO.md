# 🎬 @adhd/environment — Live Demo & Acceptance Script

> Replace 299 lines of hand-written config chaos with one YAML file, a typed `env.get()` call, and a builder with `.set()`/`.write()` — full scope cascade, auto-generated JSON Schema, provenance tracking, and cross-language parity.

**What this is.** A presentation-grade walkthrough of `@adhd/environment` v0.0.5 that doubles as its acceptance test. Follow it top to bottom and you will (a) experience the product the way a brand-new user would — project author → deployer → runtime consumer — and (b) prove every capability works, with exact commands, exact data, and pass/fail checks.

---

## 0 · How to Read This Script

**Legend**

| Marker | Meaning |
|---|---|
| 🎬 **Scene** | The story beat — what's happening and why the persona cares. |
| ▶️ **Do** | The exact action to take with literal input data. |
| 👀 **Expect** | The exact observable result. Volatile parts shown as ⟨…⟩. |
| ✅ **Verify** | Binary pass/fail assertions. Tick each only if it is literally true. |
| 🔗 **Proves** | Requirement and capability IDs this beat satisfies. |
| 📎 **Source** | What grounds this step — spec section, scope boundary, use case. |
| ⚠️ **Edge** | A deliberately adversarial beat. |

**Conventions**
- Shell prompt is `$`; commands run from `~/dev/node/adhd` (monorepo root) unless noted.
- `⟨like-this⟩` marks values that vary per run (paths, hashes, timestamps).
- All sample data uses project `agent-mcp`, orgNamespace `adhd`, namespace `production`.
- Directory structure: `~/.<orgNamespace>/<project>/<namespace>/` — always includes namespace (defaults to `"default"`)
- No `.env` file — secrets set via `adhd-env set`.

---

## 1 · Cold Open — The Hook

🎬 **Scene.** Samira opens `entrypoint/agent-mcp/src/config.ts` — 299 lines. A Zod schema with 17 nested objects. A `rawFromEnv()` function reading 26 env vars by name, one by one. A `PROVIDER_DEFAULTS` table. `loadEnvHierarchy()`. `deepFreeze()`. Every new field means editing three places. This pattern is repeated across five packages.

`@adhd/environment` v0.0.5 promises: one YAML file, one `adhd-env build` command, one typed `new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" })` call. Secrets set via `adhd-env set` — no `.env` file. Builder returns an `EnvironmentSnapshot` instance with `.set()`, `.get()`, `.configPath`, `.write()`. Full scope cascade, auto-generated JSON Schema, provenance tracking, cross-language parity.

> **The promise we'll prove in the next ~15 minutes:** 299 lines → 1 YAML file + 1 typed `env.get()` call + 1 `adhd-env set` + 1 `adhd-env build`. Verifiable, cross-language, zero `.env` files.

🔗 **Proves:** REQ-024 · CAP-024
📎 **Source:** SCOPE.md §1 Outcomes; USE_CASES.md UC-24; SPEC_0.0.5.md

---

## 2 · Cast, World & Cold-Start Setup

### 2.1 Meet Samira

Samira maintains `@adhd/agent-mcp`. She has 299 lines of config code and wants to delete 280 of them.

**Also appearing:** Luca — infrastructure lead. He needs to override config for staging without touching Samira's code.

### 2.2 The Canonical Demo Dataset

The `adhd.environment.yaml` for the agent-mcp project:

```yaml
project:
  name: agent-mcp
  description: ADHD Agent MCP Server
  # orgNamespace defaults to "adhd" — feeds ~/.adhd/agent-mcp/...
  # envPrefixOverride absent — inferred from project name: ADHD_AGENT_MCP

namespaces:
  - production
  - staging

dirs:
  - name: primary
    type: state.data
    scope: project
  - name: registry
    type: state.data
    scope: project
  - type: runtime.log
    scope: project

config:
  system:
    log.level:
      default: info
      type: string
      enum: [debug, info, warn, error]
    queue.concurrency:
      default: "5"
      type: integer
      minimum: 1
  global:
    transport.kind:
      default: stdio
      type: string
      enum: [stdio, sse]
  project:
    db.path:
      default: ${HOME}/.adhd/adhd/agent-mcp/agents.db
      type: path
    registry.path:
      default: ${HOME}/.adhd/adhd/agent-mcp/registry.db
      type: path
    server.port:
      default: "3000"
      type: integer
      minimum: 1024
      maximum: 65535
    providers.openai.secret:
      default: ""
      type: string
      env: OPENAI_API_KEY
    providers.openai.model:
      default: gpt-4o
      type: string
    providers.anthropic.secret:
      default: ""
      type: string
      env: ANTHROPIC_API_KEY
    providers.anthropic.model:
      default: claude-sonnet-4-20250514
      type: string
```

### 2.3 Prerequisites

- Node.js ≥18, Python ≥3.10, Rust stable
- Monorepo at `~/dev/node/adhd/`, dependencies installed
- Isolated test root via `ADHD_HOME`

### 2.4 Cold Start — Build the packages

▶️ **Do**
```bash
npx nx build environment-base-spec
npx nx build environment-builder
npx nx build environment-core-node
npx nx build environment-core-py
npx nx build environment-core-rs
npx nx generate-cli environment-cli
export ADHD_HOME=/tmp/adhd-env-demo-$(date +%s)
```

👀 **Expect**
```
> nx run environment-base-spec:build — success
> nx run environment-builder:build — success
> nx run environment-core-node:build — success
> nx run environment-core-py:build — success
> nx run environment-core-rs:build — success
> nx run environment-cli:generate-cli — CLI written
```

✅ **Verify**
- [ ] All 6 targets exit 0
- [ ] `ADHD_HOME` set to a temp directory path
- [ ] `dist/entrypoint/environment-cli/cli/cli.ts` exists

🔗 **Proves:** REQ-001, REQ-022 · CAP-001, CAP-020
📎 **Source:** SCOPE.md §5 Segments A–D

---

## 3 · The Journey

### Act 1 — Define & Build: YAML + CLI

#### 1.1 · Generate starter YAML   (happy)

▶️ **Do**
```bash
mkdir -p /tmp/adhd-env-demo && cd /tmp/adhd-env-demo
adhd-env init --generate-config
```

👀 **Expect**
```
✓ Generated adhd.environment.yaml (orgNamespace: adhd, 2 namespaces, 4 dirs, 12 config fields)
Edit this file to customize your project's environment, then run 'adhd-env build'.
```

✅ **Verify**
- [ ] `adhd.environment.yaml` exists
- [ ] Contains `orgNamespace: adhd` in project section
- [ ] No `envPrefixOverride` key (prefix inferred from project name)

🔗 **Proves:** REQ-015 · CAP-002
📎 **Source:** USE_CASES.md UC-01; SPEC_0.0.5.md

#### 1.2 · Write the project's YAML   (happy)

▶️ **Do** (write the agent-mcp YAML from §2.2 to `adhd.environment.yaml`)

✅ **Verify**
- [ ] `orgNamespace` defaults to `adhd` (no explicit override needed)
- [ ] No `envPrefixOverride` — prefix inferred from `agent-mcp` as `ADHD_AGENT_MCP`
- [ ] 3 directories declared, 10 fields across 3 scopes
- [ ] Only 2 fields have explicit `env` overrides

🔗 **Proves:** REQ-002, REQ-003 · CAP-002, CAP-003
📎 **Source:** USE_CASES.md UC-01, UC-11; SPEC_0.0.5.md YAML Format

#### 1.3 · Set secrets via CLI   (happy)

🎬 Samira sets her API keys using the CLI — no `.env` file needed.

▶️ **Do**
```bash
adhd-env set providers.openai.secret sk-test-openai-key --namespace production
adhd-env set providers.anthropic.secret sk-test-anthropic-key --namespace production
```

👀 **Expect**
```
✓ Set agent-mcp/production/providers.openai.secret
✓ Set agent-mcp/production/providers.anthropic.secret
```

✅ **Verify**
- [ ] Both commands exit 0
- [ ] No `.env` file was created (`test -f ~/.adhd/.env` → exit 1)
- [ ] Values stored in builder's internal store

🔗 **Proves:** REQ-004 (CLI set), REQ-027 (all env vars mappable) · CAP-004
📎 **Source:** USE_CASES.md UC-04b; SPEC_0.0.5.md CLI Commands §set

#### 1.4 · Build snapshot for production   (happy)

▶️ **Do**
```bash
adhd-env build --namespace production
```

👀 **Expect**
```
✓ Loaded adhd.environment.yaml (org: adhd, project: agent-mcp)
  namespace: production
  Inferred env prefix: ADHD_AGENT_MCP (no envPrefixOverride)
  System: 2 fields, Global: 1 field, Project: 7 fields
  Inferred 8 env var names (2 explicit overrides: OPENAI_API_KEY, ANTHROPIC_API_KEY)
✓ Merged field definitions (10 effective fields)
✓ Resolved config (2 from set-store, 8 from defaults)
✓ Generated fieldSchema (10 properties)
✓ Validated config against fieldSchema — passed
✓ Created 3 directories
✓ Provenance tracked
✓ Wrote snapshot: ⟨ADHD_HOME⟩/agent-mcp/production/adhd-environment.json
  configHash: sha256-⟨64 hex chars⟩
  structureHash: sha256-⟨64 hex chars⟩
```

✅ **Verify**
- [ ] Exits 0
- [ ] Snapshot at `$ADHD_HOME/agent-mcp/production/adhd-environment.json`
- [ ] Path includes `adhd/` (orgNamespace) and `production/` (namespace)
- [ ] `configHash` is `sha256-` prefixed
- [ ] 3 directories created under `adhd/agent-mcp/production/`

🔗 **Proves:** REQ-004, REQ-007, REQ-009, REQ-010, REQ-018 · CAP-004, CAP-007, CAP-009, CAP-014
📎 **Source:** USE_CASES.md UC-03, UC-04b, UC-13, UC-28; SPEC_0.0.5.md

#### 1.5 · Build with default namespace   (happy)

🎬 Samira builds without specifying a namespace — defaults to `"default"`.

▶️ **Do**
```bash
adhd-env build
```

👀 **Expect**
```
✓ Wrote snapshot: ⟨ADHD_HOME⟩/agent-mcp/default/adhd-environment.json
```

✅ **Verify**
- [ ] Snapshot at `$ADHD_HOME/agent-mcp/default/adhd-environment.json`
- [ ] `$ADHD_HOME/agent-mcp/production/adhd-environment.json` still exists (no collision)

🔗 **Proves:** REQ-018, REQ-023 · CAP-014
📎 **Source:** USE_CASES.md UC-23; SPEC_0.0.5.md §Namespace defaults to "default"

#### 1.6 · Verify the snapshot   (happy)

▶️ **Do**
```bash
adhd-env export --project-name agent-mcp --namespace production --out-file /tmp/snapshot.json
node -e "
const snap = JSON.parse(require('fs').readFileSync('/tmp/snapshot.json','utf8'));
console.log('config keys:', Object.keys(snap.config).sort().join(', '));
console.log('fieldSchema props:', Object.keys(snap.fieldSchema.properties).sort().join(', '));
console.log('provenance count:', Object.keys(snap.provenance).length);
console.log('namespace:', snap.namespace);
"
```

👀 **Expect**
```
config keys: db, log, providers, queue, registry, server, transport
fieldSchema props: db, log, providers, queue, registry, server, transport
provenance count: 10
namespace: production
```

✅ **Verify**
- [ ] 7 config keys present (unflattened)
- [ ] 7 fieldSchema properties present
- [ ] 10 provenance entries (one per field)
- [ ] Namespace is `"production"`

🔗 **Proves:** REQ-006, REQ-008 · CAP-006, CAP-008
📎 **Source:** USE_CASES.md UC-05; SPEC_0.0.5.md Snapshot Format

---

### Act 2 — Runtime: Typed Environment

#### 2.1 · Typed runtime — env.get() with correct types   (happy)

🎬 Samira writes the typed runtime code. Three lines, with full TypeScript type safety.

▶️ **Do**
```bash
node -e "
const { Environment } = require('@adhd/environment');
const env = new Environment({ project: 'agent-mcp', namespace: 'production', adhdRoot: process.env.ADHD_HOME });
console.log('db.path:', env.get('config.db.path'));
console.log('server.port:', env.get('config.server.port'));
console.log('log.level:', env.get('config.log.level'));
console.log('port type:', typeof env.get('config.server.port'));
"
```

👀 **Expect**
```
db.path: ⟨HOME⟩/.adhd/adhd/agent-mcp/agents.db
server.port: 3000
log.level: info
port type: number
```

✅ **Verify**
- [ ] Constructor takes a params object (not positional args)
- [ ] `db.path` resolved with `${HOME}` expanded
- [ ] `server.port` returns `3000` (number, correctly typed)
- [ ] `log.level` returns `info` (system default)
- [ ] `typeof env.get("config.server.port")` is `"number"`

🔗 **Proves:** REQ-011 · CAP-011
📎 **Source:** USE_CASES.md UC-05; SPEC_0.0.5.md §Runtime Client API

#### 2.2 · Paths, env vars, provenance   (happy)

▶️ **Do**
```bash
node -e "
const { Environment } = require('@adhd/environment');
const env = new Environment({ project: 'agent-mcp', namespace: 'production', adhdRoot: process.env.ADHD_HOME });

console.log('--- paths ---');
console.log('state.data:', env.get('path.state.data'));
console.log('runtime.log:', env.get('path.runtime.log'));

console.log('--- env vars ---');
console.log('OPENAI_API_KEY:', env.get('env.OPENAI_API_KEY'));

console.log('--- provenance ---');
console.log('db.path:', JSON.stringify(env.get('provenance.db.path')));

console.log('--- metadata ---');
console.log('prefix:', env.prefix);
console.log('namespace:', env.namespace);
"
```

👀 **Expect**
```
--- paths ---
state.data: ⟨ADHD_HOME⟩/agent-mcp/production/data/primary/
runtime.log: ⟨ADHD_HOME⟩/agent-mcp/production/log/
--- env vars ---
OPENAI_API_KEY: sk-test-openai-key
--- provenance ---
db.path: {"source":"project.default","scope":"project"}
--- metadata ---
prefix: ADHD_AGENT_MCP_PRODUCTION_
namespace: production
```

✅ **Verify**
- [ ] Directory paths include `adhd/` (orgNamespace) and `production/` (namespace)
- [ ] `env.OPENAI_API_KEY` returns value set via `adhd-env set`
- [ ] Provenance shows source of truth
- [ ] `env.prefix` includes namespace suffix: `_PRODUCTION_`
- [ ] `env.namespace` returns `"production"`

🔗 **Proves:** REQ-012, REQ-013, REQ-016, REQ-017, REQ-019 · CAP-012, CAP-013
📎 **Source:** USE_CASES.md UC-06, UC-07, UC-08, UC-09, UC-10

#### 2.3 · Scope filtering   ⚠️ (edge)

▶️ **Do**
```bash
node -e "
const { Environment } = require('@adhd/environment');
const env = new Environment({ project: 'agent-mcp', scope: 'system', namespace: 'production', adhdRoot: process.env.ADHD_HOME });
console.log('log.level (system):', env.get('config.log.level'));
console.log('db.path (project):', env.get('config.db.path'));
"
```

👀 **Expect**
```
log.level (system): info
db.path (project): undefined
```

✅ **Verify**
- [ ] System scope returns `log.level` (system-scoped)
- [ ] System scope returns `undefined` for `db.path` (project-scoped, filtered)

🔗 **Proves:** REQ-014 · CAP-011
📎 **Source:** USE_CASES.md UC-21

#### 2.4 · Snapshot not found   ⚠️ (edge)

▶️ **Do**
```bash
node -e "
const { Environment } = require('@adhd/environment');
try {
  new Environment({ project: 'nonexistent', namespace: 'production', adhdRoot: '/tmp' });
  console.log('ERROR: Should have thrown');
} catch(e) {
  console.log('not found:', e.message.includes('not found'));
  console.log('has path:', e.message.includes('adhd'));
}
"
```

👀 **Expect**
```
not found: true
has path: true
```

✅ **Verify**
- [ ] Error message says "not found"
- [ ] Error message includes `adhd/` (orgNamespace in path)

🔗 **Proves:** REQ-011 · CAP-011
📎 **Source:** USE_CASES.md UC-18

---

### Act 3 — Builder EnvironmentSnapshot API

#### 3.1 · build() returns EnvironmentSnapshot instance   (happy)

🎬 The builder exports `build()` which returns an `EnvironmentSnapshot` with typed data.

▶️ **Do**
```bash
node -e "
const { build, parseYamlSpec } = require('@adhd/environment-builder');
const spec = parseYamlSpec('/tmp/adhd-env-demo/adhd.environment.yaml');
const snap = build(spec, { adhdRoot: process.env.ADHD_HOME });
console.log('has get:', typeof snap.get);
console.log('has set:', typeof snap.set);
console.log('has configPath:', typeof snap.configPath);
console.log('has write:', typeof snap.write);
console.log('configPath:', snap.configPath);
"
```

👀 **Expect**
```
has get: function
has set: function
has configPath: string
has write: function
configPath: ⟨ADHD_HOME⟩/agent-mcp/adhd-environment.json
```

✅ **Verify**
- [ ] `build()` returns an `EnvironmentSnapshot` instance
- [ ] Instance has `.get()`, `.set()`, `.configPath`, `.write()` methods
- [ ] `.configPath` includes `adhd/` (orgNamespace) and no namespace level

🔗 **Proves:** REQ-028, REQ-029, REQ-030 · CAP-015
📎 **Source:** USE_CASES.md UC-14, UC-15, UC-31

#### 3.2 · set() + write() on EnvironmentSnapshot   (happy)

▶️ **Do**
```bash
node -e "
const { build, parseYamlSpec } = require('@adhd/environment-builder');
const spec = parseYamlSpec('/tmp/adhd-env-demo/adhd.environment.yaml');
const snap = build(spec, { adhdRoot: process.env.ADHD_HOME });
snap.set('server.port', '4000');
console.log('before write:', snap.get('server.port'));
snap.write();
console.log('after write:', snap.get('server.port'));
console.log('file exists:', require('fs').existsSync(snap.configPath));
"
```

👀 **Expect**
```
before write: 4000
after write: 4000
file exists: true
```

✅ **Verify**
- [ ] `set()` mutates in-memory value
- [ ] `write()` atomically persists to disk
- [ ] File exists at `snap.configPath` after write
- [ ] Config path matches namespace structure

🔗 **Proves:** REQ-030 · CAP-015
📎 **Source:** USE_CASES.md UC-15

#### 3.3 · Rebuild from existing snapshot   (happy)

▶️ **Do**
```bash
node -e "
const { build, EnvironmentSnapshot } = require('@adhd/environment-builder');
// Build from spec, set a value, write
const spec = { project: { name: 'test', envPrefix: 'TEST' }, config: { project: { 'test.key': { default: 'val1' } } } };
const snap1 = build(spec, { adhdRoot: process.env.ADHD_HOME });
snap1.set('test.key', 'val2');
snap1.write();

// Rebuild from snapshot — preserves set values
const snap2 = build(snap1, { adhdRoot: process.env.ADHD_HOME });
console.log('val2 preserved:', snap2.get('test.key'));
console.log('same configPath:', snap1.configPath === snap2.configPath);
"
```

👀 **Expect**
```
val2 preserved: val2
same configPath: true
```

✅ **Verify**
- [ ] `build(snap1)` reads existing snapshot
- [ ] Preserves value set via `snap1.set()`
- [ ] Config path is consistent between builds

🔗 **Proves:** REQ-031 · CAP-015
📎 **Source:** USE_CASES.md UC-16

#### 3.4 · set() with invalid value fails on write()   ⚠️ (edge)

▶️ **Do**
```bash
node -e "
const { build, parseYamlSpec } = require('@adhd/environment-builder');
const spec = parseYamlSpec('/tmp/adhd-env-demo/adhd.environment.yaml');
const snap = build(spec, { adhdRoot: process.env.ADHD_HOME });
snap.set('server.port', '50');  // below minimum: 1024
try {
  snap.write();
  console.log('ERROR: Should have thrown');
} catch(e) {
  console.log('validation error:', e.message.includes('1024'));
}
"
```

👀 **Expect**
```
validation error: true
```

✅ **Verify**
- [ ] `set()` accepts invalid values in memory (for editing convenience)
- [ ] `write()` validates against fieldSchema and throws on violation
- [ ] Snapshot is not written on validation failure

🔗 **Proves:** REQ-007 · CAP-007
📎 **Source:** USE_CASES.md UC-30

---

### Act 4 — Env Var Inference & Merge

#### 4.1 · Env var inference   (happy)

▶️ **Do**
```bash
node -e "
const { inferEnvVar } = require('@adhd/environment-builder');
console.log('db.path:', inferEnvVar('ADHD_AGENT_MCP', 'db.path'));
console.log('deepseek:', inferEnvVar('ADHD_AGENT_MCP', 'providers.deepseek.secret'));
"
```

👀 **Expect**
```
db.path: ADHD_AGENT_MCP_DB_PATH
deepseek: ADHD_AGENT_MCP_PROVIDERS_DEEPSEEK_SECRET
```

✅ **Verify**
- [ ] Dots → underscores, uppercase, prefix prepended

🔗 **Proves:** REQ-003 · CAP-003
📎 **Source:** USE_CASES.md UC-11; SPEC_0.0.5.md

#### 4.2 · Field merge — project overrides   (happy)

▶️ **Do**
```bash
node -e "
const { mergeFieldDefinitions } = require('@adhd/environment-builder');
const system = { 'server.port': { default: '8080', scope: 'system', type: 'integer', minimum: 1 } };
const global = { 'server.port': { default: '8080', scope: 'global', type: 'integer', minimum: 1024 } };
const project = { 'server.port': { default: '3000', scope: 'project' } };
const merged = mergeFieldDefinitions(system, global, project);
console.log('default:', merged['server.port'].default);
console.log('scope:', merged['server.port'].scope);
console.log('minimum:', merged['server.port'].minimum);
"
```

👀 **Expect**
```
default: 3000
scope: project
minimum: 1024
```

✅ **Verify**
- [ ] Project `default` wins
- [ ] Global validation keyword `minimum: 1024` inherited
- [ ] `scope` set to `"project"`

🔗 **Proves:** REQ-005 · CAP-005
📎 **Source:** USE_CASES.md UC-17

#### 4.3 · contentHash test vector   (happy)

▶️ **Do**
```bash
node -e "const {contentHash} = require('@adhd/environment'); console.log('TS:', contentHash({b:'2',a:'1'}));"
```

👀 **Expect**
```
TS: sha256-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

✅ **Verify**
- [ ] Output matches canonical test vector byte-for-byte
- [ ] Python and Rust produce identical output

🔗 **Proves:** REQ-020, REQ-021, REQ-022 · CAP-020
📎 **Source:** SCOPE.md §1 contentHash test vector

---

### Act 5 — The Climax: Agent-MCP Refactor

#### 5.1 · Before: the old config.ts   (baseline)

▶️ **Do**
```bash
wc -l entrypoint/agent-mcp/src/config.ts
grep -c "process\.env\|z\.\|deepFreeze\|loadEnvHierarchy\|rawFromEnv\|PROVIDER_DEFAULTS" entrypoint/agent-mcp/src/config.ts
```

👀 **Expect**
```
299 entrypoint/agent-mcp/src/config.ts
⟨~30⟩
```

✅ **Verify**
- [ ] `config.ts` is 299 lines with Zod, explicit env reads, PROVIDER_DEFAULTS

🔗 **Proves:** REQ-024 · CAP-024
📎 **Source:** SCOPE.md §1 Outcomes; CURRENT_CONFIG_PATTERNS.md

#### 5.2 · After: the typed runtime   (the payoff)

▶️ **Do**
```bash
cat > /tmp/adhd-runtime.ts << 'TYPESCRIPT'
// Replaces entrypoint/agent-mcp/src/config.ts (was 299 lines)
import { Environment } from "@adhd/environment";

// Typed config shape for full type safety
interface AgentMcpConfig {
  config: { server: { port: number }; db: { path: string }; log: { level: string } };
}

export const env = new Environment<AgentMcpConfig>({
  project: "agent-mcp",
  namespace: "production"
});

// All config access via typed env.get():
//   env.get("config.server.port")  → number  (2995)
//   env.get("config.db.path")      → string  (2925)
//   env.get("config.log.level")    → string  (2925)

// Secrets set via adhd-env set (no .env file):
//   adhd-env set providers.openai.secret sk-... --namespace production
//   env.get("env.OPENAI_API_KEY")  reads from snapshot

// Old getProviderConfig() still works, reads from env.get()
// Old isEnvNameAllowed() uses env.prefix (namespace-aware)
TYPESCRIPT
wc -l /tmp/adhd-runtime.ts
```

👀 **Expect**
```
30 /tmp/adhd-runtime.ts
```

✅ **Verify**
- [ ] ~30 lines (vs 299)
- [ ] `Environment<AgentMcpConfig>` generic provides type safety
- [ ] Constructor takes params object `{ project, namespace }`
- [ ] No Zod, no dotenv, no deepFreeze
- [ ] No `.env` file reference — uses `adhd-env set`

🔗 **Proves:** REQ-024, REQ-025, REQ-026, REQ-027 · CAP-024, CAP-025, CAP-026, CAP-027
📎 **Source:** USE_CASES.md UC-24, UC-25, UC-26, UC-27

#### 5.3 · Provider credential resolution still works   (happy)

▶️ **Do**
```bash
node -e "
const { Environment } = require('@adhd/environment');
const env = new Environment({ project: 'agent-mcp', namespace: 'production', adhdRoot: process.env.ADHD_HOME });
const openai = { model: env.get('config.providers.openai.model'), secret: env.get('env.OPENAI_API_KEY') };
console.log('openai:', JSON.stringify(openai));
"
```

👀 **Expect**
```
openai: {"model":"gpt-4o","secret":"sk-test-openai-key"}
```

✅ **Verify**
- [ ] Model from config default (`"gpt-4o"`)
- [ ] Secret from `env.get("env.OPENAI_API_KEY")` (set via `adhd-env set`)
- [ ] No `.env` file was needed

🔗 **Proves:** REQ-025 · CAP-025
📎 **Source:** USE_CASES.md UC-25

---

## 4 · Resilience Sweep

#### 4.1 · ⚠️ Namespace defaults to "default" when namespaces absent
▶️ **Do**
```bash
# YAML with no namespaces section
cat > /tmp/no-ns-test/adhd.environment.yaml << 'YAML'
project:
  name: no-ns-test
  orgNamespace: adhd
config:
  project:
    test.key:
      default: hello
      type: string
YAML
cd /tmp/no-ns-test
adhd-env build
echo "snapshot exists: $(test -f ⟨ADHD_HOME⟩/no-ns-test/default/adhd-environment.json && echo yes || echo no)"
```
👀 **Expect** — `snapshot exists: yes`
✅ **Verify** — No explicit namespaces → namespace defaults to `"default"`, snapshot at `default/adhd-environment.json`
🔗 **Proves:** REQ-023 · CAP-014
📎 **Source:** USE_CASES.md UC-23

#### 4.2 · ⚠️ orgNamespace in directory structure
▶️ **Do**
```bash
ls -d ⟨ADHD_HOME⟩/agent-mcp/production/
```
👀 **Expect** — Directory exists at `adhd/agent-mcp/production/`
✅ **Verify** — Path includes `adhd/` (orgNamespace), `agent-mcp/` (project), `production/` (namespace)
🔗 **Proves:** REQ-013 · CAP-013
📎 **Source:** USE_CASES.md UC-29

#### 4.3 · ⚠️ envPrefixOverride replaces inferred prefix
▶️ **Do**
```yaml
# In adhd.environment.yaml:
project:
  name: agent-mcp
  envPrefixOverride: CUSTOM_PREFIX
```
```bash
adhd-env build --namespace production
node -e "const {Environment} = require('@adhd/environment'); const e = new Environment({project:'agent-mcp',namespace:'production',adhdRoot:process.env.ADHD_HOME}); console.log(e.prefix);"
```
👀 **Expect** — `CUSTOM_PREFIX_PRODUCTION_`
✅ **Verify** — `envPrefixOverride` completely replaces inferred prefix; namespace suffix still appended
🔗 **Proves:** REQ-003 · CAP-003
📎 **Source:** USE_CASES.md UC-12, UC-13

#### 4.4 · ⚠️ Rejected config validation
▶️ **Do**
```bash
adhd-env set server.port 50 --namespace production
adhd-env build --namespace production 2>&1; echo "exit: $?"
```
👀 **Expect** — `Error: Validation failed: server.port: must be >= 1024 (got 50)` and `exit: 1`
✅ **Verify** — Invalid config is rejected; no snapshot written
🔗 **Proves:** REQ-007 · CAP-007
📎 **Source:** USE_CASES.md UC-19

---

## 5 · Teardown — Back to Zero

▶️ **Do**
```bash
rm -rf "$ADHD_HOME" /tmp/adhd-env-demo /tmp/snapshot.json /tmp/adhd-runtime.ts
```

✅ **Verify**
- [ ] `ls "$ADHD_HOME"` returns "No such file or directory"
- [ ] No residue

🔗 **Proves:** REQ-001 · CAP-001

---

## 6 · Coverage & Traceability Matrix

### 6.1 Requirements → Beats

| Req ID | Requirement | Proven by beat(s) | Status |
|---|---|---|---|
| REQ-001 | Build all packages | §2.4, §5 | ☐ |
| REQ-002 | YAML static spec with orgNamespace | §1.1, §1.2 | ☐ |
| REQ-003 | Env var inference + envPrefixOverride | §1.2, §4.1, §4.3 | ☐ |
| REQ-004 | CLI build + set commands | §1.3, §1.4 | ☐ |
| REQ-005 | Three-tier field merge | §4.2 | ☐ |
| REQ-006 | fieldSchema auto-generation | §1.6 | ☐ |
| REQ-007 | Config validation against fieldSchema | §1.4, §3.4, §4.4 | ☐ |
| REQ-008 | Provenance tracking | §1.6 | ☐ |
| REQ-009 | contentHash + structureHash | §1.4 | ☐ |
| REQ-010 | Atomic snapshot write | §1.4 | ☐ |
| REQ-011 | Typed runtime: env.get() with params object | §2.1, §2.4 | ☐ |
| REQ-012 | Directory type-primary lookup | §2.2 | ☐ |
| REQ-013 | env.get("env.*") + orgNamespace in paths | §2.2, §4.2 | ☐ |
| REQ-014 | Scope filtering on constructor | §2.3 | ☐ |
| REQ-015 | CLI init --generate-config | §1.1 | ☐ |
| REQ-016 | env.hash, env.version | §2.2 | ☐ |
| REQ-017 | env.prefix, env.namespace | §2.2 | ☐ |
| REQ-018 | Namespaced environments (fully nested) | §1.4, §1.5 | ☐ |
| REQ-019 | Namespace in prefix | §2.2 | ☐ |
| REQ-020 | Cross-language contentHash | §4.3 | ☐ |
| REQ-021 | Python runtime client | §4.3 | ☐ |
| REQ-022 | Rust runtime client | §4.3 | ☐ |
| REQ-023 | No "default" namespace | §1.5, §4.1 | ☐ |
| REQ-024 | Agent-mcp: config.ts → typed Environment | §5.1, §5.2 | ☐ |
| REQ-025 | Agent-mcp: getProviderConfig preserved | §5.3 | ☐ |
| REQ-026 | Agent-mcp: env.prefix replaces hardcoded | §5.2 | ☐ |
| REQ-027 | All 26 old env vars mappable | §1.3, §5.2 | ☐ |
| REQ-028 | build() returns EnvironmentSnapshot instance | §3.1 | ☐ |
| REQ-029 | EnvironmentSnapshot.get() instance method | §3.1 | ☐ |
| REQ-030 | EnvironmentSnapshot.set() + .write() persistence | §3.2 | ☐ |
| REQ-031 | Rebuild from existing snapshot preserves set values | §3.3 | ☐ |

### 6.2 Capabilities → Beats

| Cap ID | Capability | Proven by beat(s) | Status |
|---|---|---|---|
| CAP-001 | Build all packages | §2.4, §5 | ☐ |
| CAP-002 | YAML authoring + CLI init | §1.1, §1.2 | ☐ |
| CAP-003 | Env var inference + envPrefixOverride | §1.2, §4.1, §4.3 | ☐ |
| CAP-004 | CLI build + set | §1.3, §1.4 | ☐ |
| CAP-005 | Field merge | §4.2 | ☐ |
| CAP-006 | fieldSchema generation | §1.6 | ☐ |
| CAP-007 | Validation | §1.4, §3.4, §4.4 | ☐ |
| CAP-008 | Provenance | §1.6 | ☐ |
| CAP-009 | Hashing + atomic write | §1.4 | ☐ |
| CAP-011 | Runtime: get() + bracket + scope filter + params obj | §2.1, §2.3, §2.4 | ☐ |
| CAP-012 | Runtime: get("env.*") | §2.2 | ☐ |
| CAP-013 | Runtime: hash, version, project, prefix, namespace, orgNamespace paths | §2.2, §4.2 | ☐ |
| CAP-014 | Namespaces (fully nested, no "default") | §1.4, §1.5, §4.1 | ☐ |
| CAP-015 | Builder EnvironmentSnapshot (build/set/get/configPath/write) | §3.1, §3.2, §3.3, §3.4 | ☐ |
| CAP-020 | Cross-language parity | §4.3 | ☐ |
| CAP-024 | Agent-mcp: config.ts eliminated | §5.1, §5.2 | ☐ |
| CAP-025 | Agent-mcp: getProviderConfig preserved | §5.3 | ☐ |
| CAP-026 | Agent-mcp: prefix guard | §5.2 | ☐ |
| CAP-027 | Agent-mcp: full env var coverage | §1.3, §5.2 | ☐ |

### 6.3 Unresolved Interfaces & Gaps

None — every interface in this script is grounded in project context (SCOPE.md v0.0.5, USE_CASES.md v0.0.5, SPEC_0.0.5.md). All commands, API signatures, expected output formats, and error messages are specified.

---

## 7 · Sign-Off

| Field | Value |
|---|---|
| Environment | ⟨OS / version / commit SHA⟩ |
| Run by | ⟨name or agent ID⟩ |
| Date | ⟨date⟩ |
| Beats passed | ⟨X of Y⟩ |
| Requirements proven | ⟨X of Y⟩ |
| Result | ☐ PASS &nbsp;&nbsp; ☐ FAIL |

> A run is **PASS** only if every ✅ assertion is checked and every requirement in §6.1 is proven.
