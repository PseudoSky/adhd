/**
 * `json-schema-gen.ts` — Pipeline step 12 (generate `fieldSchema`).
 *
 * `generateFieldSchema(fields)` converts a flat map of dot-path field
 * definitions into a nested JSON Schema object suitable for `ajv` validation
 * of the resolved, nested `config` object (`validation.ts` consumes this
 * output directly).
 *
 * Self-contained (no runtime import of `@adhd/environment-base-spec` — see
 * the cross-package-import note in `config-resolver.ts`) so it produces
 * identical output whether called from the merged `ConfigFieldDefinition` map
 * (builder pipeline step 12) or directly from a `YamlFieldDefinition` map
 * (e.g. ad-hoc/testing use, matching `environment-base-spec`'s own
 * `generateFieldSchema` for the un-merged case). Pure — no I/O, no shared
 * mutable state.
 */

import type { ConfigFieldDefinition, YamlFieldDefinition } from '@adhd/environment-base-spec';

/** The subset of `YamlFieldDefinition`/`ConfigFieldDefinition` that is relevant to schema generation. */
interface SchemaCompatibleField {
  type: string;
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  items?: { type: string };
}

interface JsonSchemaObjectNode {
  type: 'object';
  properties: Record<string, unknown>;
  /** Index signature so a `JsonSchemaObjectNode` is itself a valid `Record<string, unknown>` (the function's declared return type). */
  [key: string]: unknown;
}

/**
 * Converts a flat map of dot-path field definitions into a nested JSON
 * Schema object.
 *
 * @example
 * generateFieldSchema({ "server.port": { type: "integer", minimum: 1024 } })
 * // → {
 * //     type: "object",
 * //     properties: {
 * //       server: {
 * //         type: "object",
 * //         properties: { port: { type: "integer", minimum: 1024 } }
 * //       }
 * //     }
 * //   }
 */
export function generateFieldSchema(
  fields: Record<string, ConfigFieldDefinition> | Record<string, YamlFieldDefinition>,
): Record<string, unknown> {
  const root: JsonSchemaObjectNode = { type: 'object', properties: {} };
  const typedFields = fields as Record<string, SchemaCompatibleField>;

  for (const fieldPath of Object.keys(typedFields)) {
    const definition = typedFields[fieldPath];
    const segments = fieldPath.split('.');
    let node: JsonSchemaObjectNode = root;

    segments.forEach((segment, index) => {
      const isLeaf = index === segments.length - 1;
      if (isLeaf) {
        node.properties[segment] = fieldDefinitionToJsonSchema(definition);
        return;
      }
      const existing = node.properties[segment] as JsonSchemaObjectNode | undefined;
      if (existing === undefined) {
        const child: JsonSchemaObjectNode = { type: 'object', properties: {} };
        node.properties[segment] = child;
        node = child;
      } else {
        node = existing;
      }
    });
  }

  return root;
}

/**
 * Scope-aware wrapper: generates a `fieldSchema` restricted to fields whose
 * effective `scope` matches `scope` (used by `adhd-env build --scope
 * project`, which still writes a full snapshot but validates/schemas only
 * the requested scope's fields).
 */
export function generateScopedFieldSchema(
  fields: Record<string, ConfigFieldDefinition>,
  scope: ConfigFieldDefinition['scope'],
): Record<string, unknown> {
  const filtered: Record<string, ConfigFieldDefinition> = {};
  for (const key of Object.keys(fields)) {
    if (fields[key].scope === scope) filtered[key] = fields[key];
  }
  return generateFieldSchema(filtered);
}

/** Converts a single field definition into a JSON-Schema leaf property. */
function fieldDefinitionToJsonSchema(def: SchemaCompatibleField): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: def.type };
  if (def.default !== undefined) schema.default = def.default;
  if (def.description !== undefined) schema.description = def.description;
  if (def.minimum !== undefined) schema.minimum = def.minimum;
  if (def.maximum !== undefined) schema.maximum = def.maximum;
  if (def.enum !== undefined) schema.enum = def.enum;
  if (def.pattern !== undefined) schema.pattern = def.pattern;
  if (def.minLength !== undefined) schema.minLength = def.minLength;
  if (def.maxLength !== undefined) schema.maxLength = def.maxLength;
  if (def.items !== undefined) schema.items = def.items;
  return schema;
}
