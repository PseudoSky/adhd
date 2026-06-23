/**
 * Instance registry for class-export instance dispatch (SPEC §10).
 *
 * When a `kind:'constructor'` op fires, the runtime constructs the target class
 * and stores the live instance here under a unique `instanceId`.  Subsequent
 * `kind:'instance-method'` ops look up the instance by `instanceId` and
 * dispatch the method against it.
 *
 * Lifecycle (TTL + dispose):
 *   - Every entry carries an optional TTL (milliseconds).  A sweeper clears
 *     expired entries automatically; the sweep interval is configurable.
 *   - Calling `dispose(instanceId)` removes the entry immediately and runs the
 *     instance's `dispose()` method if it exists.
 *   - `disposeAll()` tears down every live instance and stops the sweeper.
 *
 * Stateful caveat: the registry lives in-process; horizontal scaling without
 * sticky routing or an external store will route requests to the wrong instance.
 * Document this to API consumers (SPEC §10 note).
 *
 * Usage:
 * ```ts
 * const registry = new InstanceRegistry({ defaultTtlMs: 30_000 })
 *
 * // constructor op handler
 * const { instanceId } = registry.create(Counter, [0])
 *
 * // instance-method op handler
 * const counter = registry.get<Counter>(instanceId)
 * counter.increment()
 *
 * // explicit teardown
 * await registry.dispose(instanceId)
 * await registry.disposeAll()
 * ```
 */

// Inline UUID v4 — avoids a hard `node:crypto` dependency so this module is
// safe to bundle in both Node and browser-compat Vite builds.  The runtime
// package is tagged `platform:shared` (§12), so no Node-only builtins here.
function randomUUID(): string {
  // RFC 4122 §4.4 — version 4, variant 10xx.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Any class constructor (unknown args → unknown instance). */
export type AnyConstructor = new (...args: unknown[]) => unknown

/** Options for the registry. */
export interface InstanceRegistryOptions {
  /**
   * Default TTL in milliseconds for each instance. When omitted, instances
   * live until explicitly `dispose()`d or `disposeAll()` is called.
   */
  defaultTtlMs?: number
  /**
   * How often (ms) the background sweeper checks for expired entries.
   * Defaults to `Math.max(1_000, defaultTtlMs / 4)` when a TTL is set,
   * or `5_000` otherwise.  Pass `0` to disable the automatic sweeper.
   */
  sweepIntervalMs?: number
}

/** Internal entry stored per instance. */
interface RegistryEntry {
  instance: unknown
  expiresAt: number | null  // null = no expiry
}

/** The result returned by `registry.create()` — the `instanceId` is what the
 *  client passes back on every `kind:'instance-method'` call. */
export interface CreateResult {
  instanceId: string
}

// ---------------------------------------------------------------------------
// InstanceRegistry
// ---------------------------------------------------------------------------

/**
 * In-process instance store for SPEC §10 class-instance dispatch.
 *
 * Thread-safe within a single Node.js event-loop (single-threaded JS).
 * Stateful: does NOT survive process restarts; scale with sticky routing.
 */
export class InstanceRegistry {
  private readonly _store: Map<string, RegistryEntry> = new Map()
  private readonly _defaultTtlMs: number | undefined
  private _sweeper: ReturnType<typeof setInterval> | null = null

  constructor(opts: InstanceRegistryOptions = {}) {
    this._defaultTtlMs = opts.defaultTtlMs

    // Resolve sweep interval.
    let interval: number | null = null
    if (opts.sweepIntervalMs === 0) {
      interval = null  // explicitly disabled
    } else if (opts.sweepIntervalMs !== undefined) {
      interval = opts.sweepIntervalMs
    } else if (this._defaultTtlMs !== undefined) {
      interval = Math.max(1_000, Math.floor(this._defaultTtlMs / 4))
    } else {
      interval = null  // no TTL → no point sweeping
    }

    if (interval !== null && interval > 0) {
      this._sweeper = setInterval(() => this._sweep(), interval)
      // Allow the Node.js event loop to exit even if the registry is still alive.
      this._sweeper.unref?.()
    }
  }

  // ---------------------------------------------------------------------------
  // create — construct + register
  // ---------------------------------------------------------------------------

  /**
   * Construct an instance of `Ctor` with `args` and store it in the registry.
   *
   * @param Ctor  - The class to instantiate.
   * @param args  - Constructor arguments (positional).
   * @param ttlMs - Per-entry TTL override.  Falls back to `defaultTtlMs`.
   * @returns `{ instanceId }` — pass this to `dispatch()` / `get()`.
   */
  create(
    Ctor: AnyConstructor,
    args: unknown[] = [],
    ttlMs?: number,
  ): CreateResult {
    const instance = new Ctor(...args)
    const instanceId = randomUUID()

    const effectiveTtl = ttlMs ?? this._defaultTtlMs
    const expiresAt = effectiveTtl !== undefined ? Date.now() + effectiveTtl : null

    this._store.set(instanceId, { instance, expiresAt })
    return { instanceId }
  }

  // ---------------------------------------------------------------------------
  // get — retrieve a live instance
  // ---------------------------------------------------------------------------

  /**
   * Retrieve the instance stored under `instanceId`.
   *
   * @throws When `instanceId` is unknown or the entry has expired.
   */
  get<T = unknown>(instanceId: string): T {
    const entry = this._store.get(instanceId)
    if (!entry) {
      throw new Error(`[instance-registry] Unknown instanceId: "${instanceId}"`)
    }
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this._evict(instanceId, entry)
      throw new Error(`[instance-registry] Instance "${instanceId}" has expired`)
    }
    return entry.instance as T
  }

  // ---------------------------------------------------------------------------
  // dispatch — call a method on a live instance
  // ---------------------------------------------------------------------------

  /**
   * Look up `instanceId` and call `method` on it with `args`.
   *
   * @throws When `instanceId` is unknown/expired, or `method` is not a function
   *   on the instance.
   */
  async dispatch(instanceId: string, method: string, args: unknown[] = []): Promise<unknown> {
    const inst = this.get<Record<string, unknown>>(instanceId)
    const fn = inst[method]
    if (typeof fn !== 'function') {
      throw new Error(
        `[instance-registry] Method "${method}" not found on instance "${instanceId}"`,
      )
    }
    return (fn as (...a: unknown[]) => unknown).call(inst, ...args)
  }

  // ---------------------------------------------------------------------------
  // dispose — explicit teardown
  // ---------------------------------------------------------------------------

  /**
   * Remove `instanceId` from the registry and call `instance.dispose()` if the
   * instance exposes one (opt-in lifecycle hook).
   */
  async dispose(instanceId: string): Promise<void> {
    const entry = this._store.get(instanceId)
    if (!entry) return  // idempotent — already gone
    this._store.delete(instanceId)
    await callDispose(entry.instance)
  }

  // ---------------------------------------------------------------------------
  // disposeAll — full teardown
  // ---------------------------------------------------------------------------

  /**
   * Dispose every live instance and stop the background sweeper.  Call this
   * when the server is shutting down.
   */
  async disposeAll(): Promise<void> {
    if (this._sweeper !== null) {
      clearInterval(this._sweeper)
      this._sweeper = null
    }
    const entries = [...this._store.entries()]
    this._store.clear()
    await Promise.all(entries.map(([, e]) => callDispose(e.instance)))
  }

  // ---------------------------------------------------------------------------
  // size — diagnostic helper
  // ---------------------------------------------------------------------------

  /** Number of live (non-expired) entries currently in the registry. */
  get size(): number {
    return this._store.size
  }

  // ---------------------------------------------------------------------------
  // Internal sweeper
  // ---------------------------------------------------------------------------

  private _sweep(): void {
    const now = Date.now()
    for (const [id, entry] of this._store) {
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        this._evict(id, entry)
      }
    }
  }

  private _evict(id: string, entry: RegistryEntry): void {
    this._store.delete(id)
    // Fire-and-forget dispose — sweep must not block the event loop.
    void callDispose(entry.instance)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Calls `instance.dispose()` when the method exists.  Returns a resolved
 * promise if `dispose()` is absent or not a function.
 */
async function callDispose(instance: unknown): Promise<void> {
  if (instance !== null && typeof instance === 'object' && 'dispose' in instance) {
    const fn = (instance as Record<string, unknown>)['dispose']
    if (typeof fn === 'function') {
      await (fn as () => Promise<void> | void).call(instance)
    }
  }
}
