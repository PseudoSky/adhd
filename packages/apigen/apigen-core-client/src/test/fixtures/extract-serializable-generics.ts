// Fixture: BUG-APIGEN-CORE-004 — generic-wrapper serializable consts.
// A const typed as `Record<K, V>` (or another generic utility-type wrapper
// around an otherwise-serializable shape) must extract as kind:'query',
// not be silently skipped by isSerializableType()'s allow-list.
//
// Each exported const's initializer is an Identifier (a reference to a
// locally-declared object), not a literal `{ ... }` directly — an inline
// object-literal initializer routes through the Shape 3 "named-object
// export" branch instead of the serializable-data-const branch this bug
// affects, so an Identifier initializer is what actually exercises
// isSerializableType() here (matches how the real-world case that surfaced
// this bug is shaped).

export interface ShapeSpec {
  label: string;
  weight: number;
}

// Mirrors the real-world case from the bug report: Record<string, number>.
const scopeWeightsData = {
  recall: 1,
  search: 2,
};
export const SCOPE_WEIGHTS: Record<string, number> = scopeWeightsData;

// Record<string, Interface> — value type is a plain data interface.
const supportedShapesData = {
  a: { label: 'a', weight: 1 },
};
export const SUPPORTED_SHAPES: Record<string, ShapeSpec> = supportedShapesData;

// Partial<T> — another generic utility-type wrapper around a serialisable
// shape; structurally still just data properties.
const partialShapeData = { label: 'x' };
export const PARTIAL_SHAPE: Partial<ShapeSpec> = partialShapeData;

// Negative control: Map is a generic wrapper (`Map<K, V>`) but is genuinely
// NOT JSON-serialisable (JSON.stringify(new Map()) === '{}') — must still be
// skipped. Proves the fix doesn't regress into a naive "generic-looking →
// serialisable" false positive.
export const NOT_SERIALIZABLE_MAP: Map<string, number> = new Map();
