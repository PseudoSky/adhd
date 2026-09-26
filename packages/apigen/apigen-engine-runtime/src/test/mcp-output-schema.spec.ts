import { describe, it, expect } from 'vitest';
import {
  buildMcpOutputSchema,
  wrapMcpStructuredContent,
} from '../lib/mcp-output-schema';

// ---------- ADR-0004: buildMcpOutputSchema — no `{result}` envelope ----------
//
// `outputSchema` (and therefore `structuredContent`) is emitted ONLY for a
// return that is already a top-level `type:'object'`. Every non-object return
// (union/array/scalar/void) is passed through flat — no schema, no envelope.
// These assertions replace the ones that enshrined the old `{result}` wrapper
// (BUG-APIGEN-019's transport half, reversed by ADR-0004).

describe('[ADR-0004] buildMcpOutputSchema', () => {
  it('passes an already type:"object" schema through and marks it emit-eligible', () => {
    const output = {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    };
    const { outputSchema, wrapped } = buildMcpOutputSchema(output);
    expect(outputSchema).toEqual(output);
    // `wrapped` == "emit structuredContent" post-ADR-0004; true for objects.
    expect(wrapped).toBe(true);
  });

  it('omits outputSchema for a oneOf+discriminator union return (no envelope)', () => {
    const output = {
      oneOf: [{ $ref: '#/$defs/SearchResponse' }, { type: 'object' }],
      discriminator: { propertyName: 'outcome' },
      'x-apigen-logical': 'union',
    };
    const { outputSchema, wrapped } = buildMcpOutputSchema(output);
    expect(outputSchema).toBeUndefined();
    expect(wrapped).toBe(false);
  });

  it('omits outputSchema for a bare array return (no envelope)', () => {
    const output = { type: 'array', items: { type: 'string' } };
    const { outputSchema, wrapped } = buildMcpOutputSchema(output);
    expect(outputSchema).toBeUndefined();
    expect(wrapped).toBe(false);
  });

  it('omits outputSchema for a bare scalar return (no envelope)', () => {
    const output = { type: 'string' };
    const { outputSchema, wrapped } = buildMcpOutputSchema(output);
    expect(outputSchema).toBeUndefined();
    expect(wrapped).toBe(false);
  });

  it('returns undefined for an empty/void output schema', () => {
    expect(buildMcpOutputSchema({})).toEqual({
      outputSchema: undefined,
      wrapped: false,
    });
  });

  it('returns undefined for an undefined output', () => {
    expect(buildMcpOutputSchema(undefined)).toEqual({
      outputSchema: undefined,
      wrapped: false,
    });
  });
});

// ---------- ADR-0004: wrapMcpStructuredContent — flat object or nothing ----------

describe('[ADR-0004] wrapMcpStructuredContent', () => {
  it('emits an object value unchanged when emit is true (never wrapped under result)', () => {
    const value = { id: 'u1', name: 'Alice' };
    expect(wrapMcpStructuredContent(true, value)).toEqual(value);
    // The `{result}` envelope must never be produced.
    expect(wrapMcpStructuredContent(true, value)).not.toHaveProperty('result');
  });

  it('returns undefined for a non-object value even when emit is true', () => {
    // `structuredContent` is constrained to a plain object by the SDK, so an
    // array/scalar must never be emitted there — and never as `{result: …}`.
    expect(wrapMcpStructuredContent(true, ['alice', 'bob'])).toBeUndefined();
    expect(wrapMcpStructuredContent(true, 'hello')).toBeUndefined();
    expect(wrapMcpStructuredContent(true, null)).toBeUndefined();
  });

  it('returns undefined when emit is false (non-object return → no structuredContent)', () => {
    expect(wrapMcpStructuredContent(false, { id: 'u1' })).toBeUndefined();
    expect(wrapMcpStructuredContent(false, ['not', 'an', 'object'])).toBeUndefined();
    expect(wrapMcpStructuredContent(false, 'not-an-object')).toBeUndefined();
    expect(wrapMcpStructuredContent(false, null)).toBeUndefined();
  });
});
