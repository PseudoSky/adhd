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

```bash
# Unit + integration tests
npx nx test apigen-cli

# Performance benchmark (requires --expose-gc)
npx nx run apigen-cli:bench
```

Tests are written with Vitest. The test suite exercises:
- Unit tests for command options and flag parsing
- Integration tests for real pipeline execution with fixtures
- Behavioral tests that spawn and probe servers
- Performance benchmarks for extraction throughput

## Development workflow

```bash
# Watch mode
npx nx build apigen-cli --configuration=development --watch

# Run a specific test file
npx vitest run src/test/generate.spec.ts

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
