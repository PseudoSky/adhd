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

// ---------- BUG-APIGEN-059: real catch-all union output end-to-end ----------
//
// Proves the core-client fix (morph-walk.ts's `sanitizeCatchAllVariants`) is
// SUFFICIENT on its own — this module (the MCP transport-layer adapter)
// needs NO change to correctly surface a `Dog | Cat | Record<string,
// unknown>` union return type. Drives the REAL extractor against the SAME
// `union-catchall.ts` fixture apigen-core-client's own regression suite
// uses (cross-package fixture reuse — no second hand-written copy), takes
// the real extracted `output` fragment, runs it through the real
// `buildMcpOutputSchema`, and AJV-validates a real Dog value directly
// against the composed `output` schema.
//
// ADR-0004: the extracted output IS a non-object union, so the MCP adapter
// advertises NO `outputSchema` and emits NO `structuredContent` — the Dog
// value travels flat on `content`. This replaces the pre-ADR-0004 assertion
// that AJV-validated a `{ result: dog }` envelope against a manufactured
// `{type:'object', properties:{result:…}}` schema (the exact contract
// ADR-0004 deletes; ADR-0004 D5 names this file as a required flip site).

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
  it('a real extracted Dog|Cat|Record<string,unknown> union output advertises no MCP outputSchema and validates a real Dog value directly', async () => {
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

    // Guard the positive assertion below against passing VACUOUSLY: the real
    // extracted output must actually be the non-object union (a `oneOf`), or
    // `buildMcpOutputSchema` would not be exercising ADR-0004's non-object
    // branch at all.
    expect(
      Array.isArray((op.output as Record<string, unknown>)['oneOf']),
      `expected the extracted output to be a oneOf union; got: ${JSON.stringify(op.output)}`
    ).toBe(true);

    // ADR-0004: a non-object (union) return emits NO outputSchema and NO
    // structuredContent — it is passed through FLAT on `content`.
    const { outputSchema, wrapped } = buildMcpOutputSchema(op.output);
    expect(outputSchema).toBeUndefined();
    expect(wrapped).toBe(false);

    const dog = { kind: 'dog', bark: 'woof' };
    // No `{result}` envelope, ever — a union return has no structuredContent.
    expect(wrapMcpStructuredContent(wrapped, dog)).toBeUndefined();

    // The Dog value is validated DIRECTLY against the real composed output
    // schema (the same schema `content` now carries), never an envelope.
    const ajv = makeAjv();
    const validate = ajv.compile(op.output as Record<string, unknown>);
    expect(
      validate(dog),
      `real composed output schema must accept a Dog-shaped value unambiguously; ` +
        `ajv errors: ${JSON.stringify(validate.errors)}`
    ).toBe(true);
  });
});
