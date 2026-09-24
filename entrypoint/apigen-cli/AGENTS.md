# @adhd/apigen-cli — Agent Guide

## Package identity
- **npm:** `@adhd/apigen-cli` (version 0.1.0)
- **Bin:** `apigen` (from `bin.apigen` in package.json)
- **Build:** `npx nx build apigen-cli` → `dist/entrypoint/apigen-cli/index.js`
- **Location in repo:** `entrypoint/apigen-cli/`

## CLI commands and flags

All commands support program-level logging flags: `--log-level`, `--log-format`, `--log-file` (env fallbacks `APIGEN_LOG_LEVEL`, `APIGEN_LOG_FORMAT`, `APIGEN_LOG_FILE`).

### `apigen run [options]`
Start a live server from source.
| Flag | Required | Description |
|------|----------|-------------|
| `--source <path>` | Yes | Source file (.ts, .py) |
| `--type <plugin-id>` | Yes | Output plugin: mcp, api-fastify, api-express, cli, cli-output, py-flask, py-grpc |
| `--export <mode>` | No | Export mode: "default", "\<name\>", or omit for named |
| `--tsconfig <path>` | No | Explicit tsconfig path |
| `--namespace <name>` | No | Route prefix namespace |
| `--opt <key=value>` | No | Plugin option (repeatable) |
| `--use <plugin>` | No | Layer plugin (repeatable) — built-in: health, logger |
| `--config <path>` | No | apigen.config.json override file |
| `--v2` | No | Flag to use v2 unified orchestrator path |

### `apigen generate [options]`
Generate artifacts to disk.
| Flag | Required | Description |
|------|----------|-------------|
| `--source <path>` | Yes | Source file (.ts) |
| `--type <plugin-id>` | Yes | Output plugin |
| `--out-dir <path>` | Yes | Output directory |
| `--export <mode>` | No | Export mode |
| `--tsconfig <path>` | No | Explicit tsconfig path |
| `--namespace <name>` | No | Package namespace |
| `--opt <key=value>` | No | Plugin option (repeatable) |
| `--use <plugin>` | No | Layer plugin (repeatable) |
| `--config <path>` | No | apigen.config.json override file |
| `--link-workspace` | No | Pre-publish workspace bridge |
| `--v2` | No | Use v2 unified orchestrator path |

### `apigen serve [options]`
Multi-source, multi-language server front.
| Flag | Required | Description |
|------|----------|-------------|
| `--source <path>` | Yes | Source file to mount (repeatable) |
| `--port <port>` | Yes | Front TCP port |
| `--mount <ns>=<plugin>` | No | Pin namespace to plugin (repeatable) |

### `apigen run-registry [options]`
Multi-package live server.
| Flag | Required | Description |
|------|----------|-------------|
| `--packages-dir <path>` | Yes | Directory with packages |
| `--type <plugin-id>` | Yes | Output plugin |
| `--tag <tag>` | No | Include tag filter (repeatable) |
| `--exclude-tag <tag>` | No | Exclude tag filter (repeatable) |
| `--tsconfig <path>` | No | Explicit tsconfig path |
| `--opt <key=value>` | No | Plugin option (repeatable) |

### `apigen generate-registry [options]`
Multi-package artifact generation.
| Flag | Required | Description |
|------|----------|-------------|
| `--packages-dir <path>` | Yes | Directory with packages |
| `--type <plugin-id>` | Yes | Output plugin |
| `--out-dir <path>` | Yes | Output directory |
| `--tag <tag>` | No | Include tag filter (repeatable) |
| `--exclude-tag <tag>` | No | Exclude tag filter (repeatable) |
| `--tsconfig <path>` | No | Explicit tsconfig path |
| `--opt <key=value>` | No | Plugin option (repeatable) |

## Plugin reference

Plugins registered in `src/index.ts`:

| ID | Language | Has `run` | Has `generate` | Package |
|----|----------|-----------|----------------|---------|
| `mcp` | TS | Yes | Yes | `@adhd/apigen-plugin-mcp` |
| `jsonschema` | TS | No | Yes | `@adhd/apigen-plugin-jsonschema` |
| `ts-types` | TS | No | Yes | `@adhd/apigen-plugin-ts-types` |
| `api-fastify` | TS | Yes | Yes | `@adhd/apigen-plugin-api-fastify` |
| `api-express` | TS | Yes | Yes | `@adhd/apigen-plugin-api-express` |
| `cli` | TS | Yes | Yes | `@adhd/apigen-plugin-cli-output` |
| `cli-output` | TS | Yes | Yes | (alias for `cli`) |
| `py-flask` | Py | Yes | Yes | `@adhd/apigen-plugin-py-flask` |
| `py-grpc` | Py | Yes | Yes | `@adhd/apigen-plugin-py-grpc` |

## Built-in `--use` plugins

| Slug | Package | Description |
|------|---------|-------------|
| `health` | `@adhd/apigen-plugin-health` | Mounts `GET /_meta/health` |
| `logger` | `@adhd/apigen-plugin-logger` | Per-operation logging middleware |

Custom plugins can be loaded by package specifier or local path.

## Key implementation details

- **Entry point:** `src/index.ts` — registers five Commander.js commands, inlines plugin map
- **v1 pipeline:** `src/lib/pipeline.ts` — `runPipeline()`: resolve-tsconfig → generateSchemas → composeSchemas (default path)
- **v2 orchestrator:** `src/lib/orchestrator.ts` — `orchestrateGenerate()`, `orchestrateRun()`: detect → extract → merge → collision-check → run/generate (use `--v2` flag)
- **Registry discovery:** `src/lib/registry.ts` — `discoverPackages()`: reads nx tags from package.json keywords
- **Scaffolding:** `src/lib/scaffold.ts` — `emitResolutionScaffolding()`: generates package.json, tsconfig.json, workspace-linked node_modules
- **Serving:** `src/lib/commands/serve.ts` — `startServe()`, `createFrontServer()`, `killAll()`: child-process-based multi-source serve
- **Logging:** `src/lib/logging.ts` — pino-based, stderr-only
- **Tsconfig resolution:** `src/lib/resolve-tsconfig.ts` — explicit → nearest → builtin (memoized)

## Testing — two lanes (default `test` vs explicit `e2e`)

This project's suites are split by RESOURCE CLASS, so the resource-consuming
ones never run under `nx affected -t test` / the pre-commit + pre-push hooks.

| | default lane | e2e lane |
|---|---|---|
| target | `nx test apigen-cli` (runs in `affected`) | `nx run apigen-cli:e2e` (explicit only) |
| vitest config | `vite.config.ts` | `vitest.e2e.config.ts` |
| include | `src/**/*.spec.ts` | `src/**/*.e2e.ts` |
| prerequisites | none (in-process, source-level) | `build`, `apigen-java:package` |
| cost | seconds | minutes (subprocesses, ports, real extraction, JVM, python) |

**A resource-consuming suite must live in a `*.e2e.ts` file, never a `*.spec.ts`.**
"Resource-consuming" is broad: any use of `child_process`/`spawn`/`execFile`
(including spawning the built `dist/index.js`), any `python3`/`java`/`mvn`/`javac`
/`grpcurl` host, any real HTTP server bound to a port (`app.listen`) even when
in-process, embedding models, and CPU/mem-heavy work such as real ts-morph
extraction over fixtures. When you extract one, `git mv <name>.spec.ts
<name>.e2e.ts` and leave a cheap `<name>.spec.ts` STUB at the original path — a
header naming the sibling `.e2e.ts` and a `Resource lane: proc|embed|cpu|mem|disk|io`
line, plus one `it.todo('mocked: …')` per real case. The stub is the home of the
future MOCKED unit-test version; it must spawn/embed/bind nothing.

The `e2e` target is deliberately NOT in `affected`, NOT in any `test.dependsOn`,
and NOT in `targetDefaults` — `nx affected -t test` can never select it.

## Architecture

Extract → Compose → Project:
1. **Extract** — parse TypeScript source via ts-morph, infer JSON Schema for parameters/returns
2. **Compose** — merge schemas across packages, collision-check names
3. **Project** — hand composed descriptor to output plugin (run live or generate files)

Non-TS plugins (py-flask, py-grpc) bypass extraction and pass the source file path directly to the plugin's runtime.

The serve command uses a raw `net.Server` that peeks the first 3 bytes to demux HTTP/1.1 vs HTTP/2 (gRPC h2c) on one port.
