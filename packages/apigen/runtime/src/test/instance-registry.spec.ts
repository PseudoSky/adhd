/**
 * instance-registry.spec.ts — SPEC §10 instance lifecycle tests.
 *
 * Behavioral proofs:
 *   1. create → get: a constructed instance is retrievable by instanceId.
 *   2. dispatch: calling a method on the instance via the registry works.
 *   3. dispose: explicit dispose removes the entry + calls instance.dispose().
 *   4. TTL expiry: an expired entry is not retrievable.
 *   5. disposeAll: tears down all live instances + stops the sweeper.
 *   6. Negative controls: unknown id throws; expired id throws.
 *
 * Teeth: every positive assertion also has a post-condition that would fail if
 * the registry were a no-op.  The TTL test advances real time via vi.useFakeTimers
 * so it is deterministic, not wall-clock-dependent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InstanceRegistry } from '../lib/instance-registry'
import type { AnyConstructor } from '../lib/instance-registry'

// ---------------------------------------------------------------------------
// Fixture class
// ---------------------------------------------------------------------------

class Counter {
  private _value: number
  disposed = false

  constructor(initial = 0) {
    this._value = initial
  }

  increment(amount = 1): number {
    this._value += amount
    return this._value
  }

  getValue(): number {
    return this._value
  }

  dispose(): void {
    this.disposed = true
  }
}

// ---------------------------------------------------------------------------
// create → get
// ---------------------------------------------------------------------------

describe('InstanceRegistry — create + get', () => {
  it('[reg.1.1] returns an instanceId on create', () => {
    const registry = new InstanceRegistry()
    const { instanceId } = registry.create(Counter as AnyConstructor, [10])
    expect(typeof instanceId).toBe('string')
    expect(instanceId.length).toBeGreaterThan(0)
    void registry.disposeAll()
  })

  it('[reg.1.2] get returns the constructed instance', () => {
    const registry = new InstanceRegistry()
    const { instanceId } = registry.create(Counter as AnyConstructor, [5])
    const inst = registry.get<Counter>(instanceId)
    expect(inst).toBeInstanceOf(Counter)
    expect(inst.getValue()).toBe(5)
    void registry.disposeAll()
  })

  it('[reg.1.3] two creates produce distinct instanceIds', () => {
    const registry = new InstanceRegistry()
    const a = registry.create(Counter as AnyConstructor, [0])
    const b = registry.create(Counter as AnyConstructor, [0])
    expect(a.instanceId).not.toBe(b.instanceId)
    void registry.disposeAll()
  })

  it('[reg.1.NEGATIVE] get throws for unknown instanceId', () => {
    const registry = new InstanceRegistry()
    expect(() => registry.get('does-not-exist')).toThrow(/Unknown instanceId/)
    void registry.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe('InstanceRegistry — dispatch', () => {
  it('[reg.2.1] dispatches a method and returns its result', async () => {
    const registry = new InstanceRegistry()
    const { instanceId } = registry.create(Counter as AnyConstructor, [0])
    const result = await registry.dispatch(instanceId, 'increment', [5])
    expect(result).toBe(5)
    void registry.disposeAll()
  })

  it('[reg.2.2] dispatch mutates instance state (state is persistent across calls)', async () => {
    const registry = new InstanceRegistry()
    const { instanceId } = registry.create(Counter as AnyConstructor, [0])
    await registry.dispatch(instanceId, 'increment', [3])
    const value = await registry.dispatch(instanceId, 'getValue', [])
    expect(value).toBe(3)
    void registry.disposeAll()
  })

  it('[reg.2.NEGATIVE] dispatch throws when method does not exist', async () => {
    const registry = new InstanceRegistry()
    const { instanceId } = registry.create(Counter as AnyConstructor, [0])
    await expect(registry.dispatch(instanceId, 'nonExistent', [])).rejects.toThrow(/Method "nonExistent" not found/)
    void registry.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe('InstanceRegistry — dispose', () => {
  it('[reg.3.1] dispose removes the entry', async () => {
    const registry = new InstanceRegistry()
    const { instanceId } = registry.create(Counter as AnyConstructor, [0])
    await registry.dispose(instanceId)
    expect(() => registry.get(instanceId)).toThrow(/Unknown instanceId/)
  })

  it('[reg.3.2] dispose calls instance.dispose() lifecycle hook', async () => {
    const registry = new InstanceRegistry()
    const { instanceId } = registry.create(Counter as AnyConstructor, [0])
    const inst = registry.get<Counter>(instanceId)
    expect(inst.disposed).toBe(false)
    await registry.dispose(instanceId)
    expect(inst.disposed).toBe(true)
  })

  it('[reg.3.3] dispose is idempotent — calling twice does not throw', async () => {
    const registry = new InstanceRegistry()
    const { instanceId } = registry.create(Counter as AnyConstructor, [0])
    await registry.dispose(instanceId)
    await expect(registry.dispose(instanceId)).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// TTL expiry
// ---------------------------------------------------------------------------

describe('InstanceRegistry — TTL expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('[reg.4.1] an instance is accessible before TTL expires', async () => {
    const registry = new InstanceRegistry({ defaultTtlMs: 5_000, sweepIntervalMs: 0 })
    const { instanceId } = registry.create(Counter as AnyConstructor, [0])
    // No time advance — should be accessible.
    expect(() => registry.get<Counter>(instanceId)).not.toThrow()
    await registry.disposeAll()
  })

  it('[reg.4.2] get throws after TTL elapses', async () => {
    const registry = new InstanceRegistry({ defaultTtlMs: 1_000, sweepIntervalMs: 0 })
    const { instanceId } = registry.create(Counter as AnyConstructor, [0])
    // Advance time past TTL.
    vi.advanceTimersByTime(2_000)
    expect(() => registry.get(instanceId)).toThrow(/expired/)
    await registry.disposeAll()
  })

  it('[reg.4.3] per-entry TTL override is respected', async () => {
    const registry = new InstanceRegistry({ defaultTtlMs: 60_000, sweepIntervalMs: 0 })
    // Create with a short per-entry TTL.
    const { instanceId } = registry.create(Counter as AnyConstructor, [0], 500)
    vi.advanceTimersByTime(1_000)
    expect(() => registry.get(instanceId)).toThrow(/expired/)
    await registry.disposeAll()
  })

  it('[reg.4.4] sweeper evicts expired entries automatically', async () => {
    const registry = new InstanceRegistry({ defaultTtlMs: 1_000, sweepIntervalMs: 500 })
    const { instanceId } = registry.create(Counter as AnyConstructor, [0])
    // Advance so both TTL and sweep fire.
    vi.advanceTimersByTime(2_000)
    // Entry should be gone from the store (swept).
    expect(registry.size).toBe(0)
    await registry.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// disposeAll
// ---------------------------------------------------------------------------

describe('InstanceRegistry — disposeAll', () => {
  it('[reg.5.1] disposeAll calls dispose() on every live instance', async () => {
    const registry = new InstanceRegistry()
    const { instanceId: id1 } = registry.create(Counter as AnyConstructor, [0])
    const { instanceId: id2 } = registry.create(Counter as AnyConstructor, [0])
    const inst1 = registry.get<Counter>(id1)
    const inst2 = registry.get<Counter>(id2)
    await registry.disposeAll()
    expect(inst1.disposed).toBe(true)
    expect(inst2.disposed).toBe(true)
  })

  it('[reg.5.2] disposeAll empties the registry', async () => {
    const registry = new InstanceRegistry()
    registry.create(Counter as AnyConstructor, [0])
    registry.create(Counter as AnyConstructor, [0])
    expect(registry.size).toBe(2)
    await registry.disposeAll()
    expect(registry.size).toBe(0)
  })

  it('[reg.5.3] disposeAll is safe to call on an empty registry', async () => {
    const registry = new InstanceRegistry()
    await expect(registry.disposeAll()).resolves.toBeUndefined()
  })
})
