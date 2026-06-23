import express, { Router } from 'express'
import { pinoHttp } from 'pino-http'
import { dispatch, createLogger, describeParams } from '@adhd/apigen-runtime'
import type { ParamInfo } from '@adhd/apigen-runtime'
import type { RunInput } from '@adhd/apigen-core'
import type { Server } from 'node:http'
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
  // Fall back to a default stderr logger when the CLI did not supply one.
  const logger = input.logger ?? createLogger()

  const app = express()
  // pino-http logs every request via the shared logger instance.
  app.use(pinoHttp({ logger }))
  app.use(express.json())
  const router = Router()

  const routes: Array<{ method: string; route: string; text: string; params: ParamInfo[] }> = []

  for (const pkg of input.packages) {
    for (const [fnName, fnSchema] of Object.entries(pkg.schemas)) {
      const route = `${routePrefix}/${pkg.id}/${fnName}`
      const verb = httpVerb(`${pkg.id}:${fnName}`, fnSchema as Record<string, unknown>, projection)
      const { params, text } = describeParams(fnSchema)
      routes.push({ method: verb, route, text, params })

      if (verb === 'GET') {
        // safe op: domain args from query string, envelope from request headers
        router.get(route, async (req, res, next) => {
          try {
            const envelope = extractEnvelopeFromHeaders(
              fnSchema as Record<string, unknown>,
              req.headers as Record<string, string | string[] | undefined>,
            )
            const result = await dispatch(
              pkg.fns!,
              pkg.createClient,
              fnSchema,
              fnName,
              envelope,
              req.query as Record<string, unknown>,
            )
            res.json(result)
          } catch (err) {
            next(err)
          }
        })
      } else {
        // unsafe op: domain args from body.data, envelope from request headers
        router.post(route, async (req, res, next) => {
          try {
            const { data = {} } = req.body as Record<string, unknown>
            const envelope = extractEnvelopeFromHeaders(
              fnSchema as Record<string, unknown>,
              req.headers as Record<string, string | string[] | undefined>,
            )
            const result = await dispatch(
              pkg.fns!,
              pkg.createClient,
              fnSchema,
              fnName,
              envelope,
              data as Record<string, unknown>,
            )
            res.json(result)
          } catch (err) {
            next(err)
          }
        })
      }
    }
  }

  app.use(router)

  // §9 error handler — maps ApiError codes to correct HTTP status.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status = toHttpStatus(err)
      const body =
        err instanceof ApiError
          ? err.toJSON()
          : { code: 'internal' as ApiErrorCode, message: (err as Error).message ?? 'Internal error' }
      res.status(status).json(body)
    },
  )

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, host, () => resolve(s))
  })
  logger.info({ host, port }, `listening on http://${host}:${port}`)
  for (const r of routes)
    logger.info(
      { method: r.method, route: r.route, body: { data: r.params } },
      `${r.method} ${r.route}  body { data: {${r.text ? ` ${r.text} ` : ''}} }`,
    )

  return new Promise((resolve) => {
    if (input.signal) {
      input.signal.addEventListener('abort', () => {
        server.close(() => resolve())
      })
    }
  })
}
