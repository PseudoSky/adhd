# Writing Source Files for apigen

How to structure your TypeScript source files so apigen produces clean, predictable API endpoints, MCP tools, and CLI commands — with no annotations, no decorators, and no framework imports.

---

## The rule

**apigen reads your exports.** Every exported function, const, or class method in your source file becomes an operation. The operation's name is derived from the export name. Its input/output schemas are inferred from TypeScript types.

```
my-service/api.ts
  ├── export async function getUser(id: string) → tool/route: "api/getUser"
  ├── export async function createUser(name: string) → tool/route: "api/createUser"
  └── export const CONFIG = { ... } → query tool/route: "api/CONFIG"
```

No decorators, no annotations, no framework imports. **The function signature is the contract.**

---

## Export patterns

apigen handles three export shapes. Choose the one that fits your codebase:

### 1. Named function exports (recommended)

```ts
export async function getUser(id: string): Promise<User> { ... }
export async function createUser(name: string, email: string): Promise<User> { ... }
```

Each named export becomes an operation with `id = <namespace>/<exportName>`.

- **Route:** `POST /<namespace>/getUser`, `POST /<namespace>/createUser`
- **Tool name:** `getUser`, `createUser`
- **Best for:** most APIs, clearest naming

### 2. Named-object export (grouped under one name)

```ts
export const api = {
  getUser: async (id: string) => { ... },
  createUser: async (name: string, email: string) => { ... },
};
```

Used with `--export api` (CLI) or `exportMode: { type: 'named-object', name: 'api' }` (library). Operation ids become `<namespace>/<objectName>/<property>`.

- **Route:** `POST /<namespace>/api/getUser`
- **Best for:** grouping related operations under a version or domain key

### 3. Default export (single function)

```ts
export default async function handler(params: Input): Promise<Output> { ... }
```

Used with `--export default` (CLI). Operation id is the filename stem if the function is anonymous, or the function name if named.

- **Best for:** single-purpose modules (e.g., a Lambda handler)

---

## Naming → routes and tools

| Export name | Route segment | Tool name |
|---|---|---|
| `getUser` | `getUser` | `getUser` |
| `get_user` | `get_user` | `get_user` |
| `GetUser` | `GetUser` | `GetUser` |
| `parseCSV` | `parseCSV` | `parseCSV` |

Names are passed through **as-is** — apigen does not case-convert route segments. If you want kebab-case URLs, name your functions with hyphens (not valid in JS identifiers), or use a [projection config file](#projection-override) to remap routes.

### What makes a good operation name

```
getUser           ✓ clear, tells you what it does
createUser        ✓ imperative verb + noun
processFile       ✓
doStuff           ✗ too vague
handleIt          ✗ tells you nothing
helper            ✗ will be exported but shouldn't be
_privateFn        ✗ _-prefixed → excluded (opt-out ladder)
```

**Guidelines:**
- Use **imperative verbs** for actions: `getUser`, `createOrder`, `deleteRecord`
- Use **nouns** for data queries: `userConfig`, `productList`
- Prefix internal helpers with `_` to exclude them: `_validateInput`, `_formatOutput`
- Keep names short but descriptive — they become part of your API surface

---

## Type annotations → JSON Schema

Every parameter and return type is inferred as JSON Schema 2020-12. Here's how common TypeScript types map:

```ts
export async function example(
  id: string,                        // → { type: 'string' }
  count: number,                     // → { type: 'number' }
  active: boolean,                   // → { type: 'boolean' }
  tags: string[],                    // → { type: 'array', items: { type: 'string' } }
  meta: Record<string, unknown>,     // → { type: 'object', additionalProperties: true }
  options?: {                        // → { type: 'object', properties: {...} }
    format: 'json' | 'csv',          // → { enum: ['json', 'csv'] }
    limit: number,
  },
  user: User,                        // → { $ref: '#/$defs/User' } or inlined type
): Promise<{ id: string; name: string }>  // → { type: 'object', properties: {...} }
```

### Rich types that survive the wire

| Type | Wire encoding | Example |
|------|--------------|---------|
| `Date` | RFC 3339 UTC string | `"2024-12-01T00:00:00.000Z"` |
| `bigint` | Decimal string | `"9007199254740993"` |
| `Decimal` (from `decimal.js`) | Decimal string | `"123.456"` |
| `Uint8Array` | Base64 string | `"SGVsbG8="` |
| `Dog \| Cat` (discriminated union) | Tagged object | `{ type: 'dog', bark: ... }` |
| Nominal/branded types | Reconstructed on the other side | `type UserId = string & { __brand: 'UserId' }` |

These types produce the same JSON bytes from TypeScript, Python, or any other host language — verified by the conformance suite.

### What to avoid in parameter types

- `any` — produces `{}` (no constraint). Prefer `unknown` or a specific type.
- `Function` / `() => void` — not serializable. apigen marks these as `{}`.
- Circular type references — the schema generator will error. Break the cycle with an intermediate interface.
- Very large union types — the generated schema can be large but works. If it causes startup delays, consider splitting the file.

---

## Safe vs unsafe → GET vs POST

apigen classifies each operation as **safe** (GET-eligible) or **unsafe** (POST-only). This determines the HTTP verb when using `api-fastify` or `api-express`:

| Classification | HTTP verb | When |
|---|---|---|
| **Safe** | `GET` | All parameters are **primitive-only** (string, number, boolean, their arrays, and optional variants). No side-effect implied. |
| **Unsafe** | `POST` | Any parameter is an object, record, or complex type. Mutating endpoints should be POST. |

### How safety is determined

```ts
// Safe — GET /api/getUser?id=abc
export async function getUser(id: string): Promise<User> {
  return db.find(id);
}

// Safe — GET /api/search?q=hello&limit=10
export async function search(q: string, limit?: number): Promise<Result[]> {
  return db.query(q, limit);
}

// Unsafe — POST /api/createUser (body has nested object)
export async function createUser(input: { name: string; email: string }): Promise<User> {
  return db.insert(input);
}

// Unsafe — POST /api/upload (body has complex type)
export async function upload(file: { name: string; data: Uint8Array }): Promise<string> {
  return storage.put(file);
}
```

> **Override safety** via a [projection config file](#projection-override) when the heuristic doesn't match your semantics.

---

## The `ctx` parameter convention

The **first parameter named `ctx`** is special — apigen excludes it from the inferred schema and does not expect it from the caller. Instead, `ctx` is injected at dispatch time by the layer stack.

```ts
// ctx is injected — not part of the API schema
export async function getUser(ctx: LayerContext, id: string): Promise<User> {
  // ctx.get(Logger) — read logger seeded by loggerPlugin
  // ctx.get(Session) — read auth context seeded by auth middleware
  return db.find(id);
}
```

When the source has a `ctx` first parameter, the composed schema records `hasCtx: true`. The dispatch runtime automatically prepends the `ctx` value when calling the function, so callers only pass the domain parameters.

**Use ctx for:**
- Reading per-request loggers (seeded by `loggerPlugin`)
- Reading auth/session context (seeded by custom middleware)
- Accessing the `AbortSignal`
- Setting response metadata (envelope fields)

---

## What NOT to export

apigen exports everything it finds. **Don't export things that aren't API operations.**

```ts
// ❌ Type-only exports — these become empty operations
export type User = { id: string; name: string };
export interface Config { ... }

// ❌ Internal helpers leaked as exports
export function validateEmail(email: string): boolean { ... }

// ❌ Constants as API endpoints (sometimes useful, usually not)
export const DATABASE_URL = '...';

// ✅ Internal helpers — make them private
function validateEmail(email: string): boolean { ... }
const DATABASE_URL = '...';
```

**Opt-out ladder** (in priority order):
1. Don't export it — use `function` not `export function`
2. Prefix with `_` — `_validate` is skipped
3. Use a named-object export (`export const api = { only: [these] }`) with `--export api`

---

## Namespace and routing

The **namespace** is a route/tool prefix that groups operations from one source file.

```ts
// namespace = "users"
export async function get(id: string) { ... }    // → users/get
export async function create(name: string) { ... }  // → users/create
```

| How namespace is set | CLI flag | Library option |
|---|---|---|
| Explicit | `--namespace users` | `{ namespace: 'users' }` in `extract()` |
| From tsconfig folder name | default | default |
| Custom | `--config projection.json` | projection config |

**Resulting routes:**

```
POST /<namespace>/<fn>              → POST /users/create
GET  /<namespace>/<fn>?param=val    → GET  /users/get?id=abc
MCP tool name                       → "users/get", "users/create"
```

---

## Multiple source files

Each source file becomes a separate namespace. Pass multiple `--source` flags to the CLI or multiple packages to `plugin.run()`:

```bash
apigen run --source users.ts --source orders.ts --type api-fastify --opt port=3000
```

```ts
plugin.run({
  packages: [
    { id: 'users', schemas: usersSchemas, fns: usersModule, importPath: './users.ts' },
    { id: 'orders', schemas: ordersSchemas, fns: ordersModule, importPath: './orders.ts' },
  ],
  // ...
});
```

Each namespace gets its own route prefix:

```
POST /users/create
POST /orders/create
GET  /orders/get?id=abc
```

---

## Using plugins

Mount and layer plugins add behavior without changing your source file. They're composed at runtime:

- **Mount plugins** add synthetic endpoints (health check, OpenAPI doc)
- **Layer plugins** intercept every request (logging, auth, rate-limiting)

```bash
# CLI: attach plugins with --use
apigen run --source api.ts --type api-fastify --use openapi --use health --use logger
```

```ts
// Library: pass plugins in options.usePlugins
import { openapiPlugin } from '@adhd/apigen-plugin-openapi';
import { healthPlugin } from '@adhd/apigen-plugin-health';
import { loggerPlugin } from '@adhd/apigen-plugin-logger';

await apiFastifyPlugin.run({
  packages: [{ id: 'api', schemas, fns: mod }],
  options: {
    port: 3000,
    usePlugins: [openapiPlugin, healthPlugin, loggerPlugin],
  },
  // ...
});
```

Built-in plugins:

| Plugin | Import as | Adds | Configurable |
|---|---|---|---|
| OpenAPI | `@adhd/apigen-plugin-openapi` → `openapiPlugin` | `GET /_meta/openapi` — live OpenAPI 3.1 doc | `title`, `version` |
| Health | `@adhd/apigen-plugin-health` → `healthPlugin` | `GET /_meta/health` — readiness check | `meta` (extra response fields) |
| Logger | `@adhd/apigen-plugin-logger` → `loggerPlugin` | Per-operation structured logging | `level`, `format`, `destination` |

See each plugin's README for full API docs.

---

## Full example

```ts
// api.ts — a well-structured apigen source file
import { Logger } from '@adhd/apigen-plugin-logger';

// Public API — these become endpoints
export async function getUser(ctx: Logger, id: string): Promise<{ id: string; name: string }> {
  ctx.info({ id }, `fetching user ${id}`);
  return { id, name: `User ${id}` };
}

export async function createUser(name: string, email: string): Promise<{ id: string }> {
  return { id: Math.random().toString(36).slice(2) };
}

// Safe → GET /api/searchUsers?q=...
export async function searchUsers(q: string, limit?: number): Promise<Array<{ id: string; name: string }>> {
  return [{ id: '1', name: 'Ada' }];
}

// Internal — not exported, not an endpoint
function validateEmail(email: string): boolean {
  return email.includes('@');
}
```

```bash
# Serve it
npx @adhd/apigen-cli run --source api.ts --type api-fastify --namespace api --opt port=3000 --use openapi --use health --use logger

# Call it
curl -X POST http://localhost:3000/api/createUser \
  -H 'content-type: application/json' \
  -d '{"data":{"name":"Ada","email":"ada@example.com"}}'

curl http://localhost:3000/api/searchUsers?q=Ada

# Check health
curl http://localhost:3000/_meta/health
# → {"status":"ok","host":"ts"}

# View OpenAPI spec
curl http://localhost:3000/_meta/openapi
```

---

## Projection override

For out-of-source verb and naming overrides, use a projection config file:

```json
{
  "http.verb.getUser": "GET",
  "http.verb.deleteUser": "DELETE",
  "namespace.getUser": "v2/get-user"
}
```

Pass it with `--config projection.json` (CLI) or `options.projection` (library).

---

## See also

- [How-To: Running Servers](./running-servers.md) — start servers from your code
- [How-To: Extraction Pipeline](./extraction-pipeline.md) — the extraction internals
- [apigen spec](../../../../docs/apigen/SPEC.md) — full canonical specification
- [CLI README](../../../../entrypoint/apigen-cli/README.md) — command reference
