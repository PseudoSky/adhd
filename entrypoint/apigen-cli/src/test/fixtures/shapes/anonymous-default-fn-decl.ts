// Export-shape matrix fixture — Shape 4's anonymous sub-case: a bare
// `export default function(x) {}` function DECLARATION with no name (distinct
// from Shape 5's `export default (x) => ...` arrow/FunctionExpression form —
// this is ts-morph's FunctionDeclaration branch, not an ExportAssignment).
//
// BUG-APIGEN-033: this shape's runtime `.name` is ALSO the literal `"default"`
// (ECMAScript's `export default HoistableDeclaration` NamedEvaluation rule
// applies here too), so the op leaf name must be `'default'`, same as Shape 5.

export default function (n: number): number {
  return n * 3;
}

export const __samples__: Record<string, Record<string, unknown>> = {
  default: { n: 7 },
};
