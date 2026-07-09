# adhd-environment v0.0.5

Multi-language centralized configuration management for the ADHD monorepo. Replaces hand-written Zod schemas + dotenv + manual env var mapping with a YAML config file, a CLI builder, and thin typed runtime clients in TypeScript, Python, and Rust.

## Consumer

ADHD package authors (Samira) and deployers (Luca) who currently maintain 299-line config.ts files with Zod schemas, explicit `rawFromEnv()` calls, and PROVIDER_DEFAULTS tables. The plan delivers a unified environment SDK that any ADHD entrypoint can adopt.

## Value delta

Before: 299 lines of config.ts per package (Zod + dotenv + deepFreeze + env var mapping) × 5 packages = ~1,500 lines of repetitive config boilerplate. No provenance tracking, no cross-language config sharing, no namespace isolation.

After: One checked-in YAML file + one `adhd-env build` command + one typed `new Environment<Config>({ project, namespace })` call per package. ~30 lines per package. Provenance tracking, auto-generated JSON Schema, fully-nested namespace directory trees, and cross-language parity (TS/Python/Rust).

## Definition of Done

- `[dod.1]` **All 6 packages build successfully (nx build, pytest, cargo test) (structural)** — All 6 packages build successfully (nx build, pytest, cargo test).
  delivered-by: scaffold-workspace

- `[dod.2]` **adhd-env init --generate-config writes starter adhd.environment.yaml (structural)** — adhd-env init --generate-config writes starter adhd.environment.yaml.
  delivered-by: runtime-cli

- `[dod.3]` **adhd-env set stores config values without .env file (structural)** — adhd-env set stores config values without .env file.
  delivered-by: runtime-cli

- `[dod.4]` **adhd-env build reads YAML, writes snapshot at ~/.<org>/<project>/<namespace>/adhd-environment.json (structural)** — adhd-env build reads YAML, writes snapshot at ~/.<org>/<project>/<namespace>/adhd-environment.json.
  delivered-by: [builder-engine, runtime-cli]

- `[dod.5]` **Typed Environment::project, namespace, namespace, adhdRoot> provides typed env.get() (structural)** — Typed Environment::project, namespace, namespace, adhdRoot> provides typed env.get().
  delivered-by: runtime-core-node

- `[dod.6]` **contentHash test vector matches across all 3 languages (structural)** — contentHash test vector matches across all 3 languages.
  delivered-by: [contract-base-spec, runtime-core-node, runtime-py, runtime-rs]

- `[dod.7]` **Agent-mcp config.ts (299 lines) replaced with adhd.environment.yaml + typed Environment (structural)** — Agent-mcp config.ts (299 lines) replaced with adhd.environment.yaml + typed Environment.
  delivered-by: refactor-agent-mcp

- `[dod.8]` **build() returns EnvironmentSnapshot instance with set/get/configPath/write methods (structural)** — build() returns EnvironmentSnapshot instance with set/get/configPath/write methods.
  delivered-by: builder-snapshot-api
