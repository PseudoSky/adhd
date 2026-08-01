import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { synthesizeExample, renderExampleNote } from './example';
import type { JsonSchemaLike } from './example';

function validates(schema: JsonSchemaLike, value: unknown): boolean {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  ajv.addFormat('decimal', /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/);
  const validate = ajv.compile(schema as Record<string, unknown>);
  return validate(value) as boolean;
}

describe('synthesizeExample', () => {
  it('[example.1] required string/number/boolean object props', () => {
    const schema: JsonSchemaLike = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        count: { type: 'integer' },
        active: { type: 'boolean' },
        note: { type: 'string' }, // optional — must NOT appear
      },
      required: ['title', 'count', 'active'],
    };
    const example = synthesizeExample(schema);
    expect(example).toEqual({ title: '<string>', count: 0, active: false });
    expect(validates(schema, example)).toBe(true);
  });

  it('[example.2] arrays synthesize a one-element array', () => {
    const schema: JsonSchemaLike = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
      required: ['tags'],
    };
    const example = synthesizeExample(schema) as { tags: unknown };
    expect(example.tags).toEqual(['<string>']);
    expect(validates(schema, example)).toBe(true);
  });

  it('[example.3] nested required objects recurse', () => {
    const schema: JsonSchemaLike = {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { family: { type: 'string' }, title: { type: 'string' } },
          required: ['family', 'title'],
        },
      },
      required: ['data'],
    };
    const example = synthesizeExample(schema);
    expect(example).toEqual({ data: { family: '<string>', title: '<string>' } });
    expect(validates(schema, example)).toBe(true);
  });

  it('[example.4] enum picks the first value', () => {
    const schema: JsonSchemaLike = {
      type: 'object',
      properties: { status: { type: 'string', enum: ['OPEN', 'DONE'] } },
      required: ['status'],
    };
    const example = synthesizeExample(schema);
    expect(example).toEqual({ status: 'OPEN' });
    expect(validates(schema, example)).toBe(true);
  });

  it('[example.5] optional-only object synthesizes to {}', () => {
    const schema: JsonSchemaLike = {
      type: 'object',
      properties: { anything: { type: 'string' } },
    };
    const example = synthesizeExample(schema);
    expect(example).toEqual({});
    expect(validates(schema, example)).toBe(true);
  });

  it('[example.6] oneOf picks the first branch', () => {
    const schema: JsonSchemaLike = {
      oneOf: [
        {
          type: 'object',
          properties: { operation: { type: 'string', enum: ['a'] }, items: { type: 'array', items: { type: 'string' } } },
          required: ['operation', 'items'],
        },
        {
          type: 'object',
          properties: { operation: { type: 'string', enum: ['b'] } },
          required: ['operation'],
        },
      ],
    };
    const example = synthesizeExample(schema);
    expect(example).toEqual({ operation: 'a', items: ['<string>'] });
    expect(validates(schema, example)).toBe(true);
  });

  it('[example.7] $ref resolves against root definitions', () => {
    const schema: JsonSchemaLike = {
      type: 'object',
      properties: { user: { $ref: '#/definitions/User' } },
      required: ['user'],
      definitions: {
        User: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    };
    const example = synthesizeExample(schema);
    expect(example).toEqual({
      user: { id: '00000000-0000-0000-0000-000000000000' },
    });
    expect(validates(schema, example)).toBe(true);
  });

  it('[example.8] $ref resolves against root $defs', () => {
    const schema: JsonSchemaLike = {
      type: 'object',
      properties: { when: { $ref: '#/$defs/Timestamp' } },
      required: ['when'],
      $defs: { Timestamp: { type: 'string', format: 'date-time' } },
    };
    const example = synthesizeExample(schema);
    expect(example).toEqual({ when: '1970-01-01T00:00:00.000Z' });
    expect(validates(schema, example)).toBe(true);
  });

  it('[example.9] format-aware string placeholders pass ajv-formats', () => {
    const formats = ['date-time', 'date', 'uuid', 'email', 'uri', 'byte'] as const;
    for (const format of formats) {
      const schema: JsonSchemaLike = {
        type: 'object',
        properties: { v: { type: 'string', format } },
        required: ['v'],
      };
      const example = synthesizeExample(schema);
      expect(validates(schema, example)).toBe(true);
    }
  });

  it('[example.10] decimal/int64 apigen logical formats pass their custom validators', () => {
    const decimalSchema: JsonSchemaLike = {
      type: 'object',
      properties: { amount: { type: 'string', format: 'decimal' } },
      required: ['amount'],
    };
    expect(validates(decimalSchema, synthesizeExample(decimalSchema))).toBe(true);

    const int64Schema: JsonSchemaLike = {
      type: 'object',
      properties: { id: { type: 'string', format: 'int64' } },
      required: ['id'],
    };
    const example = synthesizeExample(int64Schema) as { id: string };
    expect(/^-?\d+$/.test(example.id)).toBe(true);
  });

  it('[example.11] zero-parameter object synthesizes to {}', () => {
    const schema: JsonSchemaLike = { type: 'object', properties: {}, required: [] };
    expect(synthesizeExample(schema)).toEqual({});
  });

  it('[example.12] allOf merges branch properties/required', () => {
    const schema: JsonSchemaLike = {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'integer' } }, required: ['b'] },
      ],
    };
    const example = synthesizeExample(schema);
    expect(example).toEqual({ a: '<string>', b: 0 });
  });

  it('[example.13] undefined schema synthesizes to null', () => {
    expect(synthesizeExample(undefined)).toBeNull();
  });
});

describe('renderExampleNote', () => {
  it('[example.14] renders a compact Example: {...} note', () => {
    const schema: JsonSchemaLike = {
      type: 'object',
      properties: { data: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
      required: ['data'],
    };
    expect(renderExampleNote(schema)).toBe('Example: {"data":{"title":"<string>"}}');
  });

  it('[example.15] returns undefined for an absent schema', () => {
    expect(renderExampleNote(undefined)).toBeUndefined();
  });
});
