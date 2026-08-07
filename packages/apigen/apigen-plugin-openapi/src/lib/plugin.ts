// @adhd/apigen-plugin-openapi — mount plugin that serves the OpenAPI 3.1 doc.
//
// This plugin implements the `mount` capability (SPEC §7.1 / §7.2b): it
// contributes a single synthetic operation (`_meta/openapi`) that returns the
// OpenAPI 3.1 document derived from the descriptor at request time.
//
// The heavy lifting (descriptor → OpenAPI doc) lives in the COMMON
// @adhd/apigen-codegen-openapi package (`toOpenApi`).  This thin shell:
//   1. Exports the v2 Plugin satisfying the `mount` capability shape.
//   2. Passes the full descriptor through `toOpenApi` in the handler.
//   3. Restricts the operation to HTTP only (`transports: ['http']`) — the doc
//      is a human/tooling artefact, not a machine-callable domain function.
//
// Usage (SPEC §7):
//   adhd-apigen run --source api.ts --type http-fastify --use openapi

import type {
  Plugin,
  Descriptor,
  MountedOperation,
  Call,
} from '@adhd/apigen-core-client';
import { syntheticOp } from '@adhd/apigen-core-client';
import { toOpenApi } from '@adhd/apigen-codegen-openapi';

// ---------------------------------------------------------------------------
// Plugin-specific options
// ---------------------------------------------------------------------------

/** Options accepted by the openapi mount plugin. */
export interface OpenapiOptions {
  /**
   * The API title placed in the generated OpenAPI doc's `info.title`.
   * @default 'API'
   */
  title?: string;

  /**
   * The API version placed in the generated OpenAPI doc's `info.version`.
   * @default '0.0.0'
   */
  version?: string;
}

// ---------------------------------------------------------------------------
// Mount capability implementation
// ---------------------------------------------------------------------------

/**
 * Returns the single `_meta/openapi` mounted operation for a given descriptor.
 *
 * Called once at compose time; the handler is invoked at request time so the
 * doc always reflects the live descriptor (SPEC §7.2b pattern).
 *
 * (DEBT-APIGEN-008 retrofit) Built via `@adhd/apigen-core-client`'s shared
 * `syntheticOp` helper rather than a locally hand-built `Operation` literal +
 * local `seg()` — mirrors the `apigen-plugin-health` retrofit (F2,
 * BUG-APIGEN-SYNTHETICOP). Behavior/output shape is unchanged (verified by
 * `test/plugin.spec.ts`, which asserts on `id`/`kind`/`safe`/`transports`/
 * `handler` and passes unmodified).
 */
function buildOpenapiOperations(
  descriptor: Descriptor,
  opts: OpenapiOptions = {}
): MountedOperation[] {
  return [
    {
      ...syntheticOp('_meta/openapi', descriptor, {
        // query + safe → GET /meta/openapi (SPEC §5)
        kind: 'query',
        safe: true,
        // Output: an object (the full OpenAPI doc shape; not narrowed further
        // here because the exact schema varies with the descriptor content).
        output: { type: 'object' },
        // Expose only on HTTP — the doc is a tooling artefact (SPEC §7.2b).
        transports: ['http'],
      }),
      // Handler: derive the doc from the descriptor at request time.
      handler: (_call: Call) =>
        toOpenApi(descriptor.operations, {
          title: opts.title,
          version: opts.version,
        }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

/**
 * v2 openapi mount plugin (SPEC §7.1 / §7.2b).
 *
 * Contributes `GET /meta/openapi` → the OpenAPI 3.1 document derived from
 * the canonical descriptor at request time.
 */
export const openapiPlugin: Plugin<OpenapiOptions> = {
  id: 'openapi',
  description: 'Mount plugin: serves the OpenAPI 3.1 doc at GET /meta/openapi',
  language: 'ts',

  optionsSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'OpenAPI info.title' },
      version: { type: 'string', description: 'OpenAPI info.version' },
    },
    additionalProperties: false,
  },

  capabilities: {
    mount: {
      operations(
        descriptor: Descriptor,
        opts?: Record<string, unknown>
      ): MountedOperation[] {
        return buildOpenapiOperations(
          descriptor,
          opts as OpenapiOptions | undefined
        );
      },
    },
  },
};

export default openapiPlugin;
