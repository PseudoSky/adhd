// @adhd/apigen-plugin-health — mount plugin that exposes a health/readiness endpoint.
//
// This plugin implements the `mount` capability (SPEC §7.1 / §7.2c): it
// contributes a single synthetic operation (`_meta/health`) that returns a
// per-host readiness signal consumed by the gateway's failure model (§13.1).
//
// Gateway readiness contract (SPEC §13.1):
//   - Each sidecar exposes `_meta/health`; the gateway routes a host's ops
//     ONLY after it reports ready.
//   - The gateway's own aggregate health reports per-host status:
//       { hosts: { <host>: 'ready' | 'degraded' | 'down' } }
//   - A single in-process runtime (non-gateway) always reports `ready` because
//     it is either serving or not yet started — there is no partial state.
//
// This implementation covers the in-process (single-host) case.  Mixed-host /
// gateway aggregation is handled by @adhd/apigen-gateway (SPEC §13).
//
// Usage (SPEC §7):
//   adhd-apigen run --source api.ts --type http-fastify --use health

import type { Plugin, Descriptor, MountedOperation, Call } from '@adhd/apigen-core'

// ---------------------------------------------------------------------------
// Plugin-specific options
// ---------------------------------------------------------------------------

/** Options accepted by the health mount plugin. */
export interface HealthOptions {
  /**
   * Optional extra metadata to include in the health response payload.
   * Values must be serialisable (string / number / boolean / null).
   */
  meta?: Record<string, string | number | boolean | null>
}

// ---------------------------------------------------------------------------
// Public types (the readiness signal shape)
// ---------------------------------------------------------------------------

/**
 * The readiness signal emitted by `_meta/health`.
 *
 * - `status: 'ok'` — the runtime is alive and ready to serve.
 * - `host`         — the owning language runtime tag from the descriptor.
 * - `meta`         — optional operator-supplied metadata (see {@link HealthOptions}).
 *
 * The gateway feeds on this shape when aggregating per-host status (§13.1).
 */
export interface HealthResponse {
  status: 'ok'
  host: string
  meta?: Record<string, string | number | boolean | null>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a casing-neutral segment inline (avoids importing @adhd/apigen-naming
 * to keep the health plugin dependency-light; the shape is trivially stable).
 */
function seg(raw: string): { raw: string; words: string[] } {
  return { raw, words: [raw] }
}

// ---------------------------------------------------------------------------
// Mount capability implementation
// ---------------------------------------------------------------------------

/**
 * Returns the single `_meta/health` mounted operation for a given descriptor.
 *
 * The handler always returns `{ status: 'ok', host: descriptor.host }` for
 * an in-process runtime — if the handler can respond, the runtime is ready.
 */
function buildHealthOperations(
  descriptor: Descriptor,
  opts: HealthOptions = {},
): MountedOperation[] {
  return [
    {
      // Canonical id — `_meta` prefix convention for meta-endpoints.
      id: '_meta/health',
      host: descriptor.host,
      namespace: seg('meta'),
      path: [seg('health')],
      // query + safe → GET /meta/health; gRPC also useful for load-balancer probes.
      kind: 'query',
      async: false,
      streaming: false,
      safe: true,
      // Input: no domain params.
      input: {},
      // Output: the HealthResponse shape (inlined for zero extra dependencies).
      output: {
        type: 'object',
        required: ['status', 'host'],
        properties: {
          status: { const: 'ok' },
          host: { type: 'string' },
          meta: { type: 'object' },
        },
      },
      envelope: {},
      typeText: null,
      // Expose on HTTP and gRPC — useful for both HTTP health checks and
      // gRPC-native load-balancer probes (SPEC §7.2c / §13.1).
      transports: ['http', 'grpc'],
      // Handler: always returns ready when the runtime can answer.
      handler: (_call: Call): HealthResponse => {
        const response: HealthResponse = {
          status: 'ok',
          host: descriptor.host,
        }
        if (opts.meta !== undefined && Object.keys(opts.meta).length > 0) {
          response.meta = opts.meta
        }
        return response
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

/**
 * v2 health mount plugin (SPEC §7.1 / §7.2c).
 *
 * Contributes `GET /meta/health` (+ gRPC) → `{ status: 'ok', host: '...' }`.
 * The gateway routes a host's operations only after this endpoint reports
 * ready (SPEC §13.1 gateway readiness contract).
 */
export const healthPlugin: Plugin<HealthOptions> = {
  id: 'health',
  description: 'Mount plugin: exposes GET /meta/health for gateway readiness (SPEC §13.1)',
  language: 'ts',

  optionsSchema: {
    type: 'object',
    properties: {
      meta: { type: 'object', description: 'Extra metadata included in the health response' },
    },
    additionalProperties: false,
  },

  capabilities: {
    mount: {
      operations(descriptor: Descriptor, opts?: Record<string, unknown>): MountedOperation[] {
        return buildHealthOperations(descriptor, opts as HealthOptions | undefined)
      },
    },
  },
}

export default healthPlugin
