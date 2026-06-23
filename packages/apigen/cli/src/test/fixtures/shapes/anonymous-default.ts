// Export-shape matrix fixture — Shape 5: anonymous default export.
//
// `export default (x) => ...` — there is NO exported symbol name. The v2
// extractor must SYNTHESISE a stable id from the filename:
//   normalizeFileName('anonymous-default.ts') = 'anonymous-default'
//   → synthesized symbol 'anonymous_default_default'
// The synthesized id must be deterministic (same file → same id) so a generated
// client stays stable across runs.

export default (n: number): number => n * 2

export const __samples__: Record<string, Record<string, unknown>> = {
  // The synthesized op takes one positional arg `n`.
  anonymous_default_default: { n: 21 },
}
