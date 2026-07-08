# adhd-environment v0.0.5

<one-paragraph statement of what this plan delivers>

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **All 6 packages build successfully (nx build, pytest, cargo test) (structural)** — All 6 packages build successfully (nx build, pytest, cargo test).

- `[dod.2]` **adhd-env init --generate-config writes starter adhd.environment.yaml (structural)** — adhd-env init --generate-config writes starter adhd.environment.yaml.

- `[dod.3]` **adhd-env set stores config values without .env file (structural)** — adhd-env set stores config values without .env file.

- `[dod.4]` **adhd-env build reads YAML, writes snapshot at ~/.<org>/<project>/<namespace>/adhd-environment.json (structural)** — adhd-env build reads YAML, writes snapshot at ~/.<org>/<project>/<namespace>/adhd-environment.json.

- `[dod.5]` **Typed Environment::project, namespace, namespace, adhdRoot> provides typed env.get() (structural)** — Typed Environment::project, namespace, namespace, adhdRoot> provides typed env.get().

- `[dod.6]` **contentHash test vector matches across all 3 languages (structural)** — contentHash test vector matches across all 3 languages.

- `[dod.7]` **Agent-mcp config.ts (299 lines) replaced with adhd.environment.yaml + typed Environment (structural)** — Agent-mcp config.ts (299 lines) replaced with adhd.environment.yaml + typed Environment.

- `[dod.8]` **build() returns EnvironmentSnapshot instance with set/get/configPath/write methods (structural)** — build() returns EnvironmentSnapshot instance with set/get/configPath/write methods.
