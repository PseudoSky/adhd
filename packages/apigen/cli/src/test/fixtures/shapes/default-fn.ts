// Export-shape matrix fixture — Shape 4: default-exported named function.
//
// `export default function greet(...)` — the exported binding is the default
// slot, but the function carries a real declaration name (`greet`). The v2
// extractor names the op by that symbol; buildFnTable likewise keys it by the
// declaration name so dispatch resolves.

export default function greet(name: string): string {
  return `hello ${name}`
}

export const __samples__: Record<string, Record<string, unknown>> = {
  greet: { name: 'Ada' },
}
