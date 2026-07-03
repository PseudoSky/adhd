# Required Tooling — @adhd/apigen-cli

## Runtime Requirements

| Tool | Version | Required By | Notes |
|------|---------|-------------|-------|
| Node.js | >=18 (tested on v24.11.1) | CLI runtime | The CLI is a Node.js application |
| npm/yarn/pnpm | any | Dependency install | Monorepo uses yarn; individual consumers use npm |

## Build & Development

| Tool | Version | Required By | Notes |
|------|---------|-------------|-------|
| Nx (monorepo) | workspace | Build, test, version, publish | Required for monorepo workflows |
| @nx/vite | workspace | Build bundling | `@nx/vite:build` executor |
| Vitest | workspace | Testing | `@nx/vite:test` executor |

## Transitive Runtimes (for specific features)

| Tool | Feature | Notes |
|------|---------|-------|
| Python 3 | `py-flask`, `py-grpc` plugins, `serve` command | Python hosts are spawned as child processes. Venv auto-provisioned by `@adhd/apigen-python-env` when `APIGEN_PYTHON` not set. |
| pip | Python venv setup | Managed by `@adhd/apigen-python-env` |
| Python grpc extras | `py-grpc` plugin | `pip install "apigen-python[grpc]"` via managed venv |
| `decimal.js` npm package | Decimal types | Peer dependency for surfaces using `format:decimal`. Guarded by assertDecimalLibPresent — fails early with actionable message if absent. |

## npm Dependencies (from package.json)

All explicitly listed in `package.json`. Notable:
- `tsx` — Used for dynamic TypeScript import (importSource.ts); bundled in CLI
- `ts-morph` — TypeScript AST introspection
- `ts-json-schema-generator` — JSON Schema generation
- `commander` — CLI framework
- `@modelcontextprotocol/sdk` — MCP server protocol
- `pino` / `pino-pretty` / `pino-http` — Logging

## Missing Tools Log

No tools were found to be missing for the verification performed in this catalog run. All capabilities could be verified through:
- Static code analysis (reading source files)
- Running `--help` on the built CLI (`node dist/entrypoint/apigen-cli/index.js`)
- Running `generate --type jsonschema` to verify actual artifact output
- Analyzing test files (spec.ts files)

**What was NOT verified live (would need these tools/tests to fully verify):**

| Capability | Missing Verification | What's Needed |
|------------|-------------------|---------------|
| `cli-run` (live server) | No live MCP/HTTP server started | Running a `run` command with a real fixture and probing the server (done in test suite: `src/test/run.spec.ts` does this but requires test runner) |
| `cli-serve` (full stack) | No multi-source serve started | Would need Python 3, nx-monorepo setup for workspace resolution; test coverage in `src/test/serve.spec.ts` |
| `use-plugin-loader` (dynamic import) | No dynamic package import tested | Would need a real package specifier to import |
| `v2-orchestrator` (live output) | No --v2 flag run against real source | Running `generate --v2` against a fixture |

None of these gaps block catalog completeness — the code-level analysis and unit test coverage confirm the capabilities exist.
