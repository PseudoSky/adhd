/**
 * Fixture: surface that imports Decimal via the DEFAULT import form
 * (`import Decimal from 'decimal.js'`). This causes ts-morph to emit the
 * fully-qualified type text:
 *   `import("/path/to/node_modules/decimal.js/decimal").default`
 * rather than the bare string `"Decimal"`, which is the failing case that
 * dod.10 exercises. The `normalizeTypeText` helper must normalise this to
 * `"Decimal"` before the SCALAR_SCHEMAS lookup in buildSchema, so the
 * extracted schema carries `{ type: 'string', format: 'decimal' }`.
 */

import Decimal from 'decimal.js';

/** Add two decimal amounts with exact arbitrary precision. */
export async function addAmounts(a: Decimal, b: Decimal): Promise<Decimal> {
  return a.plus(b);
}

export const __samples__: Record<string, Record<string, unknown>> = {
  addAmounts: { a: '1.50', b: '2.25' },
};
