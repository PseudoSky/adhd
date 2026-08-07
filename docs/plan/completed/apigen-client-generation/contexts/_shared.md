# _shared.md — Centralized definitions for apigen-client-generation

> **Rule:** States cite `[def:X]`, `[shape:X]`, `[inv:X]` tags from this file — they do NOT restate these.

---

## [ref:reference-codebase]

All implementation states should read from the reference codebase at `~/dev/projects/reverse-apis/` before writing code. The reference implementation is working and production-grade. The new packages are an extraction + redesign — the algorithms are the same, the APIs are redesigned. REFERENCES.md at `~/dev/projects/reverse-apis/docs/plans/client-generation/REFERENCES.md` gives the reading order.

Key files to read per concern:
- **Schema extraction:** `tools/executors/generate-schemas/executor.ts` (lines 299–400: `getParams`, `schemaForType`, `typeToJsonSchemaFallback`, `buildInputSchema`)
- **Middleware types:** `packages/system/middleware/src/lib/types.ts`
- **composeSchemas:** `packages/system/service/src/lib/compose-schemas.ts`
- **buildContext/EventBus:** `packages/system/service/src/lib/compose-context.ts`
- **createApiPackage:** `packages/system/service/src/lib/create-api-package.ts`
- **envelope-utils:** `packages/system/service/src/lib/envelope-utils.ts` (the two pure helper functions)
- **MCP plugin pattern:** `packages/mcp-reverse-apis/src/index.ts` + `bin.ts`
- **Fastify plugin pattern:** `apps/adhd-reverse-apis/src/app/routes/api.ts`
- **Registry discovery:** `tools/executors/generate-api-registry/executor.ts`
- **Nx scaffold generator:** `tools/generators/api-package/generator.ts`

**Key design divergences from reference codebase (new spec wins):**

| Concern | Reference (reverse-apis) | New design (AGENT_PROMPT) |
|---|---|---|
| `eventMapping` shape | `{ handlerName: string[] }` (name → selectors) | `{ selector: handler }` (selector → function) |
| CLI flag | `--output <plugin>` | `--type <plugin>` |
| Transport selection | Separate packages (`mcp-stdio`, `api-mcp`) | Single `plugin-mcp` with `--transport` option |
| Export mode flag | `--export <name>` or `--export default` | Same, but handled by `ExportMode` type union |
| Package naming | `@adhd/reverse-apis-<id>` | `@adhd/apigen-plugin-<target>` |

---

## [def:GeneratedSchemas]

The output of `generateSchemas()`. Produced by `@adhd/apigen-core`. Represents domain schemas only — no middleware envelope fields.

```typescript
interface GeneratedSchemas {
  metadata: { namespace: string; phase: string }
  schemas: Record<string, {
    input:  Record<string, unknown>  // JSON Schema — domain params only
    output: Record<string, unknown>  // JSON Schema — resolved return type (Promise<T> unwrapped)
  }>
}
```

## [def:ComposedSchemas]

The output of `composeSchemas()` or `createApiPackage()`. Domain schemas + middleware envelope fields merged. The `data: {}` wrapper is **always present** even for zero-param functions.

```typescript
type ComposedSchemas = Record<string, {
  input:  Record<string, unknown>
  output: Record<string, unknown>
}>
```

## [def:ExportMode]

The three extraction modes. Mutually exclusive.

```typescript
type ExportMode =
  | { type: 'named' }                        // default
  | { type: 'default' }                      // export default { ... }
  | { type: 'named-object'; name: string }   // export const myApi = { ... }
```

## [def:MiddlewareDef]

```typescript
interface MiddlewareDef<
  TEnvelope extends object = object,
  TContext extends object = object
> {
  id: string
  envelope?: Record<string, unknown>
  createContext?: (ctx: object) => TContext | Promise<TContext>
  eventMapping?: Record<string, (event: MiddlewareEvent) => void | Promise<void>>
}

interface MiddlewareEvent {
  module: string
  method: string
  lifecycle: 'start' | 'complete' | 'error'
  ctx: object
  error?: unknown
}
```

## [def:OutputPlugin]

The interface all output plugins implement. Language-agnostic — `files` contains `{ path, content }` tuples; a Python gRPC plugin emits `.py` files, a TypeScript plugin emits `.ts` files.

```typescript
interface PluginInput {
  packages: Array<{
    id: string
    schemas: ComposedSchemas
    importPath: string
    fns?: Record<string, (...args: unknown[]) => unknown>
    createClient?: (envelope: Record<string, unknown>) => Promise<unknown>
  }>
  outputDir: string
  options: Record<string, unknown>
}

interface PluginOutput {
  files: Array<{ path: string; content: string }>
  postCommands?: string[]
}

interface RunInput extends PluginInput {
  signal?: AbortSignal
}

interface OutputPlugin {
  id: string
  description: string
  optionsSchema?: Record<string, unknown>
  generate(input: PluginInput): PluginOutput | Promise<PluginOutput>
  run?(input: RunInput): Promise<void>
}
```

## [def:dispatch]

The **single canonical dispatch function** used by every plugin in both generate and run modes. Located in `@adhd/apigen-runtime`. No plugin may inline dispatch logic.

```typescript
async function dispatch(
  fns: Record<string, (...args: unknown[]) => unknown>,
  createClient: ((e: Record<string, unknown>) => Promise<unknown>) | undefined,
  schema: ComposedSchemas[string],
  fnName: string,
  envelope: Record<string, unknown>,
  domainArgs: Record<string, unknown>,
): Promise<unknown>
```

## [def:ApiPackageResult]

```typescript
interface ApiPackageResult {
  schemas: ComposedSchemas
  createClient: (envelope: Record<string, unknown>) => Promise<object>
}
```

## [shape:ComposedInput — with session middleware]

```json
{
  "type": "object",
  "properties": {
    "session": { "type": "string" },
    "data": {
      "type": "object",
      "properties": { "userId": { "type": "string" } },
      "required": ["userId"]
    }
  },
  "required": ["session", "data"]
}
```

## [shape:ComposedInput — with override suppressing session]

```json
{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": { "userId": { "type": "string" } },
      "required": ["userId"]
    }
  },
  "required": ["data"]
}
```

## [shape:DomainInput — named exports no ctx]

```json
{ "type": "object", "properties": { "to": { "type": "string" }, "subject": { "type": "string" } }, "required": ["to", "subject"] }
```

## [shape:McpToolCallResponse]

```json
{ "content": [{ "type": "text", "text": "<JSON.stringify(result)>" }] }
```

## [shape:PluginOptions — mcp]

```typescript
// PluginInput.options for @adhd/apigen-plugin-mcp
{
  transport?: 'stdio' | 'sse' | 'streaming-http'  // default: 'stdio'
  port?: number                                     // default: 3000 (HTTP transports only)
  toolDescriptions?: Record<string, string>         // override fn-name-as-description
}
```

## [shape:PluginOptions — api-fastify / api-express]

```typescript
{
  port?: number          // default: 3000
  routePrefix?: string   // default: '/'
}
```

## [shape:PluginOptions — cli-output]

```typescript
{
  name?: string     // CLI binary name, default: 'cli'
  version?: string  // version string, default: '0.1.0'
}
```

---

## [inv:ctx-name-only]

`ctx` is excluded from generated schemas by **name match only**: `p.getName() === 'ctx'`. No type checking. This is enforced in `generateSchemas()` — all three extraction modes apply it.

## [inv:data-wrapper-always-present]

The `data: {}` sub-object in `composeSchemas()` output is **always present** in `input.properties`, even when the function has zero parameters. `data` is always in `required`.

## [inv:false-suppresses-middleware]

Overrides use `false` to suppress a middleware's envelope contribution. `null`, `undefined`, or `0` are NOT valid suppressors. The `createApiPackage` validation checks for `false` specifically.

## [inv:dispatch-single-path]

`dispatch()` from `@adhd/apigen-runtime` is the only path through which plugins call domain functions. No plugin may copy or inline this logic.

## [inv:type-flag-only]

The CLI uses `--type <plugin-id>` to select output targets. The `--output` flag does NOT exist in this implementation.

## [inv:language-agnostic-output]

`PluginOutput.files` is `Array<{ path: string; content: string }>`. Plugins may emit any file language. Nothing in the core/runtime/CLI layer restricts content to TypeScript.

## [inv:nx-platform-tags]

All `packages/apigen/` packages use Nx tags:
- `@adhd/apigen-core`, `@adhd/apigen-runtime`: `layer:logic,platform:shared`
- `@adhd/apigen-plugin-*`, `@adhd/apigen-cli`, `@adhd/apigen-nx`: `layer:logic,platform:node`

---

## [conv:fixture-samples]

**Every behavioral audit derives its expected observable from the fixture — no literal is ever baked into a check or probe.** This keeps the tool generalized: the same probe proves correctness for *any* fixture.

Each entrypoint-driving fixture (`real-api.ts`, the registry `pkg-*/index.ts` files, `default-api.ts`, `object-api.ts`) exports a `__samples__` map alongside its functions:

```typescript
// __samples__ maps each exported fn name → the argument object the probe sends
// as the MCP `data` payload (and the positional args it spreads in-process).
export const __samples__: Record<string, Record<string, unknown>> = {
  getUser:    { userId: 'abc' },
  listUsers:  {},
  createUser: { name: 'Bob', role: 'admin' },
  ping:       {},
  sendEmail:  { to: 'a@b.com', subject: 'hi' },
}
```

Rules:
1. `__samples__` is NOT an exported API function — the probe and every extractor MUST skip the key `__samples__` (and any non-function export) when computing the tool set.
2. The **expected tool set** = the fixture's exported function names (everything callable, minus `__samples__`). Derived at runtime by `import()`-ing the fixture in-process.
3. The **ground-truth output** for a function = the value returned by calling that export directly, in-process, with its `__samples__` args spread in `dataParamNames` order (ctx omitted — the convention strips it). The probe deep-equals the entrypoint's result against this in-process value.
4. A fixture export with no `__samples__` entry is sampled with `{}` (zero-arg). Functions whose direct call needs a `ctx` first arg receive `undefined` for `ctx` (the fixtures tolerate `ctx: unknown`).

This gives the audit teeth for free: rename an export → the derived tool set changes → entrypoint's `tools/list` no longer matches → red. Break dispatch → the entrypoint's value differs from the in-process ground truth → red.
