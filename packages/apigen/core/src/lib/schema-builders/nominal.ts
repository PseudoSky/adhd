// schema-builders/nominal.ts — class → $def + $ref + x-apigen-* emitter (DESIGN §4.1, §13).
//
// This module is a **pure schema builder**: it accepts already-extracted class
// information (from `extract-classes.ts`) and produces the canonical descriptor
// fragment for a nominal type:
//
//   - A named `$def` (object schema with field properties + required array)
//     tagged with `x-apigen-logical:"nominal"` and `x-apigen-codec:"<ns>.<Name>"`.
//   - A `$ref` pointing at that `$def` (`#/$defs/<ClassName>`).
//   - Optional `x-apigen-ctor`/`x-apigen-tojson` hints when the class declares
//     `fromJSON`/`toJSON` methods.
//
// Invariant [inv:hints-advisory]: the `x-apigen-*` keys are OPTIONAL advisory
// hints. Their absence MUST NOT break correctness — the structural schema
// (`$ref` + the `$def` object shape) is the authoritative contract. The
// `stripHints` export proves this: stripping all `x-apigen-*` keys from the
// result of `buildNominalSchema` leaves a valid, structurally-complete object
// schema.
//
// This module does NOT import ts-morph or touch source files — ts-morph parsing
// is `extract-classes.ts`'s job. `nominal.ts` only runs the schema-building step
// for a class whose fields and method names are already known.

import {
  X_APIGEN_LOGICAL,
  X_APIGEN_CODEC,
  X_APIGEN_CTOR,
  X_APIGEN_TOJSON,
} from '@adhd/apigen-logical'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Information about one field of a nominal class, already expressed as a JSON
 * Schema fragment (typically produced by `buildSchema` from ts-json-schema.ts).
 */
export interface NominalField {
  /** Original field name as declared in source. */
  name: string
  /** JSON Schema fragment for the field's type. */
  schema: Record<string, unknown>
  /** True when the field has a `?` modifier or default value. */
  optional?: boolean
}

/**
 * Extracted class descriptor handed to `buildNominalSchema`.
 *
 * All ts-morph work is done upstream (in `extract-classes.ts` or the
 * caller). This record is the minimal slice needed to emit the schema.
 */
export interface NominalClassInfo {
  /** Source-level class name, e.g. `"User"`. */
  className: string
  /**
   * Namespace qualifier prepended to `className` to form the stable
   * `LogicalTypeId` (e.g. `"cli"` → `"cli.User"`). Pass `""` for
   * top-level / unnamespaced classes.
   */
  namespace: string
  /** Ordered list of public serializable fields. */
  fields: NominalField[]
  /**
   * Names of static/instance methods declared on the class (used to derive
   * the optional `x-apigen-ctor` / `x-apigen-tojson` hints).
   */
  methodNames?: string[]
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** The JSON Schema for a single field inside a `$def`. */
export type FieldSchema = Record<string, unknown>

/**
 * The `$def` schema for the class — an object schema with `properties`,
 * `required`, and optional `x-apigen-*` hints.
 */
export interface NominalDef {
  type: 'object'
  properties: Record<string, FieldSchema>
  required: string[]
  [X_APIGEN_LOGICAL]: 'nominal'
  [X_APIGEN_CODEC]: string
  [X_APIGEN_CTOR]?: string
  [X_APIGEN_TOJSON]?: string
}

/**
 * The full result of `buildNominalSchema`:
 *   - `def`: the `$def` object to register under `$defs[className]`.
 *   - `ref`: the `$ref` fragment for inline use (`#/$defs/<ClassName>`).
 *   - `defKey`: the key to use under `$defs` (the class name).
 *   - `codecId`: the qualified `LogicalTypeId` (e.g. `"cli.User"`).
 */
export interface NominalSchema {
  /** Key under `$defs` (`className`). */
  defKey: string
  /** The `$def` schema fragment — register as `$defs[defKey]`. */
  def: NominalDef
  /** Inline `$ref` schema for positions that hold this nominal type. */
  ref: { $ref: string }
  /** Stable, namespace-qualified `LogicalTypeId`. */
  codecId: string
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

/**
 * Given an extracted nominal class descriptor, emit the canonical descriptor
 * schema fragment: a named `$def` (object schema with fields + `x-apigen-*`
 * hints) and a `$ref` pointing at it.
 *
 * Per invariant `[inv:hints-advisory]` the `x-apigen-*` keys are advisory —
 * see `stripHints` to obtain a pure structural schema.
 *
 * @param info - Class info produced by the extractor.
 * @returns `{ defKey, def, ref, codecId }` ready for insertion into a descriptor.
 */
export function buildNominalSchema(info: NominalClassInfo): NominalSchema {
  const { className, namespace, fields, methodNames = [] } = info

  // Stable, namespace-qualified id: "<namespace>.<ClassName>" or just
  // "<ClassName>" when no namespace is provided.
  const codecId = namespace ? `${namespace}.${className}` : className

  // Build properties + required from field list.
  const properties: Record<string, FieldSchema> = {}
  const required: string[] = []
  for (const field of fields) {
    properties[field.name] = field.schema
    if (!field.optional) {
      required.push(field.name)
    }
  }

  // Derive optional decode/encode hints from the class's declared method names.
  // [inv:hints-advisory]: these are advisory accelerators; a missing hint falls
  // back to structural schema projection.
  const ctorHint = detectHint(methodNames, 'fromJSON')
  const toJsonHint = detectHint(methodNames, 'toJSON')

  // Assemble the $def.  Build conditionally so absent hints are truly absent
  // (no `undefined`-valued keys) — JSON.stringify would omit them but some
  // consumers enumerate keys directly.
  const def: NominalDef = {
    type: 'object',
    properties,
    required,
    [X_APIGEN_LOGICAL]: 'nominal',
    [X_APIGEN_CODEC]: codecId,
    ...(ctorHint !== undefined ? { [X_APIGEN_CTOR]: ctorHint } : {}),
    ...(toJsonHint !== undefined ? { [X_APIGEN_TOJSON]: toJsonHint } : {}),
  }

  return {
    defKey: className,
    def,
    ref: { $ref: `#/$defs/${className}` },
    codecId,
  }
}

// ---------------------------------------------------------------------------
// [inv:hints-advisory] helper — strip all x-apigen-* keys from a $def.
// ---------------------------------------------------------------------------

const HINT_KEYS = [X_APIGEN_LOGICAL, X_APIGEN_CODEC, X_APIGEN_CTOR, X_APIGEN_TOJSON] as const

/**
 * Return a copy of `def` with all `x-apigen-*` advisory keys removed.
 *
 * The result is a plain JSON Schema object schema — valid and structurally
 * authoritative without any apigen extension keys.  Proves invariant
 * `[inv:hints-advisory]`: stripping hints MUST leave a structurally-complete
 * schema (type + properties + required) that a standard JSON-Schema validator
 * can consume.
 */
export function stripHints(def: NominalDef): Omit<NominalDef, typeof HINT_KEYS[number]> {
  const stripped = { ...def }
  for (const key of HINT_KEYS) {
    delete (stripped as Record<string, unknown>)[key]
  }
  return stripped as Omit<NominalDef, typeof HINT_KEYS[number]>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return `methodName` when it appears in `methodNames`, otherwise `undefined`.
 * Used to derive the `x-apigen-ctor` / `x-apigen-tojson` advisory hints.
 */
function detectHint(methodNames: string[], methodName: string): string | undefined {
  return methodNames.includes(methodName) ? methodName : undefined
}
