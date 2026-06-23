// Pure function: Descriptor → OpenAPI 3.1 document (SPEC §7.2b / §12).
//
// Consumes the canonical descriptor (Operation[]) and emits a standards-
// conformant OpenAPI 3.1 document.  Verb derivation follows SPEC §5: safe →
// GET (idempotent, query-string params), unsafe → POST (JSON body params).
//
// Design notes:
//   - This is a COMMON codegen helper — descriptor-in → artifact-out.  It
//     never imports host-specific code (no @adhd/apigen-runtime, no TS
//     extractor).  Platform tag: `platform:shared`.
//   - The JSON-Schema-2020-12 `input`/`output` schemas in the descriptor are
//     passed through verbatim — OpenAPI 3.1 natively supports JSON Schema
//     2020-12, so no translation is required.
//   - Operations with `streaming: true` are exposed; the response schema
//     describes the per-chunk element type (SPEC §11).
//   - Mount plugins (openapi, health) contribute `_meta/*` operations that
//     also go through this function; their `id` strings starting with `_meta`
//     are a convention, not a filter.

import { project } from '@adhd/apigen-naming'
import type { Operation, JSONSchema } from '@adhd/apigen-core'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * An OpenAPI 3.1 document.  The type is intentionally open (Record) because
 * we cannot enumerate every valid 3.1 keyword here — downstream consumers can
 * narrow as needed.
 */
export type OpenApiDocument = {
  openapi: '3.1.0'
  info: { title: string; version: string }
  paths: Record<string, OpenApiPathItem>
  components?: { schemas?: Record<string, JSONSchema> }
  [key: string]: unknown
}

/** An OpenAPI path-item object (subset sufficient for apigen projection). */
export type OpenApiPathItem = {
  [verb: string]: OpenApiOperation
}

/** An OpenAPI operation object (subset). */
export type OpenApiOperation = {
  operationId: string
  summary?: string
  parameters?: OpenApiParameter[]
  requestBody?: OpenApiRequestBody
  responses: Record<string, OpenApiResponse>
  [key: string]: unknown
}

/** An OpenAPI parameter object (subset). */
export type OpenApiParameter = {
  name: string
  in: 'query' | 'header' | 'path' | 'cookie'
  required?: boolean
  schema: JSONSchema
}

/** An OpenAPI request-body object (subset). */
export type OpenApiRequestBody = {
  required: boolean
  content: { 'application/json': { schema: JSONSchema } }
}

/** An OpenAPI response object (subset). */
export type OpenApiResponse = {
  description: string
  content?: { 'application/json': { schema: JSONSchema } }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for {@link toOpenApi}.
 */
export interface ToOpenApiOptions {
  /**
   * The API title placed in `info.title`.
   * @default 'API'
   */
  title?: string

  /**
   * The API version placed in `info.version`.
   * @default '0.0.0'
   */
  version?: string
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Projects an array of {@link Operation}s to an OpenAPI 3.1 document.
 *
 * HTTP verb derivation (SPEC §5): `safe → GET`, `!safe → POST`.
 * - **GET**: domain params appear as query-string `parameters`.
 * - **POST**: domain params are wrapped in a `requestBody` (`application/json`).
 *
 * The `input` and `output` JSON-Schema fragments are passed through verbatim
 * (OpenAPI 3.1 natively supports JSON Schema 2020-12).
 *
 * @param operations - The canonical operations array from the merged descriptor.
 * @param opts       - Optional document-level metadata (title, version).
 * @returns A standards-conformant OpenAPI 3.1 document.
 *
 * @example
 * ```ts
 * const doc = toOpenApi(descriptor.operations, { title: 'My API', version: '1.0.0' })
 * // doc.openapi === '3.1.0'
 * // doc.paths['/transform/humanize/humanize-bytes']['post'] → { operationId, … }
 * ```
 */
export function toOpenApi(
  operations: Operation[],
  opts: ToOpenApiOptions = {},
): OpenApiDocument {
  const title = opts.title ?? 'API'
  const version = opts.version ?? '0.0.0'

  const paths: Record<string, OpenApiPathItem> = {}

  for (const op of operations) {
    const proj = project(op)
    const { verb, route } = proj.http
    const verbLower = verb.toLowerCase()

    const apiOp: OpenApiOperation = {
      operationId: op.id,
      summary: op.id,
      responses: {
        '200': buildResponse(op.output),
      },
    }

    // Derive params or request body from the input schema.
    if (op.safe) {
      // GET: domain params as query-string parameters.
      apiOp.parameters = buildQueryParams(op.input)
    } else {
      // POST (and other unsafe verbs): domain params as JSON body.
      const inputSchema = op.input
      const hasBody =
        typeof inputSchema === 'object' &&
        inputSchema !== null &&
        (Object.keys(inputSchema).length > 0)

      if (hasBody) {
        apiOp.requestBody = {
          required: true,
          content: {
            'application/json': {
              schema: inputSchema,
            },
          },
        }
      }
    }

    if (paths[route] === undefined) {
      paths[route] = {}
    }
    paths[route][verbLower] = apiOp
  }

  return {
    openapi: '3.1.0',
    info: { title, version },
    paths,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds an OpenAPI response object for a given output schema.
 *
 * An empty schema (`{}`) produces a response with no content body (204-style
 * semantically, but we emit 200 with no `content` to keep the shape uniform).
 */
function buildResponse(output: JSONSchema): OpenApiResponse {
  const hasContent =
    typeof output === 'object' &&
    output !== null &&
    Object.keys(output).length > 0

  if (!hasContent) {
    return { description: 'Success' }
  }

  return {
    description: 'Success',
    content: {
      'application/json': { schema: output },
    },
  }
}

/**
 * Flattens a JSON-Schema `properties` map into an array of query-string
 * parameters.  Only the top-level properties of an object schema are lifted;
 * nested objects are represented as a single `schema: { type: 'object', … }`
 * parameter.  This is sufficient for the simple domain-param shapes that
 * apigen handles.
 *
 * When the input schema has no `properties` (zero-param operation) an empty
 * array is returned.
 */
function buildQueryParams(input: JSONSchema): OpenApiParameter[] {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof input['properties'] !== 'object' ||
    input['properties'] === null
  ) {
    return []
  }

  const required: string[] =
    Array.isArray(input['required']) ? (input['required'] as string[]) : []

  const properties = input['properties'] as Record<string, JSONSchema>

  return Object.entries(properties).map(([name, schema]) => ({
    name,
    in: 'query' as const,
    required: required.includes(name),
    schema,
  }))
}
