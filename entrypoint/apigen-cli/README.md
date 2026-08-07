# @adhd/apigen-cli

**apigen: code-first, polyglot API generation.**

Write ordinary functions. Get **type-safe, production-ready servers** in any protocol — MCP, HTTP (Fastify/Express), CLI, JSON Schema — with **zero framework boilerplate, zero annotations, and zero changes to your source**.

> **CLI or library — same engine.** This is the CLI entry point. Everything it does (extract, compose, run, generate) is also available as importable library packages. If you want to embed apigen servers directly in your own Node.js process instead of running the CLI, see the [programmatic API guide](../../packages/apigen/apigen-core-client/README.md#run-servers-programmatically).

```bash
npx @adhd/apigen-cli --help
```

## What you can build

apigen turns your functions into running servers. Here's what that means in practice:

**A polyglot microservice from one command.** Mount TypeScript and Python files behind a single port — Fastify, Express, Flask, and gRPC all sharing one HTTP/1.1 + HTTP/2 endpoint, with per-namespace health and partial-availability isolation.

**An AI tool server from a single file.** Extract your business logic as an MCP server over stdio, SSE, or streaming HTTP — ready for any MCP host (Claude Desktop, Cursor, custom agents).

**Generated, deployable projects.** Emit a complete, runnable server project to disk, complete with `package.json`, `tsconfig.json`, and workspace-linked dependencies. The generated code is type-checked and imports only the dependencies your functions actually use.

**Cross-language type fidelity.** Types that normally break in JSON — `Date`, `bigint`, `Decimal`, `Uint8Array`, discriminated unions, nominal classes — survive the wire with exact precision, and they mean the *same bytes* whether the function runs in TypeScript or Python.

**Pluggable middleware via composition.** Add health endpoints, per-operation logging, auth, or rate-limiting with `--use` plugins — never by editing your business logic.

```ts
// This file. That's it. No decorators, no framework, no schema.
// apigen reads it and serves it as any protocol you ask for.
export async function greet(name: string): Promise<string> {
  return `hello, ${name}`;
}
```

> **How to structure your source files** — naming conventions, export patterns, type annotations, and what makes a good API surface: see the [Writing Source Files guide](../../packages/apigen/apigen-core-client/docs/how-to/writing-source-files.md).

```bash
# → MCP server (AI agents consume your function as a tool)
npx @adhd/apigen-cli run --source greet.ts --type mcp

# → HTTP server on port 3000
npx @adhd/apigen-cli run --source greet.ts --type api-fastify --opt port=3000

# → CLI tool (interactive command from your function)
npx @adhd/apigen-cli run --source greet.ts --type cli
```

The protocol is a deployment choice, never a rewrite.

---

## Install

### Via npm (published package)

```bash
npx @adhd/apigen-cli <command>       # run without installing
npm install -g @adhd/apigen-cli      # global install
apigen --help
```

### From source (this monorepo)

```bash
npx nx build apigen-cli
alias apigen='node dist/entrypoint/apigen-cli/index.js'
```

---

## Quickstart

### One function → one server → one curl

```bash
# Create your source
echo 'export async function greet(name: string): Promise<string> {
  return `hello, ${name}`;
}' > hello.ts

# Serve it live
npx @adhd/apigen-cli run --source hello.ts --type api-fastify --opt port=8080

# Call it — arguments in {"data":{…}} envelope
curl -X POST http://localhost:8080/hello/greet \
  -H 'content-type: application/json' \
  -d '{"data":{"name":"ada"}}'
# → {"result":"hello, ada"}
```

### One source, every protocol

```bash
# MCP server (stdio — for AI agents)
npx @adhd/apigen-cli run --source hello.ts --type mcp

# MCP over SSE
npx @adhd/apigen-cli run --source hello.ts --type mcp --opt transport=sse --opt port=3000

# HTTP (Express)
npx @adhd/apigen-cli run --source hello.ts --type api-express --opt port=3001

# CLI tool (interactive)
npx @adhd/apigen-cli run --source hello.ts --type cli

# JSON Schema (generate to disk)
npx @adhd/apigen-cli generate --source hello.ts --type jsonschema --out-dir ./schema
```

### Multi-language, one port

```bash
# TypeScript + Python behind a single HTTP/gRPC front
npx @adhd/apigen-cli serve \
  --source money.ts \
  --source orders.py \
  --port 8080

# Verify everything is healthy
curl http://localhost:8080/_meta/health
# → {"status":"ok","hosts":{"money":"ready","orders":"ready"}}
# A failed host degrades only its own namespace (503/UNAVAILABLE).
# The rest keep serving.
```

### With middleware

```bash
npx @adhd/apigen-cli run --source hello.ts --type api-fastify --use health --use logger --use batch
# health  → GET /_meta/health  (live health check)
# logger  → per-operation structured logging to stderr
# batch   → POST /_batch/query, /_batch/action (bulk fan-out)
```

Batch operations let clients invoke multiple items in one request:

```bash
curl -X POST http://localhost:3000/_batch/action \
  -H 'content-type: application/json' \
  -d '{
    "operation": "hello/greet",
    "items": [
      { "name": "alice" },
      { "name": "bob" },
      { "name": "charlie" }
    ],
    "concurrency": 2,
    "onItemError": "continue"
  }'
# => [
#   { "index": 0, "status": "fulfilled", "value": "hello, alice" },
#   { "index": 1, "status": "fulfilled", "value": "hello, bob" },
#   { "index": 2, "status": "fulfilled", "value": "hello, charlie" }
# ]
```

---

## What you get: the generated server

When you `generate`, apigen emits a **real, runnable project**:

```
./out/api/
├── package.json          # only the deps your code actually uses
├── tsconfig.json         # ready to compile
├── node_modules/         # linked (with --link-workspace) or via npm install
├── server.ts             # the generated server entry point
└── routes.ts             # generated route handlers
```

```bash
# Build output that runs standalone
npx @adhd/apigen-cli generate --source hello.ts --type api-fastify --out-dir ./out/api
cd ./out/api && npm install && npx tsx server.ts
```

The generated server imports `dispatch`/`buildFnTable` from `@adhd/apigen-engine-runtime` — no inlined dispatch logic — so it behaves identically to `run`.

---

## Commands

### `apigen run` — Serve a source file as a live server

Start a live server from TypeScript or Python source. Functions are imported at runtime via `tsx` and handed to the selected plugin.

> **Library equivalent:** `plugin.run({ packages: [{ id, schemas, importPath, fns, createClient }], options, signal })` — see the [programmatic server guide](../../packages/apigen/apigen-core-client/docs/how-to/running-servers.md).

```bash
apigen run --source <path> --type <plugin-id> [options]
```

| Flag | Description |
|------|-------------|
| `--source <path>` | Source file (`.ts`, `.py`) |
| `--type <plugin-id>` | Output plugin — see [Plugins](#plugins) |
| `--export <mode>` | Export selection: `"default"` \| `"<name>"` \| omit for named |
| `--tsconfig <path>` | Explicit tsconfig.json |
| `--namespace <name>` | Route prefix (default: tsconfig folder name) |
| `--opt <key>=<value>` | Plugin option (repeatable) |
| `--use <plugin>` | Middleware plugin (repeatable) |
| `--config <path>` | Projection-override config file |
| `--v2` | Use v2 unified orchestrator |

The server handles `SIGINT`/`SIGTERM` gracefully.

### `apigen generate` — Generate server artifacts to disk

Extract TypeScript source and write generated files to an output directory. The output includes resolution scaffolding (`package.json`, `tsconfig.json`) so it runs standalone.

> **Library equivalent:** `plugin.generate({ packages: [{ id, schemas, importPath }], outputDir, options })` — see the [plugin guide](../../packages/apigen/apigen-core-client/docs/how-to/building-plugins.md).

```bash
apigen generate --source <path> --type <plugin-id> --out-dir <path> [options]
```

| Flag | Description |
|------|-------------|
| `--source <path>` | TypeScript source file |
| `--type <plugin-id>` | Output plugin |
| `--out-dir <path>` | Output directory |
| `--export <mode>` | Export selection |
| `--tsconfig <path>` | Explicit tsconfig.json |
| `--namespace <name>` | Package namespace |
| `--opt <key>=<value>` | Plugin option (repeatable) |
| `--use <plugin>` | Middleware plugin (repeatable) |
| `--config <path>` | Projection-override config file |
| `--link-workspace` | Emit workspace-linked `node_modules` (for monorepo dev before publish) |
| `--v2` | Use v2 unified orchestrator |

```bash
# Generate a Fastify HTTP server
apigen generate --source hello.ts --type api-fastify --out-dir ./out/http
cd ./out/http && npm install && npx tsx server.ts

# Generate an MCP server project with workspace linking
apigen generate --source hello.ts --type mcp --out-dir ./out/mcp --link-workspace
node ./out/mcp/server.ts
```

Per-surface dependencies are automatically patched into `package.json`: if your function uses `Decimal`, only then does `decimal.js` appear as a dependency.

### `apigen serve` — Multi-source, multi-language front server

Mount many source files across languages behind a single HTTP/1.1 + gRPC (HTTP/2) port. This is a small distributed system in one command: each source runs as a child process supervised with health probes and partial-availability isolation.

```bash
apigen serve --source <path> [--source ...] --port <port> [--mount <ns>=<plugin> ...]
```

| Flag | Description |
|------|-------------|
| `--source <path>` | Source to mount (repeatable; `.ts` → api-fastify, `.py` → py-flask, `.java` → java-javalin) |
| `--port <port>` | Front TCP port (HTTP + gRPC multiplexed) |
| `--mount <ns>=<plugin>` | Pin namespace to specific plugin (repeatable; e.g. `ledger=py-grpc`) |

**Namespace by default** is the source filename stem. So `--source money.ts` creates namespace `money` served via `api-fastify`. Override with `--mount orders=api-express`.

```bash
# Mix TypeScript and Python, four frameworks, one port
apigen serve \
  --source money.ts \
  --source orders.ts \
  --source billing.py \
  --source ledger.py \
  --port 8080 \
  --mount orders=api-express \
  --mount ledger=py-grpc
```

**Architecture:**
- **Protocol demux** — A raw `net.Server` peeks the first 3 bytes. HTTP/2 prior-knowledge (h2c/gRPC) starts with `PRI`; everything else is HTTP/1.1. Both share one TCP port.
- **Spawn + supervise** — Each source starts as a child `apigen run` subprocess on a free loopback port. Children are tracked by PID.
- **Readiness probes** — HTTP hosts via `GET /_meta/health`, gRPC hosts via TCP connect. Both poll with 15s timeout.
- **Partial availability** — A dead child fails only its `/<ns>/*` routes (503 HTTP, UNAVAILABLE gRPC).
- **Orphan-free teardown** — `SIGINT`/`SIGTERM` sends `SIGTERM` then `SIGKILL` after 3s grace.
- **Python pre-provisioning** — The managed Python venv is set up before any child spawns, so first-time `pip install` doesn't eat the ready timeout.

### `apigen run-registry` — Multi-package live server

Discover packages by nx tag and wire them into one live server.

```bash
apigen run-registry --packages-dir <path> --type <plugin-id> [options]
```

All discovered packages are passed to `plugin.run()` in one invocation — one server, all namespaces.

### `apigen generate-registry` — Multi-package artifact generation

Discover packages by nx tag and generate artifacts for all in one pass.

```bash
apigen generate-registry --packages-dir <path> --type <plugin-id> --out-dir <path> [options]
```

---

## Plugins

> These same plugins are importable as library packages — see the [programmatic plugin table](../../packages/apigen/apigen-core-client/README.md#plugin-cheat-sheet).

| ID | Language | `run` | `generate` | Import as | What it builds |
|----|----------|-------|------------|-----------|----------------|
| `mcp` | TS | ✓ | ✓ | `mcpPlugin` from `@adhd/apigen-plugin-mcp` | **MCP server** — model-context-protocol AI tool server. Transports: stdio, SSE, streaming-http |
| `jsonschema` | TS | | ✓ | `jsonschemaPlugin` from `@adhd/apigen-plugin-jsonschema` | **JSON Schema** — per-operation input/output schema files |
| `api-fastify` | TS | ✓ | ✓ | `apiFastifyPlugin` from `@adhd/apigen-plugin-api-fastify` | **Fastify HTTP server** — high-performance, plugin-based HTTP |
| `api-express` | TS | ✓ | ✓ | `apiExpressPlugin` from `@adhd/apigen-plugin-api-express` | **Express HTTP server** — familiar Node.js HTTP framework |
| `cli` / `cli-output` | TS | ✓ | ✓ | `cliPlugin` from `@adhd/apigen-plugin-cli-output` | **Interactive CLI tool** — your functions become command-line commands |
| `py-flask` | Py | ✓ | ✓ | (Python subprocess) | **Python Flask server** — Python HTTP via the Flask framework |
| `py-grpc` | Py | ✓ | ✓ | (Python subprocess) | **Python gRPC server** — HTTP/2 gRPC with protobuf wire format |
| `java-javalin` | Java | ✓ | ✓ | (Java/Maven subprocess) | **Java Javalin server** — JavaParser-extracted `public static` methods, codegen-woven dispatcher, real HTTP via Javalin |

Non-TS plugins (`py-flask`, `py-grpc`, `java-javalin`) bypass TypeScript compilation — they spawn a Python or Java (Maven) subprocess. All plugins use the same canonical wire format, so a `Decimal` is the same JSON string from Fastify, Flask, gRPC, or Javalin.

---

## Common flags

### `--opt <key>=<value>` — Plugin options

Passed through to the target plugin. Recognized keys:

| Key | Applies to | Default | Meaning |
|-----|------------|---------|---------|
| `transport` | `mcp` | `stdio` | `stdio` \| `sse` \| `streaming-http` |
| `port` | `mcp` (HTTP), `api-fastify`, `api-express`, `py-flask` | `3000` | Listen port |
| `host` | All HTTP transports | `127.0.0.1` | Bind address |
| `routePrefix` | `api-fastify`, `api-express` | `""` | Path prefix before `/<namespace>/<fn>` |
| `http.verb.<id>=GET/POST` | All HTTP plugins | (derived) | Override HTTP verb per operation |

MCP over `stdio` keeps **stdout** clean for JSON-RPC — all logs go to stderr.

### `--use <plugin>` — Middleware plugins

Compose cross-cutting behavior without editing your source code. Accepts:

- **Built-in slugs:** `health` — mounts `GET /_meta/health`; `logger` — per-operation structured logging
- **Package specifiers:** any npm package exporting a Plugin interface
- **Local paths:** filesystem path to a plugin module

```bash
apigen run --source hello.ts --type api-fastify --use health --use logger
```

Multiple `--use` plugins compose in declaration order.

### `--export <mode>` — Export selection

Controls which exports become API operations:

| Value | Behavior |
|-------|----------|
| _(omit)_ | Named exports (`export function f`, `export const f = …`) |
| `default` | Default-exported function or object |
| `<name>` | A named object whose properties become operations |

> **v1 limitation:** `export { x as y }` aliases and anonymous defaults mis-name routes in v1 (named by declaration identifier). v2 names by exported symbol. Fixed by the `--v2` flag.

### `--v2` — Unified orchestrator

Activates the v2 detect→extract→merge→collision-check→generate/run pipeline. Uses a shared `ExtractionSession` (one ts-morph `Project` per tsconfig). Collision checks are a hard error (no silent last-writer-wins). v1 remains the default for backward compatibility.

### `--config <path>` — Projection-override file

JSON file for out-of-source HTTP verb and naming overrides (Tenet 1 — source is never modified). CLI `--opt` flags override file values.

### `--link-workspace` — Pre-publish bridge

When generating output that depends on `@adhd/apigen-*` packages not yet published, emits a workspace-linked `node_modules` so the output runs in place. For published consumers: omit this flag and run `npm install` instead.

---

## Middleware system (plugins via `--use`)

apigen's architecture supports **layer and mount plugins** that compose at runtime:

- **Layer plugins** intercept the request/response cycle — validate, log, rate-limit, add auth context.
- **Mount plugins** add routes — health endpoints, metrics, status pages.

Built-in plugins:

| Plugin | Type | What it does |
|--------|------|-------------|
| `batch` | Mount | Adds `POST /_batch/<kind>` — fan out N items through one operation with concurrency control and per-item error handling |
| `health` | Mount | Adds `GET /_meta/health` with aggregate status |
| `logger` | Layer | Per-operation pino logging to stderr |

Write your own by exporting a Plugin object (with `capabilities` field) from any npm package or local file.

---

## Type safety and rich types

apigen infers JSON Schema from your TypeScript types. Types that plain JSON would mangle are carried through a canonical wire format:

| Type | Wire encoding | Survives? |
|------|--------------|-----------|
| `Date` | RFC3339 UTC string | ✓ |
| `bigint` / `int64` | Decimal string | ✓ (no precision loss past 2⁵³) |
| `Decimal` | Decimal string | ✓ (exact, never a binary float) |
| `Uint8Array` / bytes | Base64 | ✓ |
| Discriminated unions (`Dog \| Cat`) | Tagged variant | ✓ |
| Nominal classes | Reconstructed instance | ✓ |
| `readonly T[]` | Preserved element type | ✓ |

Cross-language fidelity: a `Decimal("123.456")` produces the same JSON string from TypeScript, Python Flask, and Python gRPC — verified by the conformance suite.

---

## Logging

All logs go to **stderr** only — stdout is protocol-clean for MCP stdio transport.

| Flag | Env var | Values | Default |
|------|---------|--------|---------|
| `--log-level <level>` | `APIGEN_LOG_LEVEL` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` \| `silent` | `info` |
| `--log-format <format>` | `APIGEN_LOG_FORMAT` | `json` \| `pretty` | plain |
| `--log-file <path>` | `APIGEN_LOG_FILE` | file path | stderr |

---

## Fail-fast guards

The CLI catches common mistakes early with actionable messages:

- **0 functions found:** `--source` points to generated output or a type-only file → `"0 functions found — looks like generated output or the wrong source file."`
- **Missing `decimal.js`:** Your function uses `Decimal` but the package isn't installed → `"function quote takes a Decimal; install \`decimal.js\`."`
- **Non-TS plugin bypass:** `--type py-flask` with `.py` source skips the TS pipeline (which would crash on a non-TS file)

---

## Nx integration

- **Cache-aware generate target:** `@adhd/apigen-generator-nx:generate` — run `apigen generate` as a cached Nx target. See [`packages/apigen/apigen-generator-nx`](../../packages/apigen/apigen-generator-nx).
- **Scaffold a new output plugin:** `nx g @adhd/apigen-generator-nx:plugin <name>` — generates a buildable plugin package implementing the `OutputPlugin` interface. Use this to add a new codegen target (e.g., `nestjs`, `hono`, `spring`) without forking apigen.
- **Scaffold a new host language:** `nx g @adhd/apigen-generator-nx:host <name>` — generates a host-language harness with a "red-by-construction" conformance manifest. Use this to add a new runtime (e.g., Rust, Go, Java) to the polyglot serve topology.

---

## Architecture

apigen works in three stages:

1. **Extract** — Parse your source (TypeScript via ts-morph), infer JSON Schema for every parameter and return type, detect rich types (Date, Decimal, bigint, etc.).
2. **Compose** — Merge schemas across packages, run collision checks (no silent name shadowing).
3. **Project** — Hand the composed descriptor to the selected output plugin for live serving or code generation.

The v2 architecture (`docs/apigen/SPEC.md`) extends this to a polyglot detect → extract → merge → project pipeline with a canonical JSON descriptor as the neutral contract. Python plugins already ship; Rust/Go/Java host languages are designed in the SPEC.

---

## Known real-world consumers

Beyond this monorepo's own `entrypoint/backlog` (hand-wired `extract()`/`composeSchemas()`/`plugin.run()` consumer), apigen-cli is used directly, as a published/local dependency, by external projects:

- **`agent-browser`** (`~/dev/ai/scratch/agent-browser`) — a standalone search/browser-automation toolkit. Its `search-mcp-source.ts` (7 real operations: `search`, `listProviders`, `tripwireStatus`, `clearTripwire`, `chromeStatus`, `launchChrome`, `providerUsage`) is mounted as a live MCP server entirely via apigen-cli — no hand-written MCP glue in that project at all. The exact invocation, taken directly from its production config (`~/.config/opencode/opencode.json`'s `search` MCP server entry):
  ```bash
  npx -y @adhd/apigen-cli run \
    --source /path/to/agent-browser/search-mcp-source.ts \
    --type mcp \
    --log-level silent
  ```
  Verified (2026-07-27) that this same real source file also works correctly with `--use batch` added — a real batch call fanning out `listProviders`/`tripwireStatus` through the live MCP server returned correct results, end-to-end, against agent-browser's actual functions (no fixture, no mock). This is the real consumer that surfaced `BUG-APIGEN-MCP-ROOT-ONEOF-001` (now fixed).

---

## Developing

```bash
npx nx build apigen-cli                    # Bundle (Vite)
npx nx test apigen-cli                     # Test (Vitest — unit + integration)
npx nx run apigen-cli:bench               # Benchmarks (--expose-gc)
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Spec

- **v2 Canonical Spec:** [`docs/apigen/SPEC.md`](../../docs/apigen/SPEC.md) — architecture, canonical descriptor, polyglot topology
- **Guided Tour:** [`docs/apigen/DEMO.md`](../../docs/apigen/DEMO.md) — runnable walk-through from zero
