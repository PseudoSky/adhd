// Export-shape matrix fixture — Shape 3 (via default): `export default { ... }`.
//
// A default object literal whose keys are the exported operation symbols. The
// v2 extractor recurses into the object and names each op by its KEY (the
// exported symbol), with path `[file, 'default', key]` per SPEC §5.

function sum(a: number, b: number): number {
  return a + b
}

function product(a: number, b: number): number {
  return a * b
}

export default { sum, product }

export const __samples__: Record<string, Record<string, unknown>> = {
  sum: { a: 2, b: 3 },
  product: { a: 4, b: 5 },
}
