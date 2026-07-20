/**
 * FEAT-APIGEN-022 / BACKLOG point 3 — query-string coercion for GET domain args.
 *
 * HTTP query strings carry every value as a string (or string[] for repeated
 * keys). The composed input schema's validate-Layer (`makeValidateLayer`,
 * `@adhd/apigen-engine-runtime/validate-layer`) uses a single Ajv instance
 * with NO `coerceTypes`, shared by both GET (query) and POST (JSON body)
 * validation — enabling Ajv-level `coerceTypes` globally would silently
 * coerce POST body values too (e.g. a JSON string erroneously accepted where
 * a number was required), which SPEC §6 forbids. Coercion therefore happens
 * here, at the TRANSPORT layer, scoped to exactly the GET/query-string path,
 * before the already-strict (non-coercing) validate-Layer ever sees the
 * value — POST/body validation is completely untouched.
 *
 * Only `number`/`integer`/`boolean` are coerced (the non-`string` members of
 * FEAT-APIGEN-022's "properly typed primitives" set — `string` values are
 * already correctly typed as they arrive). A value that fails to parse (e.g.
 * `?count=abc` against a `number` param) is left AS-IS so the validate-Layer
 * still rejects it with a clear `invalid_argument` error, rather than being
 * silently dropped or coerced to `NaN`/`0`.
 */

/** Loose JSON-Schema property shape (only the field we inspect) — mirrors describe-params.ts's SchemaProp convention. */
interface DomainPropSchema {
  type?: string | string[];
}

function coercibleType(type: string | string[] | undefined): string | undefined {
  let types: string[];
  if (Array.isArray(type)) {
    types = type;
  } else if (type) {
    types = [type];
  } else {
    types = [];
  }
  return types.find((t) => t === 'number' || t === 'integer' || t === 'boolean');
}

/**
 * Coerces a request's query-string params to the JS types their domain
 * schema declares (`number`/`integer`/`boolean`), based on the function's own
 * composed schema. `string`-typed and unrecognised params pass through
 * unchanged; array-valued query entries (repeated keys) pass through
 * unchanged (arrays are outside FEAT-APIGEN-022's primitive-only hoist
 * boundary, so no domain param reaching here should be array-typed — but this
 * stays defensive rather than assuming that invariant).
 *
 * @param query  The raw `req.query` / `request.query` object.
 * @param schema The function's composed schema entry (`pkg.schemas[fnName]`) —
 *               loosely typed like `describeParams`'s `schema` param, since
 *               callers pass the untyped `ComposedSchemas` entry.
 */
export function coerceQueryParams(
  query: Record<string, unknown>,
  schema: { input?: unknown } | undefined
): Record<string, unknown> {
  const input = (schema?.input ?? {}) as {
    properties?: {
      data?: { properties?: Record<string, DomainPropSchema> };
    };
  };
  const domainProps = input.properties?.data?.properties ?? {};
  const result: Record<string, unknown> = { ...query };

  for (const [name, propSchema] of Object.entries(domainProps)) {
    const raw = result[name];
    if (typeof raw !== 'string') continue;

    const coercibleAs = coercibleType(propSchema?.type);
    if (coercibleAs === 'number' || coercibleAs === 'integer') {
      const n = Number(raw);
      if (!Number.isNaN(n) && raw.trim() !== '') result[name] = n;
    } else if (coercibleAs === 'boolean') {
      if (raw === 'true') result[name] = true;
      else if (raw === 'false') result[name] = false;
    }
  }

  return result;
}
