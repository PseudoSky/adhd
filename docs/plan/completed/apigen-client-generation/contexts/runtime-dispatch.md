# runtime-dispatch — IMPLEMENT DISPATCH UTILITIES IN @adhd/apigen-runtime

**Phase:** runtime · **Depends on:** audit-core · **Parallel with:** runtime-middleware · **Guard:** `npx --yes nx test apigen-runtime --testFile=packages/apigen/runtime/src/test/dispatch.spec.ts`

---

## Goal

Implement the three dispatch utility functions in `@adhd/apigen-runtime`: `needsEnvelopeField`, `dataParamNames`, and `dispatch`. These are pure functions (no side effects, no dependencies beyond types) that every plugin uses in both generate and run modes. After this state, plugins have a single, tested, canonical dispatch path to import.

---

## Semantic Distillation

- **Primitive:** CREATE `packages/apigen/runtime/src/lib/dispatch.ts` — three pure functions.
- **Reference Pattern:** See `[def:dispatch]` in `_shared.md` for the exact signature.
- **Delta Spec:**

### `packages/apigen/runtime/src/lib/dispatch.ts`

```typescript
import type { ComposedSchemas } from './types'

/** Returns true when the composed schema has `field` in input.properties (i.e. an envelope field). */
export function needsEnvelopeField(
  fnSchema: ComposedSchemas[string],
  field: string,
): boolean {
  const props = (fnSchema.input as Record<string, unknown>)?.['properties'] as Record<string, unknown> ?? {}
  return field in props
}

/** Returns ordered domain parameter names (keys of the data: {} sub-object). */
export function dataParamNames(fnSchema: ComposedSchemas[string]): string[] {
  const data = ((fnSchema.input as Record<string, unknown>)?.['properties'] as Record<string, unknown>)?.['data'] as Record<string, unknown> | undefined
  return Object.keys((data?.['properties'] as Record<string, unknown>) ?? {})
}

/**
 * Single canonical dispatch path used by ALL plugins in both generate and run modes.
 * No plugin may inline this logic. [inv:dispatch-single-path]
 */
export async function dispatch(
  fns: Record<string, (...args: unknown[]) => unknown>,
  createClient: ((e: Record<string, unknown>) => Promise<unknown>) | undefined,
  schema: ComposedSchemas[string],
  fnName: string,
  envelope: Record<string, unknown>,
  domainArgs: Record<string, unknown>,
): Promise<unknown> {
  const paramNames = dataParamNames(schema)
  const args = paramNames.map(k => domainArgs[k])

  if (needsEnvelopeField(schema, 'session') && createClient) {
    const ctx = await createClient({ session: envelope['session'] })
    return (fns[fnName] as (ctx: unknown, ...a: unknown[]) => unknown)(ctx, ...args)
  }
  return fns[fnName](...args)
}
```

### Update `index.ts` (additive — do NOT remove middleware exports from parallel state)

```typescript
// Add to existing exports:
export { needsEnvelopeField, dataParamNames, dispatch } from './lib/dispatch'
```

**MERGE PROTOCOL (parallel with runtime-middleware):** Both states mutate `index.ts`. The executor of whichever completes SECOND should merge both export blocks rather than overwriting. If the parallel state has already added middleware exports, preserve them and append the dispatch exports.

### Test file `dispatch.spec.ts`

```typescript
// Using inline schemas (no file fixture needed)

// Schema with session middleware
const sessionSchema = {
  input: {
    type: 'object',
    properties: {
      session: { type: 'string' },
      data: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
    },
    required: ['session', 'data'],
  },
  output: {},
}

// Schema without session (no middleware)
const noSessionSchema = {
  input: {
    type: 'object',
    properties: {
      data: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
    },
    required: ['data'],
  },
  output: {},
}

// Schema for zero-param function
const zeroParamSchema = {
  input: {
    type: 'object',
    properties: { data: { type: 'object', properties: {} } },
    required: ['data'],
  },
  output: {},
}

describe('needsEnvelopeField', () => {
  it('returns true for session when schema has session', ...)
  it('returns false when schema has no session', ...)
})

describe('dataParamNames', () => {
  it('returns ["userId"] for sessionSchema', ...)
  it('returns ["to"] for noSessionSchema', ...)
  it('returns [] for zeroParamSchema', ...)
})

describe('dispatch', () => {
  it('calls fn directly when no session field', async () => {
    const fn = vi.fn().mockResolvedValue('result')
    const result = await dispatch({ sendEmail: fn }, undefined, noSessionSchema, 'sendEmail', {}, { to: 'a@b.com' })
    expect(fn).toHaveBeenCalledWith('a@b.com')
    expect(result).toBe('result')
  })

  it('calls createClient and passes ctx as first arg when session field present', async () => {
    const ctx = { db: 'mock-db' }
    const createClient = vi.fn().mockResolvedValue(ctx)
    const fn = vi.fn().mockResolvedValue({ id: '1' })
    await dispatch({ getUser: fn }, createClient, sessionSchema, 'getUser', { session: 'tok' }, { userId: '1' })
    expect(createClient).toHaveBeenCalledWith({ session: 'tok' })
    expect(fn).toHaveBeenCalledWith(ctx, '1')
  })

  it('calls fn with no args for zero-param function', async () => {
    const fn = vi.fn().mockResolvedValue([])
    await dispatch({ listAll: fn }, undefined, zeroParamSchema, 'listAll', {}, {})
    expect(fn).toHaveBeenCalledWith()
  })
})
```

- **Invariants:** `[inv:dispatch-single-path]`

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).

```text
mutates:    ["packages/apigen/runtime/src/lib/dispatch.ts",
            "packages/apigen/runtime/src/test/dispatch.spec.ts"]
read_only:  ["packages/apigen/runtime/src/lib/types.ts"]
```

---

## Acceptance criteria

- `[runtime-dispatch.1]` `needsEnvelopeField(sessionSchema, 'session')` returns `true`.
- `[runtime-dispatch.2]` `dataParamNames(sessionSchema)` returns `['userId']`.
- `[runtime-dispatch.3]` `dispatch` calls `createClient` when schema has `session` field; passes ctx as first fn arg.
- `[runtime-dispatch.4]` `dispatch` calls fn directly (no createClient) when no `session` field.
- `[runtime-dispatch.5]` `dispatch` with zero-param function calls fn with no positional args.

---

## Commit points

1. After tests pass: `feat(apigen-runtime): implement dispatch utilities — needsEnvelopeField, dataParamNames, dispatch`
