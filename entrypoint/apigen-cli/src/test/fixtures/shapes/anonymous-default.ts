// Export-shape matrix fixture — Shape 5: anonymous default export.
//
// `export default (x) => ...` — there is NO exported symbol name.
// BUG-APIGEN-033: the op leaf name MUST be the literal `'default'` — that's
// the real runtime `.name` ECMAScript's NamedEvaluation rule gives this
// function (not a filename-derived synthetic id), since that's the only key
// `buildFnTable()` can ever resolve it under at dispatch time. `fileSegment`
// still disambiguates the op's `id` (`shapes/anonymous-default/default`);
// only the dispatch key itself is `'default'`.

export default (n: number): number => n * 2;

export const __samples__: Record<string, Record<string, unknown>> = {
  default: { n: 21 },
};
