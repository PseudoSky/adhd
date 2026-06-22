import Fastify from 'fastify'
import { dispatch, createLogger, describeParams } from '@adhd/apigen-runtime'
import type { ParamInfo } from '@adhd/apigen-runtime'
import type { RunInput } from '@adhd/apigen-core'

export async function run(input: RunInput): Promise<void> {
  const port = (input.options['port'] as number) ?? 3000
  const host = (input.options['host'] as string) ?? '127.0.0.1'
  const routePrefix = (input.options['routePrefix'] as string) ?? ''
  // Use the shared pino instance as Fastify's logger so per-request logging is
  // native + consistent; fall back to a default stderr logger when absent.
  const logger = input.logger ?? createLogger()
  // Fastify v4 accepts a pino logger instance directly via `logger`.
  const app = Fastify({ logger })

  const routes: Array<{ route: string; text: string; params: ParamInfo[] }> = []
  for (const pkg of input.packages) {
    for (const [fnName, fnSchema] of Object.entries(pkg.schemas)) {
      const route = `${routePrefix}/${pkg.id}/${fnName}`
      const { params, text } = describeParams(fnSchema)
      routes.push({ route, text, params })
      // We deliberately omit `schema: { body: fnSchema.input }` — generated
      // schemas use oneOf/anyOf shapes that Fastify's AJV rejects at route
      // registration time. Validation is deferred to dispatch(). [plugin-api-fastify.4]
      app.post(route, async (req) => {
        const { data = {}, ...envelope } = req.body as Record<string, unknown>
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

  await app.listen({ port, host })
  logger.info({ host, port }, `listening on http://${host}:${port}`)
  for (const r of routes)
    logger.info(
      { method: 'POST', route: r.route, body: { data: r.params } },
      `POST ${r.route}  body { data: {${r.text ? ` ${r.text} ` : ''}} }`,
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
