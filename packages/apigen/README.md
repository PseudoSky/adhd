# apigen

**Code-first API generation.** Write ordinary, idiomatic TypeScript functions — nothing
else — and apigen extracts a neutral operation descriptor from them and projects it to
every transport: **MCP, HTTP (Fastify/Express), CLI, JSON Schema**. No hand-authored IDL,
no stubs to implement, no annotations required. **The source functions are the single
source of truth.**

```bash
# Source — unchanged, no API awareness
export async function getUser(userId: string): Promise<{ id: string }> { return { id: userId } }

# One command → a running MCP server
npx tsx packages/apigen/cli/src/index.ts run --source ./api.ts --type mcp
```

---

## Quickstart

See **[`cli/README.md`](./cli/README.md)** for the full command surface. The short version:

```bash
cd <repo-root>
alias apigen='npx tsx packages/apigen/cli/src/index.ts'

apigen run      --source <file.ts> --type mcp                         # live MCP (stdio)
apigen run      --source <file.ts> --type api-fastify --opt port=3000 # live HTTP API
apigen generate --source <file.ts> --type mcp --out-dir ./out         # write a server to disk
```

HTTP calls use `POST /<namespace>/<fn>` with body `{"data":{…}}`.

---

## Packages

| Package | Role | Platform |
|---|---|---|
| [`@adhd/apigen-core`](./core) | Schema **extraction** (ts-morph + ts-json-schema-generator), composition, shared types & the `OutputPlugin` contract | shared |
| [`@adhd/apigen-runtime`](./runtime) | **Dispatch** runtime — `dispatch`, `buildFnTable`, `describeParams`, middleware, `createLogger` | shared |
| [`@adhd/apigen-cli`](./cli) | The user-facing CLI (`run` / `generate` / `*-registry`) | node |
| [`@adhd/apigen-nx`](./nx) | Nx generator (`plugin`) + cache-aware executor (`generate`) | node |
| `@adhd/apigen-plugin-mcp` ([`plugins/mcp`](./plugins/mcp)) | MCP server target (stdio / sse / streaming-http) | node |
| `@adhd/apigen-plugin-api-fastify` ([`plugins/api-fastify`](./plugins/api-fastify)) | Fastify HTTP target | node |
| `@adhd/apigen-plugin-api-express` ([`plugins/api-express`](./plugins/api-express)) | Express HTTP target | node |
| `@adhd/apigen-plugin-cli-output` ([`plugins/cli`](./plugins/cli)) | Commander CLI target | node |
| `@adhd/apigen-plugin-jsonschema` ([`plugins/jsonschema`](./plugins/jsonschema)) | JSON Schema emitter | node |

**Pipeline:** `source → core (extract+compose) → schemas → plugin (generate to disk | run live)`,
with `runtime.dispatch` the single canonical call path every plugin and generated server uses.

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
npx nx run-many -t build -p apigen-core apigen-runtime apigen-cli apigen-nx \
  apigen-plugin-mcp apigen-plugin-api-fastify apigen-plugin-api-express \
  apigen-plugin-cli-output apigen-plugin-jsonschema
npx nx run-many -t test -p apigen-cli            # unit + integration
```
