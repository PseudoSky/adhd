// Fixture for [dod.9] (decimal guard) and [dod.10] (dep manifest).
//
// Uses a REAL `decimal.js` `Decimal` rich type at both the param and return
// position — the truest reading of the DoD's "a surface that uses a Decimal".
// dod.10 then drives `generate` and asserts the produced package.json declares
// `decimal.js` so the output runs standalone after a clean install.
//
// This is the path DEBT-APIGEN-007 is about: ts-morph type resolution of an
// imported/aliased `Decimal` can lose the `format:decimal` annotation, in which
// case the dep-manifest collector never sees a decimal format and omits the dep.
// The probe drives the REAL pipeline and reports honestly whatever the produced
// package.json contains — it does NOT inject decimal.js or use a pre-annotated
// schema to dodge the extraction path.

import Decimal from 'decimal.js';

/** Add two decimal amounts with exact arbitrary precision. */
export async function addAmounts(a: Decimal, b: Decimal): Promise<Decimal> {
  return a.plus(b);
}

export const __samples__: Record<string, Record<string, unknown>> = {
  addAmounts: { a: '1.50', b: '2.25' },
};
