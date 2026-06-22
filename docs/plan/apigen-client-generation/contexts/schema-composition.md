# schema-composition — IMPLEMENT composeSchemas() IN @adhd/apigen-core

**Phase:** foundation · **Depends on:** core-types · **Parallel with:** schema-extraction · **Guard:** `npx --yes nx test apigen-core --testFile=packages/apigen/core/src/test/compose-schemas.spec.ts`

---

## Goal

Implement `composeSchemas()` — takes `GeneratedSchemas` + an array of middleware defs + optional overrides and returns `ComposedSchemas`. After this state, the composition logic correctly wraps domain params in `data: {}`, merges middleware envelope fields, and applies `false` overrides to suppress per-function middleware fields.

This is parallel with `schema-extraction` because they write disjoint files. `composeSchemas` only reads `middleware.envelope` (a plain `Record<string, unknown>`) — it does NOT need the full runtime middleware system (that comes in `runtime-middleware`).

---

## Semantic Distillation

- **Primitive:** CREATE `packages/apigen/core/src/lib/compose-schemas.ts` — pure function, no deps other than types.
- **Reference Pattern:** Read `~/dev/projects/reverse-apis/packages/system/service/src/lib/compose-schemas.ts` — the working implementation. Also read `compose-schemas.spec.ts` in the same directory for the exact override semantics tested. The new implementation differs only in API shape (it's a pure function with explicit middleware slim-interface, not importing from `@adhd/reverse-middleware`). See `[ref:reference-codebase]` and `[shape:ComposedInput — with session middleware]` in `_shared.md`.
- **Delta Spec:**

### `packages/apigen/core/src/lib/compose-schemas.ts`

```typescript
import type { GeneratedSchemas, ComposedSchemas } from './types'

interface SlimMiddleware {
  id: string
  envelope?: Record<string, unknown>
}

export function composeSchemas(
  domainSchemas: GeneratedSchemas,
  middlewares: ReadonlyArray<SlimMiddleware>,
  overrides?: Record<string, Record<string, boolean>>,
): ComposedSchemas {
  const result: ComposedSchemas = {}

  for (const [fnName, fnSchema] of Object.entries(domainSchemas.schemas)) {
    const fnOverrides = overrides?.[fnName] ?? {}

    // 1. Collect envelope fragments from active middlewares
    const envelopeProps: Record<string, unknown> = {}
    for (const mw of middlewares) {
      if (!mw.envelope) continue
      // Override with false suppresses this middleware's envelope for this fn
      if (fnOverrides[mw.id] === false) continue  // [inv:false-suppresses-middleware]
      Object.assign(envelopeProps, mw.envelope)
    }

    // 2. data: {} wrapper — always present, even for zero-param fns [inv:data-wrapper-always-present]
    const domainInput = fnSchema.input as { type?: string; properties?: Record<string, unknown>; required?: string[] }
    const dataSchema: Record<string, unknown> = {
      type: 'object',
      properties: domainInput.properties ?? {},
    }
    if (domainInput.required && domainInput.required.length > 0) {
      ;(dataSchema as Record<string, unknown>)['required'] = domainInput.required
    }

    // 3. Merge: envelope fields + data wrapper
    const required = [...Object.keys(envelopeProps), 'data']
    result[fnName] = {
      input: {
        type: 'object',
        properties: { ...envelopeProps, data: dataSchema },
        required,
      } as Record<string, unknown>,
      output: fnSchema.output,
    }
  }

  return result
}
```

### Update `index.ts`

Replace the `composeSchemas` stub:
```typescript
export { composeSchemas } from './lib/compose-schemas'
```

### Test file `compose-schemas.spec.ts`

**Fixtures used (no file writes needed — inline in test):**

```typescript
const domainSchemas: GeneratedSchemas = {
  metadata: { namespace: 'test', phase: '' },
  schemas: {
    getUser: {
      input: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
      output: { type: 'object' },
    },
    sendEmail: {
      input: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' } }, required: ['to', 'subject'] },
      output: { type: 'null' },
    },
    listAll: {
      // zero params (ctx was the only param, filtered by generateSchemas)
      input: { type: 'object', properties: {}, required: [] },
      output: { type: 'array' },
    },
  },
}

const sessionMiddleware = { id: 'session', envelope: { session: { type: 'string' } } }
```

**Test cases:**

1. **No middleware** — `data` wrapper is present; envelope is empty; only `data` in `required`
2. **Session middleware, no overrides** — `session` in `required`; `data` in `required`; `data.properties.userId` present
3. **Session middleware + override `{ getUser: { session: false } }`** — `getUser.input` has no `session`; `sendEmail.input` still has `session`  [dod.4]
4. **Zero-param function with session middleware** — `data.properties` is empty `{}`; `data` still in `required`; `session` in `required`
5. **Multiple middlewares** — both envelope fields appear when no overrides
6. **Override with non-boolean (should not suppress)** — only `false` suppresses; `undefined`/`null` do not

- **Invariants:** `[inv:data-wrapper-always-present]`, `[inv:false-suppresses-middleware]`

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).

```text
mutates:    ["packages/apigen/core/src/lib/compose-schemas.ts",
            "packages/apigen/core/src/test/compose-schemas.spec.ts"]
read_only:  ["packages/apigen/core/src/lib/types.ts"]
```

---

## Acceptance criteria

- `[schema-composition.1]` No middleware: composed schema has `data` in `required` and `properties`; no other keys in `properties`.
- `[schema-composition.2]` Session middleware: `required` includes both `session` and `data`.
- `[schema-composition.3]` Override `{ getUser: { session: false } }`: `getUser.input.properties` has no `session` key; `sendEmail.input.properties` still has `session`.
- `[schema-composition.4]` Zero-param function: `data` is in `required`; `data.properties` is `{}`.
- `[schema-composition.5]` `false` is the ONLY value that suppresses; `null` does not suppress:
  ```bash
  # confirmed by test case 6 in spec
  npx --yes nx test apigen-core --testFile=packages/apigen/core/src/test/compose-schemas.spec.ts
  ```

---

## Commit points

1. After test suite passes: `feat(apigen-core): implement composeSchemas() — envelope merge, data wrapper, false-override suppression`
