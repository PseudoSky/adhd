import { describe, it, expect } from 'vitest';
import {
  buildMcpOutputSchema,
  wrapMcpStructuredContent,
} from '../lib/mcp-output-schema';

// ---------- BUG-APIGEN-019 (MCP transport half): buildMcpOutputSchema ----------

describe('[BUG-APIGEN-019] buildMcpOutputSchema', () => {
  it('passes an already type:"object" schema through unchanged', () => {
    const output = {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    };
    const { outputSchema, wrapped } = buildMcpOutputSchema(output);
    expect(outputSchema).toEqual(output);
    expect(wrapped).toBe(false);
  });

  it('wraps a oneOf+discriminator union return type under "result"', () => {
    const output = {
      oneOf: [{ $ref: '#/$defs/SearchResponse' }, { type: 'object' }],
      discriminator: { propertyName: 'outcome' },
      'x-apigen-logical': 'union',
    };
    const { outputSchema, wrapped } = buildMcpOutputSchema(output);
    expect(wrapped).toBe(true);
    expect(outputSchema).toEqual({
      type: 'object',
      properties: { result: output },
      required: ['result'],
    });
    // MCP protocol requires the top-level type literal to be "object".
    expect((outputSchema as Record<string, unknown>)['type']).toBe('object');
  });

  it('wraps a bare array return type under "result"', () => {
    const output = { type: 'array', items: { type: 'string' } };
    const { outputSchema, wrapped } = buildMcpOutputSchema(output);
    expect(wrapped).toBe(true);
    expect(outputSchema).toEqual({
      type: 'object',
      properties: { result: output },
      required: ['result'],
    });
  });

  it('wraps a bare scalar return type under "result"', () => {
    const output = { type: 'string' };
    const { outputSchema, wrapped } = buildMcpOutputSchema(output);
    expect(wrapped).toBe(true);
    expect(outputSchema).toEqual({
      type: 'object',
      properties: { result: output },
      required: ['result'],
    });
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

// ---------- BUG-APIGEN-019 (MCP transport half): wrapMcpStructuredContent ----------

describe('[BUG-APIGEN-019] wrapMcpStructuredContent', () => {
  it('passes an object value through unchanged when not wrapped', () => {
    const value = { id: 'u1', name: 'Alice' };
    expect(wrapMcpStructuredContent(false, value)).toEqual(value);
  });

  it('wraps a non-object value under "result" when wrapped', () => {
    expect(wrapMcpStructuredContent(true, ['alice', 'bob'])).toEqual({
      result: ['alice', 'bob'],
    });
    expect(wrapMcpStructuredContent(true, 'hello')).toEqual({
      result: 'hello',
    });
  });

  it('returns undefined when not wrapped but the actual value is not a plain object', () => {
    // Defensive case: outputSchema said type:"object" but the real value isn't
    // one (e.g. an upstream bug) — must not throw or emit an invalid structuredContent.
    expect(wrapMcpStructuredContent(false, ['not', 'an', 'object'])).toBeUndefined();
    expect(wrapMcpStructuredContent(false, 'not-an-object')).toBeUndefined();
    expect(wrapMcpStructuredContent(false, null)).toBeUndefined();
  });
});
