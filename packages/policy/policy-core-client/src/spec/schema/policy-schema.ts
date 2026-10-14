/**
 * JSON Schema (draft 2020-12) for a policy document (spec section 2).
 * `additionalProperties: false` at every object level: no silent ignore.
 */
export const POLICY_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://adhd.dev/schema/policy-1.json',
  title: 'ADHD policy document',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'permissions'],
  properties: {
    version: { const: 1 },
    attributes: {
      type: 'object',
      additionalProperties: { enum: ['name', 'names', 'paths', 'number'] },
    },
    runtime: {
      type: 'object',
      additionalProperties: { enum: ['number', 'name'] },
    },
    defaults: {
      type: 'array',
      items: { $ref: '#/$defs/defaultsRule' },
    },
    permissions: {
      type: 'array',
      items: { $ref: '#/$defs/permission' },
    },
  },
  $defs: {
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
      required: ['set'],
      properties: {
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
      required: ['tool'],
      properties: {
        tool: {
          anyOf: [
            { type: 'string', minLength: 1 },
            {
              type: 'array',
              minItems: 1,
              items: { type: 'string', minLength: 1 },
            },
          ],
        },
        effect: { enum: ['allow', 'ask', 'deny'] },
        context: { type: 'object' },
        args: { type: 'object' },
        set: { type: 'object' },
      },
    },
  },
} as const;
