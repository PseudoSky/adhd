// nominal.spec.ts — schema-builders/nominal.ts unit tests.
//
// Guard: npx nx test apigen-core
// Criterion: [lt-extract-nominal.1] guard green.
//
// Coverage:
//   [nom.1] `class User { id: string; joinedAt: Date }` produces a $def at
//           `defKey:"User"` and a `$ref:"#/$defs/User"`.
//   [nom.2] The $def carries `x-apigen-logical:"nominal"` and a qualified
//           `x-apigen-codec` ("cli.User" for namespace="cli").
//   [nom.3] `fromJSON` / `toJSON` presence on the class drives `x-apigen-ctor`
//           / `x-apigen-tojson` hints.
//   [nom.4] A class with no `fromJSON` / no `toJSON` omits the corresponding hints.
//   [nom.5] [inv:hints-advisory] stripping all `x-apigen-*` keys leaves a valid
//           structural object schema (type + properties + required).
//   [nom.NEGATIVE] Stripping hints makes the advisory keys truly absent —
//           a standard JSON-Schema validator can consume the stripped schema
//           without encountering any `x-apigen-*` keys.

import { describe, it, expect } from 'vitest'
import {
  buildNominalSchema,
  stripHints,
  type NominalClassInfo,
} from '../lib/schema-builders/nominal'
import {
  X_APIGEN_LOGICAL,
  X_APIGEN_CODEC,
  X_APIGEN_CTOR,
  X_APIGEN_TOJSON,
} from '@adhd/apigen-logical'

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

/** A minimal `User` class descriptor: id: string, joinedAt: Date-formatted string. */
function userInfo(overrides: Partial<NominalClassInfo> = {}): NominalClassInfo {
  return {
    className: 'User',
    namespace: 'cli',
    fields: [
      { name: 'id', schema: { type: 'string' } },
      { name: 'joinedAt', schema: { type: 'string', format: 'date-time' } },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// [nom.1] $def + $ref structure
// ---------------------------------------------------------------------------

describe('buildNominalSchema — $def + $ref structure', () => {
  it('[nom.1.1] defKey is the class name', () => {
    const { defKey } = buildNominalSchema(userInfo())
    expect(defKey).toBe('User')
  })

  it('[nom.1.2] ref is #/$defs/<ClassName>', () => {
    const { ref } = buildNominalSchema(userInfo())
    expect(ref).toEqual({ $ref: '#/$defs/User' })
  })

  it('[nom.1.3] def type is "object"', () => {
    const { def } = buildNominalSchema(userInfo())
    expect(def.type).toBe('object')
  })

  it('[nom.1.4] def.properties contains all fields', () => {
    const { def } = buildNominalSchema(userInfo())
    expect(def.properties).toHaveProperty('id')
    expect(def.properties).toHaveProperty('joinedAt')
  })

  it('[nom.1.5] non-optional fields appear in required', () => {
    const { def } = buildNominalSchema(userInfo())
    expect(def.required).toContain('id')
    expect(def.required).toContain('joinedAt')
  })

  it('[nom.1.6] optional field is absent from required', () => {
    const info = userInfo({
      fields: [
        { name: 'id', schema: { type: 'string' } },
        { name: 'bio', schema: { type: 'string' }, optional: true },
      ],
    })
    const { def } = buildNominalSchema(info)
    expect(def.required).toContain('id')
    expect(def.required).not.toContain('bio')
  })

  it('[nom.1.7] field schema is preserved verbatim', () => {
    const { def } = buildNominalSchema(userInfo())
    expect(def.properties['joinedAt']).toEqual({ type: 'string', format: 'date-time' })
  })
})

// ---------------------------------------------------------------------------
// [nom.2] x-apigen-logical + x-apigen-codec
// ---------------------------------------------------------------------------

describe('buildNominalSchema — x-apigen-logical + x-apigen-codec', () => {
  it('[nom.2.1] x-apigen-logical is "nominal"', () => {
    const { def } = buildNominalSchema(userInfo())
    expect(def[X_APIGEN_LOGICAL]).toBe('nominal')
  })

  it('[nom.2.2] x-apigen-codec is namespace-qualified', () => {
    const { def, codecId } = buildNominalSchema(userInfo())
    expect(def[X_APIGEN_CODEC]).toBe('cli.User')
    expect(codecId).toBe('cli.User')
  })

  it('[nom.2.3] empty namespace produces unqualified codec id', () => {
    const { def, codecId } = buildNominalSchema(userInfo({ namespace: '' }))
    expect(def[X_APIGEN_CODEC]).toBe('User')
    expect(codecId).toBe('User')
  })

  it('[nom.2.4] different namespace is reflected in codec id', () => {
    const { codecId } = buildNominalSchema(userInfo({ namespace: 'billing' }))
    expect(codecId).toBe('billing.User')
  })
})

// ---------------------------------------------------------------------------
// [nom.3] x-apigen-ctor / x-apigen-tojson hints when methods are present
// ---------------------------------------------------------------------------

describe('buildNominalSchema — ctor/toJSON hints (methods present)', () => {
  const withMethods = userInfo({ methodNames: ['fromJSON', 'toJSON', 'constructor'] })

  it('[nom.3.1] x-apigen-ctor is "fromJSON" when fromJSON is declared', () => {
    const { def } = buildNominalSchema(withMethods)
    expect(def[X_APIGEN_CTOR]).toBe('fromJSON')
  })

  it('[nom.3.2] x-apigen-tojson is "toJSON" when toJSON is declared', () => {
    const { def } = buildNominalSchema(withMethods)
    expect(def[X_APIGEN_TOJSON]).toBe('toJSON')
  })
})

// ---------------------------------------------------------------------------
// [nom.4] hints are absent when the class lacks the methods
// ---------------------------------------------------------------------------

describe('buildNominalSchema — hints absent when methods missing', () => {
  it('[nom.4.1] no fromJSON → x-apigen-ctor key is absent', () => {
    const { def } = buildNominalSchema(userInfo({ methodNames: [] }))
    expect(Object.prototype.hasOwnProperty.call(def, X_APIGEN_CTOR)).toBe(false)
  })

  it('[nom.4.2] no toJSON → x-apigen-tojson key is absent', () => {
    const { def } = buildNominalSchema(userInfo({ methodNames: [] }))
    expect(Object.prototype.hasOwnProperty.call(def, X_APIGEN_TOJSON)).toBe(false)
  })

  it('[nom.4.3] methodNames defaults to [] when omitted', () => {
    const info: NominalClassInfo = {
      className: 'Item',
      namespace: 'shop',
      fields: [{ name: 'sku', schema: { type: 'string' } }],
      // methodNames intentionally omitted
    }
    const { def } = buildNominalSchema(info)
    expect(Object.prototype.hasOwnProperty.call(def, X_APIGEN_CTOR)).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(def, X_APIGEN_TOJSON)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// [nom.5] [inv:hints-advisory] — stripHints leaves a valid structural schema
// ---------------------------------------------------------------------------

describe('stripHints — [inv:hints-advisory]', () => {
  const withHints = buildNominalSchema(
    userInfo({ methodNames: ['fromJSON', 'toJSON'] }),
  )

  it('[nom.5.1] stripped schema still has type:"object"', () => {
    const stripped = stripHints(withHints.def)
    expect(stripped.type).toBe('object')
  })

  it('[nom.5.2] stripped schema still has properties', () => {
    const stripped = stripHints(withHints.def)
    expect(stripped).toHaveProperty('properties')
    expect(Object.keys((stripped as { properties: Record<string, unknown> }).properties)).toContain('id')
  })

  it('[nom.5.3] stripped schema still has required', () => {
    const stripped = stripHints(withHints.def)
    expect(stripped).toHaveProperty('required')
  })

  // [nom.NEGATIVE] The structural schema MUST be valid without x-apigen-* keys.
  // Proves teeth: reintroduce a required x-apigen-* key and the check goes red.

  it('[nom.NEGATIVE] x-apigen-logical is absent after stripHints', () => {
    const stripped = stripHints(withHints.def) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(stripped, X_APIGEN_LOGICAL)).toBe(false)
  })

  it('[nom.NEGATIVE] x-apigen-codec is absent after stripHints', () => {
    const stripped = stripHints(withHints.def) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(stripped, X_APIGEN_CODEC)).toBe(false)
  })

  it('[nom.NEGATIVE] x-apigen-ctor is absent after stripHints (even when set)', () => {
    const stripped = stripHints(withHints.def) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(stripped, X_APIGEN_CTOR)).toBe(false)
  })

  it('[nom.NEGATIVE] x-apigen-tojson is absent after stripHints (even when set)', () => {
    const stripped = stripHints(withHints.def) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(stripped, X_APIGEN_TOJSON)).toBe(false)
  })

  it('[nom.5.4] stripHints does not mutate the original def', () => {
    const before = withHints.def[X_APIGEN_LOGICAL]
    stripHints(withHints.def)
    expect(withHints.def[X_APIGEN_LOGICAL]).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// [nom.6] codecId exposed on result
// ---------------------------------------------------------------------------

describe('buildNominalSchema — codecId field', () => {
  it('[nom.6.1] codecId matches x-apigen-codec on the def', () => {
    const result = buildNominalSchema(userInfo())
    expect(result.codecId).toBe(result.def[X_APIGEN_CODEC])
  })
})
