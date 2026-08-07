// example.ts — BUG-APIGEN-MCP-DISCOVERABILITY-001 support.
//
// Generic, schema-driven "worked example" synthesis for JSON Schema
// fragments. Given ANY JSON Schema (draft-07-ish: `type`/`properties`/
// `required`/`items`/`enum`/`const`/`oneOf`/`anyOf`/`allOf`/`$ref`/`format`),
// produces a plausible, minimal, AJV-valid example value.
//
// This is the SINGLE shared primitive behind two otherwise-duplicated
// concerns in `@adhd/apigen-*`:
//   - `apigen-core-client`'s `composeSchemas` (BUG-APIGEN-020) appends a
//     concrete `Example: {...}` to the calling-convention note it stamps on
//     every composed input schema's `description`, so an MCP tool's
//     description shows the REAL field names an agent must send — not just
//     a generic "wrap params in a data envelope" sentence.
//   - `apigen-engine-runtime`'s `validate-layer.ts` appends the SAME kind of
//     concrete example to an AJV validation failure message, so a rejected
//     call tells the caller not just WHAT was wrong (AJV's own message) but
//     what a PASSING call looks like.
//
// Deliberately schema-shape-driven, not per-operation hand-written — this
// generalizes automatically to every apigen-composed schema (present and
// future), across both `{data:{...}}`-enveloped extracted operations AND
// flat, non-enveloped mount-derived operations (e.g. `apigen-plugin-batch`'s
// `_batch/<kind>` synthetic ops) — the shape is read off whatever schema is
// passed in, never assumed.
//
// Design notes:
//  - Only REQUIRED properties are populated (object shapes with no
//    `required` array synthesize to `{}`) — this keeps examples compact
//    (SPEC intent: "compact JSON example") while still guaranteeing the
//    synthesized value satisfies AJV's `required` check. Optional
//    properties are never necessary for an example to validate.
//  - `$ref` is resolved against the schema document's own `definitions`/
//    `$defs` (apigen composes both root-level `Operation.input` and mount
//    schemas as fully self-contained documents — see `compose-schemas.ts`
//    and `hoistNestedDefs` in `extract.ts` — so there is never an external
//    document to fetch).
//  - `oneOf`/`anyOf` pick the FIRST branch — deterministic, and for the one
//    real repo-wide use of a root-level `oneOf` (the batch plugin's
//    discriminated per-kind mount, `apigen-core-client/src/lib/batch.ts`)
//    this yields a concrete, valid example selecting one real fan-out
//    operation, not a hand-wavy union placeholder.
//  - `format`-tagged strings synthesize a value that actually satisfies
//    `ajv-formats`' format validators (date-time, date, time, uuid, email,
//    uri, byte) plus apigen's own registered logical formats (decimal,
//    int64 — see `validate-layer.ts`), not a generic `<string>` that would
//    fail format validation.
//  - Recursion is depth-bounded (`MAX_DEPTH`) purely as a safety net against
//    a pathological/self-referential schema; every real schema in this repo
//    is far shallower.

/** The minimal JSON-Schema-shaped structure this module reads. */
export interface JsonSchemaLike {
  type?: string | string[];
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  items?: JsonSchemaLike | JsonSchemaLike[];
  enum?: unknown[];
  const?: unknown;
  format?: string;
  oneOf?: JsonSchemaLike[];
  anyOf?: JsonSchemaLike[];
  allOf?: JsonSchemaLike[];
  $ref?: string;
  definitions?: Record<string, JsonSchemaLike>;
  $defs?: Record<string, JsonSchemaLike>;
  [key: string]: unknown;
}

const MAX_DEPTH = 12;

/**
 * Resolve a `$ref` (e.g. `"#/definitions/User"` or `"#/$defs/User"`) against
 * `root`'s own `definitions`/`$defs` maps. Only same-document, JSON-Pointer
 * style refs are supported — the only kind apigen's schema builders ever
 * produce (see `compose-schemas.ts`'s `validateComposedRefs`).
 */
function resolveRef(
  ref: string,
  root: JsonSchemaLike
): JsonSchemaLike | undefined {
  const match = /^#\/(definitions|\$defs)\/(.+)$/.exec(ref);
  if (!match) return undefined;
  const [, bucket, name] = match;
  const dict =
    bucket === '$defs' ? root.$defs : (root.definitions as typeof root.$defs);
  return dict?.[decodeURIComponent(name)];
}

/** First defined element of an array-of-schemas branch list, if any. */
function firstBranch(
  branches: JsonSchemaLike[] | undefined
): JsonSchemaLike | undefined {
  return Array.isArray(branches) && branches.length > 0
    ? branches[0]
    : undefined;
}

/**
 * Resolve the effective scalar `type` for a schema fragment: a `type` array
 * picks the first non-`'null'` entry (falling back to `'null'` if that's all
 * there is); an absent `type` with `properties` present is treated as
 * `'object'` (common in generator output that omits the redundant `type`
 * keyword).
 */
function effectiveType(schema: JsonSchemaLike): string | undefined {
  if (Array.isArray(schema.type)) {
    return schema.type.find((t) => t !== 'null') ?? schema.type[0];
  }
  if (typeof schema.type === 'string') return schema.type;
  if (schema.properties) return 'object';
  return undefined;
}

/** Format-aware placeholder for a `{type:'string', format:'...'}` schema. */
function synthesizeString(schema: JsonSchemaLike): string {
  switch (schema.format) {
    case 'date-time':
      return '1970-01-01T00:00:00.000Z';
    case 'date':
      return '1970-01-01';
    case 'time':
      return '00:00:00Z';
    case 'uuid':
      return '00000000-0000-0000-0000-000000000000';
    case 'email':
      return 'user@example.com';
    case 'uri':
    case 'url':
    case 'uri-reference':
      return 'https://example.com';
    case 'hostname':
      return 'example.com';
    case 'ipv4':
      return '127.0.0.1';
    case 'ipv6':
      return '::1';
    // apigen logical-type formats registered by validate-layer.ts / codecs:
    case 'decimal':
      return '0';
    case 'int64':
      return '0';
    case 'byte':
      return ''; // empty base64 — always valid standard-base64
    default:
      return '<string>';
  }
}

function synthesizeObject(
  schema: JsonSchemaLike,
  root: JsonSchemaLike,
  depth: number
): Record<string, unknown> {
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  const obj: Record<string, unknown> = {};
  for (const key of required) {
    const propSchema = props[key];
    obj[key] =
      propSchema !== undefined
        ? synthesizeExample(propSchema, root, depth + 1)
        : `<${key}>`;
  }
  return obj;
}

function synthesizeArray(
  schema: JsonSchemaLike,
  root: JsonSchemaLike,
  depth: number
): unknown[] {
  const itemSchema = Array.isArray(schema.items)
    ? schema.items[0]
    : schema.items;
  if (!itemSchema) return [];
  return [synthesizeExample(itemSchema, root, depth + 1)];
}

/**
 * Synthesize a minimal, AJV-plausible example value for `schema`.
 *
 * @param schema - The schema fragment to synthesize a value for.
 * @param root - The document root `$ref`s in `schema` (and its descendants)
 *   resolve against. Defaults to `schema` itself — correct for the common
 *   case where `schema` IS the whole self-contained document (apigen always
 *   composes schemas this way; see module doc).
 * @param depth - Internal recursion guard; callers never need to pass this.
 */
export function synthesizeExample(
  schema: JsonSchemaLike | undefined,
  root: JsonSchemaLike = schema ?? {},
  depth = 0
): unknown {
  if (!schema || depth > MAX_DEPTH) return null;

  if (typeof schema.$ref === 'string') {
    const resolved = resolveRef(schema.$ref, root);
    return resolved !== undefined
      ? synthesizeExample(resolved, root, depth + 1)
      : null;
  }

  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    // Merge all branches' properties/required into one synthetic object
    // shape — apigen's own allOf usage (logical-type intersections) is
    // always object-shaped in this repo.
    const mergedProps: Record<string, JsonSchemaLike> = {};
    const mergedRequired: string[] = [];
    for (const branch of schema.allOf) {
      Object.assign(mergedProps, branch.properties ?? {});
      for (const r of branch.required ?? []) {
        if (!mergedRequired.includes(r)) mergedRequired.push(r);
      }
    }
    return synthesizeObject(
      { ...schema, properties: mergedProps, required: mergedRequired },
      root,
      depth
    );
  }

  const branch = firstBranch(schema.oneOf) ?? firstBranch(schema.anyOf);
  if (branch) return synthesizeExample(branch, root, depth + 1);

  const type = effectiveType(schema);
  switch (type) {
    case 'object':
      return synthesizeObject(schema, root, depth);
    case 'array':
      return synthesizeArray(schema, root, depth);
    case 'string':
      return synthesizeString(schema);
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return null;
  }
}

/**
 * Render `schema`'s synthesized example as a compact `Example: {...}` note,
 * or `undefined` if there's nothing meaningful to show (schema absent).
 * Shared rendering so every call site (tool descriptions, validation error
 * messages) produces byte-identical example text for the same schema.
 */
export function renderExampleNote(schema: JsonSchemaLike | undefined): string | undefined {
  if (!schema) return undefined;
  const example = synthesizeExample(schema);
  return `Example: ${JSON.stringify(example)}`;
}
