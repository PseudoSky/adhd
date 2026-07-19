# @adhd/environment (`environment-core-node`)

The headline runtime of the `@adhd/environment` family: the Node/TypeScript
implementation. Published to npm as the unprefixed **`@adhd/environment`** (see the
alias note below).

```bash
npm install @adhd/environment
```

## What it does

Consistent, cascading, scope-aware configuration + directory resolution for a project
that runs in more than one mode (stdio vs. server, project-local vs. global). The one
principle: **zero-config by default** — a consumer never has to write a file or export a
var just to make things *run*. Files and env vars are purely optional overrides.

## Usage — code-first, live resolve

You declare the spec (with defaults) in code and construct `Environment`. It resolves the
whole cascade **in memory at construction** — nothing on disk is required.

```ts
import { Environment } from '@adhd/environment';

interface AppConfig {
  transport: { port: number };
  db: { path: string };
  logging: { level: string };
}

export const env = new Environment<AppConfig>('agent-mcp', {
  dirs:  { logs: { kind: 'logs' }, data: { kind: 'data' } },
  files: { db: { in: 'data', name: 'agents.db' } },
  config: {
    'transport.port': { type: 'integer', default: 8787 },
    'logging.level':  { type: 'string',  default: 'info' },
    'db.path':        { type: 'string' },                              // falls back to env.files.db
    'api.secret':     { type: 'string', secret: true, at: 'runtime' }, // read live from env each access
  },
});

env.config.transport.port;          // 8787 — typed, with zero files on disk
env.paths.logs;                     // <root>/.adhd/agent-mcp/<ns>/logs/<instanceId>
env.files.db;                       // <root>/.adhd/agent-mcp/<ns>/data/agents.db
env.get('config.transport.port');   // dynamic dot-path accessor (config.* / path.* / env.* / provenance.*)
env['config.transport.port'];       // bracket-access shorthand for get()
env.resolveEnvName('ADHD_AGENT_MCP_API_SECRET'); // value of a remapped, prefix-allowed env var
env.isEnvNameAllowed(name);         // prefix-scoped security guard
const release = env.lock('singleton'); /* one-writer-per-scope */ release();
```

## The cascade (every layer optional; lowest always present)

```
code defaults → system → global(~/.adhd) → project(<projectRoot>/.adhd) → local(*.local) → env vars
```

- **Value precedence** (high→low): remapped env var > `config.local.yaml` > project `config.yaml` >
  global `config.yaml` > system > spec default.
- **Scope** is resolved by: explicit `options.scope` → `ADHD_ENV_SCOPE` env → auto (a project marker
  `.git`/`.adhd`/`adhd.environment.yaml` at/above `cwd` → `project`, else `global`).
- **Directory roots follow the active scope**: `project` → `<projectRoot>/.adhd/<project>/<ns>/…`;
  `global` → `~/.adhd/<project>/<ns>/…`. Everything (including layer files) nests under
  `<root>/.adhd/<project>/<ns>/`, so each package gets an isolated subtree — no root clutter, no
  cross-package collision.

## Build-time vs. runtime fields

A field's `at` controls when it resolves: `at: 'build'` (default) bakes the value into the resolved
config; `at: 'runtime'` (and every `secret: true` field) is stored as an `adhd-env-ref:<ENV_VAR>`
reference and read live from `process.env` on each access — the caller always gets the current value
(or `undefined`), never the literal reference, and the plaintext is never persisted or hashed.

## The snapshot is optional

`env.write()` persists a resolved `adhd-environment.json` snapshot (atomic) purely as an optional
artifact — for cross-process handoff, drift detection, or `export`/inspection. It is **never** a
prerequisite: `Environment.fromSnapshot(path)` reads one back for a consumer that only has the file.

## Multi-instance collision

Per-`dirs`/`files` `share` policy (consumer-overridable): `logs`/`temp` default **per-instance**
(suffixed by `env.instanceId`, never collide); `data`/`cache` default **shared**; a shared SQLite DB
opens WAL + `busy_timeout`. `env.lock(name)` gives advisory one-writer-per-scope enforcement via an
atomic lockfile under the resolved `run` dir.

## Building & testing

- Build: `nx build environment-core-node`
- Test:  `nx test environment-core-node`

Full contract, rationale, and the Definition-of-Done proofs: `packages/environment/ARCHITECTURE.md`.

## `@adhd/environment` family — naming map

| directory | nx project name | distribution name | registry | import specifier |
|-----------|-----------------|-------------------|----------|------------------|
| `packages/environment/environment-base-spec` | `environment-base-spec` | `@adhd/environment-base-spec` | npm | `@adhd/environment-base-spec` |
| `packages/environment/environment-builder` | `environment-builder` | `@adhd/environment-builder` | npm | `@adhd/environment-builder` |
| `packages/environment/environment-core-node` | `environment-core-node` | `@adhd/environment` | npm | `@adhd/environment` |
| `entrypoint/environment-cli` | `environment-cli` | `@adhd/environment-cli` | npm | `@adhd/environment-cli` |

> The Python (`environment-core-py`) and Rust (`environment-core-rs`) runtime clients were **removed**
> in the zero-config redesign (2026-07-18) — no non-JS consumer exists yet. See `CHANGELOG.md`
> (DEBT-ENV-REDESIGN-002). If a cross-language client is needed later, it reads the optional snapshot.

### The `environment-core-node` → `@adhd/environment` alias (deliberate)

`environment-core-node`'s nx project name stays `environment-core-node` (matching its directory), but
its **published npm name is the unprefixed `@adhd/environment`** so consumers import the ergonomic
name. `tsconfig.base.json` maps the import specifier `@adhd/environment` to this package's `src/index.ts`.
