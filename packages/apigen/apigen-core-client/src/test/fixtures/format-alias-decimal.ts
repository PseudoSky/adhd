// Fixture: DEBT-APIGEN-007 — user type-alias with `@format` JSDoc preserves
// the format annotation through extract()'s param/return-type resolution.
//
// Exact repro from the backlog item: a plain, non-generic reference to a
// user-defined scalar type alias carrying an `@format` JSDoc tag, used as
// BOTH the param type and the return type of the same function.

/** @format decimal */
export type DecimalValue = string;

export function echoDecimal(value: DecimalValue): DecimalValue {
  return value;
}
