import Fastify from 'fastify'
import type { FastifyReply } from 'fastify'
import {
  createInvoker,
  makeValidateLayer,
  createLogger,
  describeParams,
  LayerContext,
} from '@adhd/apigen-runtime'
import type { Call as RuntimeCall, Layer, ParamInfo } from '@adhd/apigen-runtime'
import type { RunInput, ComposedSchemas } from '@adhd/apigen-core'
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

// ---------------------------------------------------------------------------
// §7.1 / §8 — `--use` Layer + Mount composition (BUG-APIGEN-009 / -010)
// ---------------------------------------------------------------------------

/**
 * A loaded `--use` plugin object (SPEC §7.1).  We only depend on the shape we
 * actually consume here (layer / mount capabilities) so the transport adapter
 * stays decoupled from the full `Plugin` type surface.
 */
interface UsePlugin {
  id: string
  capabilities?: {
    layer?: {
      layer: (call: unknown, next: () => Promise<unknown>) => Promise<unknown> | AsyncIterable<unknown>
    }
    mount?: {
      operations: (
        descriptor: { host: string; operations: unknown[] },
        opts?: Record<string, unknown>,
      ) => Array<{
        id: string
        transports?: string[]
        handler: (call: unknown) => unknown
      }>
    }
  }
}

/** Per-`--use` plugin option bag, keyed by plugin id (carried on options.useOptions). */
type UseOptions = Record<string, Record<string, unknown>>

/**
 * Read the loaded `--use` plugins off `input.options`.  The CLI loads the
 * specifiers into real plugin objects and threads them here (RunInput carries no
 * dedicated field, so they ride on `options.usePlugins`).
 */
function readUsePlugins(options: Record<string, unknown>): UsePlugin[] {
  const raw = options['usePlugins']
  return Array.isArray(raw) ? (raw as UsePlugin[]) : []
}

function readUseOptions(options: Record<string, unknown>): UseOptions {
  const raw = options['useOptions']
  return raw && typeof raw === 'object' ? (raw as UseOptions) : {}
}

/**
 * Adapt a core `LayerCapability.layer` (which receives the SPEC §7.1 `Call`
 * shape with `.data`) into a runtime {@link Layer} (which threads the §8.1
 * `Call` with `.domainArgs`).  The runtime Call already carries `operation.id`,
 * `envelope`, `ctx`, and `signal`; we additionally surface `.data` (an alias of
 * `domainArgs`) so layers written against either shape see their fields.
 */
function adaptCoreLayer(
  cap: NonNullable<NonNullable<UsePlugin['capabilities']>['layer']>,
): Layer {
  return async function useLayer(call: RuntimeCall, next): Promise<unknown> {
    const view = Object.assign(call, { data: call.domainArgs })
    const result = await cap.layer(view, next as () => Promise<unknown>)
    return result
  }
}

/**
 * Compose the request-path invoker for one package: the `--use` layer plugins
 * (outermost-first, in declaration order) wrapping the central validate-Layer
 * (innermost, immediately before dispatch — BUG-APIGEN-009).
 */
function buildInvokerForPackage(
  schemas: ComposedSchemas,
  usePlugins: UsePlugin[],
) {
  const layers: Layer[] = []
  for (const plugin of usePlugins) {
    const cap = plugin.capabilities?.layer
    if (cap) layers.push(adaptCoreLayer(cap))
  }
  // validate-Layer is ALWAYS innermost so malformed input is rejected before
  // dispatch is ever reached (SPEC §6 / §8.1 rule 1).
  layers.push(makeValidateLayer(schemas))
  return createInvoker(layers)
}

/**
 * A mount route resolved from a `--use` mount plugin: the synthetic op's id
 * (e.g. `_meta/health`) becomes `GET /_meta/health`, answered by its handler.
 */
interface MountRoute {
  route: string
  handler: (call: unknown) => unknown
}

/**
 * Collect HTTP mount routes contributed by the `--use` mount plugins
 * (BUG-APIGEN-010).  A mounted op is exposed on HTTP unless it declares an
 * explicit `transports` filter that omits `'http'`.
 */
function collectMountRoutes(
  usePlugins: UsePlugin[],
  useOptions: UseOptions,
  host: string,
  routePrefix: string,
): MountRoute[] {
  const routes: MountRoute[] = []
  const descriptor = { host, operations: [] as unknown[] }
  for (const plugin of usePlugins) {
    const cap = plugin.capabilities?.mount
    if (!cap) continue
    const ops = cap.operations(descriptor, useOptions[plugin.id])
    for (const op of ops) {
      if (op.transports && !op.transports.includes('http')) continue
      // The op id is the canonical slug (e.g. `_meta/health`); mount it as a
      // top-level route so `GET /_meta/health` resolves (task contract).
      routes.push({ route: `${routePrefix}/${op.id}`, handler: op.handler })
    }
  }
  return routes
}

/**
 * Emit the invoker result as canonical JSON wire (`application/json`).
 *
 * BUG-APIGEN-015: a scalar logical return (`Decimal`/`int64`/`Date`) is encoded
 * by the runtime to a STRING like `"123.456"`. If a Fastify handler simply
 * returns that string, Fastify serialises it as a raw `text/plain` body
 * (`123.456`, no quotes — and for a `Date`, `2024-…Z` which is not even valid
 * JSON). That drifts from the py-flask host, which emits the canonical JSON
 * string `"123.456"`, breaking cross-language wire parity on the RESPONSE path
 * (and losing precision for any client that `JSON.parse`s a bare big number).
 *
 * Serialising every result with `JSON.stringify` and pinning
 * `application/json` makes scalar returns byte-identical to py-flask while
 * leaving object/array returns unchanged. `undefined` (void op) becomes `null`.
 */
function sendJson(reply: FastifyReply, result: unknown): string {
  reply.type('application/json')
  return JSON.stringify(result === undefined ? null : result)
}

export async function run(input: RunInput): Promise<void> {
  const port = (input.options['port'] as number) ?? 3000
  const host = (input.options['host'] as string) ?? '127.0.0.1'
  const routePrefix = (input.options['routePrefix'] as string) ?? ''
  const projection = (input.options['projection'] as ProjectionConfig | undefined) ?? {}
  const usePlugins = readUsePlugins(input.options)
  const useOptions = readUseOptions(input.options)
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
    // BUG-APIGEN-009: compose the validate-Layer (+ any `--use` layers) around
    // dispatch ONCE per package, then invoke through it per request. The
    // invoker rejects schema-violating input with ApiError{invalid_argument}
    // BEFORE the target function is ever called.
    const invoke = buildInvokerForPackage(pkg.schemas, usePlugins)
    const invokeOpts = { fns: pkg.fns!, createClient: pkg.createClient, schemas: pkg.schemas }

    for (const [fnName, fnSchema] of Object.entries(pkg.schemas)) {
      const route = `${routePrefix}/${pkg.id}/${fnName}`
      const verb = httpVerb(`${pkg.id}:${fnName}`, fnSchema as Record<string, unknown>, projection)
      const { params, text } = describeParams(fnSchema)
      routes.push({ method: verb, route, text, params })

      // We deliberately omit `schema: { body: fnSchema.input }` — generated
      // schemas use oneOf/anyOf shapes that Fastify's AJV rejects at route
      // registration time. Validation is performed by the validate-Layer in the
      // composed invoker instead. [plugin-api-fastify.4]

      if (verb === 'GET') {
        // safe op: domain args from query string, envelope from request headers
        app.get(route, async (req, reply) => {
          const envelope = extractEnvelopeFromHeaders(
            fnSchema as Record<string, unknown>,
            req.headers as Record<string, string | string[] | undefined>,
          )
          const call: RuntimeCall = {
            operation: { id: fnName },
            ctx: new LayerContext(),
            envelope,
            domainArgs: req.query as Record<string, unknown>,
            signal: input.signal,
          }
          return sendJson(reply, await invoke(fnName, call, invokeOpts))
        })
      } else {
        // unsafe op: domain args from body.data, envelope from request headers
        app.post(route, async (req, reply) => {
          const { data = {} } = (req.body as Record<string, unknown> | undefined) ?? {}
          const envelope = extractEnvelopeFromHeaders(
            fnSchema as Record<string, unknown>,
            req.headers as Record<string, string | string[] | undefined>,
          )
          const call: RuntimeCall = {
            operation: { id: fnName },
            ctx: new LayerContext(),
            envelope,
            domainArgs: data as Record<string, unknown>,
            signal: input.signal,
          }
          return sendJson(reply, await invoke(fnName, call, invokeOpts))
        })
      }
    }
  }

  // BUG-APIGEN-010: register `--use` mount plugins (health, …) as real HTTP
  // routes. The health plugin declares `_meta/health` → GET /_meta/health.
  const mountHost = input.packages[0]?.id ?? 'ts'
  const mountRoutes = collectMountRoutes(usePlugins, useOptions, mountHost, routePrefix)
  for (const m of mountRoutes) {
    routes.push({ method: 'GET', route: m.route, text: '', params: [] })
    app.get(m.route, async (req) => {
      const call = {
        operation: { id: m.route },
        data: {},
        envelope: {},
        ctx: new LayerContext(),
        transport: 'http',
        signal: input.signal ?? new AbortController().signal,
        raw: req,
      }
      return m.handler(call)
    })
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
