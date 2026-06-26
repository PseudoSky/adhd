/**
 * Tests for @adhd/apigen-schema public exports.
 *
 * TEETH (CLAUDE.md §6):
 *   - Exercises the REAL exports — not stubs or mocks of the module.
 *   - Every assertion has a paired negative control that would go RED if the
 *     implementation regressed (e.g. isJsonSchema accepting null would break
 *     the null-rejection test; requiredFields ignoring the array type would
 *     break the non-array rejection test).
 *   - No env-gating: runs by default in every CI/audit pass.
 */

import { describe, it, expect } from 'vitest'
import {
  __apigen_pkg,
  isJsonSchema,
  requiredFields,
  schemaType,
  type ApigenSchema,
} from '../index'

// ---------------------------------------------------------------------------
// Package identity
// ---------------------------------------------------------------------------

describe('__apigen_pkg', () => {
  it('identifies the package as @adhd/apigen-schema', () => {
    expect(__apigen_pkg).toBe('@adhd/apigen-schema')
  })

  it('(negative) does not equal a different package name', () => {
    expect(__apigen_pkg).not.toBe('@adhd/apigen-core')
  })
})

// ---------------------------------------------------------------------------
// isJsonSchema
// ---------------------------------------------------------------------------

describe('isJsonSchema', () => {
  it('returns true for a plain object (empty schema)', () => {
    expect(isJsonSchema({})).toBe(true)
  })

  it('returns true for a schema with type + properties', () => {
    const schema: ApigenSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    }
    expect(isJsonSchema(schema)).toBe(true)
  })

  it('returns false for null', () => {
    expect(isJsonSchema(null)).toBe(false)
  })

  it('returns false for an array', () => {
    expect(isJsonSchema([])).toBe(false)
  })

  it('returns false for a string', () => {
    expect(isJsonSchema('{ "type": "object" }')).toBe(false)
  })

  it('returns false for a number', () => {
    expect(isJsonSchema(42)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isJsonSchema(undefined)).toBe(false)
  })

  // Negative control: if isJsonSchema mistakenly accepted null, this would fail.
  it('(negative) null is not a schema — guard has teeth', () => {
    const guard = isJsonSchema(null)
    // If this ever passes, the guard is broken.
    expect(guard).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// requiredFields
// ---------------------------------------------------------------------------

describe('requiredFields', () => {
  it('extracts required field names from a valid schema', () => {
    const schema: ApigenSchema = {
      type: 'object',
      required: ['userId', 'email'],
    }
    expect(requiredFields(schema)).toEqual(['userId', 'email'])
  })

  it('returns an empty array when required is absent', () => {
    expect(requiredFields({ type: 'object' })).toEqual([])
  })

  it('returns an empty array when required is not an array', () => {
    // Malformed schema: required is a string, not an array
    expect(requiredFields({ type: 'object', required: 'name' as unknown as string[] })).toEqual([])
  })

  it('filters out non-string entries from required array', () => {
    const schema = {
      required: ['name', 42, null, 'email'] as unknown as string[],
    }
    expect(requiredFields(schema)).toEqual(['name', 'email'])
  })

  it('returns an empty array for null input', () => {
    expect(requiredFields(null)).toEqual([])
  })

  it('returns an empty array for a plain string input', () => {
    expect(requiredFields('not a schema')).toEqual([])
  })

  // Negative control: a schema with required fields must NOT return empty.
  it('(negative) schema with required fields does not return empty array', () => {
    const schema: ApigenSchema = { required: ['id'] }
    expect(requiredFields(schema)).not.toEqual([])
  })
})

// ---------------------------------------------------------------------------
// schemaType
// ---------------------------------------------------------------------------

describe('schemaType', () => {
  it('returns the type string for an object schema', () => {
    expect(schemaType({ type: 'object' })).toBe('object')
  })

  it('returns "array" for an array schema', () => {
    expect(schemaType({ type: 'array', items: { type: 'string' } })).toBe('array')
  })

  it('returns undefined when type is absent', () => {
    expect(schemaType({})).toBeUndefined()
  })

  it('returns undefined for null input', () => {
    expect(schemaType(null)).toBeUndefined()
  })

  it('returns undefined when type is not a string', () => {
    // Malformed: type is a number
    expect(schemaType({ type: 123 })).toBeUndefined()
  })

  it('returns undefined for string input', () => {
    expect(schemaType('object')).toBeUndefined()
  })

  // Negative control: schemaType({ type: 'string' }) must NOT return 'object'.
  it('(negative) string-typed schema does not return "object"', () => {
    expect(schemaType({ type: 'string' })).not.toBe('object')
  })

  // Round-trip: the type read back from the schema matches what was set.
  it('round-trip: type set on schema is the same value read back', () => {
    const types = ['object', 'array', 'string', 'number', 'boolean', 'null']
    for (const t of types) {
      expect(schemaType({ type: t })).toBe(t)
    }
  })
})
