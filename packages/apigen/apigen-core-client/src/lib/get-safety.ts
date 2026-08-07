// FEAT-APIGEN-022 — the single, shared definition of "GET-hoistable by param
// shape" (SPEC §5 verb derivation). Consumed by both `apigen-engine-naming`'s
// `project()` (Operation-based, e.g. gRPC/openapi paths that bypass
// ComposedSchemas entirely) and `compose-schemas.ts` (which stamps the result
// onto `x-apigen-safe` for the HTTP transports' shared `httpVerb()` to read —
// see BUG-APIGEN-025). One implementation, two call sites, never re-derived.
//
// "Properly typed primitives" (BACKLOG FEAT-APIGEN-022 point 4): only
// `string`/`number`/`boolean`/`integer` round-trip reliably through a query
// string with no serialization convention. `array`/`object`/`$ref`/union
// (`oneOf`/`anyOf`/`allOf`) params are NOT eligible — Express's `qs` and
// Fastify's default query parser disagree on nested-object encoding, so
// "properly typed primitives" is a hard boundary, not a heuristic.
//
// A zero-domain-param function (`properties: {}`) is vacuously primitive-only
// — there is nothing to fail to round-trip — so it hoists too.

/** A single JSON-Schema property fragment, loosely typed (only fields we inspect). */
interface PropertySchema {
  type?: string | string[];
  $ref?: string;
  oneOf?: unknown[];
  anyOf?: unknown[];
  allOf?: unknown[];
  enum?: unknown[];
  items?: unknown;
  properties?: unknown;
}

const PRIMITIVE_TYPES = new Set(['string', 'number', 'boolean', 'integer']);

function isPrimitivePropertySchema(propSchema: unknown): boolean {
  if (typeof propSchema !== 'object' || propSchema === null) return false;
  const s = propSchema as PropertySchema;

  // Named/branded ($ref) and union/logical ($defs-backed oneOf/anyOf/allOf)
  // shapes are never "properly typed primitives" — they need a $defs pool to
  // resolve and aren't guaranteed query-string round-trippable.
  if (s.$ref !== undefined) return false;
  if (s.oneOf || s.anyOf || s.allOf) return false;

  const { type } = s;
  if (typeof type === 'string') return PRIMITIVE_TYPES.has(type);
  if (Array.isArray(type)) {
    // e.g. ['string', 'null'] for an optional param — every branch must be a
    // primitive (or 'null', which contributes no shape of its own).
    return type.every((t) => PRIMITIVE_TYPES.has(t) || t === 'null');
  }

  // No `type` keyword but a primitive-valued `enum` (string/number/boolean
  // literal union rendered without an accompanying `type`) is still a bare
  // primitive on the wire.
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    return s.enum.every((v) => ['string', 'number', 'boolean'].includes(typeof v));
  }

  return false;
}

/**
 * Structural check over a bare domain-input JSON Schema — the exact shape
 * carried as `Operation.input` (and, unchanged, as `GeneratedSchemas.schemas
 * [fn].input` — orchestrator.ts's Step 5 passes `op.input` straight through):
 * `{ type: 'object', properties, required }`.
 *
 * Returns `true` iff every declared property is a "properly typed primitive"
 * (`string`/`number`/`boolean`/`integer`, optionally unioned with `null`) —
 * including the zero-property case (vacuously true). Absence of a
 * `properties` key at all (as opposed to an explicit empty object) is NOT the
 * same as zero params — it means the input shape was never populated, so this
 * returns `false` rather than assume eligibility.
 */
export function isPrimitiveOnlyInputSchema(
  input: Record<string, unknown> | undefined | null
): boolean {
  if (!input || typeof input !== 'object') return false;
  const properties = input['properties'];
  if (properties === undefined) return false;
  if (typeof properties !== 'object' || properties === null) return false;
  return Object.values(properties as Record<string, unknown>).every(
    isPrimitivePropertySchema
  );
}
