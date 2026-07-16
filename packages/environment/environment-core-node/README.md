# @adhd/environment (`environment-core-node`)

The headline runtime of the `@adhd/environment` package family: the Node/TypeScript
implementation of the environment spec. Published to npm as the unprefixed
**`@adhd/environment`** (see the alias note below).

```bash
npm install @adhd/environment
```

## Usage

```ts
import { Environment } from '@adhd/environment';

const env = new Environment({ project: 'agent-mcp', namespace: 'production' });

env.get('config.transport.port');       // typed/nested config value
env.get('path.state.data');              // resolved directory path
env.get('env.OPENAI_API_KEY');           // recorded env var
env.get('provenance.transport.port');    // where the value came from
env['config.transport.port'];            // bracket-access shorthand for get()
```

`Environment` is a **thin runtime client**: it only reads a pre-built
`adhd-environment.json` snapshot (produced by `@adhd/environment-builder`) and
exposes typed accessors. It never parses YAML, merges fields, generates a
schema, validates, creates directories, or loads `.env` files.

**Secret-reference resolution:** a `config.*` field whose value was redacted
at build time into an `adhd-secret-ref:<ENV_VAR>` reference (see
`@adhd/environment-builder`'s `redactSecrets`) is resolved from
`process.env` at read time in `Environment.get` — the caller always gets the
live secret value (or `undefined` if the env var is unset), never the
literal reference string. This matches the read-side behavior already
implemented in the Python (`environment-core-py`) and Rust
(`environment-core-rs`) runtime clients (ENV-CORE-009 / ENV-CORE-014).

## Building & testing

- Build: `nx build environment-core-node`
- Test:  `nx test environment-core-node`

## `@adhd/environment` family — naming map

Canonical naming for all six packages in the family. `directory` is the on-disk
location; `nx project name` is what `nx run` / `--projects=environment-*` targets;
`distribution name` is the published artifact; `registry` is where it publishes;
`import specifier` is how a consumer references it.

| directory | nx project name | distribution name | registry | import specifier |
|-----------|-----------------|-------------------|----------|------------------|
| `packages/environment/environment-base-spec` | `environment-base-spec` | `@adhd/environment-base-spec` | npm | `@adhd/environment-base-spec` |
| `packages/environment/environment-builder` | `environment-builder` | `@adhd/environment-builder` | npm | `@adhd/environment-builder` |
| `packages/environment/environment-core-node` | `environment-core-node` | `@adhd/environment` | npm | `@adhd/environment` |
| `packages/environment/environment-core-py` | `environment-core-py` | `adhd-environment` | PyPI | `import adhd_environment` |
| `packages/environment/environment-core-rs` | `environment-core-rs` | `adhd-environment` | crates.io | `use adhd_environment;` (crate `adhd-environment`) |
| `entrypoint/environment-cli` | `environment-cli` | `@adhd/environment-cli` | npm | `@adhd/environment-cli` |

### The `environment-core-node` → `@adhd/environment` alias (deliberate)

`environment-core-node`'s nx project name stays `environment-core-node` — matching
its directory and the `-core-<lang>` sibling pattern — but its **published npm name
is the unprefixed `@adhd/environment`**. This is the intentional "name+alias B3"
decision: consumers import the ergonomic `@adhd/environment`, while the monorepo
keeps the disambiguated project name so the three runtimes read as a set
(`-core-node` / `-core-py` / `-core-rs`). The PyPI and crates.io artifacts mirror
this by publishing as `adhd-environment` — the cross-registry spelling of the same
unprefixed name. `tsconfig.base.json` maps the import specifier `@adhd/environment`
to this package's `src/index.ts`.

### Registry name spellings

Each ecosystem normalizes names differently, so the *same logical name* is spelled
per registry:

- **npm**: `@adhd/environment` (scoped, hyphenated within scope).
- **PyPI**: distribution `adhd-environment`; the importable Python package is
  `adhd_environment` (PEP 8 requires the underscore module name).
- **crates.io**: crate `adhd-environment`; the Rust library path is `adhd_environment`
  (Rust identifiers replace `-` with `_`).

### Renames performed in this task

**None.** Every package, nx project, and distribution name already conformed to the
CLAUDE.md naming rules (hyphenated names, `@adhd/` npm scope, correct layer/platform
tags), so no name was changed. Two nx project names — `environment-core-py` and
`environment-core-rs` — were **newly assigned**: those packages previously had no
`project.json` and were invisible to nx (`nx show projects` returned 4 of 6, so a
`--projects=environment-*` guard silently skipped both cross-language runtimes).
Assigning them is a first-time wiring, not a rename. The stock generated READMEs of
`environment-base-spec`, `environment-builder`, and this package also carried
incorrect doubled nx names (e.g. `environment-environment-base-spec`) in their
build/test instructions; those were corrected here.
