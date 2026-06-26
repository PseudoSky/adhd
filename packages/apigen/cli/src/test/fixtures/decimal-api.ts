/**
 * Fixture: surface that uses a Decimal-typed parameter and return value.
 *
 * Uses a JSDoc @format annotation on an exported type alias so
 * ts-json-schema-generator emits { type: 'string', format: 'decimal' }
 * — the standard hook that the dep-manifest collector keys on.
 *
 * The type MUST be exported for ts-json-schema-generator to resolve it
 * from the function parameter type text.
 */

/** @format decimal */
export type DecimalValue = string;

/** Calculate the tax amount on a price. */
export async function calcTax(
  price: DecimalValue,
  rate: DecimalValue,
): Promise<DecimalValue> {
  // Fixture only — not run in tests.
  void price; void rate;
  return '0.00' as DecimalValue;
}

export const __samples__: Record<string, Record<string, unknown>> = {
  calcTax: { price: '100.00', rate: '0.15' },
}
