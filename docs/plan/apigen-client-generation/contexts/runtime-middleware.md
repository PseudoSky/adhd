# runtime-middleware — IMPLEMENT MIDDLEWARE SYSTEM IN @adhd/apigen-runtime

**Phase:** runtime · **Depends on:** audit-core · **Parallel with:** runtime-dispatch · **Guard:** `npx --yes nx test apigen-runtime --testFile=packages/apigen/runtime/src/test/api-package.spec.ts`

---

## Goal

Build the middleware system in `@adhd/apigen-runtime`: `MiddlewareDef`, `defineMiddleware`, `EventBus`, `wireObservers`, `buildContext`, `assertNoSelfSubscription`, and `createApiPackage`. After this state, a caller can compose middleware into an `ApiPackageResult` with a `createClient` closure for per-request context building.

No external dependencies — this is pure TypeScript. `@adhd/apigen-runtime` imports **types only** from `@adhd/apigen-core` (via `import type`).

---

## Semantic Distillation

- **Primitive:** CREATE `packages/apigen/runtime/src/lib/` — 5 files implementing the middleware system.
- **Reference Pattern:** Read these in order:
  1. `~/dev/projects/reverse-apis/packages/system/middleware/src/lib/types.ts` — `MiddlewareDef`, `ComposedContext`, `EventSelectorString`
  2. `~/dev/projects/reverse-apis/packages/system/middleware/src/lib/define-middleware.ts`
  3. `~/dev/projects/reverse-apis/packages/system/service/src/lib/compose-context.ts` — `EventBus`, `wireObservers`, `buildContext`
  4. `~/dev/projects/reverse-apis/packages/system/service/src/lib/recursion-guard.ts` — `assertNoSelfSubscription`
  5. `~/dev/projects/reverse-apis/packages/system/service/src/lib/create-api-package.ts`
  6. `~/dev/projects/reverse-apis/packages/system/service/src/lib/middleware-integration.spec.ts` — integration test (read the behavior, not the API)

  **Key API divergence:** `eventMapping` in the reference uses `{ handlerName: string[] }` (name → selectors). The new design uses `{ selector: handler }` (selector → function). The new design's `wireObservers` must map `Object.entries(mw.eventMapping)` where each key IS the selector string. See `[ref:reference-codebase]` in `_shared.md`.
- **Delta Spec:**

### `types.ts`

```typescript
import type { GeneratedSchemas, ComposedSchemas } from '@adhd/apigen-core'

export type { GeneratedSchemas, ComposedSchemas }

export interface MiddlewareDef<
  TEnvelope extends object = object,
  TContext extends object = object
> {
  id: string
  envelope?: Record<string, unknown>
  createContext?: (ctx: object) => TContext | Promise<TContext>
  eventMapping?: Record<string, (event: MiddlewareEvent) => void | Promise<void>>
}

export interface MiddlewareEvent {
  module: string
  method: string
  lifecycle: 'start' | 'complete' | 'error'
  ctx: object
  error?: unknown
}

export interface ApiPackageOptions<M extends readonly MiddlewareDef[]> {
  domainSchemas: GeneratedSchemas
  middlewares: readonly [...M]
  overrides?: Partial<Record<string, Partial<Record<string, boolean>>>>
  strict?: boolean
}

export interface ApiPackageResult {
  schemas: ComposedSchemas
  createClient: (envelope: Record<string, unknown>) => Promise<object>
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}
```

### `define-middleware.ts`

```typescript
import type { MiddlewareDef } from './types'

export function defineMiddleware<
  TId extends string,
  TEnvelope extends object,
  TContext extends object
>(def: MiddlewareDef<TEnvelope, TContext> & { id: TId }): typeof def {
  return def
}
```

### `event-bus.ts`

```typescript
import type { MiddlewareDef, MiddlewareEvent } from './types'

export class EventBus {
  private handlers: Map<string, Array<(event: MiddlewareEvent) => void | Promise<void>>> = new Map()

  on(selector: string, handler: (event: MiddlewareEvent) => void | Promise<void>): void {
    const existing = this.handlers.get(selector) ?? []
    this.handlers.set(selector, [...existing, handler])
  }

  async emit(event: MiddlewareEvent): Promise<void> {
    for (const [selector, handlers] of this.handlers) {
      if (matches(selector, event)) {
        for (const h of handlers) await h(event)
      }
    }
  }
}

function matches(selector: string, event: MiddlewareEvent): boolean {
  const [mod, method, lifecycle] = selector.split(':')
  if (mod !== '*' && mod !== event.module) return false
  if (method && method !== '*' && method !== event.method) return false
  if (lifecycle && lifecycle !== '*' && lifecycle !== event.lifecycle) return false
  return true
}

export function wireObservers(middlewares: readonly MiddlewareDef[], bus: EventBus): void {
  for (const mw of middlewares) {
    if (!mw.eventMapping) continue
    for (const [selector, handler] of Object.entries(mw.eventMapping)) {
      bus.on(selector, handler)
    }
  }
}
```

### `build-context.ts`

```typescript
import type { MiddlewareDef } from './types'
import type { EventBus } from './event-bus'

export async function buildContext(
  middlewares: readonly MiddlewareDef[],
  envelope: Record<string, unknown>,
  bus: EventBus,
): Promise<object> {
  let ctx: object = { ...envelope }
  for (const mw of middlewares) {
    if (!mw.createContext) continue
    await bus.emit({ module: mw.id, method: 'createContext', lifecycle: 'start', ctx })
    try {
      const contribution = await mw.createContext(ctx)
      ctx = { ...ctx, ...contribution }
      await bus.emit({ module: mw.id, method: 'createContext', lifecycle: 'complete', ctx })
    } catch (error) {
      await bus.emit({ module: mw.id, method: 'createContext', lifecycle: 'error', ctx, error })
      throw error
    }
  }
  return ctx
}
```

### `api-package.ts`

```typescript
import { composeSchemas } from '@adhd/apigen-core'
import type { MiddlewareDef, ApiPackageOptions, ApiPackageResult, ConfigurationError as CE } from './types'
import { ConfigurationError } from './types'
import { EventBus, wireObservers } from './event-bus'
import { buildContext } from './build-context'

export function assertNoSelfSubscription(middlewares: readonly MiddlewareDef[]): void {
  for (const mw of middlewares) {
    for (const selector of Object.keys(mw.eventMapping ?? {})) {
      const [module] = selector.split(':')
      if (module !== '*' && module === mw.id) {
        throw new ConfigurationError(
          `Middleware "${mw.id}" subscribes to its own events via "${selector}". ` +
          `This would cause infinite recursion.`
        )
      }
    }
  }
}

export function createApiPackage<M extends readonly MiddlewareDef[]>(
  options: ApiPackageOptions<M>
): ApiPackageResult {
  const { domainSchemas, middlewares, overrides = {}, strict = false } = options

  // Startup validation
  assertNoSelfSubscription(middlewares)

  // Validate override keys exist in domainSchemas
  for (const fnKey of Object.keys(overrides)) {
    if (!(fnKey in domainSchemas.schemas)) {
      const msg = `Override key "${fnKey}" not found in domain schemas.`
      if (strict) throw new ConfigurationError(msg)
      else console.warn('[apigen-runtime]', msg)
    }
  }

  // Validate middleware ids in override values
  const mwIds = new Set(middlewares.map(m => m.id))
  for (const [fnKey, fnOverride] of Object.entries(overrides)) {
    for (const mwId of Object.keys(fnOverride ?? {})) {
      if (!mwIds.has(mwId)) {
        const msg = `Override key "${fnKey}.${mwId}" does not match any declared middleware id.`
        if (strict) throw new ConfigurationError(msg)
        else console.warn('[apigen-runtime]', msg)
      }
    }
  }

  const schemas = composeSchemas(
    domainSchemas,
    middlewares as unknown as Array<{ id: string; envelope?: Record<string, unknown> }>,
    overrides as Record<string, Record<string, boolean>>
  )

  const bus = new EventBus()
  wireObservers(middlewares, bus)

  const createClient = async (envelope: Record<string, unknown>): Promise<object> => {
    return buildContext(middlewares, envelope, bus)
  }

  return { schemas, createClient }
}
```

### `index.ts`

```typescript
export { defineMiddleware } from './lib/define-middleware'
export { EventBus, wireObservers } from './lib/event-bus'
export { buildContext } from './lib/build-context'
export { assertNoSelfSubscription, createApiPackage } from './lib/api-package'
export type { MiddlewareDef, MiddlewareEvent, ApiPackageOptions, ApiPackageResult, ConfigurationError } from './lib/types'
// Note: dispatch utilities come from runtime-dispatch state
```

### Test file `api-package.spec.ts`

```typescript
// Test: createApiPackage with session middleware → schemas have session field
// Test: createClient accumulates context from middleware
// Test: assertNoSelfSubscription throws ConfigurationError on self-subscription
// Test: override validation warns on unknown fn key (strict=false) / throws (strict=true)
// Test: wireObservers: observer middleware receives start + complete events
// Test: buildContext: error in createContext triggers 'error' event + re-throws
```

Each test case is a unit test. Use `vi.fn()` (vitest) for event handler spies.

### Test file `build-context.spec.ts`

```typescript
// Test: sequential accumulation — second mw sees first mw's contribution in ctx
// Test: error in mw.createContext → error event emitted → error re-thrown
// Test: observer-only mw (no createContext) does not block other middlewares
```

- **Invariants:** `[inv:dispatch-single-path]` — `@adhd/apigen-runtime` does NOT call domain functions directly.

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).

```text
mutates:    ["packages/apigen/runtime/src/lib/types.ts",
            "packages/apigen/runtime/src/lib/define-middleware.ts",
            "packages/apigen/runtime/src/lib/event-bus.ts",
            "packages/apigen/runtime/src/lib/build-context.ts",
            "packages/apigen/runtime/src/lib/api-package.ts",
            "packages/apigen/runtime/src/test/api-package.spec.ts",
            "packages/apigen/runtime/src/test/build-context.spec.ts",
            "packages/apigen/runtime/src/index.ts"]
read_only:  ["packages/apigen/core/src/"]
```

---

## Acceptance criteria

- `[runtime-middleware.1]` `createApiPackage` builds schemas via `composeSchemas` from core — verify session middleware adds `session` to schema.
- `[runtime-middleware.2]` `assertNoSelfSubscription` throws `ConfigurationError` when a middleware's `eventMapping` key starts with its own `id`.
- `[runtime-middleware.3]` Observer middleware (eventMapping only) receives `start` and `complete` events for other middlewares.
- `[runtime-middleware.4]` `createApiPackage` with `strict: true` throws on unknown override fn key.
- `[runtime-middleware.5]` `buildContext` accumulates context sequentially — second middleware sees first middleware's contribution.
- `[runtime-middleware.6]` No import of `@adhd/apigen-plugin-*` or Node-only APIs (`fs`, `path`, `child_process`) in `packages/apigen/runtime/src/`:
  ```bash
  grep -rn "from 'fs'\|from 'path'\|from 'child_process'\|@adhd/apigen-plugin" packages/apigen/runtime/src/
  # must produce no output
  ```

---

## Commit points

1. After all tests pass: `feat(apigen-runtime): implement middleware system — MiddlewareDef, EventBus, buildContext, createApiPackage`
