/**
 * Central validation Layer — SPEC §6 (normative).
 *
 * Validates the incoming call's `domainArgs` (the `data` sub-object) and
 * `envelope` against the operation's composed input schema **before** dispatch
 * is reached.  A validation failure short-circuits the Layer stack and throws
 * `ApiError{ code: 'invalid_argument' }`, so dispatch is NEVER called with
 * malformed input (§8.1 rule 1).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * NECESSARY BUT NOT SUFFICIENT (SPEC §6, normative boundary)
 * ──────────────────────────────────────────────────────────────────────────
 * JSON-Schema validation is a fast-fail **pre-filter**, not the host's native
 * type guarantee.  It can accept values the native deserializer would coerce or
 * reject (number precision, extra properties, date strings, `Option` vs
 * missing), and it cannot enforce nominality / branded types (on the wire a
 * branded type *is* its base type).  The **authoritative** boundary is the
 * host's typed dispatch — for static hosts that is the codegen-woven
 * deserialize→typed-params step (SPEC §2).  Hosts MUST NOT treat "validated"
 * as "safe to transmute."
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Design:
 *  - One Ajv instance is created once (module-level singleton) — compile is
 *    cheap; schema-compile happens per schema object (cached by reference).
 *  - The layer validates the FULL composed input schema against a synthetic
 *    object `{ data: domainArgs, ...envelope }` so that both the domain params
 *    and the envelope side-channel are covered in one pass.
 *  - The `input` schema is taken from `opts.schemas[fnName].input`.  If no
 *    schema is present the layer delegates to next (unknown operation — the
 *    invoker will throw the "no schema found" guard downstream).
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import { ApiError } from '@adhd/apigen-base-errors';
import {
  X_APIGEN_LOGICAL,
  X_APIGEN_CODEC,
  X_APIGEN_CTOR,
  X_APIGEN_TOJSON,
  synthesizeExample,
} from '@adhd/apigen-base-logical';
import type { Layer, Call, Next } from './invoke';
import type { LayerResult } from './invoke';

// ---------------------------------------------------------------------------
// Ajv singleton — one instance for all validation in the runtime process.
// `allErrors: true` collects all violations, not just the first, so the error
// message is maximally informative.
// `verbose: true` attaches `parentSchema` and `data` to each ErrorObject. The
// formatter below reads `parentSchema.properties` (the set of keys that WOULD
// have been accepted, for a "did you mean"/allowed-keys hint) and `data` (to
// echo back the rejected value) — neither is present on AJV's default lite
// error shape, so verbose is a correctness requirement here, not decoration.
// `addFormats` registers all standard JSON Schema `format` keywords (date-time,
// date, time, uuid, email, uri, etc.) so that a schema like
// `{ type: 'string', format: 'date-time' }` actively rejects non-conforming
// strings instead of treating the format keyword as advisory.
//
// apigen's schema builders (`schema-builders/nominal.ts`, `schema-builders/
// union.ts`) tag nominal/branded and union `$def`s with advisory
// `x-apigen-*` keys (`X_APIGEN_LOGICAL`/`X_APIGEN_CODEC`/`X_APIGEN_CTOR`/
// `X_APIGEN_TOJSON` from `@adhd/apigen-base-logical`) plus an OpenAPI-style
// `discriminator` object on union fragments — read back by `union-codec.ts`/
// `nominal-codec.ts` at decode time, never by Ajv itself. Per DESIGN §4.1
// `[inv:hints-advisory]` these keys are optional annotations layered on top
// of an already-authoritative structural schema (`$ref`/`oneOf`/`properties`),
// so they're registered here as no-op `valid: true` keywords rather than via
// Ajv's built-in `discriminator: true` option — that option enforces its own
// OpenAPI discriminator semantics and explicitly rejects the `mapping` object
// apigen's `discriminator` fragment carries ("discriminator: mapping is not
// supported"), so it cannot compile these schemas either. `strict: true`
// (Ajv 8's default) throws `strict mode: unknown keyword` at compile time for
// any of these five keys unless declared, which crashed BUG-APIGEN-030.
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, verbose: true });
addFormats(ajv);
for (const keyword of [
  X_APIGEN_LOGICAL,
  X_APIGEN_CODEC,
  X_APIGEN_CTOR,
  X_APIGEN_TOJSON,
  'discriminator',
]) {
  ajv.addKeyword({ keyword, valid: true });
}
// apigen logical-type `format`s that ajv-formats does not ship. The canonical wire
// for `decimal` is a decimal string (DESIGN §3); register it so a `{type:'string',
// format:'decimal'}` param validates instead of throwing "unknown format" once the
// validate-Layer is active over a live transport. (date-time/int64/byte/uuid are
// already covered by ajv-formats above.)
ajv.addFormat('decimal', /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an AJV `instancePath` (a JSON Pointer, e.g. `/data/input/filter`)
 * into a readable dotted path (`data.input.filter`). An empty path is `(root)`.
 *
 * @internal
 */
function pointerToPath(instancePath: string): string {
  if (!instancePath) return '(root)';
  return instancePath
    .replace(/^\//, '')
    .split('/')
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');
}

/**
 * The declared keys of the object schema a violation points at. AJV carries the
 * offending object's own schema in `ErrorObject.parentSchema`, so its
 * `properties` is exactly the set of keys that WOULD have been accepted.
 *
 * @internal
 */
function allowedKeysOf(parentSchema: unknown): string[] {
  const props = (
    parentSchema as { properties?: Record<string, unknown> } | undefined
  )?.properties;
  return props ? Object.keys(props) : [];
}

/**
 * Levenshtein edit distance. Small inputs only (the bounded-key suggestion path).
 *
 * @internal
 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * The nearest declared key to an unrecognized one — the "did you mean" hint.
 * Returns `undefined` when nothing is close enough; the threshold grows with the
 * input length so short keys do not match spuriously.
 *
 * @internal
 */
function closestKey(unknown: string, allowed: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const key of allowed) {
    const d = editDistance(unknown.toLowerCase(), key.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = key;
    }
  }
  const threshold = Math.max(2, Math.floor(unknown.length / 3));
  return best !== undefined && bestDist <= threshold ? best : undefined;
}

/** A short type label for a rejected value (used by `type` violations). */
function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Render ONE AJV error as an actionable line.
 *
 * The whole point (BUG-APIGEN-MCP-DISCOVERABILITY-001): AJV's raw `message` for
 * an `additionalProperties` violation is the bare string "must NOT have
 * additional properties" — it names NEITHER the offending key NOR the keys that
 * would have been accepted, so a caller (especially an LLM) can only guess
 * again. AJV carries the offending key in `params.additionalProperty` and the
 * accepted set in `parentSchema.properties`; this surfaces both, plus a
 * nearest-key ("did you mean") hint.
 *
 * @internal
 */
function formatOneError(e: ErrorObject): string {
  const where = pointerToPath(e.instancePath);
  const params = (e.params ?? {}) as Record<string, unknown>;

  switch (e.keyword) {
    case 'additionalProperties': {
      const unknownKey = String(params['additionalProperty'] ?? '?');
      const allowed = allowedKeysOf(e.parentSchema);
      const suggestion = closestKey(unknownKey, allowed);
      const allowedPart = allowed.length
        ? `; allowed keys: ${allowed.join(', ')}`
        : '';
      const hintPart = suggestion ? ` (did you mean '${suggestion}'?)` : '';
      return `unknown key '${unknownKey}' at ${where}${allowedPart}${hintPart}`;
    }
    case 'required': {
      const missing = String(params['missingProperty'] ?? '?');
      const allowed = allowedKeysOf(e.parentSchema);
      const allowedPart = allowed.length
        ? `; allowed keys: ${allowed.join(', ')}`
        : '';
      return `missing required key '${missing}' at ${where}${allowedPart}`;
    }
    case 'enum': {
      const allowed = Array.isArray(params['allowedValues'])
        ? (params['allowedValues'] as unknown[])
        : [];
      const got = (e as { data?: unknown }).data;
      return `value ${JSON.stringify(got)} at ${where} is not one of: ${allowed
        .map((v) => JSON.stringify(v))
        .join(', ')}`;
    }
    case 'type': {
      const got = (e as { data?: unknown }).data;
      return `${where} must be ${String(params['type'])} (got ${valueType(got)})`;
    }
    default:
      return `${where} ${e.message ?? 'failed schema check'}`;
  }
}

/** Max individual violations listed before the tail is summarized by a count. */
const MAX_REPORTED_ERRORS = 12;

/**
 * Format AJV error objects into an actionable, human/agent-readable summary.
 *
 * @internal
 */
function formatErrors(errors: ErrorObject[]): string {
  const shown = errors.slice(0, MAX_REPORTED_ERRORS).map(formatOneError);
  if (errors.length > MAX_REPORTED_ERRORS) {
    shown.push(`…and ${errors.length - MAX_REPORTED_ERRORS} more`);
  }
  return shown.join('; ');
}

/**
 * True when a synthesized example carries a concrete value, i.e. it is not just
 * nested empty objects. A schema whose required set is empty (e.g. an
 * all-optional `data.input`) synthesizes to `{"data":{"input":{}}}`, which
 * teaches a caller nothing and reads as "pass an empty object" — worse than no
 * example. Such an example is suppressed.
 *
 * @internal
 */
function hasInformativeValue(value: unknown): boolean {
  if (value === null) return false;
  if (Array.isArray(value)) return value.some(hasInformativeValue);
  if (typeof value === 'object') {
    const values = Object.values(value as Record<string, unknown>);
    return values.some(hasInformativeValue);
  }
  return true;
}

/**
 * BUG-APIGEN-MCP-DISCOVERABILITY-001: builds the full `invalid_argument`
 * message for a validation failure — AJV's own per-violation diagnostics
 * (WHAT was wrong, from {@link formatErrors}, made actionable: the offending
 * key, the accepted keys, and a nearest-key hint) PLUS, when it is actually
 * informative, a concrete schema-derived example of a shape that WOULD pass
 * (WHAT a correct call looks like), synthesized by the same
 * `@adhd/apigen-base-logical` primitive the MCP tool description
 * (`tool-description.ts`'s `buildToolDescription`) uses for its own
 * `Example: {...}` note.
 *
 * An example that would synthesize to nested empty objects (an all-optional
 * input) is dropped rather than shown, so the error never reads as "pass an
 * empty object".
 *
 * @internal shared by both {@link validateLayer} and {@link makeValidateLayer}.
 */
function buildValidationErrorMessage(
  errors: ErrorObject[],
  inputSchema: Record<string, unknown>
): string {
  const parts = [`Validation failed: ${formatErrors(errors)}`];
  const example = synthesizeExample(
    inputSchema as Parameters<typeof synthesizeExample>[0]
  );
  if (hasInformativeValue(example)) {
    parts.push(`Example: ${JSON.stringify(example)}`);
  }
  return parts.join(' — ');
}

// ---------------------------------------------------------------------------
// validateLayer — the exported Layer
// ---------------------------------------------------------------------------

/**
 * A compose-time Layer that validates `call.domainArgs` and `call.envelope`
 * against the operation's composed input schema before forwarding to dispatch.
 *
 * Place this Layer **innermost** (last in the `layers` array passed to
 * `createInvoker`) so it runs immediately before dispatch, after all
 * authentication / authorization Layers have had their chance to inspect (and
 * reject) the call.
 *
 * Short-circuits with `ApiError{ code: 'invalid_argument' }` on any schema
 * violation.  Delegates to `next()` on success.
 *
 * @remarks
 * This validates **shape**, not **domain correctness** (SPEC §6 necessary-but-
 * not-sufficient boundary — see module JSDoc).
 */
export const validateLayer: Layer = async (
  call: Call,
  next: Next
  // InvokeOptions is not a Layer param in the §8.1 signature; the layer
  // closes over the schemas via the call's operation id.  We reach the
  // schemas through a different mechanism: we accept an optional opts override
  // injected by makeValidateLayer when callers need schema access.
  // For the common compose-time path we use the schemas carried on the Call
  // via a typed ctx extension (see ValidateLayerSchemas symbol).
  // However, the simplest harness-compatible design is to provide a factory:
): Promise<LayerResult> => {
  // Retrieve schemas from ctx (inserted by makeValidateLayer's wrapper).
  const schemas = call.ctx.get(ValidateSchemasToken);
  if (schemas === undefined) {
    // No schemas injected — pass through (graceful degradation; the invoker
    // will enforce the schema-not-found guard at dispatch time).
    return next();
  }

  const fnName = call.operation.id;
  const schema = schemas[fnName];
  if (schema === undefined) {
    // Unknown operation — delegate; createInvoker throws "no schema found".
    return next();
  }

  // Build the subject to validate: synthesize the composed input shape
  // `{ data: domainArgs, ...envelope }` so both sides are covered in one pass.
  const subject: Record<string, unknown> = {
    data: call.domainArgs,
    ...call.envelope,
  };

  const validate = ajv.compile(schema.input);
  const valid = validate(subject);

  if (!valid) {
    const errors = validate.errors ?? [];
    throw new ApiError(
      'invalid_argument',
      buildValidationErrorMessage(errors, schema.input),
      errors
    );
  }

  return next();
};

// ---------------------------------------------------------------------------
// ValidateSchemasToken — typed ctx extension key
// ---------------------------------------------------------------------------

import type { ComposedSchemas } from './types';

/**
 * Typed ctx extension token that carries the `ComposedSchemas` through the
 * Layer stack to `validateLayer`.
 *
 * Usage (by the caller / transport adapter):
 * ```ts
 * call.ctx.set(ValidateSchemasToken, schemas)
 * ```
 *
 * `validateLayer` reads it back with `call.ctx.get(ValidateSchemasToken)`.
 */
export const ValidateSchemasToken = Symbol('ValidateSchemasToken');

// Teach LayerContext about this symbol's type via module augmentation is not
// possible for symbols, so we use a cast at the read site.  The token is
// documented and exported so callers can set/get the correct type.
declare module './invoke' {
  interface LayerContext {
    get(token: typeof ValidateSchemasToken): ComposedSchemas | undefined;
    set(token: typeof ValidateSchemasToken, value: ComposedSchemas): void;
  }
}

// ---------------------------------------------------------------------------
// makeValidateLayer — factory that produces a self-contained Layer
// ---------------------------------------------------------------------------

/**
 * Factory that produces a validation Layer **pre-bound** to a `ComposedSchemas`
 * map.  Prefer this over the raw `validateLayer` singleton when composing a
 * static invoker at plugin instantiation time — it avoids the ctx-token
 * ceremony and makes the Layer entirely self-contained.
 *
 * ```ts
 * const invoke = createInvoker([makeValidateLayer(schemas), authLayer])
 * ```
 *
 * Validation is still necessary-but-not-sufficient (SPEC §6) — it validates
 * shape, not domain correctness.
 *
 * @param schemas - The composed schemas for the target namespace.
 */
export function makeValidateLayer(schemas: ComposedSchemas): Layer {
  return async function validationLayer(
    call: Call,
    next: Next
  ): Promise<LayerResult> {
    const fnName = call.operation.id;
    const schema = schemas[fnName];
    if (schema === undefined) {
      // Unknown operation — delegate; createInvoker throws "no schema found".
      return next();
    }

    // Synthesize the composed input subject for validation.
    const subject: Record<string, unknown> = {
      data: call.domainArgs,
      ...call.envelope,
    };

    const validate = ajv.compile(schema.input);
    const valid = validate(subject);

    if (!valid) {
      const errors = validate.errors ?? [];
      throw new ApiError(
        'invalid_argument',
        buildValidationErrorMessage(errors, schema.input),
        errors
      );
    }

    return next();
  };
}
