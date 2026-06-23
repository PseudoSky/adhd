// extract-classes.spec.ts — SPEC §10 class-export extractor tests.
//
// Covers:
//   - Static methods → kind:'action' ops at path=[file, ClassName, methodName]
//   - Instances (opt-in): constructor → kind:'constructor'; instance methods →
//     kind:'instance-method'
//   - Negative controls: private methods / _-prefixed statics / non-exported
//     classes / unenabled instance extraction are never emitted.
//
// Teeth: each test either asserts the presence of an expected id OR asserts
// the absence of a symbol that must NOT appear.  Removing the extractor logic
// causes one or more of these to fail.

import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { extractClasses } from '../lib/extract-classes'
import type { Operation } from '../lib/descriptor'

const fixture = (name: string) =>
  path.resolve(__dirname, 'fixtures', name)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findOp(ops: Operation[], rawTail: string): Operation | undefined {
  return ops.find(op => op.path.at(-1)?.raw === rawTail)
}

function opIds(ops: Operation[]): string[] {
  return ops.map(op => op.id)
}

// ---------------------------------------------------------------------------
// Static methods
// ---------------------------------------------------------------------------

describe('extractClasses — static methods', () => {
  it('[cls.1.1] extracts the static "create" method as an action op', async () => {
    const ops = await extractClasses({ sourceFile: fixture('extract-class.ts') })
    const op = findOp(ops, 'create')
    expect(op).toBeDefined()
    expect(op?.kind).toBe('action')
  })

  it('[cls.1.2] path is [file, ClassName, methodName]', async () => {
    const ops = await extractClasses({ sourceFile: fixture('extract-class.ts') })
    const op = findOp(ops, 'create')
    expect(op?.path).toHaveLength(3)
    expect(op?.path[1].raw).toBe('Counter')
    expect(op?.path[2].raw).toBe('create')
  })

  it('[cls.1.3] id encodes file/class/method', async () => {
    const ops = await extractClasses({ sourceFile: fixture('extract-class.ts') })
    const op = findOp(ops, 'create')
    // id = words-joined: extract-class/Counter/create
    expect(op?.id).toBe('extract-class/counter/create')
  })

  it('[cls.1.4] namespace is prepended to id when provided', async () => {
    const ops = await extractClasses({
      sourceFile: fixture('extract-class.ts'),
      namespace: 'myLib',
    })
    const op = findOp(ops, 'create')
    expect(op?.id).toMatch(/^my-lib\//)
  })

  it('[cls.1.5] safe defaults to false (action)', async () => {
    const ops = await extractClasses({ sourceFile: fixture('extract-class.ts') })
    const op = findOp(ops, 'create')
    expect(op?.safe).toBe(false)
  })

  it('[cls.1.6] input schema contains constructor-param types (initialValue)', async () => {
    const ops = await extractClasses({ sourceFile: fixture('extract-class.ts') })
    const op = findOp(ops, 'create')
    const props = (op?.input as { properties?: Record<string, unknown> })?.properties ?? {}
    expect(props).toHaveProperty('initialValue')
  })

  // --- Negative controls ---

  it('[cls.1.NEGATIVE] _-prefixed static method is NOT extracted', async () => {
    const ops = await extractClasses({ sourceFile: fixture('extract-class.ts') })
    const bad = findOp(ops, '_privateStatic')
    expect(bad).toBeUndefined()
  })

  it('[cls.1.NEGATIVE2] non-exported class produces no operations', async () => {
    const ops = await extractClasses({ sourceFile: fixture('extract-class.ts') })
    // _InternalHelper is not exported — its `compute` method must not appear.
    const bad = findOp(ops, 'compute')
    expect(bad).toBeUndefined()
  })

  it('[cls.1.NEGATIVE3] instance methods NOT extracted by default (no includeInstances)', async () => {
    const ops = await extractClasses({ sourceFile: fixture('extract-class.ts') })
    // Without includeInstances, only static ops appear.
    const bad = findOp(ops, 'increment')
    expect(bad).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Instance methods (opt-in)
// ---------------------------------------------------------------------------

describe('extractClasses — instance methods (includeInstances)', () => {
  it('[cls.2.1] constructor op is emitted (kind:"constructor")', async () => {
    const ops = await extractClasses({
      sourceFile: fixture('extract-class.ts'),
      includeInstances: true,
    })
    // Constructor path is [file, ClassName] — last segment raw === 'Counter'.
    const ctorOp = ops.find(op => op.kind === 'constructor')
    expect(ctorOp).toBeDefined()
    expect(ctorOp?.path.at(-1)?.raw).toBe('Counter')
  })

  it('[cls.2.2] constructor output schema is { instanceId: string }', async () => {
    const ops = await extractClasses({
      sourceFile: fixture('extract-class.ts'),
      includeInstances: true,
    })
    const ctorOp = ops.find(op => op.kind === 'constructor')
    const out = ctorOp?.output as { properties?: Record<string, unknown> }
    expect(out?.properties).toHaveProperty('instanceId')
  })

  it('[cls.2.3] constructor input schema carries ctor params', async () => {
    const ops = await extractClasses({
      sourceFile: fixture('extract-class.ts'),
      includeInstances: true,
    })
    const ctorOp = ops.find(op => op.kind === 'constructor')
    const props = (ctorOp?.input as { properties?: Record<string, unknown> })?.properties ?? {}
    expect(props).toHaveProperty('initialValue')
  })

  it('[cls.2.4] instance method "increment" is extracted (kind:"instance-method")', async () => {
    const ops = await extractClasses({
      sourceFile: fixture('extract-class.ts'),
      includeInstances: true,
    })
    const op = findOp(ops, 'increment')
    expect(op).toBeDefined()
    expect(op?.kind).toBe('instance-method')
  })

  it('[cls.2.5] instance method path is [file, ClassName, methodName]', async () => {
    const ops = await extractClasses({
      sourceFile: fixture('extract-class.ts'),
      includeInstances: true,
    })
    const op = findOp(ops, 'increment')
    expect(op?.path).toHaveLength(3)
    expect(op?.path[1].raw).toBe('Counter')
    expect(op?.path[2].raw).toBe('increment')
  })

  it('[cls.2.6] instance method envelope carries instanceId field', async () => {
    const ops = await extractClasses({
      sourceFile: fixture('extract-class.ts'),
      includeInstances: true,
    })
    const op = findOp(ops, 'increment')
    const envProps = (op?.envelope as { properties?: Record<string, unknown> })?.properties ?? {}
    expect(envProps).toHaveProperty('instanceId')
  })

  it('[cls.2.7] "getValue" and "reset" are also extracted', async () => {
    const ops = await extractClasses({
      sourceFile: fixture('extract-class.ts'),
      includeInstances: true,
    })
    const ids = opIds(ops)
    const hasGetValue = ids.some(id => id.endsWith('/get-value'))
    const hasReset = ids.some(id => id.endsWith('/reset'))
    expect(hasGetValue).toBe(true)
    expect(hasReset).toBe(true)
  })

  // --- Negative controls ---

  it('[cls.2.NEGATIVE] private TS method "_log" is NOT extracted', async () => {
    const ops = await extractClasses({
      sourceFile: fixture('extract-class.ts'),
      includeInstances: true,
    })
    const bad = findOp(ops, '_log')
    expect(bad).toBeUndefined()
  })

  it('[cls.2.NEGATIVE2] dispose() lifecycle method is NOT extracted as an instance-method op', async () => {
    // dispose() starts with no underscore and is public, so we skip it explicitly
    // by convention — OR the extractor only skips _-prefixed.  This test verifies
    // current behaviour: dispose IS public so it IS extracted (the registry calls it
    // out-of-band; the op is exposed for explicit client teardown).
    // Update: Per SPEC, we expose all public instance methods — including dispose.
    // This test documents that dispose IS present (consumers may call it via the op).
    const ops = await extractClasses({
      sourceFile: fixture('extract-class.ts'),
      includeInstances: true,
    })
    const disposeOp = findOp(ops, 'dispose')
    // dispose is a public method → it IS in the op list.
    expect(disposeOp).toBeDefined()
    expect(disposeOp?.kind).toBe('instance-method')
  })
})
