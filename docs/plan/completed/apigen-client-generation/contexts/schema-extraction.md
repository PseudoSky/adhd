# schema-extraction — IMPLEMENT generateSchemas() IN @adhd/apigen-core

**Phase:** foundation · **Depends on:** core-types · **Parallel with:** schema-composition · **Guard:** `npx --yes nx test apigen-core --testFile=packages/apigen/core/src/test/generate-schemas.spec.ts`

---

## Goal

Implement `generateSchemas()` — the function that reads a TypeScript source file and returns `GeneratedSchemas`. After this state, all three extraction modes work, `ctx` parameters are filtered, optional params are marked non-required, `Promise<T>` is unwrapped, and the test suite passes.

This state is parallel with `schema-composition` because they write disjoint files in `@adhd/apigen-core`.

---

## Semantic Distillation

- **Primitive:** CREATE `packages/apigen/core/src/lib/generate-schemas.ts` + extractors + schema builders.
- **Reference Pattern:** Read `~/dev/projects/reverse-apis/tools/executors/generate-schemas/executor.ts` — specifically `getParams` (line ~299, ctx filter), `schemaForType` + `typeToJsonSchemaFallback` (two-tier schema builder), `buildInputSchema` / `buildOutputSchema`, and the extraction functions `extractFromExportedFunctions` / `extractFromExportedObject`. This is the reference implementation. Extract and generalize — do not copy the executor shell. See `[ref:reference-codebase]` in `_shared.md`. Parameter-name extraction conforms to the vendored ts-morph contract `[iface:ts-morph]`; JSON-Schema generation from TS types conforms to `[iface:ts-json-schema-generator]` (both in `interfaces.json`).
- **Delta Spec:**

### Install dependencies

Add to `packages/apigen/core/package.json` `dependencies`:
```json
{
  "ts-morph": "^23.0.0",
  "ts-json-schema-generator": "^2.3.0"
}
```
Run `npm install` from repo root.

### File layout

```
packages/apigen/core/src/lib/
├── generate-schemas.ts           ← orchestrator
├── extractors/
│   ├── named.ts                  ← Mode 1: named export functions
│   ├── default-export.ts         ← Mode 2: export default { ... }
│   └── named-object.ts           ← Mode 3: export const api = { ... }
└── schema-builders/
    ├── ts-json-schema.ts          ← ts-json-schema-generator wrapper
    └── morph-fallback.ts          ← ts-morph recursive fallback (depth-limit 6)
```

### `generate-schemas.ts` orchestrator

```typescript
import { Project, SourceFile } from 'ts-morph'
import type { GenerateSchemasOptions, GeneratedSchemas } from './types'
import { extractNamed } from './extractors/named'
import { extractDefault } from './extractors/default-export'
import { extractNamedObject } from './extractors/named-object'
import { buildSchema } from './schema-builders/ts-json-schema'

export async function generateSchemas(opts: GenerateSchemasOptions): Promise<GeneratedSchemas> {
  const { sourceFile: filePath, exportMode = { type: 'named' }, namespace = '', phase = '' } = opts
  const project = new Project({ skipAddingFilesFromTsConfig: true })
  const sf: SourceFile = project.addSourceFileAtPath(filePath)

  let fns: Array<{ name: string; params: Array<{ name: string; type: string; optional: boolean }>; returnType: string }>
  if (exportMode.type === 'named') fns = extractNamed(sf)
  else if (exportMode.type === 'default') fns = extractDefault(sf)
  else fns = extractNamedObject(sf, exportMode.name)

  const schemas: GeneratedSchemas['schemas'] = {}
  for (const fn of fns) {
    const domainParams = fn.params.filter(p => p.name !== 'ctx')  // [inv:ctx-name-only]
    const required = domainParams.filter(p => !p.optional).map(p => p.name)
    const properties: Record<string, unknown> = {}
    for (const p of domainParams) {
      properties[p.name] = await buildSchema(project, sf, p.type)
    }
    const rawReturn = fn.returnType
    const resolvedReturn = rawReturn.replace(/^Promise<(.+)>$/, '$1').trim()
    const outputSchema = await buildSchema(project, sf, resolvedReturn)
    schemas[fn.name] = {
      input: { type: 'object', properties, required } as Record<string, unknown>,
      output: outputSchema,
    }
  }

  return { metadata: { namespace, phase }, schemas }
}
```

### Extractors

Each extractor returns `Array<{ name, params: Array<{ name, type, optional }>, returnType }>`.

**`extractors/named.ts`** — enumerate exported function declarations + exported function-valued consts. Silently skip non-function exports (e.g. `export const VERSION = '1.0.0'`).

```typescript
import { SourceFile } from 'ts-morph'
type FnMeta = { name: string; params: { name: string; type: string; optional: boolean }[]; returnType: string }

export function extractNamed(sf: SourceFile): FnMeta[] {
  const result: FnMeta[] = []
  for (const fn of sf.getFunctions()) {
    if (!fn.isExported()) continue
    result.push(toMeta(fn.getName() ?? '', fn.getParameters(), fn.getReturnType().getText()))
  }
  for (const decl of sf.getVariableDeclarations()) {
    if (!decl.isExported()) continue
    const init = decl.getInitializer()
    if (!init) continue
    const text = init.getKindName()
    if (!['ArrowFunction', 'FunctionExpression'].includes(text)) continue
    const arrowOrFn = init as import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression
    result.push(toMeta(decl.getName(), arrowOrFn.getParameters(), arrowOrFn.getReturnType().getText()))
  }
  return result
}
```

**`extractors/default-export.ts`** — read `export default { ... }` object literal; each property whose value is a function becomes an endpoint. Skip non-function properties.

**`extractors/named-object.ts`** — find `export const <name> = { ... }`; each property becomes an endpoint. Same non-function skip logic.

### Schema builders

**`schema-builders/ts-json-schema.ts`** — try `ts-json-schema-generator` first:
```typescript
import { createGenerator, Config } from 'ts-json-schema-generator'
import { Project, SourceFile } from 'ts-morph'
import { morphFallback } from './morph-fallback'

export async function buildSchema(project: Project, sf: SourceFile, typeText: string): Promise<Record<string, unknown>> {
  if (['void', 'undefined', 'null', 'Promise<void>'].includes(typeText)) return { type: 'null' }
  try {
    const config: Config = { path: sf.getFilePath(), type: typeText, skipTypeCheck: true }
    const schema = createGenerator(config).createSchema(typeText)
    return schema as Record<string, unknown>
  } catch {
    return morphFallback(typeText, 0)
  }
}
```

**`schema-builders/morph-fallback.ts`** — recursive fallback for primitives, arrays, unions, and anonymous object shapes. Depth-limited to 6:

```typescript
export function morphFallback(typeText: string, depth: number): Record<string, unknown> {
  if (depth > 6) return {}
  const t = typeText.trim()
  if (t === 'string') return { type: 'string' }
  if (t === 'number') return { type: 'number' }
  if (t === 'boolean') return { type: 'boolean' }
  if (t === 'null') return { type: 'null' }
  if (t === 'undefined') return { type: 'null' }
  if (t.endsWith('[]')) return { type: 'array', items: morphFallback(t.slice(0, -2), depth + 1) }
  if (t.includes('|')) {
    const variants = t.split('|').map(v => v.trim())
    // Check if all are string literals
    if (variants.every(v => v.startsWith("'"))) {
      return { type: 'string', enum: variants.map(v => v.replace(/'/g, '')) }
    }
    return { anyOf: variants.map(v => morphFallback(v, depth + 1)) }
  }
  // Anonymous object: { key: type; key2: type2 }
  if (t.startsWith('{') && t.endsWith('}')) {
    const inner = t.slice(1, -1).trim()
    const props: Record<string, unknown> = {}
    for (const part of inner.split(';').filter(Boolean)) {
      const [k, v] = part.split(':').map(s => s.trim())
      if (k && v) props[k.replace('?', '')] = morphFallback(v, depth + 1)
    }
    return { type: 'object', properties: props }
  }
  return {}  // unknown complex type — return empty schema
}
```

### Update `index.ts`

Replace the `generateSchemas` stub with the real import:
```typescript
export { generateSchemas } from './lib/generate-schemas'
```

### Test fixtures

**`src/test/fixtures/named-exports.ts`** — covers: named export fn, exported arrow fn const, non-fn export (ignored), optional param, complex return type:
```typescript
export async function getUser(userId: string): Promise<{ id: string; name: string }> {
  return { id: userId, name: 'test' }
}
export const sendEmail = async (to: string, subject: string, body?: string): Promise<void> => {}
export const VERSION = '1.0.0'  // should be ignored
```

**`src/test/fixtures/default-export.ts`**:
```typescript
export default {
  getUser: (userId: string) => ({ id: userId }),
  deleteUser: (userId: string): void => {},
}
```

**`src/test/fixtures/named-object.ts`**:
```typescript
export const myApi = {
  getUser: (userId: string) => ({ id: userId }),
}
```

**`src/test/fixtures/ctx-param.ts`**:
```typescript
interface DbContext { db: unknown }
export async function getUser(ctx: DbContext, userId: string): Promise<{ id: string }> {
  return { id: userId }
}
// Zero-param function
export async function listAll(ctx: DbContext): Promise<string[]> { return [] }
```

### Test file `generate-schemas.spec.ts`

Cover:
- Named exports: getUser has `userId` in `data.properties`; sendEmail has `to`, `subject`; `body` is not in `required`; VERSION not in schemas
- Default export: both fns appear
- Named object: fn appears
- ctx filtering: no `ctx` in any schema's input properties `[dod.3]`
- Zero-param with ctx: `data.properties` is empty object `{}`; `data` still present
- Promise<T> unwrapped: `getUser.output` schema represents `{ id, name }` not `Promise<...>`

- **Invariants:** `[inv:ctx-name-only]`

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).

```text
mutates:    ["packages/apigen/core/src/lib/generate-schemas.ts",
            "packages/apigen/core/src/lib/extractors/named.ts",
            "packages/apigen/core/src/lib/extractors/default-export.ts",
            "packages/apigen/core/src/lib/extractors/named-object.ts",
            "packages/apigen/core/src/lib/schema-builders/ts-json-schema.ts",
            "packages/apigen/core/src/lib/schema-builders/morph-fallback.ts",
            "packages/apigen/core/src/test/generate-schemas.spec.ts",
            "packages/apigen/core/src/test/fixtures/named-exports.ts",
            "packages/apigen/core/src/test/fixtures/default-export.ts",
            "packages/apigen/core/src/test/fixtures/named-object.ts",
            "packages/apigen/core/src/test/fixtures/ctx-param.ts",
            "package.json"]
read_only:  ["packages/apigen/core/src/lib/types.ts"]
```

---

## Acceptance criteria

- `[schema-extraction.1]` Named exports: `schemas` has `getUser` and `sendEmail`; `VERSION` is absent:
  ```bash
  npx --yes vitest run packages/apigen/core/src/test/generate-schemas.spec.ts --reporter=verbose 2>&1 | grep -E "PASS|FAIL"
  ```
- `[schema-extraction.2]` `ctx` first param is excluded: `schemas.getUser.input.properties` has no `ctx` key.
- `[schema-extraction.3]` Optional param `body` in sendEmail: not in `required` array.
- `[schema-extraction.4]` `Promise<T>` unwrapped: `schemas.getUser.output` is an object schema, not `Promise<...>`.
- `[schema-extraction.5]` Default export mode: both functions appear as endpoints.
- `[schema-extraction.6]` Named object mode: `myApi.getUser` appears.
- `[schema-extraction.7]` Zero-param-with-ctx: `schemas.listAll.input.properties.data.properties` is empty `{}`.

---

## Commit points

1. After test suite passes: `feat(apigen-core): implement generateSchemas() with ts-morph + ts-json-schema-generator, all 3 extraction modes`
