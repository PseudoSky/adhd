import type { SchemaNode } from '@adhd/apigen-base-logical';
import { validateSchemaRefs } from '@adhd/apigen-base-logical';
import type { GeneratedSchemas, ComposedSchemas } from './types';
import { isPrimitiveOnlyInputSchema } from './get-safety';

interface SlimMiddleware {
  id: string;
  envelope?: Record<string, unknown>;
}

/**
 * BUG-APIGEN-CORE-001 (v1 retirement): v1's deleted `generate-schemas.ts`
 * validated every function's `input`/`output` schema's `$ref`s against a
 * `$defs` dictionary pooled across ALL functions in the source file, so an
 * unresolvable `$ref` (e.g. the BUG-APIGEN-026 class of bug) threw a clear,
 * function-scoped error at generate time instead of a confusing AJV crash on
 * first invocation. That safety net was silently dropped when v1 was deleted
 * — `composeSchemas()` is where all of a namespace's functions are present
 * together in one pass, the same shape v1 had them in, so it's re-wired here.
 */
function validateComposedRefs(domainSchemas: GeneratedSchemas): void {
  // BUG-APIGEN-029: `validateSchemaRefs` (apigen-base-logical) looks resolved
  // definitions up by the LITERAL `$ref` string (e.g. `"#/definitions/User"`),
  // not the bare definition name — and `ts-json-schema-generator` (the only
  // real producer of these defs, via extract.ts's `hoistNestedDefs`) keys its
  // `definitions` dict by BARE name (`{ User: {...} }`), never `$defs`, and
  // never by the full ref-URI. Collecting only bare names under a `$defs` key
  // (the pre-fix code) silently no-op'd this entire safety net for every real
  // schema, so BUG-APIGEN-029-class dangling refs reached `ajv.compile()` at
  // first dispatch instead of failing loudly here at generate time.
  //
  // Two def-dict key conventions coexist in this codebase: real generator
  // output keys bare (`definitions: { User: {...} }`), while this file's own
  // hand-built test fixtures (`compose-schemas.spec.ts`, matching
  // `validateSchemaRefs`'s own doc example) key `$defs` by the full ref-URI
  // directly (`$defs: { '#/$defs/User': {...} }`). Detect which form a given
  // entry already is (its key already starts with `#/`) instead of blindly
  // prefixing, so real-generator bare names get the `#/<defKey>/` prefix
  // added while already-qualified hand-built keys aren't double-prefixed.
  const allDefs: Record<string, SchemaNode> = {};
  const collectDefs = (node: Record<string, unknown>): void => {
    for (const defKey of ['definitions', '$defs'] as const) {
      const defs = node[defKey] as Record<string, SchemaNode> | undefined;
      if (!defs) continue;
      for (const [name, def] of Object.entries(defs)) {
        const refUri = name.startsWith('#/') ? name : `#/${defKey}/${name}`;
        allDefs[refUri] = def;
      }
    }
  };
  for (const fnSchema of Object.values(domainSchemas.schemas)) {
    collectDefs(fnSchema.input);
    collectDefs(fnSchema.output);
  }
  // Only run validation when there are $defs to resolve against; a schema
  // with $ref but no $defs at all is a structural problem the composed
  // output / downstream AJV compile will catch.
  if (Object.keys(allDefs).length === 0) return;

  for (const [fnName, fnSchema] of Object.entries(domainSchemas.schemas)) {
    try {
      validateSchemaRefs(fnSchema.input, allDefs);
      validateSchemaRefs(fnSchema.output, allDefs);
    } catch (err) {
      throw new Error(
        `[apigen-core-client] Schema validation failed for function "${fnName}": ${(err as Error).message}`
      );
    }
  }
}

/**
 * BUG-APIGEN-020: builds the human-readable calling-convention note that
 * apigen stamps onto every composed input schema's top-level `description`.
 *
 * Consumers (agents, MCP hosts) otherwise have to discover by trial and error
 * that (a) ALL domain parameters are wrapped in a `data: {}` envelope, and
 * (b) any transport-level envelope fields (session, auth token, …) are NOT
 * part of `data` — for MCP specifically they travel via
 * `arguments._meta["x-<pluginId>-<field>"]` (see `@adhd/apigen-naming`
 * `envelopeMetaKey`), not as sibling properties of `data`.
 */
function buildEnvelopeDescription(
  envelopeFieldNames: readonly string[],
  hasDomainParams: boolean
): string {
  const parts: string[] = [
    `apigen calling convention: all domain parameters go inside a "data" envelope — ` +
      `e.g. { "data": { ... } }` +
      (hasDomainParams ? '.' : ' (an empty object for this zero-parameter tool).'),
  ];
  if (envelopeFieldNames.length > 0) {
    parts.push(
      `Field(s) ${envelopeFieldNames
        .map((f) => `"${f}"`)
        .join(', ')} are transport-level envelope metadata, NOT domain data — ` +
        `do not nest them under "data". Over MCP they are read from ` +
        `arguments._meta["x-<pluginId>-<field>"] (default pluginId "adhd"); ` +
        `see @adhd/apigen-naming's envelopeMetaKey/envelopeCliFlag/envelopeEnvVar ` +
        `for the HTTP-header / CLI-flag / env-var equivalents.`
    );
  }
  return parts.join(' ');
}

/**
 * Merges domain schemas with middleware envelope fields.
 *
 * The `data: {}` wrapper **property** is always present, even for zero-param
 * functions, so `{"data": {}}` still validates for callers who send it out of
 * habit or symmetry. FEAT-APIGEN-023: the wrapper is only listed in the outer
 * `required` array when the function actually has ≥1 required domain param
 * (`domainRequired.length > 0`) — mirroring the exact same condition already
 * used for the nested `data` schema's own `required`. A truly zero-parameter
 * function's published schema therefore does not force callers to send an
 * empty `data: {}` (or the whole envelope, if no middleware requires anything
 * else). Override a middleware with `false` to suppress its envelope
 * contribution for a specific function [inv:false-suppresses-middleware].
 *
 * BUG-APIGEN-017: both the top-level (envelope + data) object and the nested
 * `data` object are generated with `additionalProperties: false` so MCP hosts
 * (and any other JSON-Schema-validating consumer) reject unknown parameters
 * instead of silently discarding them.
 *
 * BUG-APIGEN-020: the top-level schema also carries a `description` that
 * documents the `data` envelope + any transport-envelope fields — see
 * {@link buildEnvelopeDescription}.
 */
export function composeSchemas(
  domainSchemas: GeneratedSchemas,
  middlewares: ReadonlyArray<SlimMiddleware>,
  overrides?: Record<string, Record<string, boolean>>
): ComposedSchemas {
  validateComposedRefs(domainSchemas);

  const result: ComposedSchemas = {};

  for (const [fnName, fnSchema] of Object.entries(domainSchemas.schemas)) {
    const fnOverrides = overrides?.[fnName] ?? {};

    const domainProperties = (fnSchema.input['properties'] ?? {}) as Record<
      string,
      unknown
    >;
    const domainRequired = (fnSchema.input['required'] ?? []) as string[];

    // Collect envelope fragments from active middlewares.
    // Only `false` suppresses — null/undefined/0 do not [inv:false-suppresses-middleware].
    const envelopeProperties: Record<string, unknown> = {};
    const envelopeRequired: string[] = [];

    for (const mw of middlewares) {
      if (!mw.envelope) continue;
      if (fnOverrides[mw.id] === false) continue;
      for (const [key, schema] of Object.entries(mw.envelope)) {
        envelopeProperties[key] = schema;
        if (!envelopeRequired.includes(key)) envelopeRequired.push(key);
      }
    }

    // data: {} wrapper property — always present, even for zero-param fns, so
    // `{"data": {}}` still validates. FEAT-APIGEN-023: the top-level `required`
    // entry for "data" is conditional on the function actually having ≥1
    // required domain param, not unconditional like the property itself.
    // BUG-APIGEN-017: additionalProperties:false — unknown domain params are rejected, not ignored.
    const dataSchema: Record<string, unknown> = {
      type: 'object',
      properties: domainProperties,
      additionalProperties: false,
      ...(domainRequired.length > 0 ? { required: domainRequired } : {}),
    };

    // FEAT-APIGEN-022 / BUG-APIGEN-025: the single decision point for
    // GET-eligibility. `fnSchema.safe` is `op.safe` threaded through from the
    // extractor (currently always `false` for every `kind: 'action'` — see
    // extract.ts — so this term is a no-op today, but is real once `safe`
    // becomes inferable). `isPrimitiveOnlyInputSchema` auto-hoists a function
    // whose domain params are ALL "properly typed primitives" (or zero
    // params) — the param-shape criterion FEAT-APIGEN-022 asked for — WITHOUT
    // requiring the manual `--opt http.verb.<id>=GET` override. Stamped as
    // `x-apigen-safe` so every HTTP transport's shared `httpVerb()`
    // (`@adhd/apigen-naming`) picks it up identically; the manual override
    // still wins there regardless of this value (checked first).
    const safe =
      fnSchema.safe === true || isPrimitiveOnlyInputSchema(fnSchema.input);

    // BUG-APIGEN-029: `fnSchema.input`'s own `definitions`/`$defs` (hoisted by
    // extract.ts's `hoistNestedDefs` from param fragments that needed an
    // internal `$ref`, e.g. self-referential/recursive complex types) must
    // land on THIS object — the actual document root `ajv.compile(schema.input)`
    // resolves `$ref`s against — not merely somewhere inside `dataSchema`,
    // which sits one level deeper once wrapped in the `data` envelope below.
    const inputDefinitions = fnSchema.input['definitions'] as
      | Record<string, unknown>
      | undefined;
    const inputDollarDefs = fnSchema.input['$defs'] as
      | Record<string, unknown>
      | undefined;

    result[fnName] = {
      input: {
        type: 'object',
        properties: { ...envelopeProperties, data: dataSchema },
        required: [
          ...envelopeRequired,
          ...(domainRequired.length > 0 ? ['data'] : []),
        ],
        // BUG-APIGEN-017: reject any property that isn't a declared envelope
        // field or the "data" wrapper — no silently-ignored junk params.
        additionalProperties: false,
        // BUG-APIGEN-020: document the envelope/data calling convention inline.
        description: buildEnvelopeDescription(
          Object.keys(envelopeProperties),
          Object.keys(domainProperties).length > 0
        ),
        ...(inputDefinitions ? { definitions: inputDefinitions } : {}),
        ...(inputDollarDefs ? { $defs: inputDollarDefs } : {}),
      },
      output: fnSchema.output,
      // Carry the ctx-param flag through to dispatch (BUG-APIGEN-001).
      ...(fnSchema.hasCtx ? { hasCtx: true } : {}),
      'x-apigen-safe': safe,
    };
  }

  return result;
}
