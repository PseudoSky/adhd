import path from 'node:path';
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { extract } from '@adhd/apigen-core-client';
import {
  X_APIGEN_LOGICAL,
  X_APIGEN_CODEC,
  X_APIGEN_CTOR,
  X_APIGEN_TOJSON,
} from '@adhd/apigen-base-logical';
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

// ---------- BUG-APIGEN-059: real catch-all union output end-to-end ----------
//
// Proves the core-client fix (morph-walk.ts's `sanitizeCatchAllVariants`) is
// SUFFICIENT on its own — this module (the MCP transport-layer adapter)
// needs NO change to correctly surface a `Dog | Cat | Record<string,
// unknown>` union return type. Drives the REAL extractor against the SAME
// `union-catchall.ts` fixture apigen-core-client's own regression suite
// uses (cross-package fixture reuse — no second hand-written copy), takes
// the real extracted `output` fragment, runs it through the real
// `buildMcpOutputSchema`, then AJV-compiles the resulting `outputSchema`
// and validates a real `wrapMcpStructuredContent`-wrapped Dog value.

const UNION_CATCHALL_FIXTURE = path.join(
  __dirname,
  '../../../apigen-core-client/src/test/fixtures/union-catchall.ts'
);

function makeAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  ajv.addFormat('decimal', /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/);
  // Mirrors validate-layer.ts's advisory-keyword registration (see that
  // file's own comment) — morph-walk.ts stamps every union fragment with
  // `[X_APIGEN_LOGICAL]: 'union'`, which Ajv 8 strict mode otherwise rejects
  // as an unknown keyword at compile time.
  for (const keyword of [
    X_APIGEN_LOGICAL,
    X_APIGEN_CODEC,
    X_APIGEN_CTOR,
    X_APIGEN_TOJSON,
    'discriminator',
  ]) {
    ajv.addKeyword({ keyword, valid: true });
  }
  return ajv;
}

describe('[BUG-APIGEN-059] real catch-all union output end-to-end', () => {
  it('a real extracted Dog|Cat|Record<string,unknown> output schema, adapted for MCP, validates a real Dog structuredContent', async () => {
    const operations = await extract({
      sourceFile: UNION_CATCHALL_FIXTURE,
      namespace: 'union-catchall',
    });
    const op = operations.find((o) => o.path.at(-1)?.raw === 'classifyPet');
    if (!op) {
      throw new Error(
        'operation "classifyPet" must exist in the real extracted union-catchall fixture'
      );
    }

    // The real extracted output fragment is the sanitized oneOf union
    // itself (not type:"object") — buildMcpOutputSchema must wrap it under
    // "result" for MCP's Tool.outputSchema contract.
    const { outputSchema, wrapped } = buildMcpOutputSchema(op.output);
    expect(outputSchema).toBeDefined();
    expect(wrapped).toBe(true);
    expect((outputSchema as Record<string, unknown>)['type']).toBe('object');

    const ajv = makeAjv();
    const validate = ajv.compile(outputSchema as Record<string, unknown>);

    const dog = { kind: 'dog', bark: 'woof' };
    const structuredContent = wrapMcpStructuredContent(wrapped, dog);
    expect(structuredContent).toEqual({ result: dog });

    expect(
      validate(structuredContent),
      `real MCP-adapted output schema must accept a Dog-shaped structuredContent unambiguously; ` +
        `ajv errors: ${JSON.stringify(validate.errors)}`
    ).toBe(true);
  });
});
