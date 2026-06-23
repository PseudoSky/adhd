import Fastify from 'fastify'
import { dispatch, createLogger, describeParams } from '@adhd/apigen-runtime'
import type { ParamInfo } from '@adhd/apigen-runtime'
import type { RunInput } from '@adhd/apigen-core'
import { envelopeKey } from '@adhd/apigen-naming'
import { HTTP_STATUS, ApiError } from '@adhd/apigen-errors'
import type { ProjectionConfig } from '@adhd/apigen-naming'
import type { ApiErrorCode } from '@adhd/apigen-errors'

// ---------------------------------------------------------------------------
// §5 — verb from safe
// ---------------------------------------------------------------------------

function httpVerb(
  fnId: string,
  schema: Record<string, unknown>,
  config: ProjectionConfig,
): 'GET' | 'POST' {
  const override = config.http?.verb?.[fnId]
  if (override === 'GET' || override === 'POST') return override
  return (schema['x-apigen-safe'] as boolean | undefined) ? 'GET' : 'POST'
}

// ---------------------------------------------------------------------------
// §9.1 — envelope from HTTP headers (x-<pluginId>-<field>)
// ---------------------------------------------------------------------------

/**
 * Extracts envelope values from request headers following the §9.1 binding table.
 *
 * For each envelope field declared in the composed schema's top-level input
 * properties (excluding `data`), reads the `x-<pluginId>-<field>` request header.
 * pluginId defaults to 'adhd' for fields without an explicit x-apigen-envelope entry.
 */
function extractEnvelopeFromHeaders(
  schema: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
): Record<string, unknown> {
  const inputProps = (
    (schema['input'] as Record<string, unknown> | undefined)?.['properties'] as
      | Record<string, unknown>
      | undefined
  ) ?? {}
  const meta = schema['x-apigen-envelope'] as Record<string, string> | undefined
  const envelope: Record<string, unknown> = {}
  for (const field of Object.keys(inputProps)) {
    if (field === 'data') continue
    const pluginId = meta?.[field] ?? 'adhd'
    const headerName = envelopeKey(pluginId, field)
    const value = headers[headerName]
    if (value !== undefined) envelope[field] = value
  }
  return envelope
}

// ---------------------------------------------------------------------------
// §9 — map ApiError to HTTP status
// ---------------------------------------------------------------------------

function toHttpStatus(err: unknown): number {
  if (err instanceof ApiError) {
    return HTTP_STATUS[err.code as ApiErrorCode] ?? 500
  }
  return 500
}

export async function run(input: RunInput): Promise<void> {
  const port = (input.options['port'] as number) ?? 3000
  const host = (input.options['host'] as string) ?? '127.0.0.1'
  const routePrefix = (input.options['routePrefix'] as string) ?? ''
  const projection = (input.options['projection'] as ProjectionConfig | undefined) ?? {}
  // Use the shared pino instance as Fastify's logger so per-request logging is
  // native + consistent; fall back to a default stderr logger when absent.
  const logger = input.logger ?? createLogger()
  // Fastify v4 accepts a pino logger instance directly via `logger`.
  const app = Fastify({ logger })

  // Set a custom error handler that maps ApiError codes to correct HTTP status
  // per the §9 error table.
  app.setErrorHandler((err, _req, reply) => {
    const status = toHttpStatus(err)
    const body =
      err instanceof ApiError
        ? err.toJSON()
        : { code: 'internal' as ApiErrorCode, message: err.message ?? 'Internal error' }
    reply.status(status).send(body)
  })

  const routes: Array<{ method: string; route: string; text: string; params: ParamInfo[] }> = []

  for (const pkg of input.packages) {
    for (const [fnName, fnSchema] of Object.entries(pkg.schemas)) {
      const route = `${routePrefix}/${pkg.id}/${fnName}`
      const verb = httpVerb(`${pkg.id}:${fnName}`, fnSchema as Record<string, unknown>, projection)
      const { params, text } = describeParams(fnSchema)
      routes.push({ method: verb, route, text, params })

      // We deliberately omit `schema: { body: fnSchema.input }` — generated
      // schemas use oneOf/anyOf shapes that Fastify's AJV rejects at route
      // registration time. Validation is deferred to dispatch(). [plugin-api-fastify.4]

      if (verb === 'GET') {
        // safe op: domain args from query string, envelope from request headers
        app.get(route, async (req) => {
          const envelope = extractEnvelopeFromHeaders(
            fnSchema as Record<string, unknown>,
            req.headers as Record<string, string | string[] | undefined>,
          )
          return dispatch(
            pkg.fns!,
            pkg.createClient,
            fnSchema,
            fnName,
            envelope,
            req.query as Record<string, unknown>,
          )
        })
      } else {
        // unsafe op: domain args from body.data, envelope from request headers
        app.post(route, async (req) => {
          const { data = {} } = req.body as Record<string, unknown>
          const envelope = extractEnvelopeFromHeaders(
            fnSchema as Record<string, unknown>,
            req.headers as Record<string, string | string[] | undefined>,
          )
          return dispatch(
            pkg.fns!,
            pkg.createClient,
            fnSchema,
            fnName,
            envelope,
            data as Record<string, unknown>,
          )
        })
      }
    }
  }

  await app.listen({ port, host })
  logger.info({ host, port }, `listening on http://${host}:${port}`)
  for (const r of routes)
    logger.info(
      { method: r.method, route: r.route, body: { data: r.params } },
      `${r.method} ${r.route}  body { data: {${r.text ? ` ${r.text} ` : ''}} }`,
    )
  return new Promise((resolve) => {
    if (input.signal) {
      input.signal.addEventListener('abort', async () => {
        await app.close()
        resolve()
      })
    }
  })
}
