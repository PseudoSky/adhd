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

import Ajv from 'ajv'
import type { ErrorObject } from 'ajv'
import { ApiError } from '@adhd/apigen-errors'
import type { Layer, Call, Next } from './invoke'
import type { LayerResult } from './invoke'
import type { InvokeOptions } from './invoke'

// ---------------------------------------------------------------------------
// Ajv singleton — one instance for all validation in the runtime process.
// `allErrors: true` collects all violations, not just the first, so the error
// message is maximally informative.
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format AJV error objects into a human-readable summary line.
 *
 * @internal
 */
function formatErrors(errors: ErrorObject[]): string {
  return errors
    .map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'failed schema check'}`)
    .join('; ')
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
  next: Next,
  // InvokeOptions is not a Layer param in the §8.1 signature; the layer
  // closes over the schemas via the call's operation id.  We reach the
  // schemas through a different mechanism: we accept an optional opts override
  // injected by makeValidateLayer when callers need schema access.
  // For the common compose-time path we use the schemas carried on the Call
  // via a typed ctx extension (see ValidateLayerSchemas symbol).
  // However, the simplest harness-compatible design is to provide a factory:
): Promise<LayerResult> => {
  // Retrieve schemas from ctx (inserted by makeValidateLayer's wrapper).
  const schemas = call.ctx.get(ValidateSchemasToken)
  if (schemas === undefined) {
    // No schemas injected — pass through (graceful degradation; the invoker
    // will enforce the schema-not-found guard at dispatch time).
    return next()
  }

  const fnName = call.operation.id
  const schema = schemas[fnName]
  if (schema === undefined) {
    // Unknown operation — delegate; createInvoker throws "no schema found".
    return next()
  }

  // Build the subject to validate: synthesize the composed input shape
  // `{ data: domainArgs, ...envelope }` so both sides are covered in one pass.
  const subject: Record<string, unknown> = {
    data: call.domainArgs,
    ...call.envelope,
  }

  const validate = ajv.compile(schema.input)
  const valid = validate(subject)

  if (!valid) {
    const errors = validate.errors ?? []
    throw new ApiError(
      'invalid_argument',
      `Validation failed: ${formatErrors(errors)}`,
      errors,
    )
  }

  return next()
}

// ---------------------------------------------------------------------------
// ValidateSchemasToken — typed ctx extension key
// ---------------------------------------------------------------------------

import type { ComposedSchemas } from './types'

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
export const ValidateSchemasToken = Symbol('ValidateSchemasToken')

// Teach LayerContext about this symbol's type via module augmentation is not
// possible for symbols, so we use a cast at the read site.  The token is
// documented and exported so callers can set/get the correct type.
declare module './invoke' {
  interface LayerContext {
    get(token: typeof ValidateSchemasToken): ComposedSchemas | undefined
    set(token: typeof ValidateSchemasToken, value: ComposedSchemas): void
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
  return async function validationLayer(call: Call, next: Next): Promise<LayerResult> {
    const fnName = call.operation.id
    const schema = schemas[fnName]
    if (schema === undefined) {
      // Unknown operation — delegate; createInvoker throws "no schema found".
      return next()
    }

    // Synthesize the composed input subject for validation.
    const subject: Record<string, unknown> = {
      data: call.domainArgs,
      ...call.envelope,
    }

    const validate = ajv.compile(schema.input)
    const valid = validate(subject)

    if (!valid) {
      const errors = validate.errors ?? []
      throw new ApiError(
        'invalid_argument',
        `Validation failed: ${formatErrors(errors)}`,
        errors,
      )
    }

    return next()
  }
}
