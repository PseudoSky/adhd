# apigen

**Code-first API generation.** Write ordinary, idiomatic TypeScript functions — nothing
else — and apigen extracts a neutral operation descriptor from them and projects it to
every transport: **MCP, HTTP (Fastify/Express), CLI, JSON Schema**. No hand-authored IDL,
no stubs to implement, no annotations required. **The source functions are the single
source of truth.**

> **New to apigen?** Start with the [Writing Source Files guide](./apigen-core-client/docs/how-to/writing-source-files.md) to learn how to structure your TypeScript for clean endpoints, then see the [CLI README](../../entrypoint/apigen-cli/README.md) to serve them.

```bash
# Source — unchanged, no API awareness
export async function getUser(userId: string): Promise<{ id: string }> { return { id: userId } }

# One command → a running MCP server
npx @adhd/apigen-cli run --source ./api.ts --type mcp
```

---

## Quickstart

See the **[`@adhd/apigen-cli` README](../../entrypoint/apigen-cli/README.md)** for the full command surface. The short version:

```bash
# MCP server (stdio — for AI agents)
npx @adhd/apigen-cli run --source <file.ts> --type mcp

# HTTP API on port 3000
npx @adhd/apigen-cli run --source <file.ts> --type api-fastify --opt port=3000

# Generate a deployable project to disk
npx @adhd/apigen-cli generate --source <file.ts> --type mcp --out-dir ./out
```

HTTP calls use `POST /<namespace>/<fn>` with body `{"data":{…}}`.

---

## Packages

| Package | Role | Has `run()` | Has `generate()` |
|---|---|---|---|
| [`@adhd/apigen-core-client`](./apigen-core-client) | **Extraction engine** — `extract()`, `composeSchemas()`, plugin contracts, types | — | — |
| [`@adhd/apigen-engine-runtime`](./apigen-engine-runtime) | **Dispatch runtime** — `dispatch`, `buildFnTable`, middleware, streaming, logging | — | — |
| [`@adhd/apigen-base-errors`](./apigen-base-errors) | **Error model** — canonical error codes mapped to each transport | — | — |
| [`@adhd/apigen-base-logical`](./apigen-base-logical) | **Logical type codecs** — Date, int64, Decimal, UUID, bytes | — | — |
| [`@adhd/apigen-engine-naming`](./apigen-engine-naming) | **Naming** — case conversion, collision detection, envelope keys | — | — |
| [`@adhd/apigen-engine-gateway`](./apigen-engine-gateway) | **Gateway** — multi-package aggregation with health probes | — | — |
| [`@adhd/apigen-plugin-mcp`](./apigen-plugin-mcp) | MCP server (stdio / sse / streaming-http) | ✓ | ✓ |
| [`@adhd/apigen-plugin-api-fastify`](./apigen-plugin-api-fastify) | Fastify HTTP server | ✓ | ✓ |
| [`@adhd/apigen-plugin-api-express`](./apigen-plugin-api-express) | Express HTTP server | ✓ | ✓ |
| [`@adhd/apigen-plugin-cli-output`](./apigen-plugin-cli-output) | Commander CLI tool | ✓ | ✓ |
| [`@adhd/apigen-plugin-jsonschema`](./apigen-plugin-jsonschema) | JSON Schema files | — | ✓ |
| [`@adhd/apigen-plugin-openapi`](./apigen-plugin-openapi) | Mount: `GET /_meta/openapi` live doc | — | — |
| [`@adhd/apigen-plugin-health`](./apigen-plugin-health) | Mount: `GET /_meta/health` | — | — |
| [`@adhd/apigen-plugin-logger`](./apigen-plugin-logger) | Layer: per-operation logging | — | — |
| [`@adhd/apigen-codegen-openapi`](./apigen-codegen-openapi) | OpenAPI 3.1 document builder | — | — |
| [`@adhd/apigen-generator-nx`](./apigen-generator-nx) | Nx generator (`plugin`) + cache-aware executor (`generate`) | — | — |
| [`@adhd/apigen-python-env`](./python-env) | Python venv provisioning | — | — |

**Pipeline:** `source → apigen-core-client (extract+compose) → schemas → plugin (generate to disk | run live)`,
with `apigen-engine-runtime.dispatch` the single canonical call path every plugin and generated server uses.

---

## v1 (today) vs v2 (the standard)

This tree is the **v1 TypeScript host** — working extraction, dispatch, 5 plugins, and the
standalone CLI. The **canonical, transport-neutral, polyglot v2 standard** (one descriptor,
Layer harness, central validation, metadata envelope, plugin capabilities, unified
`adhd-apigen` CLI + sidecar gateway, polyglot hosts) is specified in
**[`docs/apigen/SPEC.md`](../../docs/apigen/SPEC.md)** and is being built out via the state
machine at `docs/plan/apigen-client-generation/`.

---

## Develop

```bash
npx nx run-many -t build -p apigen-core-client apigen-engine-runtime apigen-cli \
  apigen-generator-nx apigen-plugin-mcp apigen-plugin-api-fastify \
  apigen-plugin-api-express apigen-plugin-cli-output apigen-plugin-jsonschema
npx nx run-many -t test -p apigen-cli            # unit + integration
```
