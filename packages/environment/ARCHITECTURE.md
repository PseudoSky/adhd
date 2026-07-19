# @adhd/environment — Zero-Config Redesign (Architect Work-Order)

> Supersedes DeepSeek's `docs/plan/adhd-environment/SPEC_0.0.x`. Authored 2026-07-18.
> Baseline for this worktree is the preserved WIP branch `wip/adhd-environment-old-api`.
> This document is the authoritative contract. Executors implement to it exactly.

## 0. The one principle

**Zero-config by default.** A downstream consumer must NEVER have to write a file or
export a var just to make things *run*. Files and env vars are purely optional
overrides that layer on top — exactly how an LLM CLI (Claude Code) cascades settings:
built-in defaults work with nothing on disk; `~/.claude/…` → `.claude/…` →
`.claude/*.local` layer over them only when present.

## 1. What was wrong (do not reintroduce)

1. **Snapshot-reader runtime.** `environment-core-node`'s `Environment` reads a JSON
   snapshot from disk and returns `config: {}` when none exists → every value
   `undefined` out of the box. The defaults live only in the builder/CLI, which must
   run first. **This is the exact opposite of zero-config.**
2. **CLI-as-sole-builder / no-env.** Values only enterable via `adhd-env set`. The user
   wants env vars *remapped*, not abolished, and a code-first API, not a CLI gate.
3. **Cross-language (Py/Rust) from day one.** No consumer needs it yet. Node-only.

## 2. Corrected model

### 2.1 Live in-memory resolve (THE core change)
`Environment` is constructed WITH the code-defined spec and resolves the whole
cascade **in memory at construction**. Defaults always apply because the spec is in
code. The on-disk snapshot becomes an **optional** `.write()` artifact (cross-process
handoff, drift detection, `export`/inspect) — never a prerequisite.

### 2.2 Cascade (every layer optional; lowest always present)
```
code defaults  →  system  →  global(~/.adhd)  →  project(<root>/.adhd)  →  local(*.local)  →  env vars
```
Config value precedence, high→low: **env var (remapped) > local file > project file >
global file > system file > spec default**.

### 2.3 Scope resolution (first match wins)
1. explicit `options.scope` (`'system'|'global'|'project'`)
2. `ADHD_ENV_SCOPE` env var
3. auto: a project marker (`.git` / `.adhd` / `adhd.environment.yaml`) found at/above
   `cwd` → `project`; otherwise → `global`.

### 2.4 Directory roots follow the active scope
- `project` → `<projectRoot>/.adhd/<project>/<namespace>/…`
- `global`  → `~/.adhd/<project>/<namespace>/…`  (org dir = `.<orgNamespace>`, default `.adhd`)
- `system`  → OS app dir (macOS `~/Library/Application Support/adhd/<project>/<namespace>`)

**Everything nests under `<root>/.adhd/<project>/<namespace>/`** — config layer files
included (`config.yaml`, `config.local.yaml`) — so one consuming project's `.adhd/`
holds an isolated subtree per package: no root clutter, no cross-package collision.

## 3. Public API contract (environment-core-node)

```ts
// PRIMARY — code-first, live resolve:
const env = new Environment<TConfig>('agent-mcp', spec, options?);

// SECONDARY — read a persisted snapshot only (cross-process / another consumer):
const env = Environment.fromSnapshot(snapshotPath);
```

### 3.1 EnvironmentSpec<T>
```ts
interface EnvironmentSpec<T> {
  orgNamespace?: string;          // default "adhd"
  envPrefixOverride?: string;     // else inferred: "agent-mcp" → "ADHD_AGENT_MCP"
  namespaces?: string[];          // optional; absent ⇒ ["default"]
  dirs?:   Record<string, DirSpec>;
  files?:  Record<string, FileSpec>;
  config:  Record<string, FieldSpec>;   // dot-path keys, e.g. "transport.port"
}
type DirKind = 'data'|'logs'|'cache'|'state'|'run'|'temp'|'config';
interface DirSpec  { kind: DirKind; share?: Share; scope?: Scope; path?: string; }
interface FileSpec { in: string; name: string; share?: Share; } // in = a dirs key
type Share = 'shared' | 'per-instance' | 'singleton';  // default per kind (§5)
interface FieldSpec {
  type: 'string'|'integer'|'number'|'boolean'|'array';
  default?: unknown;
  at?: 'build'|'runtime';      // runtime = re-read live env each access (env-ref); default 'build'
  env?: string;                // explicit env var name; else inferred from prefix+path
  scope?: Scope;
  secret?: boolean;            // never logged; stored as env-ref, resolved at runtime
  minimum?; maximum?; enum?; pattern?; minLength?; maxLength?; items?;  // JSON-Schema keywords
}
interface EnvironmentOptions { scope?: Scope; namespace?: string; adhdRoot?: string; cwd?: string; instanceId?: string; }
```

### 3.2 Instance members (MUST preserve the real agent-mcp consumer surface)
| Member | Contract |
|---|---|
| `env.config: T` | typed, fully-resolved nested config object — the PRIMARY accessor (`env.config.transport.port`, `env.config.db.path`, `env.config.logging.level`, …). |
| `env.get(path)` | dynamic dot-path: `config.*` / `path.*` / `env.*` / `provenance.*`. |
| `env["config.x"]` | bracket-access proxy → `env.get`. (keep existing behavior) |
| `env.paths: Record<string,string>` | resolved absolute dir path per declared `dirs` key; created lazily/on `ensureDirs()`. |
| `env.files: Record<string,string>` | resolved absolute file path per declared `files` key. |
| `env.resolveEnvName(name): string \| undefined` | value of a remapped/allowed env var (used by agent-mcp `getProviderConfig`). |
| `env.isEnvNameAllowed(name): boolean` | true iff `name` is within this project's prefix scope (security guard). |
| `env.prefix / project / namespace / scope / orgNamespace` | resolved identity. |
| `env.instanceId: string` | unique per constructed instance (pid + short random). |
| `env.lock(name?='singleton'): () => void` | acquire an advisory lock under `paths.run`; returns release fn; throws if held (for singleton-per-scope). |
| `env.hash / version / provenance / dirs` | snapshot metadata (computed live). |
| `env.write(): string` | persist snapshot JSON atomically; returns path. Optional. |
| `env.snapshotPath: string` | where `.write()` persists. |

## 4. Package plan

- **`environment-base-spec`** (salvage): KEEP `contentHash`, `structureHash`,
  `inferEnvVar`, `generateFieldSchema`, env-ref helpers (`makeEnvRef`/`isEnvRef`/…),
  `projectEnvPrefix`, `LoneSurrogateError`, `DeepPath`. ADD: `DirKind`, `Share`,
  `Scope='system'|'global'|'project'`, `FieldSpec.at`, new `DirSpec`/`FileSpec`,
  `EnvironmentSpec`. REMOVE: cross-language vectors (`generateCrossLanguageVectors`,
  `CrossLanguageVectors`) and Py/Rust obligations. Replace dotted `DirectoryType`
  (`'state.data'|'runtime.log'|…`) with flat `DirKind`.
- **`environment-builder`** (re-architect): pure resolve engine, no disk-read
  prerequisite. Functions: `resolveScope(options,env,cwd)`, `resolveRoots(scope,…)`,
  `loadLayerFiles(roots)` (yaml, all optional), `resolveConfig(spec, layers, processEnv)`
  (defaults→system→global→project→local→env, provenance per field, `at:'runtime'`
  fields stored as env-refs), `resolveDirs`/`resolveFiles` (kind→base, share→suffix),
  `buildSnapshot(...)`, `writeSnapshot(...)` (atomic, optional). SALVAGE existing
  `field-merge`, `json-schema-gen`, `validation`, `provenance`, `snapshot-writer`,
  `config-resolver` (`inferEnvVar`, `readStore`, `redactSecrets`) where they fit.
- **`environment-core-node`** (re-architect): the `Environment` class per §3, wrapping
  the builder to resolve live at construction; typed `config`/`paths`/`files`;
  `resolveEnvName`/`isEnvNameAllowed`/`lock`/`instanceId`; `fromSnapshot`; `write`.
- **`environment-cli`** (demote): thin optional wrapper over the builder
  (`init`/`build`/`set`/`status`/`export`); NOT required for consumers to run.
- **DELETE** `environment-core-py`, `environment-core-rs` (and their project refs, tags,
  `nx.json`/tsconfig references). Log in CHANGELOG.

## 5. Multi-instance collision — configurable, sensible defaults
Per-`dirs`/`files` `share` policy (consuming package overrides):
- `logs`, `temp` → **per-instance** default: path suffixed with `env.instanceId` — never collide.
- `data`, `cache`, `state`, `config` → **shared** default.
- SQLite DBs (a `files` entry) → **shared**, opened WAL + `busy_timeout` (safe concurrent).
- `run` dir holds the instance registry + lockfiles; `env.lock('singleton')` lets an app
  enforce one-writer-per-scope (second instance throws/waits).

## 6. agent-mcp refactor (reference consumer / demo)
- `entrypoint/agent-mcp/src/config.ts`: define the spec in code and
  `export const env = Object.assign(new Environment<AgentMcpConfig>('agent-mcp', spec, {...}), { getProviderConfig })`.
  Preserve `getProviderConfig` + the `env.resolveEnvName`/`env.isEnvNameAllowed` surface it uses.
- Preserve ALL existing call sites verbatim: `env.config.logging.level`,
  `env.config.plugins.{configPath,entries}`, `env.config.queue.concurrency`,
  `env.config.server.{maxDepth,maxToolLoops,allowedAgents,registryDbPath}`,
  `env.config.sse.{port,host}`, `env.config.transport.{kind,port}`, `env.config.db.path`.
- Delete `utils/load-env.ts` (dotenv cascade) — the Environment cascade replaces it.
- `db/client.ts`: `env.config.db.path` still works; ALSO expose `env.files.db` as the
  zero-config default so no path need be set.

## 7. Definition of Done (verification — teeth required, per AGENTS.md §7)
1. `nx build environment-base-spec environment-builder environment-core-node` clean.
2. **Zero-config proof (default-running test, no files on disk):**
   `new Environment('t', { config: { 'a.port': { type:'integer', default: 8787 } } })`
   → `env.config.a.port === 8787` with an empty temp `adhdRoot` and no cwd markers.
   Negative control: break the default-fallback → test goes RED.
3. **Cascade proof:** write a project-scope `config.yaml` → it overrides the default;
   set the remapped env var → it overrides the file. Each layer proven by a distinct assertion.
4. **Scope proof:** `ADHD_ENV_SCOPE=project` + a temp project root → `env.paths.data`
   is under `<projectRoot>/.adhd/...`; unset + no marker → under `~/.adhd/...`.
5. **Runtime-vs-build proof:** `at:'runtime'` field changes when `process.env` changes
   between two `env.get()` calls; `at:'build'` field does not.
6. **Multi-instance proof:** two instances → distinct `env.paths.logs` (per-instance);
   `env.lock('singleton')` on the 2nd throws while the 1st holds it (deterministic, no sleep).
7. **agent-mcp proof:** `nx build agent-mcp` clean; agent-mcp test suite green; a test
   constructs the real `env` and asserts `env.config.transport.port` is the default with
   zero files, and that a set env var overrides it.
8. `nx lint` clean on every touched project.
```
