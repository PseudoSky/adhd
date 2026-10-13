/**
 * JSON Schema (draft 2020-12) for a compiled policy (spec section 3).
 * Mirrors `ICompiledPolicy`; `schemaVersion` is pinned to 1.
 */
export const COMPILED_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://adhd.dev/schema/compiled-1.json',
  title: 'ADHD compiled policy',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'compilerVersion',
    'inputHash',
    'contentHash',
    'attributes',
    'runtime',
    'defaults',
    'permissions',
    'index',
    'narrowingCovered',
  ],
  properties: {
    schemaVersion: { const: 1 },
    compilerVersion: { type: 'string', minLength: 1 },
    inputHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    contentHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    attributes: {
      type: 'object',
      additionalProperties: { enum: ['name', 'names', 'paths', 'number'] },
    },
    runtime: {
      type: 'object',
      additionalProperties: { enum: ['number', 'name'] },
    },
    defaults: { type: 'array', items: { $ref: '#/$defs/defaultsRule' } },
    permissions: { type: 'array', items: { $ref: '#/$defs/permission' } },
    index: {
      type: 'object',
      additionalProperties: false,
      required: ['exact', 'patterns'],
      properties: {
        exact: {
          type: 'object',
          additionalProperties: { $ref: '#/$defs/indexList' },
        },
        patterns: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['prefix', 'rules'],
            properties: {
              prefix: { type: 'string' },
              rules: { $ref: '#/$defs/indexList' },
            },
          },
        },
      },
    },
    narrowingCovered: {
      type: 'object',
      additionalProperties: { type: 'array', items: { type: 'string' } },
    },
  },
  $defs: {
    layer: { enum: ['global', 'project', 'local'] },
    indexList: { type: 'array', items: { type: 'integer', minimum: 0 } },
    attributeValue: {
      anyOf: [
        { type: 'string' },
        { type: 'number' },
        { type: 'array', items: { type: 'string' } },
      ],
    },
    defaultsRule: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'layer', 'source', 'set'],
      properties: {
        id: { type: 'string', minLength: 1 },
        layer: { $ref: '#/$defs/layer' },
        source: { type: 'string' },
        where: { type: 'object' },
        set: {
          type: 'object',
          additionalProperties: { $ref: '#/$defs/attributeValue' },
        },
      },
    },
    permission: {
      type: 'object',
      additionalProperties: false,
      required: [
        'id',
        'layer',
        'tools',
        'effect',
        'placeholders',
        'usesWithin',
        'readsRuntime',
      ],
      properties: {
        id: { type: 'string', minLength: 1 },
        layer: { $ref: '#/$defs/layer' },
        tools: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', minLength: 1 },
        },
        effect: { enum: ['allow', 'ask', 'deny'] },
        context: { type: 'object' },
        args: { type: 'object' },
        placeholders: { type: 'array', items: { type: 'string' } },
        set: { type: 'object' },
        usesWithin: { type: 'boolean' },
        readsRuntime: { type: 'boolean' },
      },
    },
  },
} as const;
