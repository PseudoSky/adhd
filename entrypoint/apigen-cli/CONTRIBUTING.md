# Contributing — @adhd/apigen-cli

## Prerequisites

- Node.js >= 18 (tested on v24)
- Yarn (or npm/pnpm) — monorepo uses yarn
- Nx CLI (workspace-local, run via `npx nx`)

## Setup

```bash
# From repo root
cd /Users/nix/dev/node/adhd
yarn install
```

## Build

```bash
npx nx build apigen-cli
```

Output: `dist/entrypoint/apigen-cli/index.js`

## Test

Tests are split into two lanes. The **default** lane runs automatically (it is
what `nx affected -t test`, the pre-commit hook, and the pre-push hook run); the
**e2e** lane is resource-consuming and runs ONLY when invoked explicitly.

```bash
# Default lane — fast, in-process unit tests only (no subprocesses, no ports,
# no real ts-morph extraction). This is what `nx affected -t test` runs.
npx nx test apigen-cli

# Resource-consuming e2e lane — every suite that spawns the built dist/index.js,
# a python3/JVM host, or binds a real HTTP server, plus the CPU-heavy real
# extraction suites. Builds dist/ and the Java module first, then runs them.
npx nx run apigen-cli:e2e
```

The default lane's vitest `include` is `src/**/*.spec.ts`; the e2e lane's is
`src/**/*.e2e.ts` (`vitest.e2e.config.ts`). A resource-consuming suite lives as
`<name>.e2e.ts`, with a cheap `<name>.spec.ts` STUB left at the original path —
the placeholder for a future mocked version of the same cases (see the stub's
`it.todo` inventory). Never add a resource-consuming case back into a `*.spec.ts`.

Tests are written with Vitest. The suite exercises:
- Unit tests for command options and flag parsing
- Integration/extraction tests for real pipeline execution with fixtures
- Behavioral tests that spawn and probe servers (e2e lane)
- Performance benchmarks for extraction throughput (e2e lane)

## Development workflow

```bash
# Watch mode
npx nx build apigen-cli --configuration=development --watch

# Run a specific default-lane spec
npx vitest run src/test/list-types.spec.ts

# Run a specific resource-consuming e2e spec
npx vitest run src/test/orchestrator.e2e.ts --config vitest.e2e.config.ts

# Lint
npx nx lint apigen-cli
```

## Architecture

The CLI is structured as:

- `src/index.ts` — Entry point, registers plugins and commands on Commander.js
- `src/lib/commands/` — One file per CLI command (`run.ts`, `generate.ts`, `serve.ts`, `run-registry.ts`, `generate-registry.ts`)
- `src/lib/pipeline.ts` — v1 pipeline (default)
- `src/lib/orchestrator.ts` — v2 unified orchestrator (via `--v2` flag)
- `src/lib/scaffold.ts` — Resolution scaffolding for generated output
- `src/lib/registry.ts` — Package discovery by nx tag
- `src/lib/resolve-tsconfig.ts` — tsconfig resolution (explicit → nearest → builtin)
- `src/lib/import-source.ts` — Dynamic TypeScript import via tsx
- `src/lib/logging.ts` — Pino-based stderr-only logger

## Adding a new plugin

1. Implement the `OutputPlugin` interface from `@adhd/apigen-core-client` with `generate()` and/or `run()` methods
2. Register it in `src/index.ts` plugins record
3. Add test coverage in `src/test/`
4. Add the plugin id to the `--type <plugin-id>` help text in the relevant command registration

## Code style

- TypeScript with strict null checks
- PascalCase for interfaces and classes
- camelCase for functions and variables
- JSDoc comments for public exports
- Tests alongside source in `src/test/` and `src/lib/*.spec.ts`
