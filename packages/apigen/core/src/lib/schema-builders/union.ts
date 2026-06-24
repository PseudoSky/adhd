// schema-builders/union.ts — discriminated union → oneOf + discriminator + x-apigen-logical:"union"
//
// Implements DESIGN §4.1 (apigen-logical-types) for tagged / discriminated unions:
//
//   Given a set of variant class names (already registered as nominal $defs via
//   `nominal.ts`) and the name of the common const-tag property, emit:
//
//     {
//       "oneOf": [ {"$ref":"#/$defs/Dog"}, {"$ref":"#/$defs/Cat"} ],
//       "discriminator": {
//         "propertyName": "kind",
//         "mapping": { "dog": "#/$defs/Dog", "cat": "#/$defs/Cat" }
//       },
//       "x-apigen-logical": "union"
//     }
//
// This module is **pure schema building**: it does NOT run ts-morph, does NOT
// touch source files, and does NOT duplicate the $def production — it only
// assembles the oneOf + discriminator referencing the $defs that `nominal.ts`
// already registers.
//
// Import chain (schema-builders layer only):
//   union.ts → nominal.ts ($def key helper) → @adhd/apigen-logical (constants)

import { X_APIGEN_LOGICAL } from '@adhd/apigen-logical'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One variant of a discriminated union.
 *
 *   - `className`       the PascalCase class name matching its `$defs` key
 *                       (produced by `buildNominalSchema`'s `defKey` output).
 *   - `discriminantValue` the literal string value of the discriminant property
 *                       on this variant (e.g. `"dog"` for `kind:"dog"`).
 */
export interface UnionVariant {
  /** The class name — must match the `$defs` key produced by `nominal.ts`. */
  className: string
  /**
   * The literal discriminant value for this variant (the `const` value on the
   * discriminant property in the variant's $def, e.g. `"dog"` for `kind:"dog"`).
   */
  discriminantValue: string
}

/**
 * Everything `buildUnionSchema` needs to emit the union fragment.
 */
export interface UnionInfo {
  /**
   * Name of the shared const-tag property that discriminates the variants,
   * e.g. `"kind"`.
   */
  discriminatorPropertyName: string
  /** Ordered list of union variants; must contain at least two entries. */
  variants: UnionVariant[]
}

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

/**
 * The JSON Schema fragment for a discriminated union per DESIGN §4.1:
 *
 * ```json
 * {
 *   "oneOf": [ {"$ref":"#/$defs/Dog"}, {"$ref":"#/$defs/Cat"} ],
 *   "discriminator": {
 *     "propertyName": "kind",
 *     "mapping": { "dog": "#/$defs/Dog", "cat": "#/$defs/Cat" }
 *   },
 *   "x-apigen-logical": "union"
 * }
 * ```
 */
export interface UnionSchema {
  oneOf: Array<{ $ref: string }>
  discriminator: {
    propertyName: string
    mapping: Record<string, string>
  }
  [X_APIGEN_LOGICAL]: 'union'
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

/**
 * Given a discriminated-union descriptor, emit the canonical OpenAPI-compatible
 * `oneOf` + `discriminator` + `x-apigen-logical:"union"` schema fragment.
 *
 * Each variant is referenced via `$ref` (`#/$defs/<ClassName>`) — the caller is
 * responsible for ensuring each variant's `$def` is registered in the descriptor
 * (via `buildNominalSchema` from `nominal.ts`).
 *
 * Per DESIGN §4.1 `[inv:hints-advisory]`: `x-apigen-logical:"union"` is advisory.
 * The structural contract (the `oneOf` + `discriminator`) is the authoritative
 * wire representation and MUST be usable without the `x-apigen-*` key.
 *
 * @throws {Error} When `variants` is empty or contains a single entry (a
 *   one-variant "union" is not a union).
 *
 * @param info - Discriminated union descriptor.
 * @returns The `oneOf` + `discriminator` schema fragment for inline use.
 */
export function buildUnionSchema(info: UnionInfo): UnionSchema {
  const { discriminatorPropertyName, variants } = info

  if (variants.length < 2) {
    throw new Error(
      `buildUnionSchema: a union requires at least 2 variants; got ${variants.length}`,
    )
  }

  // Each variant $ref points at the $def produced by buildNominalSchema.
  const oneOf: Array<{ $ref: string }> = variants.map(v => ({
    $ref: buildDefRef(v.className),
  }))

  // The discriminator mapping: discriminantValue → full $ref string.
  const mapping: Record<string, string> = {}
  for (const v of variants) {
    mapping[v.discriminantValue] = buildDefRef(v.className)
  }

  return {
    oneOf,
    discriminator: {
      propertyName: discriminatorPropertyName,
      mapping,
    },
    [X_APIGEN_LOGICAL]: 'union',
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Produce the JSON Schema `$ref` string for a named `$defs` entry, e.g.
 * `"Dog"` → `"#/$defs/Dog"`.
 *
 * Mirrors the ref shape emitted by `buildNominalSchema` in `nominal.ts`.
 */
function buildDefRef(className: string): string {
  return `#/$defs/${className}`
}
