/** Deep-clones JSON data (plain objects, arrays, primitives). `undefined` members are kept as absent. */
export function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => deepClone(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      if (member !== undefined) out[key] = deepClone(member);
    }
    return out as T;
  }
  return value;
}

/** Recursively freezes JSON data in place and returns it. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value as Record<string, unknown>)) deepFreeze(member);
  }
  return value;
}

/** Defines an own enumerable data property (safe for keys such as `__proto__`). */
export function setOwn<T extends object>(target: T, key: string, value: unknown): T {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  return target;
}
