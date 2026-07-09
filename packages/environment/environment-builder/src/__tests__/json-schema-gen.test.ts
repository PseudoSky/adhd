import { describe, expect, it } from 'vitest';
import { generateFieldSchema, generateScopedFieldSchema } from '../json-schema-gen';
import { mergeFieldDefinitions } from '../field-merge';

describe('generateFieldSchema', () => {
  it('converts a single flat field into a nested schema', () => {
    expect(generateFieldSchema({ 'server.port': { type: 'integer', minimum: 1024 } })).toEqual({
      type: 'object',
      properties: {
        server: {
          type: 'object',
          properties: { port: { type: 'integer', minimum: 1024 } },
        },
      },
    });
  });

  it('nests multiple fields under shared parent paths', () => {
    const schema = generateFieldSchema({
      'providers.openai.model': { type: 'string', default: 'gpt-4o' },
      'providers.openai.secret': { type: 'string' },
      'providers.anthropic.model': { type: 'string' },
    });
    expect(schema).toEqual({
      type: 'object',
      properties: {
        providers: {
          type: 'object',
          properties: {
            openai: {
              type: 'object',
              properties: {
                model: { type: 'string', default: 'gpt-4o' },
                secret: { type: 'string' },
              },
            },
            anthropic: {
              type: 'object',
              properties: { model: { type: 'string' } },
            },
          },
        },
      },
    });
  });

  it('passes through all JSON-Schema validation keywords (inheritance-adjacent: min/max survive)', () => {
    const schema = generateFieldSchema({
      'log.level': {
        type: 'string',
        enum: ['debug', 'info', 'warn', 'error'],
        pattern: '^[a-z]+$',
        minLength: 3,
        maxLength: 10,
        description: 'Log verbosity',
      },
      'server.port': { type: 'integer', minimum: 1024, maximum: 65535 },
    });
    const props = (schema.properties as Record<string, unknown>).log as { properties: Record<string, unknown> };
    expect(props.properties.level).toEqual({
      type: 'string',
      enum: ['debug', 'info', 'warn', 'error'],
      pattern: '^[a-z]+$',
      minLength: 3,
      maxLength: 10,
      description: 'Log verbosity',
    });
    const serverProps = (schema.properties as Record<string, unknown>).server as { properties: Record<string, unknown> };
    expect(serverProps.properties.port).toEqual({ type: 'integer', minimum: 1024, maximum: 65535 });
  });

  it('passes through the "items" keyword for array-typed fields', () => {
    const schema = generateFieldSchema({ 'server.allowedAgents': { type: 'array', items: { type: 'string' } } });
    const serverProps = (schema.properties as Record<string, unknown>).server as { properties: Record<string, unknown> };
    expect(serverProps.properties.allowedAgents).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('returns an empty object schema for an empty field map', () => {
    expect(generateFieldSchema({})).toEqual({ type: 'object', properties: {} });
  });

  it('accepts the merged ConfigFieldDefinition shape from field-merge (post-merge, not just as-authored YAML)', () => {
    const merged = mergeFieldDefinitions(
      {},
      {},
      { 'db.path': { type: 'string', default: '/tmp/db' }, 'server.port': { type: 'integer', minimum: 1024 } },
    );
    const schema = generateFieldSchema(merged);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        db: { type: 'object', properties: { path: { type: 'string', default: '/tmp/db' } } },
        server: { type: 'object', properties: { port: { type: 'integer', minimum: 1024 } } },
      },
    });
  });
});

describe('generateScopedFieldSchema', () => {
  it('restricts the generated schema to fields of the given effective scope', () => {
    const merged = mergeFieldDefinitions(
      { 'log.level': { type: 'string', default: 'info' } },
      { 'transport.kind': { type: 'string', default: 'stdio' } },
      { 'db.path': { type: 'string', default: '/tmp/db' } },
    );
    const schema = generateScopedFieldSchema(merged, 'project');
    expect(schema).toEqual({
      type: 'object',
      properties: { db: { type: 'object', properties: { path: { type: 'string', default: '/tmp/db' } } } },
    });
  });

  it('returns an empty schema when no fields match the requested scope', () => {
    const merged = mergeFieldDefinitions({ 'log.level': { type: 'string', default: 'info' } }, {}, {});
    expect(generateScopedFieldSchema(merged, 'project')).toEqual({ type: 'object', properties: {} });
  });
});
